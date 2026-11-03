import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { today } from './format';
import type { QueuedSale } from './saleQueue';

// Supabase and IndexedDB are both mocked: these tests never touch a real project or browser.
const backend = vi.hoisted(() => ({
  ownerId: 'account-a',
  tables: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code: string; message: string } | null }>>(),
  queue: new Map<string, QueuedSale>()
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: backend.ownerId } } }, error: null }) },
    rpc: (name: string, args: Record<string, unknown>) => backend.rpc(name, args),
    from: (table: string) => {
      const query = {
        select: () => query, order: () => query, range: () => query, limit: () => query,
        then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => void) => resolve({ data: backend.tables[table] ?? [], error: null })
      };
      return query;
    }
  }
}));

vi.mock('./saleQueue', () => ({
  queueAvailable: () => true,
  readQueuedSales: async () => [...backend.queue.values()].map((sale) => structuredClone(sale)),
  putQueuedSale: async (sale: QueuedSale) => { backend.queue.set(sale.id, structuredClone(sale)); },
  deleteQueuedSale: async (id: string) => { backend.queue.delete(id); }
}));

import { closeDay, createSale, discardQueuedSale, isRetryableSyncError, online, products, refresh, resetAccountData, retryQueuedSale, sales, syncQueuedSales } from './store';

const offline = { code: '', message: 'TypeError: Failed to fetch' };
const closedDay = { code: 'P0001', message: 'The business day for this queued sale (2026-01-01) is not open' };

function queued(id: string, at: string, overrides: Partial<QueuedSale> = {}): QueuedSale {
  return {
    id, at, total: 100, cost: 0, hasCostDeficit: true, source: 'supabase', sync: 'queued', ownerId: 'account-a',
    lines: [{ productId: 'rice', name: 'Rice', quantity: 2, unitPrice: 50, cost: 0 }],
    payments: [{ method: 'cash', amount: 100 }],
    ...overrides
  };
}

beforeEach(async () => {
  backend.ownerId = 'account-a';
  online.set(true);
  backend.queue.clear();
  backend.rpc.mockReset();
  backend.rpc.mockResolvedValue({ data: null, error: null });
  backend.tables = {
    products: [{ id: 'rice', name: 'Rice', category: 'Grain', unit: 'sack', stock: 10, price: 50, active: true }],
    business_days: [{ id: 'day', date: today(), status: 'open', opened_at: new Date().toISOString() }]
  };
  resetAccountData('account-a');
  await refresh();
});

describe('queued sales', () => {
  it('queues a sale on the device when the request never reaches Supabase', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: offline });

    const saleId = await createSale([{ productId: 'rice', quantity: 3, unitPrice: 50 }], [{ method: 'cash', amount: 150 }]);

    expect(backend.queue.get(saleId)).toMatchObject({ ownerId: 'account-a', sync: 'queued', total: 150 });
    expect(get(sales).find((sale) => sale.id === saleId)?.sync).toBe('queued');
    expect(get(products)[0].stock).toBe(7);
  });

  it('does not queue a sale the server rejected for a business reason', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'Not enough stock for Rice' } });

    await expect(createSale([{ productId: 'rice', quantity: 3, unitPrice: 50 }], [{ method: 'cash', amount: 150 }])).rejects.toMatchObject({ message: 'Not enough stock for Rice' });
    expect(backend.queue.size).toBe(0);
  });

  it('keeps queued sales visible and counted in stock after a reload', async () => {
    backend.queue.set('s1', queued('s1', new Date().toISOString()));
    backend.queue.set('s2', queued('s2', new Date().toISOString(), { sync: 'failed', syncError: 'Rejected' }));

    await refresh();

    expect(get(sales).map((sale) => [sale.id, sale.sync])).toEqual(expect.arrayContaining([['s1', 'queued'], ['s2', 'failed']]));
    // Only the sale still waiting reduces stock; the rejected one was never recorded.
    expect(get(products)[0].stock).toBe(8);
  });

  it('removes a queued copy once the server already has that sale', async () => {
    const at = new Date().toISOString();
    backend.queue.set('s1', queued('s1', at));
    backend.tables.sales = [{ id: 's1', created_at: at, sale_lines: [], payments: [], total: 100, cost: 60, has_cost_deficit: false }];

    await refresh();

    expect(backend.queue.size).toBe(0);
    expect(get(sales).filter((sale) => sale.id === 's1')).toHaveLength(1);
    expect(get(products)[0].stock).toBe(10);
  });

  it('syncs oldest first with the original sale time and keeps rejected sales for review', async () => {
    backend.queue.set('late', queued('late', '2026-01-02T10:00:00.000Z'));
    backend.queue.set('early', queued('early', '2026-01-01T10:00:00.000Z'));
    backend.rpc.mockResolvedValueOnce({ data: null, error: closedDay }).mockResolvedValueOnce({ data: null, error: null });

    const result = await syncQueuedSales();

    expect(backend.rpc.mock.calls.map(([, args]) => [args.p_id, args.p_sold_at])).toEqual([
      ['early', '2026-01-01T10:00:00.000Z'],
      ['late', '2026-01-02T10:00:00.000Z']
    ]);
    expect(result).toEqual({ synced: 1, rejected: 1, waiting: 0 });
    expect(backend.queue.get('early')).toMatchObject({ sync: 'failed', syncError: closedDay.message });
    expect(backend.queue.has('late')).toBe(false);
  });

  it('stops at a network failure and keeps the rest queued in order', async () => {
    backend.queue.set('a', queued('a', '2026-01-01T10:00:00.000Z'));
    backend.queue.set('b', queued('b', '2026-01-01T11:00:00.000Z'));
    backend.rpc.mockResolvedValueOnce({ data: null, error: offline });

    const result = await syncQueuedSales();

    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ synced: 0, rejected: 0, waiting: 2 });
    expect([...backend.queue.values()].map((sale) => sale.sync)).toEqual(['queued', 'queued']);
  });

  it('never sends another account’s sales, or untagged legacy sales', async () => {
    backend.queue.set('other', queued('other', '2026-01-01T10:00:00.000Z', { ownerId: 'account-b' }));
    backend.queue.set('legacy', queued('legacy', '2026-01-01T10:00:00.000Z', { ownerId: undefined }));

    await syncQueuedSales();
    await refresh();

    expect(backend.rpc).not.toHaveBeenCalled();
    expect(get(sales).map((sale) => sale.id)).toEqual(['legacy']);
    expect(get(sales)[0].sync).toBe('failed');
  });

  it('blocks closing while today’s queue is not empty, even before it is loaded', async () => {
    backend.queue.set('s1', queued('s1', new Date().toISOString()));

    await expect(closeDay(0)).rejects.toThrow('Sync all queued sales');
    backend.queue.set('s1', queued('s1', new Date().toISOString(), { sync: 'failed' }));
    await expect(closeDay(0)).rejects.toThrow('Review the rejected queued sales');
    expect(backend.rpc).not.toHaveBeenCalledWith('close_business_day', expect.anything());
  });

  it('retries a rejected sale and discards one that was handled by hand', async () => {
    backend.queue.set('r', queued('r', new Date().toISOString(), { sync: 'failed', syncError: 'Rejected' }));
    backend.queue.set('d', queued('d', new Date().toISOString(), { sync: 'failed', syncError: 'Rejected' }));
    await refresh();

    await expect(retryQueuedSale('r')).resolves.toMatchObject({ synced: 1 });
    expect(backend.queue.has('r')).toBe(false);

    await discardQueuedSale('d');
    expect(backend.queue.size).toBe(0);
    expect(get(sales).some((sale) => sale.id === 'd')).toBe(false);
  });

  it('classifies which errors are worth retrying', () => {
    expect(isRetryableSyncError(offline)).toBe(true);
    expect(isRetryableSyncError({ code: 'PGRST301' })).toBe(true);
    expect(isRetryableSyncError({ code: 'PGRST202' })).toBe(true);
    expect(isRetryableSyncError({ code: '08006' })).toBe(true);
    expect(isRetryableSyncError(closedDay)).toBe(false);
    expect(isRetryableSyncError({ code: '23514' })).toBe(false);
  });
});
