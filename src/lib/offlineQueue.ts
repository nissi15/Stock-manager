import type { BusinessDay, Product, Sale } from './types';

const databaseName = 'stock-manager-queue';
const databaseVersion = 2;

export type QueuedSale = {
  id: string;
  ownerId: string;
  dayDate: string;
  sale: Sale;
  state: 'queued' | 'needs_attention';
  lastError?: string;
};

export type OfflineSnapshot = {
  ownerId: string;
  savedAt: string;
  products: Product[];
  businessDay: BusinessDay | null;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('sales')) database.createObjectStore('sales', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots', { keyPath: 'ownerId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open offline storage.'));
  });
}

async function write(storeName: 'sales' | 'snapshots', action: (store: IDBObjectStore) => void): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Offline storage failed.')); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Offline storage was cancelled.')); };
    try { action(transaction.objectStore(storeName)); }
    catch (error) { transaction.abort(); reject(error); }
  });
}

async function read<T>(storeName: 'sales' | 'snapshots', action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    let request: IDBRequest<T>;
    try { request = action(transaction.objectStore(storeName)); }
    catch (error) { database.close(); reject(error); return; }
    transaction.oncomplete = () => { database.close(); resolve(request.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Could not read offline storage.')); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Offline storage read was cancelled.')); };
  });
}

export function saveQueuedSale(entry: QueuedSale): Promise<void> {
  return write('sales', (store) => { store.put(entry); });
}

export function removeQueuedSale(id: string): Promise<void> {
  return write('sales', (store) => { store.delete(id); });
}

export async function queuedSalesFor(ownerId: string): Promise<QueuedSale[]> {
  const entries = await read<QueuedSale[]>('sales', (store) => store.getAll());
  return entries.filter((entry) => entry.ownerId === ownerId && entry.sale?.id === entry.id)
    .sort((a, b) => new Date(a.sale.at).getTime() - new Date(b.sale.at).getTime() || a.id.localeCompare(b.id));
}

// Version 1 wrote sales without an owner. Keep them intact, but never guess
// which account may upload them to Supabase.
export async function legacyQueueCount(): Promise<number> {
  const entries = await read<QueuedSale[]>('sales', (store) => store.getAll());
  return entries.filter((entry) => !entry.ownerId).length;
}

export function saveOfflineSnapshot(snapshot: OfflineSnapshot): Promise<void> {
  return write('snapshots', (store) => { store.put(snapshot); });
}

export async function offlineSnapshotFor(ownerId: string): Promise<OfflineSnapshot | undefined> {
  return read<OfflineSnapshot | undefined>('snapshots', (store) => store.get(ownerId));
}
