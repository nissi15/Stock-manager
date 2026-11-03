import type { Sale } from './types';

/** A sale made while offline (or while Supabase was unreachable), waiting to be recorded. */
export type QueuedSale = Sale & { ownerId?: string | null };

const DB_NAME = 'stock-manager-queue';
const STORE = 'sales';

export const queueAvailable = () => typeof indexedDB !== 'undefined';

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openQueue();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      // Resolve only once the transaction commits, so a "saved" sale is really on disk.
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The offline sale queue could not be saved.'));
    });
  } finally {
    db.close();
  }
}

export async function readQueuedSales(): Promise<QueuedSale[]> {
  if (!queueAvailable()) return [];
  return (await withStore<QueuedSale[]>('readonly', (store) => store.getAll())) ?? [];
}

export async function putQueuedSale(sale: QueuedSale): Promise<void> {
  if (!queueAvailable()) throw new Error('This browser cannot store offline sales. Reconnect before selling.');
  // Plain JSON copy: IndexedDB cannot clone reactive proxies.
  await withStore('readwrite', (store) => store.put(JSON.parse(JSON.stringify(sale))));
}

export async function deleteQueuedSale(id: string): Promise<void> {
  if (!queueAvailable()) return;
  await withStore('readwrite', (store) => store.delete(id));
}
