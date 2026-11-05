import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { today } from './format';
import type { Product } from './types';
import { queuedSalesFor, saveOfflineSnapshot } from './offlineQueue';

const backend = vi.hoisted(() => ({
  ownerId: 'account-a',
  rpcCalls: [] as Array<{ ownerId: string; id: string }>,
  savedSales: [] as Array<{ ownerId: string; id: string; at: string; lines: Array<{ productId: string; quantity: number; unitPrice: number }>; payments: Array<{ method: string; amount: number }> }>,
  nextError: null as null | { message: string; code: string },
  failRefreshOnce: false
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: backend.ownerId } } }, error: null }) },
    rpc: async (_name: string, args: { p_id: string; p_sold_at: string; p_lines: Array<{ productId: string; quantity: number; unitPrice: number }>; p_payments: Array<{ method: string; amount: number }> }) => {
      backend.rpcCalls.push({ ownerId: backend.ownerId, id: args.p_id });
      const error = backend.nextError;
      backend.nextError = null;
      if ((!error || /fetch/i.test(error.message)) && !backend.savedSales.some((sale) => sale.id === args.p_id)) backend.savedSales.push({ ownerId: backend.ownerId, id: args.p_id, at: args.p_sold_at, lines: args.p_lines, payments: args.p_payments });
      return { data: null, error };
    },
    from: (table: string) => {
      const ownerId = backend.ownerId;
      const rows = table === 'products'
        ? [{ id: `${ownerId}-product`, name: 'Rice', category: 'Rice', unit: 'sack', stock: 10 - backend.savedSales.filter((sale) => sale.ownerId === ownerId).reduce((sum, sale) => sum + sale.lines.reduce((count, line) => count + line.quantity, 0), 0), price: 3000, active: true }]
        : table === 'business_days'
          ? [{ id: `${ownerId}-day`, date: today(), status: 'open', opened_at: `${today()}T08:00:00Z`, closed_at: null }]
          : table === 'sales'
            ? backend.savedSales.filter((sale) => sale.ownerId === ownerId).map((sale) => ({ id: sale.id, created_at: sale.at, total: sale.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), cost: 0, has_cost_deficit: false, sale_lines: sale.lines.map((line) => ({ product_id: line.productId, product_name: 'Rice', quantity: line.quantity, unit_price: line.unitPrice, unit_cost: 0 })), payments: sale.payments }))
            : [];
      const query = { select: () => query, order: () => query, range: () => query, limit: () => query, then: (resolve: (value: { data: typeof rows; error: { message: string } | null }) => void) => {
        const error = table === 'sales' && backend.savedSales.length > 0 && backend.failRefreshOnce ? { message: 'Refresh failed' } : null;
        if (error) backend.failRefreshOnce = false;
        return Promise.resolve({ data: rows, error }).then(resolve);
      } };
      return query;
    }
  }
}));

import { businessDay, closeDay, createSale, isRetryableSyncError, online, products, refresh, resetAccountData, restoreOfflineAccount, retryQueuedSales, sales, syncQueuedSales, updateSale } from './store';

const productFor = (ownerId: string): Product => ({ id: `${ownerId}-product`, name: 'Rice', category: 'Rice', unit: 'sack', stock: 10, price: 3000, active: true });

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('stock-manager-queue'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  backend.ownerId = 'account-a'; backend.rpcCalls = []; backend.savedSales = []; backend.nextError = null; backend.failRefreshOnce = false;
  vi.stubGlobal('navigator', { onLine: false });
  resetAccountData('account-a');
  products.set([productFor('account-a')]);
  businessDay.set({ date: today(), status: 'open', openedAt: `${today()}T08:00:00Z` });
  online.set(false);
  await saveOfflineSnapshot({ ownerId: 'account-a', savedAt: new Date().toISOString(), products: [productFor('account-a')], businessDay: get(businessDay) });
});

describe('offline sale recovery', () => {
  it('does not confirm a sale when durable browser storage fails', async () => {
    const workingDatabase = indexedDB;
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('Disk unavailable'); } });
    try {
      await expect(createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }])).rejects.toThrow('Disk unavailable');
      expect(get(sales)).toEqual([]);
      expect(get(products)[0].stock).toBe(10);
    } finally { vi.stubGlobal('indexedDB', workingDatabase); }
  });

  it('restores a sale after an app restart and uploads it only once', async () => {
    const id = await createSale([{ productId: 'account-a-product', quantity: 2, unitPrice: 3000 }], [{ method: 'cash', amount: 6000 }]);
    expect(backend.rpcCalls).toEqual([]);
    expect((await queuedSalesFor('account-a')).map((entry) => entry.id)).toEqual([id]);

    resetAccountData('account-a'); // Simulates memory lost on a full restart.
    await restoreOfflineAccount('account-a');
    expect(get(products)[0].stock).toBe(8);
    expect(get(sales)).toMatchObject([{ id, sync: 'queued' }]);

    vi.stubGlobal('navigator', { onLine: true }); online.set(true);
    await syncQueuedSales();
    expect(backend.rpcCalls).toEqual([{ ownerId: 'account-a', id }]);
    expect(await queuedSalesFor('account-a')).toEqual([]);
    expect(get(sales)).toMatchObject([{ id, sync: 'synced' }]);
    await syncQueuedSales();
    expect(backend.rpcCalls).toHaveLength(1);
  });

  it('keeps a sale if the server committed it but its acknowledgement was lost', async () => {
    const id = await createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }]);
    backend.nextError = { message: 'Failed to fetch', code: '' };
    vi.stubGlobal('navigator', { onLine: true }); online.set(true);
    await syncQueuedSales();
    expect((await queuedSalesFor('account-a')).map((entry) => entry.id)).toEqual([id]);
    await syncQueuedSales();
    expect(backend.savedSales.filter((sale) => sale.id === id)).toHaveLength(1);
    expect(await queuedSalesFor('account-a')).toEqual([]);
  });

  it('does not ask the cashier to repeat a committed sale when the following refresh fails', async () => {
    vi.stubGlobal('navigator', { onLine: true }); online.set(true);
    backend.failRefreshOnce = true;
    const id = await createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }]);
    expect(backend.savedSales.filter((sale) => sale.id === id)).toHaveLength(1);
    expect(await queuedSalesFor('account-a')).toEqual([]);
    await refresh();
    expect(get(sales).filter((sale) => sale.id === id)).toHaveLength(1);
  });

  it('retains a rejected sale for review and never sends it under another account', async () => {
    const id = await createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }]);
    backend.nextError = { message: 'The original business day is closed', code: 'P0001' };
    vi.stubGlobal('navigator', { onLine: true }); online.set(true);
    await syncQueuedSales();
    expect(await queuedSalesFor('account-a')).toMatchObject([{ id, state: 'needs_attention' }]);
    expect(get(sales)[0]).toMatchObject({ sync: 'needs_attention', syncError: 'The original business day is closed' });

    backend.ownerId = 'account-b'; resetAccountData('account-b');
    await syncQueuedSales();
    expect(backend.rpcCalls).toHaveLength(1);
    expect(await queuedSalesFor('account-b')).toEqual([]);

    backend.ownerId = 'account-a'; resetAccountData('account-a');
    await restoreOfflineAccount('account-a');
    await retryQueuedSales();
    expect(backend.rpcCalls).toHaveLength(2);
  });

  it('blocks closing from the durable queue even when the in-memory sale list is empty', async () => {
    const id = await createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }]);
    sales.set([]);
    await expect(closeDay(0)).rejects.toThrow('Sync or reconcile all offline sales');
    expect((await queuedSalesFor('account-a')).map((entry) => entry.id)).toEqual([id]);
  });

  it('does not close a day if its offline queue cannot be read', async () => {
    const workingDatabase = indexedDB;
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('Disk unavailable'); } });
    try { await expect(closeDay(0)).rejects.toThrow('Disk unavailable'); }
    finally { vi.stubGlobal('indexedDB', workingDatabase); }
  });

  it('does not edit an unsynced sale or retry a business rejection automatically', async () => {
    const id = await createSale([{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }]);
    await expect(updateSale(id, [{ productId: 'account-a-product', quantity: 1, unitPrice: 3000 }], [{ method: 'cash', amount: 3000 }])).rejects.toThrow('Wait for this sale to sync');
    expect(isRetryableSyncError({ code: 'P0001', message: 'Day closed' })).toBe(false);
    expect(isRetryableSyncError({ code: 'PGRST202', message: 'RPC missing' })).toBe(true);
    expect(isRetryableSyncError({ code: '40001', message: 'Serialization conflict' })).toBe(true);
    expect(isRetryableSyncError({ code: '', message: 'Failed to fetch' })).toBe(true);
    expect(isRetryableSyncError({ code: '', message: 'Product not found' })).toBe(false);
  });
});
