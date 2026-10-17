import { get, writable } from 'svelte/store';
import type { Activity, BusinessDay, Expense, Product, Sale, StockEntry, CartLine, Payment } from './types';
import { today } from './format';
import { supabase } from './supabase';
import { generateDemoScenario } from './demoScenario';

export const isDemo = !supabase;
const demo = isDemo ? generateDemoScenario() : null;
export const products = writable<Product[]>(demo?.products ?? []);
export const sales = writable<Sale[]>(demo?.sales ?? []);
export const stockEntries = writable<StockEntry[]>(demo?.stockEntries ?? []);
export const expenses = writable<Expense[]>(demo?.expenses ?? []);
export const activities = writable<Activity[]>(demo?.activities ?? []);
export const businessDay = writable<BusinessDay | null>(demo?.businessDay ?? null);
export const ready = writable(false);
export const online = writable(typeof navigator === 'undefined' ? true : navigator.onLine);
const key = 'stock-manager-demo-v2';
const id = () => crypto.randomUUID();
const audit = (action: string, detail: string) => activities.update((all) => [{ id: id(), at: new Date().toISOString(), action, detail }, ...all]);

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
      activities.set(data.activities ?? []);
      businessDay.set(data.businessDay ?? null);
    } catch { /* A corrupt demo cache starts fresh. */ }
  }
  if (isDemo) {
    for (const store of [products, sales, stockEntries, expenses, activities, businessDay]) store.subscribe(persist);
  }
  window.addEventListener('online', () => { online.set(true); void syncQueuedSales(); });
  window.addEventListener('offline', () => online.set(false));
  ready.set(true);
}

function persist() {
  if (!isDemo || typeof localStorage === 'undefined' || !get(ready)) return;
  localStorage.setItem(key, JSON.stringify({ products: get(products), sales: get(sales), stockEntries: get(stockEntries), expenses: get(expenses), activities: get(activities), businessDay: get(businessDay) }));
}

export async function refresh() {
  if (!supabase) return;
  const [p, s, e, a, d, b] = await Promise.all([
    supabase.from('products').select('*').order('name'),
    supabase.from('sales').select('*, sale_lines(*), payments(*)').order('created_at', { ascending: false }).limit(500),
    supabase.from('expenses').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('business_days').select('*').order('date', { ascending: false }).limit(1),
    supabase.from('stock_batches').select('*, products(name)').order('received_at', { ascending: false }).limit(500)
  ]);
  if (p.error) throw p.error;
  products.set((p.data ?? []).map((row) => ({ id: row.id, name: row.name, category: row.category, unit: row.unit, stock: row.stock, price: row.price, active: row.active })));
  if (!s.error) sales.set((s.data ?? []).map((row) => ({ id: row.id, at: row.created_at, lines: (row.sale_lines ?? []).map((line: Record<string, unknown>) => ({ productId: line.product_id, name: line.product_name, quantity: line.quantity, unitPrice: line.unit_price, cost: line.unit_cost })), payments: (row.payments ?? []).map((payment: Record<string, unknown>) => ({ method: payment.method, amount: payment.amount })), total: row.total, cost: row.cost, hasCostDeficit: row.has_cost_deficit, source: 'supabase', sync: 'synced' })) as Sale[]);
  if (!e.error) expenses.set((e.data ?? []).map((row) => ({ id: row.id, at: row.created_at, category: row.category, description: row.description, amount: row.amount, method: row.method })));
  if (!a.error) activities.set((a.data ?? []).map((row) => ({ id: row.id, at: row.created_at, action: row.action, detail: row.detail })));
  if (!d.error && d.data?.[0]) { const row = d.data[0]; businessDay.set({ date: row.date, status: row.status, openedAt: row.opened_at, closedAt: row.closed_at }); }
  if (!b.error) stockEntries.set((b.data ?? []).map((row) => ({ id: row.id, at: row.received_at, productId: row.product_id, productName: row.products?.name ?? '', quantity: row.quantity, unitCost: row.unit_cost, supplier: row.supplier, paid: row.paid, note: row.note })));
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

export async function closeDay() {
  if (supabase) { const { error } = await supabase.rpc('close_business_day'); if (error) throw error; await refresh(); }
  else { businessDay.update((day) => day ? { ...day, status: 'closed', closedAt: new Date().toISOString() } : day); audit('Day closed', 'Business day formally closed'); }
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
  if (payments.reduce((sum, p) => sum + p.amount, 0) !== total) throw new Error('Payments must equal the sale total.');
  const saleId = id();
  if (supabase && get(online)) {
    const { error } = await supabase.rpc('record_sale', { p_id: saleId, p_lines: lines, p_payments: payments });
    if (error) throw error;
    await refresh();
    return saleId;
  }
  const catalog = get(products);
  const resolved = lines.map((line) => ({ ...line, name: catalog.find((p) => p.id === line.productId)?.name ?? 'Unknown', cost: 0 }));
  const sale: Sale = { id: saleId, at: new Date().toISOString(), lines: resolved, payments, total, cost: 0, hasCostDeficit: true, source: isDemo ? 'demo' : 'supabase', sync: isDemo ? 'synced' : 'queued' };
  sales.update((all) => [sale, ...all]);
  products.update((all) => all.map((p) => ({ ...p, stock: p.stock - (lines.find((l) => l.productId === p.id)?.quantity ?? 0) })));
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
  audit('Sale edited', `${saleId.slice(0, 8)} · RWF ${total.toLocaleString()}`);
}

export async function addStock(input: { productId: string; quantity: number; unitCost: number; supplier: string; paid: number; note: string }) {
  if (input.quantity <= 0 || input.unitCost < 0 || input.paid < 0 || input.paid > input.quantity * input.unitCost) throw new Error('Check stock quantity, cost and payment.');
  if (supabase) { const { error } = await supabase.rpc('receive_stock', { p_product_id: input.productId, p_quantity: input.quantity, p_unit_cost: input.unitCost, p_supplier: input.supplier, p_paid: input.paid, p_note: input.note }); if (error) throw error; await refresh(); return; }
  const product = get(products).find((p) => p.id === input.productId);
  stockEntries.update((all) => [{ id: id(), at: new Date().toISOString(), productName: product?.name ?? '', ...input }, ...all]);
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
  if (input.amount <= 0) throw new Error('Enter an amount greater than zero.');
  if (supabase) { const { error } = await supabase.from('expenses').insert(input); if (error) throw error; await refresh(); return; }
  expenses.update((all) => [{ ...input, id: id(), at: new Date().toISOString() }, ...all]);
  audit('Expense recorded', `${input.category} · RWF ${input.amount.toLocaleString()}`);
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
