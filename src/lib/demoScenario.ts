import { today } from './format';
import type { Activity, BusinessDay, Expense, Payment, Product, Sale, StockEntry, StockLoss } from './types';

const catalog = [
  { id: 'rice-tanzanian', name: 'Tanzanian', category: 'Rice', unit: '25 kg sack', price: 48000, unitCost: 37000, openingStock: 90 },
  { id: 'rice-zahabu', name: 'Zahabu', category: 'Rice', unit: '25 kg sack', price: 56000, unitCost: 43000, openingStock: 90 },
  { id: 'rice-pakistan', name: 'Pakistan', category: 'Rice', unit: '25 kg sack', price: 53000, unitCost: 41000, openingStock: 90 },
  { id: 'oil-zahabu', name: 'Zahabu', category: 'Oil', unit: '20 L jerrycan', price: 69000, unitCost: 54000, openingStock: 80 },
  { id: 'oil-crystal', name: 'Crystal', category: 'Oil', unit: '20 L jerrycan', price: 65000, unitCost: 51000, openingStock: 80 },
  { id: 'drink-novida', name: 'Novida', category: 'Soft drink', unit: 'crate', price: 18000, unitCost: 13500, openingStock: 140 },
  { id: 'drink-martin', name: 'Martin', category: 'Soft drink', unit: 'crate', price: 20000, unitCost: 15000, openingStock: 140 },
  { id: 'salt', name: 'Salt', category: 'Salt', unit: '25 kg sack', price: 15000, unitCost: 10500, openingStock: 100 },
  { id: 'soap-jambo', name: 'Jambo', category: 'Soap', unit: 'carton', price: 24000, unitCost: 18000, openingStock: 120 },
  { id: 'soap-jama', name: 'Jama', category: 'Soap', unit: 'carton', price: 22000, unitCost: 16500, openingStock: 120 }
] as const;

const dailyTargets = [21, 24, 26, 22, 28, 25, 20];
const suppliers = ['City wholesalers', 'Main depot', 'Regional supplier'];
const expenseKinds = [
  { category: 'Transport', description: 'Delivery van', amount: 12000 },
  { category: 'Wages', description: 'Daily loading team', amount: 15000 },
  { category: 'Utilities', description: 'Shop utilities', amount: 8000 },
  { category: 'Packaging', description: 'Packing materials', amount: 5000 }
] as const;

function dateOffset(referenceDate: string, offset: number) {
  const date = new Date(`${referenceDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function operationTime(date: string, index: number) {
  const hour = String(8 + Math.floor(index / 4)).padStart(2, '0');
  const minute = String((index % 4) * 12).padStart(2, '0');
  return `${date}T${hour}:${minute}:00.000Z`;
}

function paymentsForSale(total: number, index: number): Payment[] {
  if (index % 4 === 0) return [{ method: 'cash', amount: total }];
  if (index % 4 === 1) return [{ method: 'momo', amount: total }];
  if (index % 4 === 2) return [{ method: 'bank', amount: total }];
  const cash = Math.floor(total / 2);
  return [{ method: 'cash', amount: cash }, { method: 'momo', amount: total - cash }];
}

/** A deterministic, local-only week of wholesale activity. No database writes. */
export function generateDemoScenario(referenceDate = today()) {
  const products: Product[] = catalog.map((item) => ({ id: item.id, name: item.name, category: item.category, unit: item.unit, stock: 0, price: item.price, active: true }));
  const sales: Sale[] = [];
  const stockEntries: StockEntry[] = [];
  const expenses: Expense[] = [];
  const stockLosses: StockLoss[] = [];
  const activities: Activity[] = [];
  const batches = new Map<string, { remaining: number; unitCost: number }[]>(catalog.map((item) => [item.id, []]));
  let saleNumber = 0;

  function log(id: string, at: string, action: string, detail: string) {
    activities.unshift({ id: `activity-${id}`, at, action, detail });
  }

  function receive(item: (typeof catalog)[number], quantity: number, at: string, id: string, supplier: string) {
    const paid = Math.floor(quantity * item.unitCost * (id.startsWith('opening') ? 1 : 0.5));
    const entry: StockEntry = { id, at, productId: item.id, productName: item.name, quantity, remaining: quantity, unitCost: item.unitCost, supplier, paid, note: id.startsWith('opening') ? 'Opening stock' : 'Regular delivery' };
    stockEntries.unshift(entry);
    products.find((product) => product.id === item.id)!.stock += quantity;
    batches.get(item.id)!.push(entry);
    log(id, at, 'Stock received', `${quantity} × ${item.name} · ${item.category}`);
  }

  // Every listed product has a costed opening receipt before the seven-day period.
  const openingDate = dateOffset(referenceDate, -7);
  catalog.forEach((item, index) => receive(item, item.openingStock, operationTime(openingDate, index), `opening-${item.id}`, suppliers[index % suppliers.length]));

  for (let dayIndex = 0; dayIndex < dailyTargets.length; dayIndex += 1) {
    const date = dateOffset(referenceDate, dayIndex - 6);
    const target = dailyTargets[dayIndex];
    let receiptNumber = 0;
    let expenseNumber = 0;

    for (let operation = 0; operation < target; operation += 1) {
      const at = operationTime(date, operation);
      const id = `${dayIndex}-${operation}`;

      if (operation === 0 || operation === 8) {
        const item = catalog[(dayIndex * 2 + receiptNumber) % catalog.length];
        receive(item, 12 + (dayIndex % 4) * 4, at, `receipt-${id}`, suppliers[(dayIndex + receiptNumber) % suppliers.length]);
        receiptNumber += 1;
        continue;
      }

      if (operation === 5 || operation === target - 3) {
        const kind = expenseKinds[(dayIndex + expenseNumber) % expenseKinds.length];
        const method = expenseNumber === 0 ? 'cash' : dayIndex % 2 === 0 ? 'momo' : 'bank';
        expenses.unshift({ id: `expense-${id}`, at, category: kind.category, description: kind.description, amount: kind.amount, method });
        log(`expense-${id}`, at, 'Expense recorded', `${kind.category} · RWF ${kind.amount.toLocaleString()}`);
        expenseNumber += 1;
        continue;
      }

      const item = catalog[saleNumber % catalog.length];
      const quantity = 1 + (saleNumber % 3);
      const product = products.find((entry) => entry.id === item.id)!;
      if (product.stock < quantity) throw new Error(`Demo stock exhausted for ${item.name}`);
      product.stock -= quantity;
      let needed = quantity;
      let cost = 0;
      for (const batch of batches.get(item.id)!) {
        const used = Math.min(needed, batch.remaining);
        batch.remaining -= used;
        needed -= used;
        cost += used * batch.unitCost;
        if (!needed) break;
      }
      if (needed) throw new Error(`Demo purchase cost missing for ${item.name}`);
      const total = quantity * item.price;
      sales.unshift({ id: `demo-sale-${id}`, at, lines: [{ productId: item.id, name: item.name, quantity, unitPrice: item.price, cost }], payments: paymentsForSale(total, saleNumber), total, cost, hasCostDeficit: false, source: 'demo', sync: 'synced' });
      log(`sale-${id}`, at, 'Sale completed', `${quantity} × ${item.name} · RWF ${total.toLocaleString()}`);
      saleNumber += 1;
    }
  }

  const businessDay: BusinessDay = { date: referenceDate, status: 'open', openedAt: `${referenceDate}T07:00:00.000Z` };
  return { products, sales, stockEntries, expenses, stockLosses, activities, businessDay };
}
