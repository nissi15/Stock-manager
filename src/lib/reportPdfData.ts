import type { PaymentMethod, Product, Sale } from './types';

const businessDate = (value: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(value));

export function paymentsForDay(sales: Sale[], date: string): Record<PaymentMethod, number> {
  const totals: Record<PaymentMethod, number> = { cash: 0, momo: 0, bank: 0 };
  for (const sale of sales) {
    if (businessDate(sale.at) !== date) continue;
    for (const payment of sale.payments) totals[payment.method] += payment.amount;
  }
  return totals;
}

export function productsSoldForReport(sales: Sale[], products: Product[]) {
  const catalog = new Map(products.map((product) => [product.id, product]));
  const totals = new Map<string, { label: string; units: number }>();
  for (const sale of sales) {
    for (const line of sale.lines) {
      const product = catalog.get(line.productId);
      const label = product ? `${product.name} - ${product.unit}` : line.name;
      const previous = totals.get(line.productId);
      totals.set(line.productId, { label, units: (previous?.units ?? 0) + line.quantity });
    }
  }
  return [...totals.values()].sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));
}
