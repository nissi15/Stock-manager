import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const backend = vi.hoisted(() => ({
  ownerId: 'account-a',
  read: vi.fn<(table: string, ownerId: string) => Promise<{ data: Record<string, unknown>[]; error: null }>>()
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: backend.ownerId } } }, error: null }) },
    from: (table: string) => {
      const ownerId = backend.ownerId;
      const query = {
        select: () => query,
        order: () => query,
        range: () => query,
        limit: () => query,
        then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => void, reject: (reason: unknown) => void) =>
          backend.read(table, ownerId).then(resolve, reject)
      };
      return query;
    }
  }
}));

import { activities, businessDay, expenses, products, refresh, resetAccountData, sales, stockEntries, stockLosses } from './store';

const rowsFor = (table: string, ownerId: string) => ({
  data: table === 'products'
    ? [{ id: `${ownerId}-product`, name: ownerId, category: 'Rice', unit: 'bag', stock: 1, price: 10, active: true }]
    : table === 'business_days' && ownerId === 'account-a'
      ? [{ id: 'a-day', date: '2026-10-19', status: 'open', opened_at: '2026-10-19T08:00:00Z', closed_at: null }]
      : [],
  error: null as null
});

beforeEach(() => {
  backend.ownerId = 'account-a';
  backend.read.mockReset();
  backend.read.mockImplementation(async (table, ownerId) => rowsFor(table, ownerId));
  resetAccountData();
});

describe('account data isolation', () => {
  it('clears every account store immediately, including the last business day', async () => {
    resetAccountData('account-a');
    await refresh();
    expect(get(products)[0]?.id).toBe('account-a-product');
    expect(get(businessDay)?.date).toBe('2026-10-19');

    resetAccountData('account-b');
    expect([get(products), get(sales), get(stockEntries), get(expenses), get(stockLosses), get(activities)])
      .toEqual([[], [], [], [], [], []]);
    expect(get(businessDay)).toBeNull();

    backend.ownerId = 'account-b';
    await refresh();
    expect(get(products).map((product) => product.id)).toEqual(['account-b-product']);
    expect(get(businessDay)).toBeNull();
  });

  it('discards a late response from the previous account', async () => {
    let releaseAccountA!: (value: ReturnType<typeof rowsFor>) => void;
    const slowAccountA = new Promise<ReturnType<typeof rowsFor>>((resolve) => { releaseAccountA = resolve; });
    backend.read.mockImplementation((table, ownerId) =>
      table === 'products' && ownerId === 'account-a'
        ? slowAccountA
        : Promise.resolve(rowsFor(table, ownerId))
    );

    resetAccountData('account-a');
    const pendingAccountA = refresh();
    await vi.waitFor(() => expect(backend.read).toHaveBeenCalledWith('products', 'account-a'));

    resetAccountData('account-b');
    backend.ownerId = 'account-b';
    await refresh();
    expect(get(products).map((product) => product.id)).toEqual(['account-b-product']);

    releaseAccountA(rowsFor('products', 'account-a'));
    await pendingAccountA;
    expect(get(products).map((product) => product.id)).toEqual(['account-b-product']);
  });
});
