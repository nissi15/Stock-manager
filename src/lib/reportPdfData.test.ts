import { describe, expect, it } from 'vitest';
import { paymentsForSales, productsSoldForReport, splitReportSales } from './reportPdfData';
import type { Product, Sale } from './types';

const products: Product[] = [
  { id: 'rice', name: 'Zahabu', category: 'Rice', unit: '25 kg sack', stock: 10, price: 50000, active: true },
  { id: 'oil', name: 'Zahabu', category: 'Oil', unit: '20 L jerrycan', stock: 10, price: 70000, active: true }
];

const sales: Sale[] = [
  {
    id: 'today-one', at: '2026-10-18T22:30:00Z',
    lines: [{ productId: 'rice', name: 'Zahabu', quantity: 2, unitPrice: 50000, cost: 60000 }],
    payments: [{ method: 'cash', amount: 40000 }, { method: 'momo', amount: 60000 }],
    total: 100000, cost: 60000, hasCostDeficit: false, source: 'demo', sync: 'synced'
  },
  {
    id: 'today-two', at: '2026-10-19T12:00:00Z',
    lines: [{ productId: 'oil', name: 'Zahabu', quantity: 3, unitPrice: 70000, cost: 150000 }],
    payments: [{ method: 'bank', amount: 210000 }],
    total: 210000, cost: 150000, hasCostDeficit: false, source: 'demo', sync: 'synced'
  },
  {
    id: 'tomorrow', at: '2026-10-19T22:30:00Z',
    lines: [{ productId: 'rice', name: 'Zahabu', quantity: 1, unitPrice: 50000, cost: 30000 }],
    payments: [{ method: 'cash', amount: 50000 }],
    total: 50000, cost: 30000, hasCostDeficit: false, source: 'demo', sync: 'synced'
  }
];

describe('report PDF data', () => {
  it('totals payments only from the sales selected for the report period', () => {
    expect(paymentsForSales(sales.slice(0, 2))).toEqual({ cash: 40000, momo: 60000, bank: 210000 });
  });

  it('groups sold units by product identity and distinguishes duplicate names', () => {
    expect(productsSoldForReport(sales.slice(0, 2), products)).toEqual([
      { label: 'Zahabu - 20 L jerrycan', units: 3 },
      { label: 'Zahabu - 25 kg sack', units: 2 }
    ]);
  });
});

describe('rejected offline sales in reports', () => {
  it('leaves a rejected sale out of the totals but keeps one that is still waiting to sync', () => {
    const mixed: Sale[] = [sales[0], { ...sales[1], id: 'waiting', sync: 'queued' }, { ...sales[2], id: 'rejected', sync: 'needs_attention', syncError: 'Not enough stock' }];
    const { counted, excluded } = splitReportSales(mixed);
    expect(counted.map((sale) => sale.id)).toEqual(['today-one', 'waiting']);
    expect(excluded.map((sale) => sale.id)).toEqual(['rejected']);
    expect(counted.reduce((sum, sale) => sum + sale.total, 0)).toBe(310000);
    expect(paymentsForSales(counted).cash).toBe(40000);
  });
});
