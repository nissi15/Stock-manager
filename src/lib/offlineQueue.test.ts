import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sale } from './types';
import { legacyQueueCount, offlineSnapshotFor, queuedSalesFor, removeQueuedSale, saveOfflineSnapshot, saveQueuedSale } from './offlineQueue';

function sale(id: string): Sale {
  return {
    id, at: '2026-10-19T10:00:00.000Z',
    lines: [{ productId: 'product-1', name: 'Rice', quantity: 2, unitPrice: 3000, cost: 0 }],
    payments: [{ method: 'cash', amount: 6000 }], total: 6000, cost: 0,
    hasCostDeficit: true, source: 'supabase', sync: 'queued'
  };
}

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('stock-manager-queue');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe('durable offline sales', () => {
  it('writes an account-scoped sale before resolving and keeps it until acknowledgement', async () => {
    await saveQueuedSale({ id: 'sale-a', ownerId: 'account-a', dayDate: '2026-10-19', sale: sale('sale-a'), state: 'queued' });
    expect((await queuedSalesFor('account-a')).map((entry) => entry.id)).toEqual(['sale-a']);
    expect(await queuedSalesFor('account-b')).toEqual([]);
    await removeQueuedSale('sale-a');
    expect(await queuedSalesFor('account-a')).toEqual([]);
  });

  it('keeps an upload error for later review without exposing it to another account', async () => {
    await saveQueuedSale({ id: 'sale-a', ownerId: 'account-a', dayDate: '2026-10-19', sale: sale('sale-a'), state: 'needs_attention', lastError: 'Day is closed' });
    await saveQueuedSale({ id: 'sale-b', ownerId: 'account-b', dayDate: '2026-10-19', sale: sale('sale-b'), state: 'queued' });
    expect(await queuedSalesFor('account-a')).toMatchObject([{ state: 'needs_attention', lastError: 'Day is closed' }]);
    expect((await queuedSalesFor('account-b')).map((entry) => entry.id)).toEqual(['sale-b']);
  });

  it('restores only the signed-in account catalog and business day', async () => {
    await saveOfflineSnapshot({ ownerId: 'account-a', savedAt: '2026-10-19T10:00:00Z', products: [{ id: 'rice', name: 'Rice', category: 'Rice', unit: 'sack', stock: 5, price: 3000, active: true }], businessDay: { date: '2026-10-19', status: 'open', openedAt: '2026-10-19T08:00:00Z' } });
    expect((await offlineSnapshotFor('account-a'))?.products[0].stock).toBe(5);
    expect(await offlineSnapshotFor('account-b')).toBeUndefined();
  });

  it('does not silently assign a legacy unowned sale to a signed-in account', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('stock-manager-queue', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sales', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('sales', 'readwrite');
        transaction.objectStore('sales').put(sale('old-sale'));
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
    expect(await legacyQueueCount()).toBe(1);
    expect(await queuedSalesFor('account-a')).toEqual([]);
  });
});
