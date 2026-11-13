import type { PaymentMethod, Product, Sale } from './types';

// A rejected offline sale is not on the server, so reports leave it out until it syncs.
// A sale still waiting to sync is a real sale and stays in.
export function splitReportSales(sales: Sale[]) {
  return { counted: sales.filter((sale) => sale.sync !== 'needs_attention'), excluded: sales.filter((sale) => sale.sync === 'needs_attention') };
}

export function paymentsForSales(sales: Sale[]): Record<PaymentMethod, number> {
  const totals: Record<PaymentMethod, number> = { cash: 0, momo: 0, bank: 0 };
  for (const sale of sales) {
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
