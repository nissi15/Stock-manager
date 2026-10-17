import { describe, expect, it } from 'vitest';
import { generateDemoScenario } from './demoScenario';

const referenceDate = '2026-10-17';

describe('wholesale demo scenario', () => {
  const scenario = generateDemoScenario(referenceDate);

  it('includes the requested five categories and products', () => {
    expect([...new Set(scenario.products.map((product) => product.category))]).toEqual(['Rice', 'Oil', 'Soft drink', 'Salt', 'Soap']);
    expect(scenario.products.map((product) => `${product.category}: ${product.name}`)).toEqual([
      'Rice: Tanzanian', 'Rice: Zahabu', 'Rice: Pakistan',
      'Oil: Zahabu', 'Oil: Crystal',
      'Soft drink: Novida', 'Soft drink: Martin',
      'Salt: Salt', 'Soap: Jambo', 'Soap: Jama'
    ]);
  });

  it('has 19–30 stock, sale and expense operations on each of seven days', () => {
    const dailyCounts = new Map<string, number>();
    for (const activity of scenario.activities) {
      const day = activity.at.slice(0, 10);
      dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
    }
    const currentWeek = [...dailyCounts.entries()].filter(([date]) => date >= '2026-10-11' && date <= referenceDate).sort(([left], [right]) => left.localeCompare(right));
    expect(currentWeek.map(([, count]) => count)).toEqual([21, 24, 26, 22, 28, 25, 20]);
    expect(new Set(scenario.activities.map((activity) => activity.action))).toEqual(new Set(['Stock received', 'Sale completed', 'Expense recorded']));
  });

  it('receives opening stock for every product and reconciles remaining stock', () => {
    const openingReceipts = scenario.stockEntries.filter((entry) => entry.note === 'Opening stock');
    expect(new Set(openingReceipts.map((entry) => entry.productId))).toEqual(new Set(scenario.products.map((product) => product.id)));

    for (const product of scenario.products) {
      const received = scenario.stockEntries.filter((entry) => entry.productId === product.id).reduce((sum, entry) => sum + entry.quantity, 0);
      const sold = scenario.sales.flatMap((sale) => sale.lines).filter((line) => line.productId === product.id).reduce((sum, line) => sum + line.quantity, 0);
      expect(product.stock).toBe(received - sold);
      expect(product.stock).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps sale totals, purchase costs and mixed payment accounts consistent', () => {
    expect(scenario.sales.length).toBeGreaterThan(100);
    for (const sale of scenario.sales) {
      expect(sale.total).toBe(sale.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
      expect(sale.total).toBe(sale.payments.reduce((sum, payment) => sum + payment.amount, 0));
      expect(sale.cost).toBe(sale.lines.reduce((sum, line) => sum + line.cost, 0));
      expect(sale.hasCostDeficit).toBe(false);
    }
    expect(new Set(scenario.sales.flatMap((sale) => sale.payments.map((payment) => payment.method)))).toEqual(new Set(['cash', 'momo', 'bank']));
    expect(scenario.sales.some((sale) => sale.payments.length > 1)).toBe(true);
    expect(new Set(scenario.expenses.map((expense) => expense.method))).toEqual(new Set(['cash', 'momo', 'bank']));
  });

  it('is repeatable and leaves the current business day open', () => {
    expect(generateDemoScenario(referenceDate)).toEqual(scenario);
    expect(scenario.businessDay).toMatchObject({ date: referenceDate, status: 'open' });
  });
});
