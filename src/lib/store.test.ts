import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Product } from './types';
import { today } from './format';

// Exercise the in-memory workflow only. Tests must never contact the live project.
vi.mock('./supabase', () => ({ supabase: null }));

import {
  activities, addExpense, addProduct, addStock, businessDay, closeDay,
  createSale, expenses, openDay, products, reopenDay, sales, stockEntries,
  updateDailyPrices, updateSale
} from './store';

const catalog: Product[] = [
  { id: 'rice', name: 'Bismati', category: 'Rice', unit: '25 kg sack', stock: 12, price: 50000, active: true },
  { id: 'sugar', name: 'Sugar', category: 'Sugar', unit: '50 kg sack', stock: 6, price: 40000, active: true }
];

beforeEach(() => {
  products.set(catalog.map((product) => ({ ...product })));
  sales.set([]);
  stockEntries.set([]);
  expenses.set([]);
  activities.set([]);
  businessDay.set(null);
});

describe('business day', () => {
  it('opens with the confirmed selling prices', async () => {
    await openDay({ rice: 55000, sugar: 42000 });

    expect(get(businessDay)).toMatchObject({ date: today(), status: 'open' });
    expect(get(products).map((product) => product.price)).toEqual([55000, 42000]);
    expect(get(activities)[0].action).toBe('Day opened');
  });

  it('requires a reason to reopen a closed day', async () => {
    await openDay({});
    await closeDay();

    await expect(reopenDay('  ')).rejects.toThrow('A reason is required');
    expect(get(businessDay)?.status).toBe('closed');

    await reopenDay('Corrected an expense');
    expect(get(businessDay)?.status).toBe('open');
    expect(get(activities)[0]).toMatchObject({ action: 'Day reopened', detail: 'Corrected an expense' });
  });

  it('updates selling prices during an open day', async () => {
    await openDay({ rice: 55000, sugar: 42000 });
    await updateDailyPrices({ rice: 57000, sugar: 43000 });

    expect(get(products).map((product) => product.price)).toEqual([57000, 43000]);
    expect(get(activities)[0].action).toBe('Daily prices updated');
  });
});

describe('inventory', () => {
  it('records a delivery, increases stock and keeps its cost details', async () => {
    await addStock({ productId: 'rice', quantity: 8, unitCost: 30000, supplier: 'Rice supplier', paid: 120000, note: 'Morning delivery' });

    expect(get(products).find((product) => product.id === 'rice')?.stock).toBe(20);
    expect(get(stockEntries)[0]).toMatchObject({ productName: 'Bismati', quantity: 8, unitCost: 30000, paid: 120000 });
    expect(get(activities)[0].action).toBe('Stock received');
  });

  it('rejects a stock payment greater than its total cost', async () => {
    await expect(addStock({ productId: 'rice', quantity: 2, unitCost: 10000, supplier: '', paid: 25000, note: '' })).rejects.toThrow('Check stock quantity, cost and payment');
    expect(get(stockEntries)).toHaveLength(0);
    expect(get(products)[0].stock).toBe(12);
  });

  it('creates a product with its category and zero opening stock', async () => {
    await addProduct({ name: 'Jasmine', category: 'Rice', unit: '25 kg sack', price: 60000 });
    expect(get(products).find((product) => product.name === 'Jasmine')).toMatchObject({ category: 'Rice', stock: 0, unit: '25 kg sack' });
  });

  it('allows one product name with different measurements', async () => {
    await addProduct({ name: 'Meru', category: 'Oil', unit: '5 L bottle', price: 18000 });
    await addProduct({ name: 'Meru', category: 'Oil', unit: '20 L jerrycan', price: 65000 });
    expect(get(products).filter((product) => product.name === 'Meru').map((product) => product.unit)).toEqual(['5 L bottle', '20 L jerrycan']);
  });
});

describe('sales and expenses', () => {
  it('requires an open business day and exact payment total', async () => {
    const lines = [{ productId: 'rice', quantity: 2, unitPrice: 55000 }];
    await expect(createSale(lines, [{ method: 'cash', amount: 110000 }])).rejects.toThrow('Open the business day');

    await openDay({});
    await expect(createSale(lines, [{ method: 'cash', amount: 100000 }])).rejects.toThrow('Payments must equal');
    expect(get(sales)).toHaveLength(0);
    expect(get(products)[0].stock).toBe(12);
  });

  it('does not allow a sale quantity above available stock', async () => {
    await openDay({});
    await expect(createSale(
      [{ productId: 'sugar', quantity: 7, unitPrice: 40000 }],
      [{ method: 'cash', amount: 280000 }]
    )).rejects.toThrow('Not enough stock for Sugar');
    expect(get(products).find((product) => product.id === 'sugar')?.stock).toBe(6);
    expect(get(sales)).toHaveLength(0);
  });

  it('reduces stock and records both payment accounts on a completed sale', async () => {
    await openDay({});
    const saleId = await createSale(
      [{ productId: 'rice', quantity: 2, unitPrice: 55000 }],
      [{ method: 'cash', amount: 60000 }, { method: 'momo', amount: 50000 }]
    );

    expect(get(products)[0].stock).toBe(10);
    expect(get(sales)[0]).toMatchObject({ id: saleId, total: 110000, sync: 'synced', payments: [{ method: 'cash', amount: 60000 }, { method: 'momo', amount: 50000 }] });
    expect(get(activities)[0].action).toBe('Sale completed');
  });

  it('corrects a same-day sale and reconciles stock and payments', async () => {
    await openDay({});
    const saleId = await createSale(
      [{ productId: 'rice', quantity: 2, unitPrice: 55000 }],
      [{ method: 'cash', amount: 110000 }]
    );

    await updateSale(
      saleId,
      [{ productId: 'rice', quantity: 3, unitPrice: 56000 }],
      [{ method: 'momo', amount: 168000 }]
    );

    expect(get(products)[0].stock).toBe(9);
    expect(get(sales)[0]).toMatchObject({ total: 168000, payments: [{ method: 'momo', amount: 168000 }] });
    expect(get(activities)[0].action).toBe('Sale edited');
  });

  it('rejects zero expenses and audits a valid expense', async () => {
    await expect(addExpense({ category: 'Transport', description: '', amount: 0, method: 'cash' })).rejects.toThrow('greater than zero');
    await addExpense({ category: 'Transport', description: 'Delivery van', amount: 15000, method: 'bank' });

    expect(get(expenses)[0]).toMatchObject({ amount: 15000, method: 'bank' });
    expect(get(activities)[0].action).toBe('Expense recorded');
  });
});
