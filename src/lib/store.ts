import { get, writable } from 'svelte/store';
import type { Activity, BatchProfit, BusinessDay, DayClosingSnapshot, Expense, Product, Sale, StockEntry, CartLine, Payment, PaymentMethod, StockLoss, StockLossReason } from './types';
import { today } from './format';
import { supabase } from './supabase';
import { generateDemoScenario } from './demoScenario';

export const isDemo = !supabase;
const demo = isDemo ? generateDemoScenario() : null;
export const products = writable<Product[]>(demo?.products ?? []);
export const sales = writable<Sale[]>(demo?.sales ?? []);
export const stockEntries = writable<StockEntry[]>(demo?.stockEntries ?? []);
export const expenses = writable<Expense[]>(demo?.expenses ?? []);
export const stockLosses = writable<StockLoss[]>(demo?.stockLosses ?? []);
export const activities = writable<Activity[]>(demo?.activities ?? []);
export const businessDay = writable<BusinessDay | null>(demo?.businessDay ?? null);
export const ready = writable(false);
export const online = writable(typeof navigator === 'undefined' ? true : navigator.onLine);
const key = 'stock-manager-demo-v3';
const id = () => crypto.randomUUID();
const audit = (action: string, detail: string) => activities.update((all) => [{ id: id(), at: new Date().toISOString(), action, detail }, ...all]);
const localDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(value));

export function initStore() {
  if (typeof window === 'undefined' || get(ready)) return;
  const saved = localStorage.getItem(key);
  if (saved && isDemo) {
    try {
      const data = JSON.parse(saved);
      products.set(data.products ?? demo?.products ?? []);
      sales.set(data.sales ?? []);
      stockEntries.set(data.stockEntries ?? []);
      expenses.set(data.expenses ?? []);
      stockLosses.set(data.stockLosses ?? []);
      activities.set(data.activities ?? []);
      businessDay.set(data.businessDay ?? null);
    } catch { /* A corrupt demo cache starts fresh. */ }
  }
  if (isDemo) {
    reconcileDemoLedger();
    for (const store of [products, sales, stockEntries, expenses, stockLosses, activities, businessDay]) store.subscribe(persist);
  }
  window.addEventListener('online', () => { online.set(true); void syncQueuedSales(); });
  window.addEventListener('offline', () => online.set(false));
  ready.set(true);
  if (isDemo) persist();
}

function persist() {
  if (!isDemo || typeof localStorage === 'undefined' || !get(ready)) return;
  localStorage.setItem(key, JSON.stringify({ products: get(products), sales: get(sales), stockEntries: get(stockEntries), expenses: get(expenses), stockLosses: get(stockLosses), activities: get(activities), businessDay: get(businessDay) }));
}

function reconcileDemoLedger() {
  if (!isDemo) return;
  const batches = get(stockEntries).map((entry) => ({ ...entry, remaining: entry.quantity }))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id));
  const revisedSales = get(sales).map((sale) => ({ ...sale, lines: sale.lines.map((line) => ({ ...line })) }));
  const revisedLosses = get(stockLosses).map((loss) => ({ ...loss }));
  const events = [
    ...revisedSales.map((sale) => ({ type: 'sale' as const, at: sale.at, sale })),
    ...revisedLosses.map((loss) => ({ type: 'loss' as const, at: loss.at, loss }))
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const allocate = (productId: string, quantity: number, at: string) => {
    let needed = quantity;
    let cost = 0;
    for (const batch of batches) {
      if (needed <= 0) break;
      if (batch.productId !== productId || batch.remaining <= 0 || new Date(batch.at) > new Date(at)) continue;
      const used = Math.min(needed, batch.remaining);
      batch.remaining -= used;
      needed -= used;
      cost += used * batch.unitCost;
    }
    return { cost, missing: needed };
  };

  for (const event of events) {
    if (event.type === 'sale') {
      let saleCost = 0;
      let hasCostDeficit = false;
      event.sale.lines = event.sale.lines.map((line) => {
        const allocation = allocate(line.productId, line.quantity, event.at);
        saleCost += allocation.cost;
        hasCostDeficit ||= allocation.missing > 0;
        return { ...line, cost: allocation.cost };
      });
      event.sale.cost = saleCost;
      event.sale.hasCostDeficit = hasCostDeficit;
    } else {
      const allocation = allocate(event.loss.productId, event.loss.quantity, event.at);
      event.loss.cost = allocation.cost;
    }
  }

  const remainingById = new Map(batches.map((batch) => [batch.id, batch.remaining]));
  sales.set(revisedSales);
  stockLosses.set(revisedLosses);
  stockEntries.update((all) => all.map((entry) => ({ ...entry, remaining: remainingById.get(entry.id) ?? entry.remaining })));
}

let activeAccountId: string | null = null;
let refreshGeneration = 0;

export function resetAccountData(accountId: string | null = null) {
  if (!supabase) return;
  activeAccountId = accountId;
  refreshGeneration += 1;
  products.set([]);
  sales.set([]);
  stockEntries.set([]);
  expenses.set([]);
  stockLosses.set([]);
  activities.set([]);
  businessDay.set(null);
}

export async function refresh() {
  if (!supabase) return;
  const db = supabase;
  const startedGeneration = refreshGeneration;
  const { data: sessionData, error: sessionError } = await db.auth.getSession();
  if (startedGeneration !== refreshGeneration) return;
  if (sessionError) throw sessionError;
  const accountId = sessionData.session?.user.id ?? null;
  if (!accountId) {
    resetAccountData();
    return;
  }
  if (activeAccountId !== accountId) resetAccountData(accountId);
  const requestGeneration = ++refreshGeneration;
  // PostgREST can cap a single response independently of the requested range.
  // Walk in small pages so reports and closing previews never silently stop at 500 rows.
  const allRows = async (table: 'sales' | 'expenses' | 'activity_logs' | 'stock_batches' | 'stock_losses', columns: string, order: string) => {
    const pageSize = 250;
    const rows: Record<string, any>[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.from(table).select(columns).order(order, { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data?.length ?? 0) < pageSize) return { data: rows, error: null };
    }
  };
  const [p, s, e, a, d, b, l, c] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    allRows('sales', '*, sale_lines(*), payments(*)', 'created_at'),
    allRows('expenses', '*', 'created_at'),
    allRows('activity_logs', '*', 'created_at'),
    supabase.from('business_days').select('*').order('date', { ascending: false }).limit(1),
    allRows('stock_batches', '*, products(name)', 'received_at'),
    allRows('stock_losses', '*, products(name,unit)', 'created_at'),
    supabase.from('business_day_closings').select('id,day_id,closed_at,snapshot').order('closed_at', { ascending: false }).limit(20)
  ]);
  if (requestGeneration !== refreshGeneration || activeAccountId !== accountId) return;
  if (p.error) throw p.error;
  if (s.error) throw s.error;
  if (e.error) throw e.error;
  if (a.error) throw a.error;
  if (d.error) throw d.error;
  if (b.error) throw b.error;
  if (l.error) throw l.error;
  if (c.error) throw c.error;
  products.set((p.data ?? []).map((row) => ({ id: row.id, name: row.name, category: row.category, unit: row.unit, stock: row.stock, price: row.price, active: row.active })));
  sales.set((s.data ?? []).map((row) => ({ id: row.id, at: row.created_at, lines: (row.sale_lines ?? []).map((line: Record<string, unknown>) => ({ productId: line.product_id, name: line.product_name, quantity: line.quantity, unitPrice: line.unit_price, cost: line.unit_cost })), payments: (row.payments ?? []).map((payment: Record<string, unknown>) => ({ method: payment.method, amount: payment.amount })), total: row.total, cost: row.cost, hasCostDeficit: row.has_cost_deficit, source: 'supabase', sync: 'synced' })) as Sale[]);
  expenses.set((e.data ?? []).map((row) => ({ id: row.id, at: row.created_at, category: row.category, description: row.description, amount: row.amount, method: row.method })));
  activities.set((a.data ?? []).map((row) => ({ id: row.id, at: row.created_at, action: row.action, detail: row.detail })));
  if (d.data?.[0]) {
    const row = d.data[0];
    const closingRow = (c.data ?? []).find((entry) => entry.day_id === row.id);
    businessDay.set({ date: row.date, status: row.status, openedAt: row.opened_at, closedAt: row.closed_at, closing: closingRow ? parseClosingSnapshot({ ...closingRow.snapshot, id: closingRow.id }) : undefined });
  } else businessDay.set(null);
  stockEntries.set((b.data ?? []).map((row) => ({ id: row.id, at: row.received_at, productId: row.product_id, productName: row.products?.name ?? '', quantity: row.quantity, remaining: row.remaining, unitCost: row.unit_cost, supplier: row.supplier, paid: row.paid, note: row.note })));
  stockLosses.set((l.data ?? []).map((row) => ({ id: row.id, at: row.created_at, productId: row.product_id, productName: row.products?.name ?? '', unit: row.products?.unit ?? '', quantity: row.quantity, cost: row.cost, reason: row.reason, note: row.note })) as StockLoss[]);
}

export async function loadBatchProfitReport(from: string, to: string): Promise<BatchProfit[]> {
  if (supabase) {
    const { data, error } = await supabase.rpc('get_stock_batch_report', { p_from: from || null, p_to: to || null });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: String(row.batch_id), at: String(row.received_at), productId: String(row.product_id),
      productName: String(row.product_name), category: String(row.category), unit: String(row.unit),
      quantityReceived: Number(row.quantity_received), quantitySold: Number(row.quantity_sold),
      quantityLost: Number(row.quantity_lost), quantityUntracked: Number(row.quantity_untracked),
      quantityRemaining: Number(row.quantity_remaining), unitCost: Number(row.unit_cost),
      salesRevenue: Number(row.sales_revenue), costOfGoods: Number(row.cost_of_goods),
      stockLossCost: Number(row.stock_loss_cost),
      realizedContribution: row.realized_contribution === null ? null : Number(row.realized_contribution),
      status: String(row.status) as BatchProfit['status']
    }));
  }

  const catalog = get(products);
  const batches = get(stockEntries).map((entry) => ({
    entry,
    available: entry.quantity,
    sold: 0,
    lost: 0,
    revenue: 0,
    cost: 0,
    lossCost: 0
  })).sort((a, b) => new Date(a.entry.at).getTime() - new Date(b.entry.at).getTime() || a.entry.id.localeCompare(b.entry.id));
  const events = [
    ...get(sales).map((sale) => ({ type: 'sale' as const, at: sale.at, sale })),
    ...get(stockLosses).map((loss) => ({ type: 'loss' as const, at: loss.at, loss }))
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const localDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(value));
  const isInRange = (value: string) => (!from || localDate(value) >= from) && (!to || localDate(value) <= to);

  for (const event of events) {
    const countInReport = isInRange(event.at);
    const allocations = event.type === 'sale'
      ? event.sale.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitPrice: line.unitPrice, loss: false }))
      : [{ productId: event.loss.productId, quantity: event.loss.quantity, unitPrice: 0, loss: true }];
    for (const allocation of allocations) {
      let needed = allocation.quantity;
      for (const batch of batches) {
        if (!needed) break;
        if (batch.entry.productId !== allocation.productId || batch.available <= 0 || new Date(batch.entry.at) > new Date(event.at)) continue;
        const used = Math.min(needed, batch.available);
        batch.available -= used;
        needed -= used;
        if (!countInReport) continue;
        if (allocation.loss) {
          batch.lost += used;
          batch.lossCost += used * batch.entry.unitCost;
        } else {
          batch.sold += used;
          batch.revenue += used * allocation.unitPrice;
          batch.cost += used * batch.entry.unitCost;
        }
      }
    }
  }

  return batches
    .filter(({ entry, sold, lost }) => isInRange(entry.at) || sold > 0 || lost > 0)
    .map(({ entry, available, sold, lost, revenue, cost, lossCost }) => {
      const product = catalog.find((item) => item.id === entry.productId);
      return {
        id: entry.id, at: entry.at, productId: entry.productId, productName: entry.productName,
        category: product?.category ?? '', unit: product?.unit ?? '', quantityReceived: entry.quantity,
        quantitySold: sold, quantityLost: lost, quantityUntracked: 0, quantityRemaining: available,
        unitCost: entry.unitCost, salesRevenue: revenue, costOfGoods: cost, stockLossCost: lossCost,
        realizedContribution: revenue - cost - lossCost,
        status: available === 0 ? 'Finished' as const : 'Open' as const
      };
    }).toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || b.id.localeCompare(a.id));
}

export async function openDay(prices: Record<string, number>) {
  const date = today();
  if (supabase) {
    const { error } = await supabase.rpc('open_business_day', { p_date: date, p_prices: prices });
    if (error) throw error;
    await refresh();
  } else {
    products.update((all) => all.map((p) => ({ ...p, price: prices[p.id] ?? p.price })));
    businessDay.set({ date, status: 'open', openedAt: new Date().toISOString() });
    audit('Day opened', `Selling prices confirmed for ${date}`);
  }
}

export async function updateDailyPrices(prices: Record<string, number>) {
  const active = get(products).filter((product) => product.active);
  if (active.some((product) => !Number.isFinite(prices[product.id]) || prices[product.id] < 0)) throw new Error('Every active product needs a valid price.');
  if (supabase) {
    const { error } = await supabase.rpc('update_daily_prices', { p_prices: prices });
    if (error) throw error;
    await refresh();
  } else {
    products.update((all) => all.map((product) => ({ ...product, price: prices[product.id] ?? product.price })));
    audit('Daily prices updated', `${active.length} product prices confirmed for ${today()}`);
  }
}

export function getClosingPreview(countedCash?: number): DayClosingSnapshot {
  const day = get(businessDay);
  const date = day?.date ?? today();
  const daySales = get(sales).filter((sale) => localDate(sale.at) === date);
  const dayExpenses = get(expenses).filter((expense) => localDate(expense.at) === date);
  const dayLosses = get(stockLosses).filter((loss) => localDate(loss.at) === date);
  const payments: Record<PaymentMethod, number> = { cash: 0, momo: 0, bank: 0 };
  for (const entry of daySales.flatMap((sale) => sale.payments)) payments[entry.method] += entry.amount;
  const salesRevenue = daySales.reduce((sum, sale) => sum + sale.total, 0);
  const costOfGoods = daySales.reduce((sum, sale) => sum + sale.cost, 0);
  const expenseTotal = dayExpenses.reduce((sum, expense) => sum + expense.amount, 0);
  const stockLossTotal = dayLosses.reduce((sum, loss) => sum + loss.cost, 0);
  const expectedCash = payments.cash - dayExpenses.filter((expense) => expense.method === 'cash').reduce((sum, expense) => sum + expense.amount, 0);
  const physicalCash = countedCash === undefined ? expectedCash : Math.round(countedCash);
  return {
    date,
    openedAt: day?.openedAt ?? new Date().toISOString(),
    closedAt: new Date().toISOString(),
    salesCount: daySales.length,
    unitsSold: daySales.flatMap((sale) => sale.lines).reduce((sum, line) => sum + line.quantity, 0),
    salesRevenue,
    costOfGoods,
    grossProfit: salesRevenue - costOfGoods,
    expenseTotal,
    stockLossTotal,
    netProfit: salesRevenue - costOfGoods - expenseTotal - stockLossTotal,
    payments,
    expectedCash,
    countedCash: physicalCash,
    cashDifference: physicalCash - expectedCash,
    stockRemaining: get(products).filter((product) => product.active).map((product) => ({ productId: product.id, name: product.name, category: product.category, unit: product.unit, quantity: product.stock })).toSorted((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit))
  };
}

function parseClosingSnapshot(value: Record<string, unknown>): DayClosingSnapshot {
  const payments = value.payments as Record<string, unknown> | undefined;
  const stock = Array.isArray(value.stockRemaining) ? value.stockRemaining : [];
  return {
    id: value.id ? String(value.id) : undefined,
    date: String(value.date), openedAt: String(value.openedAt), closedAt: String(value.closedAt),
    salesCount: Number(value.salesCount), unitsSold: Number(value.unitsSold), salesRevenue: Number(value.salesRevenue),
    costOfGoods: Number(value.costOfGoods), grossProfit: Number(value.grossProfit), expenseTotal: Number(value.expenseTotal),
    stockLossTotal: Number(value.stockLossTotal), netProfit: Number(value.netProfit),
    payments: { cash: Number(payments?.cash ?? 0), momo: Number(payments?.momo ?? 0), bank: Number(payments?.bank ?? 0) },
    expectedCash: Number(value.expectedCash), countedCash: Number(value.countedCash), cashDifference: Number(value.cashDifference),
    stockRemaining: stock.map((item) => { const row = item as Record<string, unknown>; return { productId: String(row.productId), name: String(row.name), category: String(row.category), unit: String(row.unit), quantity: Number(row.quantity) }; })
  };
}

export async function closeDay(countedCash = getClosingPreview().expectedCash): Promise<DayClosingSnapshot> {
  const closingDate = get(businessDay)?.date ?? today();
  if (!Number.isFinite(countedCash) || countedCash < 0) throw new Error('Counted cash must be zero or more.');
  if (get(sales).some((sale) => sale.sync === 'queued' && localDate(sale.at) === closingDate)) throw new Error('Sync all queued sales before closing the day.');
  if (get(sales).some((sale) => sale.hasCostDeficit && localDate(sale.at) === closingDate)) throw new Error('Resolve uncosted stock deficits before closing the day.');
  if (supabase) {
    const { data, error } = await supabase.rpc('close_business_day', { p_counted_cash: Math.round(countedCash) });
    if (error) throw error;
    const snapshot = parseClosingSnapshot(data as Record<string, unknown>);
    await refresh();
    return snapshot;
  }
  const snapshot = getClosingPreview(countedCash);
  businessDay.update((day) => day ? { ...day, status: 'closed', closedAt: snapshot.closedAt, closing: snapshot } : day);
  audit('Day closed', `${snapshot.date} · ${snapshot.salesCount} sales · Cash difference RWF ${snapshot.cashDifference.toLocaleString()}`);
  return snapshot;
}

export async function reopenDay(reason: string) {
  if (!reason.trim()) throw new Error('A reason is required to reopen the day.');
  if (supabase) { const { error } = await supabase.rpc('reopen_business_day', { p_reason: reason.trim() }); if (error) throw error; await refresh(); }
  else { businessDay.update((day) => day?.date === today() && day.status === 'closed' ? { ...day, status: 'open', closedAt: undefined } : day); audit('Day reopened', reason.trim()); }
}

export async function createSale(lines: CartLine[], payments: Payment[]) {
  const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  if (!get(businessDay) || get(businessDay)?.status !== 'open') throw new Error('Open the business day before selling.');
  if (!lines.length || lines.some((l) => l.quantity <= 0 || l.unitPrice < 0)) throw new Error('Check the sale items.');
  const catalog = get(products);
  const unavailable = lines.find((line) => line.quantity > (catalog.find((product) => product.id === line.productId)?.stock ?? 0));
  if (unavailable) throw new Error(`Not enough stock for ${catalog.find((product) => product.id === unavailable.productId)?.name ?? 'this product'}.`);
  if (payments.reduce((sum, p) => sum + p.amount, 0) !== total) throw new Error('Payments must equal the sale total.');
  const saleId = id();
  if (supabase && get(online)) {
    const { error } = await supabase.rpc('record_sale', { p_id: saleId, p_lines: lines, p_payments: payments });
    if (error) throw error;
    await refresh();
    return saleId;
  }
  const resolved = lines.map((line) => ({ ...line, name: catalog.find((p) => p.id === line.productId)?.name ?? 'Unknown', cost: 0 }));
  const sale: Sale = { id: saleId, at: new Date().toISOString(), lines: resolved, payments, total, cost: 0, hasCostDeficit: true, source: isDemo ? 'demo' : 'supabase', sync: isDemo ? 'synced' : 'queued' };
  sales.update((all) => [sale, ...all]);
  products.update((all) => all.map((p) => ({ ...p, stock: p.stock - (lines.find((l) => l.productId === p.id)?.quantity ?? 0) })));
  reconcileDemoLedger();
  audit('Sale completed', `${saleId.slice(0, 8)} · RWF ${total.toLocaleString()}`);
  if (!isDemo) await queueSale(sale);
  return saleId;
}

export async function updateSale(saleId: string, lines: CartLine[], payments: Payment[]) {
  const original = get(sales).find((sale) => sale.id === saleId);
  if (!original) throw new Error('Sale not found.');
  const saleDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(original.at));
  if (saleDate !== today() || get(businessDay)?.status !== 'open') throw new Error('Only sales from the open business day can be edited.');
  if (!lines.length || lines.some((line) => line.quantity <= 0 || line.unitPrice < 0)) throw new Error('Check the sale items.');
  const catalog = get(products);
  const unavailable = lines.find((line) => {
    const before = original.lines.find((entry) => entry.productId === line.productId)?.quantity ?? 0;
    const available = catalog.find((product) => product.id === line.productId)?.stock ?? 0;
    return line.quantity - before > available;
  });
  if (unavailable) throw new Error(`Not enough stock for ${catalog.find((product) => product.id === unavailable.productId)?.name ?? 'this product'}.`);
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  if (payments.reduce((sum, payment) => sum + payment.amount, 0) !== total) throw new Error('Payments must equal the sale total.');
  if (supabase) {
    const { error } = await supabase.rpc('edit_sale', { p_sale_id: saleId, p_lines: lines, p_payments: payments });
    if (error) throw error;
    await refresh();
    return;
  }
  const oldQuantity = new Map(original.lines.map((line) => [line.productId, line.quantity]));
  products.update((all) => all.map((product) => {
    const before = oldQuantity.get(product.id) ?? 0;
    const after = lines.find((line) => line.productId === product.id)?.quantity ?? 0;
    return { ...product, stock: product.stock + before - after };
  }));
  const resolved = lines.map((line) => {
    const oldLine = original.lines.find((entry) => entry.productId === line.productId);
    return { ...line, name: oldLine?.name ?? get(products).find((product) => product.id === line.productId)?.name ?? 'Unknown', cost: oldLine ? Math.round(oldLine.cost * line.quantity / oldLine.quantity) : 0 };
  });
  const cost = resolved.reduce((sum, line) => sum + line.cost, 0);
  sales.update((all) => all.map((sale) => sale.id === saleId ? { ...sale, lines: resolved, payments, total, cost } : sale));
  reconcileDemoLedger();
  audit('Sale edited', `${saleId.slice(0, 8)} · RWF ${total.toLocaleString()}`);
}

export async function addStock(input: { productId: string; quantity: number; unitCost: number; supplier: string; paid: number; note: string }) {
  if (get(businessDay)?.date === today() && get(businessDay)?.status === 'closed') throw new Error('Reopen the business day before receiving stock.');
  if (input.quantity <= 0 || input.unitCost < 0 || input.paid < 0 || input.paid > input.quantity * input.unitCost) throw new Error('Check stock quantity, cost and payment.');
  if (supabase) { const { error } = await supabase.rpc('receive_stock', { p_product_id: input.productId, p_quantity: input.quantity, p_unit_cost: input.unitCost, p_supplier: input.supplier, p_paid: input.paid, p_note: input.note }); if (error) throw error; await refresh(); return; }
  const product = get(products).find((p) => p.id === input.productId);
  stockEntries.update((all) => [{ id: id(), at: new Date().toISOString(), productName: product?.name ?? '', remaining: input.quantity, ...input }, ...all]);
  products.update((all) => all.map((p) => p.id === input.productId ? { ...p, stock: p.stock + input.quantity } : p));
  audit('Stock received', `${input.quantity} × ${product?.name} from ${input.supplier || 'unspecified supplier'}`);
}

export async function addProduct(input: Pick<Product, 'name' | 'category' | 'unit' | 'price'>) {
  if (!input.name.trim() || !input.category.trim()) throw new Error('Name and category are required.');
  if (supabase) { const { error } = await supabase.rpc('create_product', { p_name: input.name, p_category: input.category, p_unit: input.unit, p_price: input.price }); if (error) throw error; await refresh(); return; }
  products.update((all) => [...all, { ...input, id: id(), stock: 0, active: true }]);
  audit('Product created', input.name);
}

export async function addExpense(input: Omit<Expense, 'id' | 'at'>) {
  if (get(businessDay)?.date === today() && get(businessDay)?.status === 'closed') throw new Error('Reopen the business day before recording an expense.');
  if (input.amount <= 0) throw new Error('Enter an amount greater than zero.');
  if (supabase) { const { error } = await supabase.from('expenses').insert(input); if (error) throw error; await refresh(); return; }
  expenses.update((all) => [{ ...input, id: id(), at: new Date().toISOString() }, ...all]);
  audit('Expense recorded', `${input.category} · RWF ${input.amount.toLocaleString()}`);
}

export async function recordStockLoss(input: { productId: string; quantity: number; reason: StockLossReason; note: string }) {
  if (get(businessDay)?.date === today() && get(businessDay)?.status === 'closed') throw new Error('Reopen the business day before recording stock damage or loss.');
  const product = get(products).find((entry) => entry.id === input.productId);
  if (!product) throw new Error('Choose a product.');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error('Enter a whole quantity greater than zero.');
  if (input.quantity > product.stock) throw new Error(`Only ${product.stock} ${product.unit} available.`);
  if (!['Damaged', 'Expired', 'Stolen', 'Missing', 'Other'].includes(input.reason)) throw new Error('Choose a valid loss reason.');
  if (supabase) {
    const { error } = await supabase.rpc('record_stock_loss', { p_product_id: input.productId, p_quantity: input.quantity, p_reason: input.reason, p_note: input.note });
    if (error) throw error;
    await refresh();
    return;
  }
  let needed = input.quantity;
  let cost = 0;
  const usage = new Map<string, number>();
  for (const batch of get(stockEntries).filter((entry) => entry.productId === input.productId && entry.remaining > 0).toSorted((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id))) {
    const used = Math.min(needed, batch.remaining);
    if (!used) continue;
    usage.set(batch.id, used);
    cost += used * batch.unitCost;
    needed -= used;
    if (!needed) break;
  }
  if (needed) throw new Error(`Missing purchase cost for ${product.name}.`);
  stockEntries.update((all) => all.map((entry) => usage.has(entry.id) ? { ...entry, remaining: entry.remaining - (usage.get(entry.id) ?? 0) } : entry));
  products.update((all) => all.map((entry) => entry.id === input.productId ? { ...entry, stock: entry.stock - input.quantity } : entry));
  stockLosses.update((all) => [{ id: id(), at: new Date().toISOString(), productId: product.id, productName: product.name, unit: product.unit, quantity: input.quantity, cost, reason: input.reason, note: input.note.trim() }, ...all]);
  audit('Stock loss recorded', `${input.quantity} × ${product.name} · ${input.reason} · RWF ${cost.toLocaleString()}`);
}

// IndexedDB keeps unsynced sales durable even if the tab closes.
async function queueSale(sale: Sale) {
  const db = await openQueue();
  const tx = db.transaction('sales', 'readwrite');
  tx.objectStore('sales').put(sale);
}
function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('stock-manager-queue', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sales', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function syncQueuedSales() {
  if (!supabase || !get(online)) return;
  const db = await openQueue();
  const queued = await new Promise<Sale[]>((resolve, reject) => { const req = db.transaction('sales').objectStore('sales').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  for (const sale of queued) {
    const { error } = await supabase.rpc('record_sale', { p_id: sale.id, p_lines: sale.lines.map(({ productId, quantity, unitPrice }) => ({ productId, quantity, unitPrice })), p_payments: sale.payments });
    if (error) break;
    db.transaction('sales', 'readwrite').objectStore('sales').delete(sale.id);
  }
  await refresh();
}
