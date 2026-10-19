<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import { ArrowRight, BarChart3, Box, ChevronRight, Clock3, CreditCard, FileDown, FileText, LockKeyhole, LogOut, MailCheck, Menu, Package, Plus, Search, ShoppingCart, Trash2, TriangleAlert, Wallet, X } from '@lucide/svelte';
  import { activities, addExpense, addProduct, addStock, businessDay, closeDay, createSale, expenses, getClosingPreview, initStore, isDemo, loadBatchProfitReport, online, openDay, products, recordStockLoss, resetAccountData, sales, stockEntries, stockLosses, refresh, reopenDay, updateDailyPrices, updateSale } from '../lib/store';
  import { exportDayClosingPdf, exportReportPdf } from '../lib/pdf';
  import { paymentsForDay, productsSoldForReport } from '../lib/reportPdfData';
  import { money, rwf, shortDate, today } from '../lib/format';
  import { supabase } from '../lib/supabase';
  import { isStrongPassword, passwordRequirements } from '../lib/password';
  import type { BatchProfit, CartLine, DayClosingSnapshot, Expense, PaymentMethod, Product, Sale, StockEntry, StockLoss, StockLossReason } from '../lib/types';

  type Page = 'sale' | 'sales' | 'inventory' | 'expenses' | 'reports' | 'activity';
  let page: Page = $state('sale');
  let railOpen = $state(true);
  let search = $state('');
  let searchInput: HTMLInputElement = $state()!;
  let cart: CartLine[] = $state([]);
  let paymentOpen = $state(false);
  let selectedPaymentMethods: PaymentMethod[] = $state([]);
  let splitPaymentAmount = $state(0);
  let secondSplitPaymentAmount = $state(0);
  let working = $state(false);
  let error = $state('');
  let success = $state('');
  let startDayOpen = $state(false);
  let priceDraft: Record<string, number> = $state({});
  let reopenReason = $state('');
  let closeDayOpen = $state(false);
  let countedCash = $state(0);
  let closingSnapshot = $state<DayClosingSnapshot | null>(null);
  let inventoryTab: 'products' | 'history' | 'balances' = $state('products');
  let productSort = $state<'name-asc' | 'name-desc' | 'category' | 'stock-low' | 'stock-high' | 'price-low' | 'price-high'>('name-asc');
  let stockSort = $state<'newest' | 'oldest' | 'category' | 'product-asc' | 'product-desc' | 'cost-high'>('newest');
  let stockFrom = $state('');
  let stockTo = $state('');
  let stockCategory = $state('all');
  let stockProduct = $state('all');
  let balanceSort = $state<'supplier' | 'due-high'>('supplier');
  let stockDrawer = $state(false);
  let damageDrawer = $state(false);
  let productDrawer = $state(false);
  let selectedSale = $state<Sale | null>(null);
  let editingSale = $state(false);
  let salesFrom = $state(today());
  let salesTo = $state(today());
  let salesCategory = $state('all');
  let salesPayment = $state<'all' | PaymentMethod>('all');
  let salesOrder = $state<'newest' | 'oldest'>('newest');
  let reportTab: 'revenue' | 'cash' = $state('revenue');
  let reportFrom = $state(dateOffset(today(), -6));
  let reportTo = $state(today());
  let reportProductId = $state('all');
  let reportBatchId = $state('all');
  let batchProfitRows: BatchProfit[] = $state([]);
  let batchReportLoading = $state(false);
  let batchReportError = $state('');
  let activityFrom = $state(dateOffset(today(), -6));
  let activityTo = $state(today());
  let activityOrder: 'newest' | 'oldest' = $state('newest');
  let saleLinesDraft: CartLine[] = $state([]);
  let salePaymentDraft: Record<PaymentMethod, number> = $state({ cash: 0, momo: 0, bank: 0 });
  let stockForm = $state({ productId: '', quantity: 1, unitCost: 0, supplier: '', paid: 0, note: '' });
  let productForm = $state({ name: '', category: '', unit: '25 kg sack', price: 0 });
  let expenseForm = $state({ category: 'Transport', description: '', amount: 0, method: 'cash' as PaymentMethod });
  let damageForm = $state({ productId: '', quantity: 1, reason: 'Damaged' as StockLossReason, note: '' });
  let dragProgress = $state(0);
  let dragging = $state(false);
  let sliderElement: HTMLDivElement = $state()!;
  let userEmail = $state('');
  let password = $state('');
  let authMode: 'signin' | 'signup' | 'reset' | 'verify' = $state('signin');
  let resendCooldown = $state(0);
  let accountEmail = $state('');
  let authenticated = $state(isDemo);
  let authInitialized = $state(isDemo);
  let accountLoading = $state(false);
  let currentAccountId: string | null = null;
  let accountEpoch = 0;
  let passwordChecks = $derived(passwordRequirements(password));

  onMount(() => {
    initStore();
    void tick().then(() => searchInput?.focus());
    if (supabase) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => { applyAuthSession(session); });
      const timer = window.setInterval(() => { if (resendCooldown > 0) resendCooldown -= 1; }, 1000);
      return () => { data.subscription.unsubscribe(); window.clearInterval(timer); };
    }
  });

  let activeProducts = $derived($products.filter((p) => p.active && `${p.name} ${p.category} ${p.unit}`.toLowerCase().includes(search.toLowerCase())));
  let total = $derived(cart.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0));
  let hasStockIssue = $derived(cart.some((line) => line.quantity > ($products.find((product) => product.id === line.productId)?.stock ?? 0)));
  let payment: Record<PaymentMethod, number> = $derived.by(() => {
    const amounts: Record<PaymentMethod, number> = { cash: 0, momo: 0, bank: 0 };
    if (selectedPaymentMethods.length === 1) amounts[selectedPaymentMethods[0]] = total;
    if (selectedPaymentMethods.length === 2) {
      const firstAmount = Math.max(0, Math.min(total, Math.round(splitPaymentAmount || 0)));
      amounts[selectedPaymentMethods[0]] = firstAmount;
      amounts[selectedPaymentMethods[1]] = total - firstAmount;
    }
    if (selectedPaymentMethods.length === 3) {
      const firstAmount = Math.max(0, Math.min(total, Math.round(splitPaymentAmount || 0)));
      const secondAmount = Math.max(0, Math.min(total - firstAmount, Math.round(secondSplitPaymentAmount || 0)));
      amounts[selectedPaymentMethods[0]] = firstAmount;
      amounts[selectedPaymentMethods[1]] = secondAmount;
      amounts[selectedPaymentMethods[2]] = total - firstAmount - secondAmount;
    }
    return amounts;
  });
  let paid = $derived(payment.cash + payment.momo + payment.bank);
  let remaining = $derived(Math.max(0, total - paid));
  let validPaymentChoice = $derived(
    selectedPaymentMethods.length === 1
    || (selectedPaymentMethods.length === 2 && splitPaymentAmount > 0 && splitPaymentAmount < total)
    || (selectedPaymentMethods.length === 3 && splitPaymentAmount > 0 && secondSplitPaymentAmount > 0 && splitPaymentAmount + secondSplitPaymentAmount < total)
  );
  let canConfirm = $derived(cart.length > 0 && !hasStockIssue && validPaymentChoice && remaining === 0 && paid === total && !working);
  let dayIsOpen = $derived($businessDay?.status === 'open' && $businessDay?.date === today());
  let productCategories = $derived([...new Set($products.map((product) => product.category))].sort());
  let visibleSales = $derived.by(() => $sales
    .filter((sale) => inDateRange(sale.at, salesFrom, salesTo))
    .filter((sale) => salesCategory === 'all' || sale.lines.some((line) => $products.find((product) => product.id === line.productId)?.category === salesCategory))
    .filter((sale) => salesPayment === 'all' || sale.payments.some((payment) => payment.method === salesPayment))
    .toSorted((a, b) => salesOrder === 'newest' ? new Date(b.at).getTime() - new Date(a.at).getTime() : new Date(a.at).getTime() - new Date(b.at).getTime()));
  let dayExpenses = $derived($expenses.filter((e) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(e.at)) === today()));
  let recentDayExpenses = $derived([...dayExpenses].toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 8));
  let expenseTotal = $derived(dayExpenses.reduce((sum, e) => sum + e.amount, 0));
  let reportPeriodSales = $derived($sales.filter((sale) => inDateRange(sale.at, reportFrom, reportTo)));
  let reportExpenses = $derived($expenses.filter((expense) => inDateRange(expense.at, reportFrom, reportTo)));
  let reportPeriodStockLosses = $derived($stockLosses.filter((entry) => inDateRange(entry.at, reportFrom, reportTo)));
  let reportProductBatches = $derived(batchProfitRows
    .filter((batch) => reportProductId === 'all' || batch.productId === reportProductId)
    .toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()));
  let reportSelectedBatch = $derived(reportBatchId === 'all' ? null : batchProfitRows.find((batch) => batch.id === reportBatchId) ?? null);
  let reportScopedProductId = $derived(reportSelectedBatch?.productId ?? reportProductId);
  let reportSales = $derived.by(() => reportPeriodSales
    .map((sale) => {
      if (reportScopedProductId === 'all') return sale;
      const lines = sale.lines.filter((line) => line.productId === reportScopedProductId);
      return { ...sale, lines, total: lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0), cost: lines.reduce((sum, line) => sum + line.cost, 0) };
    })
    .filter((sale) => sale.lines.length > 0));
  let reportStockLosses = $derived(reportPeriodStockLosses.filter((entry) => reportScopedProductId === 'all' || entry.productId === reportScopedProductId));
  let reportRevenue = $derived(reportSelectedBatch?.salesRevenue ?? reportSales.reduce((sum, sale) => sum + sale.total, 0));
  let reportUnitsSold = $derived(reportSelectedBatch?.quantitySold ?? reportSales.flatMap((sale) => sale.lines).reduce((sum, line) => sum + line.quantity, 0));
  let reportCost = $derived(reportSelectedBatch?.costOfGoods ?? reportSales.reduce((sum, sale) => sum + sale.cost, 0));
  let reportGrossProfit = $derived(reportRevenue - reportCost);
  let reportExpenseTotal = $derived(reportScopedProductId === 'all' ? reportExpenses.reduce((sum, expense) => sum + expense.amount, 0) : 0);
  let reportStockLossTotal = $derived(reportSelectedBatch?.stockLossCost ?? reportStockLosses.reduce((sum, entry) => sum + entry.cost, 0));
  let reportPeriodStockLossTotal = $derived(reportPeriodStockLosses.reduce((sum, entry) => sum + entry.cost, 0));
  let reportPeriodTradingLossTotal = $derived(reportPeriodSales.reduce((sum, sale) => sum + Math.max(0, sale.cost - sale.total), 0));
  let reportProfit = $derived(reportGrossProfit - reportExpenseTotal - reportStockLossTotal);
  let profitVerified = $derived(reportSelectedBatch ? reportSelectedBatch.realizedContribution !== null : reportSales.every((sale) => !sale.hasCostDeficit));
  let reportTrend = $derived(reportSelectedBatch
    ? [{ key: reportSelectedBatch.id, label: 'Selected', detail: batchName(reportSelectedBatch), revenue: reportSelectedBatch.salesRevenue, expenses: reportSelectedBatch.costOfGoods + reportSelectedBatch.stockLossCost, profit: reportSelectedBatch.realizedContribution ?? 0 }]
    : buildTrend(reportSales, reportScopedProductId === 'all' ? reportExpenses : [], reportStockLosses, reportFrom, reportTo));
  let reportTrendMax = $derived(Math.max(1, ...reportTrend.flatMap((period) => [period.revenue, Math.abs(period.profit)])));
  let reportTrendIsDaily = $derived(reportTrend[0]?.key.length === 10);
  let reportRangeLabel = $derived(formatRange(reportFrom, reportTo));
  let visibleActivities = $derived.by(() => $activities
    .filter((item) => inDateRange(item.at, activityFrom, activityTo))
    .toSorted((a, b) => activityOrder === 'newest' ? new Date(b.at).getTime() - new Date(a.at).getTime() : new Date(a.at).getTime() - new Date(b.at).getTime()));
  let balances = $derived([...new Set($stockEntries.map((entry) => entry.supplier).filter(Boolean))].map((supplier) => ({ supplier, due: $stockEntries.filter((e) => e.supplier === supplier).reduce((sum, e) => sum + e.quantity * e.unitCost - e.paid, 0) })));
  let sortedProducts = $derived.by(() => [...$products].sort((a, b) => productSort === 'name-desc' ? b.name.localeCompare(a.name) : productSort === 'category' ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name) : productSort === 'stock-low' ? a.stock - b.stock : productSort === 'stock-high' ? b.stock - a.stock : productSort === 'price-low' ? a.price - b.price : productSort === 'price-high' ? b.price - a.price : a.name.localeCompare(b.name)));
  let sortedStockEntries = $derived.by(() => $stockEntries
    .filter((entry) => inDateRange(entry.at, stockFrom, stockTo))
    .filter((entry) => stockCategory === 'all' || ($products.find((product) => product.id === entry.productId)?.category ?? '') === stockCategory)
    .filter((entry) => stockProduct === 'all' || entry.productId === stockProduct)
    .toSorted((a, b) => {
    if (stockSort === 'oldest') return new Date(a.at).getTime() - new Date(b.at).getTime();
    if (stockSort === 'category') return ($products.find((product) => product.id === a.productId)?.category ?? '').localeCompare($products.find((product) => product.id === b.productId)?.category ?? '') || a.productName.localeCompare(b.productName) || new Date(b.at).getTime() - new Date(a.at).getTime();
    if (stockSort === 'product-asc') return a.productName.localeCompare(b.productName) || new Date(b.at).getTime() - new Date(a.at).getTime();
    if (stockSort === 'product-desc') return b.productName.localeCompare(a.productName) || new Date(b.at).getTime() - new Date(a.at).getTime();
    if (stockSort === 'cost-high') return b.unitCost - a.unitCost;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  }));
  let sortedBalances = $derived.by(() => [...balances].sort((a, b) => balanceSort === 'due-high' ? b.due - a.due : a.supplier.localeCompare(b.supplier)));
  let lowStock = $derived($products.filter((product) => product.active && product.stock < 10));
  let selectedSaleIsEditable = $derived(!!selectedSale && dayIsOpen && new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(selectedSale.at)) === today());
  let saleDraftTotal = $derived(saleLinesDraft.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
  let saleDraftPaid = $derived(salePaymentDraft.cash + salePaymentDraft.momo + salePaymentDraft.bank);
  let damageEstimate = $derived(estimateStockLoss(damageForm.productId, damageForm.quantity));
  let closingPreview = $derived.by(() => closeDayOpen ? getClosingPreview(countedCash) : null);
  let queuedSalesToday = $derived($sales.filter((sale) => sale.sync === 'queued' && localDate(sale.at) === today()).length);
  let closeDayBlocked = $derived(!$online || queuedSalesToday > 0 || $sales.some((sale) => localDate(sale.at) === today() && sale.hasCostDeficit));

  let batchRequest = 0;
  function resetAccountView() {
    page = 'sale'; search = ''; cart = []; closePaymentPanel(); dragging = false;
    startDayOpen = false; priceDraft = {}; reopenReason = ''; closeDayOpen = false;
    countedCash = 0; closingSnapshot = null;
    inventoryTab = 'products'; productSort = 'name-asc'; stockSort = 'newest';
    stockFrom = ''; stockTo = ''; stockCategory = 'all'; stockProduct = 'all'; balanceSort = 'supplier';
    stockDrawer = false; damageDrawer = false; productDrawer = false;
    selectedSale = null; editingSale = false; saleLinesDraft = []; salePaymentDraft = { cash: 0, momo: 0, bank: 0 };
    stockForm = { productId: '', quantity: 1, unitCost: 0, supplier: '', paid: 0, note: '' };
    productForm = { name: '', category: '', unit: '25 kg sack', price: 0 };
    expenseForm = { category: 'Transport', description: '', amount: 0, method: 'cash' };
    damageForm = { productId: '', quantity: 1, reason: 'Damaged', note: '' };
    salesFrom = today(); salesTo = today(); salesCategory = 'all'; salesPayment = 'all'; salesOrder = 'newest';
    reportTab = 'revenue'; reportFrom = dateOffset(today(), -6); reportTo = today(); reportProductId = 'all'; reportBatchId = 'all';
    batchRequest += 1; batchProfitRows = []; batchReportLoading = false; batchReportError = '';
    activityFrom = dateOffset(today(), -6); activityTo = today(); activityOrder = 'newest';
    userEmail = ''; password = ''; authMode = 'signin'; resendCooldown = 0; error = ''; success = '';
  }
  function applyAuthSession(session: Session | null) {
    const accountId = session?.user.id ?? null;
    if (accountId === currentAccountId && authInitialized) {
      accountEmail = session?.user.email ?? '';
      return;
    }
    const epoch = ++accountEpoch;
    currentAccountId = accountId;
    authenticated = false;
    resetAccountData(accountId);
    resetAccountView();
    accountEmail = session?.user.email ?? '';
    authInitialized = true;
    authenticated = !!session;
    accountLoading = !!session;
    if (!session) return;
    window.setTimeout(() => {
      if (accountEpoch !== epoch) return;
      void refresh().catch((reason) => {
        if (accountEpoch === epoch) error = message(reason);
      }).finally(() => {
        if (accountEpoch === epoch) accountLoading = false;
      });
    }, 0);
  }
  $effect(() => {
    if (!authenticated || accountLoading || page !== 'reports') {
      batchRequest += 1;
      batchProfitRows = [];
      batchReportLoading = false;
      batchReportError = '';
      return;
    }
    const request = ++batchRequest;
    const from = reportFrom;
    const to = reportTo;
    batchReportLoading = true;
    batchReportError = '';
    void loadBatchProfitReport(from, to).then((rows) => {
      if (request === batchRequest) batchProfitRows = rows;
    }).catch((reason) => {
      if (request === batchRequest) batchReportError = message(reason);
    }).finally(() => {
      if (request === batchRequest) batchReportLoading = false;
    });
  });
  $effect(() => { if (reportProductId !== 'all' && !$products.some((product) => product.id === reportProductId)) reportProductId = 'all'; });
  $effect(() => { if (reportBatchId !== 'all' && !reportProductBatches.some((batch) => batch.id === reportBatchId)) reportBatchId = 'all'; });
  $effect(() => {
    if (!success) return;
    const visibleMessage = success;
    const timer = window.setTimeout(() => { if (success === visibleMessage) success = ''; }, 3000);
    return () => window.clearTimeout(timer);
  });

  function selectPage(value: Page) { page = value; error = ''; paymentOpen = false; }
  function localDate(value: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(value)); }
  function dateOffset(value: string, offset: number) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
  function inDateRange(value: string, from: string, to: string) { const date = localDate(value); return (!from || date >= from) && (!to || date <= to); }
  function formatRange(from: string, to: string) {
    const format = (value: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
    if (!from && !to) return 'All dates';
    if (from && to && from === to) return format(from);
    return `${from ? format(from) : 'Beginning'} – ${to ? format(to) : 'Today'}`;
  }
  function buildTrend(records: Sale[], costs: Expense[], losses: StockLoss[], from: string, to: string) {
    if (!from || !to || from > to) return [];
    const start = new Date(`${from}T12:00:00Z`);
    const end = new Date(`${to}T12:00:00Z`);
    const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
    if (days <= 7) return Array.from({ length: days }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + index);
      const key = date.toISOString().slice(0, 10);
      const daySales = records.filter((sale) => localDate(sale.at) === key);
      const revenue = daySales.reduce((sum, sale) => sum + sale.total, 0);
      const expenses = daySales.reduce((sum, sale) => sum + sale.cost, 0) + costs.filter((expense) => localDate(expense.at) === key).reduce((sum, expense) => sum + expense.amount, 0) + losses.filter((loss) => localDate(loss.at) === key).reduce((sum, loss) => sum + loss.cost, 0);
      return { key, label: new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(date), detail: new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date), revenue, expenses, profit: revenue - expenses };
    });
    const months: { key: string; label: string; detail: string; revenue: number; expenses: number; profit: number }[] = [];
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12));
    const finalMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1, 12));
    while (cursor <= finalMonth) {
      const key = cursor.toISOString().slice(0, 7);
      const monthSales = records.filter((sale) => localDate(sale.at).startsWith(key));
      const revenue = monthSales.reduce((sum, sale) => sum + sale.total, 0);
      const expenses = monthSales.reduce((sum, sale) => sum + sale.cost, 0) + costs.filter((expense) => localDate(expense.at).startsWith(key)).reduce((sum, expense) => sum + expense.amount, 0) + losses.filter((loss) => localDate(loss.at).startsWith(key)).reduce((sum, loss) => sum + loss.cost, 0);
      months.push({ key, label: new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(cursor), detail: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(cursor), revenue, expenses, profit: revenue - expenses });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return months;
  }
  function setReportRange(days: number) { reportTo = today(); reportFrom = dateOffset(reportTo, 1 - days); }
  function addToCart(product: Product) {
    if (!dayIsOpen) { startDay(); return; }
    const existing = cart.find((line) => line.productId === product.id);
    cart = existing ? cart.map((line) => line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...cart, { productId: product.id, quantity: 1, unitPrice: product.price }];
    search = '';
    void tick().then(() => document.querySelector<HTMLInputElement>(`[data-qty="${product.id}"]`)?.focus());
  }
  function readMoneyInput(input: HTMLInputElement): number {
    const before = input.value;
    const digitsBeforeCursor = before.slice(0, input.selectionStart ?? before.length).replace(/\D/g, '').length;
    const digits = before.replace(/\D/g, '');
    const amount = Math.min(Number.MAX_SAFE_INTEGER, Number(digits || '0'));
    const formatted = digits ? money(amount) : '';
    input.value = formatted;
    let cursor = 0;
    let seenDigits = 0;
    while (cursor < formatted.length && seenDigits < digitsBeforeCursor) {
      if (/\d/.test(formatted[cursor])) seenDigits += 1;
      cursor += 1;
    }
    input.setSelectionRange(cursor, cursor);
    return amount;
  }
  function updateLine(productId: string, field: 'quantity' | 'unitPrice', value: string) { const requested = Math.max(field === 'quantity' ? 1 : 0, Math.round(Number(value) || 0)); cart = cart.map((line) => line.productId === productId ? { ...line, [field]: requested } : line); }
  function removeLine(productId: string) { cart = cart.filter((line) => line.productId !== productId); }
  function openPaymentPanel() { selectedPaymentMethods = []; splitPaymentAmount = 0; secondSplitPaymentAmount = 0; dragProgress = 0; paymentOpen = true; }
  function closePaymentPanel() { selectedPaymentMethods = []; splitPaymentAmount = 0; secondSplitPaymentAmount = 0; dragProgress = 0; paymentOpen = false; }
  function togglePaymentMethod(method: PaymentMethod) {
    if (selectedPaymentMethods.includes(method)) selectedPaymentMethods = selectedPaymentMethods.filter((item) => item !== method);
    else if (selectedPaymentMethods.length < 3) selectedPaymentMethods = [...selectedPaymentMethods, method];
    splitPaymentAmount = 0;
    secondSplitPaymentAmount = 0;
    dragProgress = 0;
  }
  function startDay() { selectedSale = null; editingSale = false; priceDraft = Object.fromEntries($products.map((p) => [p.id, p.price])); startDayOpen = true; }
  async function submitDay() { try { working = true; error = ''; if ($businessDay?.date === today() && $businessDay.status === 'closed') { await reopenDay(reopenReason); success = 'Business day reopened'; } else if (dayIsOpen) { await updateDailyPrices(priceDraft); success = 'Daily prices updated'; } else { await openDay(priceDraft); success = 'Business day opened'; } startDayOpen = false; reopenReason = ''; } catch (e) { error = message(e); } finally { working = false; } }
  function openCloseDay() { const preview = getClosingPreview(); countedCash = Math.max(0, preview.expectedCash); closingSnapshot = null; closeDayOpen = true; error = ''; }
  async function submitCloseDay() {
    let snapshot: DayClosingSnapshot;
    const epoch = accountEpoch;
    try {
      working = true;
      error = '';
      snapshot = await closeDay(countedCash);
      if (accountEpoch !== epoch) { working = false; return; }
      closingSnapshot = snapshot;
      closeDayOpen = false;
      success = 'Business day closed · Closing PDF downloaded';
    } catch (e) {
      if (accountEpoch === epoch) error = message(e);
      working = false;
      return;
    }
    working = false;
    try { await exportDayClosingPdf(snapshot, () => accountEpoch === epoch); }
    catch (e) { if (accountEpoch === epoch) error = `The day was closed, but the PDF could not be downloaded: ${message(e)}`; }
  }
  async function downloadClosingPdf() {
    const snapshot = $businessDay?.closing ?? closingSnapshot;
    if (!snapshot) return;
    const epoch = accountEpoch;
    try { working = true; error = ''; await exportDayClosingPdf(snapshot, () => accountEpoch === epoch); }
    catch (e) { error = message(e); }
    finally { working = false; }
  }
  async function downloadReportPdf() {
    const epoch = accountEpoch;
    const selectedProduct = $products.find((product) => product.id === reportScopedProductId);
    const scope = reportSelectedBatch ? batchName(reportSelectedBatch) : selectedProduct ? `${selectedProduct.name} · ${selectedProduct.unit}` : 'Whole business';
    const paymentDate = today();
    const productsSold = reportSelectedBatch
      ? [{ label: `${reportSelectedBatch.productName} - ${reportSelectedBatch.unit}`, units: reportSelectedBatch.quantitySold }]
      : productsSoldForReport(reportSales, $products);
    try {
      working = true;
      error = '';
      await exportReportPdf({ dateRange: reportRangeLabel, scope, salesCount: reportSales.length, unitsSold: reportUnitsSold, salesRevenue: reportRevenue, costOfGoods: reportCost, grossProfit: reportGrossProfit, expenseTotal: reportExpenseTotal, stockLossTotal: reportStockLossTotal, netProfit: reportProfit, paymentDate, paymentsToday: paymentsForDay($sales, paymentDate), productsSold }, () => accountEpoch === epoch);
      if (accountEpoch === epoch) success = 'Report PDF downloaded';
    } catch (e) { if (accountEpoch === epoch) error = message(e); }
    finally { working = false; }
  }
  async function finishSale() {
    if (!canConfirm) return;
    try { working = true; error = ''; await createSale(cart, Object.entries(payment).filter(([, amount]) => amount > 0).map(([method, amount]) => ({ method: method as PaymentMethod, amount }))); success = `Sale completed · ${rwf(total)}`; cart = []; selectedPaymentMethods = []; splitPaymentAmount = 0; secondSplitPaymentAmount = 0; paymentOpen = false; dragProgress = 0; void tick().then(() => searchInput?.focus()); }
    catch (e) { error = message(e); dragProgress = 0; } finally { working = false; }
  }
  async function submitStock() { try { working = true; error = ''; await addStock(stockForm); stockDrawer = false; stockForm = { productId: '', quantity: 1, unitCost: 0, supplier: '', paid: 0, note: '' }; success = 'Stock received'; } catch (e) { error = message(e); } finally { working = false; } }
  async function submitProduct() { try { working = true; error = ''; await addProduct(productForm); productDrawer = false; productForm = { name: '', category: '', unit: '25 kg sack', price: 0 }; success = 'Product created'; } catch (e) { error = message(e); } finally { working = false; } }
  async function submitExpense() { try { working = true; error = ''; await addExpense(expenseForm); expenseForm = { category: 'Transport', description: '', amount: 0, method: 'cash' }; success = 'Expense recorded'; } catch (e) { error = message(e); } finally { working = false; } }
  function openDamageDrawer() { damageForm = { productId: $products.find((product) => product.stock > 0)?.id ?? $products[0]?.id ?? '', quantity: 1, reason: 'Damaged', note: '' }; damageDrawer = true; }
  async function submitDamage() { try { working = true; error = ''; await recordStockLoss(damageForm); damageDrawer = false; success = `Stock loss recorded · ${rwf(damageEstimate.cost)}`; damageForm = { productId: '', quantity: 1, reason: 'Damaged', note: '' }; } catch (e) { error = message(e); } finally { working = false; } }
  function showSale(sale: Sale) { selectedSale = sale; editingSale = false; saleLinesDraft = sale.lines.map(({ productId, quantity, unitPrice }) => ({ productId, quantity, unitPrice })); salePaymentDraft = { cash: 0, momo: 0, bank: 0 }; for (const payment of sale.payments) salePaymentDraft[payment.method] += payment.amount; }
  function clientLabel(sale: Sale) {
    const chronological = [...visibleSales].toSorted((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id));
    const index = chronological.findIndex((entry) => entry.id === sale.id);
    return index >= 0 ? `Client ${index + 1}` : 'Client';
  }
  async function saveSaleEdit() {
    if (!selectedSale) return;
    try { working = true; error = ''; await updateSale(selectedSale.id, saleLinesDraft, Object.entries(salePaymentDraft).filter(([, amount]) => amount > 0).map(([method, amount]) => ({ method: method as PaymentMethod, amount }))); selectedSale = $sales.find((sale) => sale.id === selectedSale?.id) ?? null; editingSale = false; success = 'Sale updated'; }
    catch (e) { error = message(e); } finally { working = false; }
  }
  async function auth() {
    if (!supabase) return;
    if (authMode === 'signup' && !isStrongPassword(password)) { error = 'Choose a password that meets every requirement below.'; return; }
    try { working = true; error = '';
      if (authMode === 'reset') { const { error: e } = await supabase.auth.resetPasswordForEmail(userEmail, { redirectTo: window.location.origin }); if (e) throw e; success = 'Password reset email sent'; }
      else if (authMode === 'signup') { const { data, error: e } = await supabase.auth.signUp({ email: userEmail, password, options: { emailRedirectTo: window.location.origin } }); if (e) throw e; password = ''; if (!data.session) { authMode = 'verify'; success = ''; } else applyAuthSession(data.session); }
      else { const { data, error: e } = await supabase.auth.signInWithPassword({ email: userEmail, password }); if (e) throw e; applyAuthSession(data.session); }
    } catch (e) { error = message(e); } finally { working = false; }
  }
  async function resendVerification() {
    if (!supabase || resendCooldown > 0) return;
    try { working = true; error = ''; success = ''; const { error: e } = await supabase.auth.resend({ type: 'signup', email: userEmail, options: { emailRedirectTo: window.location.origin } }); if (e) throw e; success = 'A new confirmation email is on its way.'; resendCooldown = 60; }
    catch (e) { error = message(e); } finally { working = false; }
  }
  function changeAuthMode(mode: 'signin' | 'signup' | 'reset') { authMode = mode; userEmail = ''; password = ''; error = ''; success = ''; }
  async function signOut() {
    if (!supabase) { success = 'Demo mode has no signed-in account to log out of.'; return; }
    try {
      working = true;
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      applyAuthSession(null);
    } catch (reason) { error = message(reason); }
    finally { working = false; }
  }
  function message(e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return /failed to fetch|networkerror|internet_disconnected/i.test(detail)
      ? 'Cannot reach Supabase. Check your internet connection and try again.'
      : detail;
  }
  function batchReference(entry: Pick<StockEntry, 'id' | 'at'>) { const stamp = entry.at.replace(/\D/g, '').slice(0, 12); const suffix = entry.id.replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase(); return `BAT-${stamp}-${suffix}`; }
  function batchName(batch: Pick<BatchProfit, 'productName' | 'at'>) { return `${batch.productName} · ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Kigali' }).format(new Date(batch.at))} delivery`; }
  function stockCategoryFor(entry: StockEntry) { return $products.find((product) => product.id === entry.productId)?.category ?? '—'; }
  function estimateStockLoss(productId: string, quantity: number) { let needed = Math.max(0, Math.round(quantity || 0)); let cost = 0; for (const batch of $stockEntries.filter((entry) => entry.productId === productId && entry.remaining > 0).toSorted((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id.localeCompare(b.id))) { const used = Math.min(needed, batch.remaining); cost += used * batch.unitCost; needed -= used; if (!needed) break; } return { cost, missing: needed }; }
  function exportCsv() { const rows = [['Date', 'Client', 'Total RWF', 'Cost RWF', 'Profit RWF', 'Payments'], ...visibleSales.map((s) => [s.at, clientLabel(s), s.total, s.cost, s.total - s.cost, s.payments.map((p) => `${p.method}:${p.amount}`).join(' | ')])]; const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `sales-${salesFrom || 'start'}-to-${salesTo || 'latest'}.csv`; a.click(); URL.revokeObjectURL(url); }
  function pointerDown(event: PointerEvent) { if (!canConfirm) return; dragging = true; sliderElement.setPointerCapture(event.pointerId); pointerMove(event); }
  function pointerMove(event: PointerEvent) { if (!dragging) return; const rect = sliderElement.getBoundingClientRect(); dragProgress = Math.max(0, Math.min(1, (event.clientX - rect.left - 27) / (rect.width - 54))); }
  function pointerUp() { if (!dragging) return; dragging = false; if (dragProgress > 0.88) { dragProgress = 1; void finishSale(); } else dragProgress = 0; }
</script>

<svelte:head><title>Stock Manager — Wholesale POS</title><meta name="description" content="Wholesale sales, inventory and daily profit in one focused workspace." /></svelte:head>

{#if !authInitialized || (authenticated && accountLoading)}
  <main class="auth-page"><div class="auth-shell"><div class="auth-wordmark"><span class="brand-mark"><Box size={20} /></span><span>Stock Manager</span></div><p class="auth-footer">Loading your workspace…</p></div></main>
{:else if !authenticated}
  <main class="auth-page">
    <div class="auth-shell">
      <div class="auth-wordmark"><span class="brand-mark"><Box size={20} /></span><span>Stock Manager</span></div>
      {#if authMode === 'verify'}
        <section class="auth-card verify-card" aria-labelledby="verify-title">
          <div class="verify-icon"><MailCheck size={28} strokeWidth={1.7} /></div>
          <div class="auth-intro"><span class="eyebrow">ONE MORE STEP</span><h1 id="verify-title">Check your inbox</h1><p>We sent a confirmation link to <strong>{userEmail}</strong>. Open that email and confirm your address to activate your workspace.</p></div>
          <div class="verify-steps"><span class="step-number">1</span><span>Open the confirmation email and follow its verification link.</span></div>
          <div class="verify-steps"><span class="step-number">2</span><span>Return here and sign in with your email and password.</span></div>
          {#if error}<div class="notice danger" role="alert">{error}</div>{/if}
          {#if success}<div class="notice" role="status">{success}</div>{/if}
          <button class="primary" type="button" onclick={() => changeAuthMode('signin')}>I’ve confirmed my email <ArrowRight size={18} /></button>
          <div class="verify-actions"><button type="button" disabled={working || resendCooldown > 0} onclick={resendVerification}>{resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend confirmation email'}</button><button type="button" onclick={() => changeAuthMode('signup')}>Use another email</button></div>
          <p class="verify-hint">Don’t see it? Check your spam folder or resend the email.</p>
        </section>
      {:else}
        {#key authMode}
        <form class="auth-card" autocomplete={authMode === 'signup' ? 'off' : 'on'} onsubmit={(e) => { e.preventDefault(); void auth(); }}>
          <div class="auth-intro"><span class="eyebrow">WHOLESALE WORKSPACE</span><h1>{authMode === 'signin' ? 'Welcome back' : authMode === 'signup' ? 'Create your account' : 'Reset password'}</h1><p>{authMode === 'signin' ? 'Sign in to keep your day moving.' : authMode === 'signup' ? 'Track stock, sales and profit in one place.' : 'We’ll send you a secure link to reset your password.'}</p></div>
          <label>Email<input type="email" bind:value={userEmail} autocomplete={authMode === 'signup' ? 'off' : 'email'} placeholder="you@business.com" required /></label>
          {#if authMode !== 'reset'}<label>Password<input type="password" bind:value={password} autocomplete={authMode === 'signup' ? 'new-password' : 'current-password'} placeholder={authMode === 'signup' ? 'Create a strong password' : 'Password'} required minlength={authMode === 'signup' ? 12 : 6} aria-describedby={authMode === 'signup' ? 'password-requirements' : undefined} /></label>{/if}
          {#if authMode === 'signup'}<div id="password-requirements" class="password-requirements" aria-live="polite"><span>Use a password with:</span><ul><li class:met={passwordChecks.length}>At least 12 characters</li><li class:met={passwordChecks.uppercase}>A capital letter</li><li class:met={passwordChecks.lowercase}>A lowercase letter</li><li class:met={passwordChecks.number}>A number</li><li class:met={passwordChecks.symbol}>A symbol (for example, ! or @)</li></ul></div>{/if}
          {#if error}<div class="notice danger" role="alert">{error}</div>{/if}{#if success}<div class="notice" role="status">{success}</div>{/if}
          <button class="primary" disabled={working || (authMode === 'signup' && !isStrongPassword(password))}>{authMode === 'signin' ? 'Sign in' : authMode === 'signup' ? 'Create account' : 'Send reset email'} <ArrowRight size={18} /></button>
          <div class="auth-links"><button type="button" onclick={() => changeAuthMode(authMode === 'signup' ? 'signin' : 'signup')}>{authMode === 'signup' ? 'Already have an account? Sign in' : 'Create account'}</button><button type="button" onclick={() => changeAuthMode(authMode === 'reset' ? 'signin' : 'reset')}>{authMode === 'reset' ? 'Back to sign in' : 'Forgot password?'}</button></div>
        </form>
        {/key}
      {/if}
      <p class="auth-footer">A clearer view of every business day.</p>
    </div>
  </main>
{:else}
  <div class="app-shell"><aside class:expanded={railOpen} class="rail"><div class="rail-header"><button class="rail-brand" title="Toggle menu" aria-label="Toggle menu" onclick={() => railOpen = !railOpen}><Box size={22} /></button><span class="brand-name">Stock Manager</span></div><span class="rail-caption">WORKSPACE</span><nav aria-label="Main navigation"><button class:active={page === 'sale'} title="New sale" onclick={() => selectPage('sale')}><ShoppingCart size={20} /><span>New sale</span></button><button class:active={page === 'sales'} title="Sales" onclick={() => selectPage('sales')}><FileText size={20} /><span>Sales</span></button><button class:active={page === 'inventory'} title="Inventory" onclick={() => selectPage('inventory')}><Package size={20} /><span>Inventory</span></button><button class:active={page === 'expenses'} title="Expenses" onclick={() => selectPage('expenses')}><CreditCard size={20} /><span>Expenses</span></button><button class:active={page === 'reports'} title="Reports" onclick={() => selectPage('reports')}><BarChart3 size={20} /><span>Reports</span></button><button class:active={page === 'activity'} title="Activity" onclick={() => selectPage('activity')}><Clock3 size={20} /><span>Activity</span></button></nav><div class="rail-footer"><button class="rail-bottom" title="Toggle menu" aria-label="Toggle menu" onclick={() => railOpen = !railOpen}><Menu size={19} /><span>Collapse menu</span></button><button class="signout-button" title="Log out" aria-label="Log out" disabled={working} onclick={signOut}><span class="account-avatar"><LogOut size={17} /></span><span class="account-details"><strong>Log out</strong><small>{isDemo ? 'Demo workspace' : accountEmail}</small></span></button></div></aside>
    <main class="workspace"><header class="topbar"><div class="page-heading"><span class="eyebrow">{page === 'sale' ? 'POINT OF SALE' : 'WORKSPACE'} · {today()}</span><h1>{page === 'sale' ? 'New sale' : page === 'sales' ? 'Sales' : page === 'inventory' ? 'Inventory' : page === 'expenses' ? 'Expenses' : page === 'reports' ? 'Reports' : 'Activity'}</h1></div><div class="status">{#if dayIsOpen}<button class="daily-prices-button" onclick={startDay}>Daily prices</button>{:else if $businessDay?.date === today() && $businessDay.status === 'closed' && ($businessDay.closing || closingSnapshot)}<button class="daily-prices-button" disabled={working} onclick={downloadClosingPdf}><FileDown size={15} /> Closing PDF</button>{/if}<button class="status-button" onclick={dayIsOpen ? openCloseDay : startDay}><i class:off={!dayIsOpen}></i>{dayIsOpen ? 'Day open' : $businessDay?.date === today() && $businessDay.status === 'closed' ? 'Day closed' : 'Start day'}</button><span class="status-divider"></span><span><i class:off={!$online}></i>{$online ? 'Online' : 'Offline'}</span>{#if isDemo}<span class="demo-pill">Demo mode</span>{/if}</div></header>
    {#if error}<div class="banner danger" role="alert">{error}<button aria-label="Dismiss" onclick={() => error = ''}><X size={17} /></button></div>{/if}{#if success}<div class="banner success" role="status">{success}<button aria-label="Dismiss" onclick={() => success = ''}><X size={17} /></button></div>{/if}
    {#if page === 'sale'}
      <div class:payment-visible={paymentOpen} class="sale-layout"><section class="panel products-panel"><div class="panel-heading"><div><h2>Products</h2><p>Select an item to add it to this sale.</p></div><span class="count-pill">{$products.length} items</span></div><div class="search-wrap"><Search size={20} /><input bind:this={searchInput} bind:value={search} placeholder="Search products" aria-label="Search products" /></div>{#if $products.length > 0}<div class="product-head"><span>Product</span><span>Stock</span><span>Today’s price (RWF)</span></div>{/if}<div class="product-list">{#each activeProducts as product}<button class="product-row" onclick={() => addToCart(product)}><span class="product-name"><strong>{product.name}</strong><small>{product.category} · {product.unit}</small></span><span>{money(Math.max(0, product.stock))}</span><span>{money(product.price)}</span><ChevronRight size={18} /></button>{:else}{#if $products.length === 0}<div class="onboarding-empty"><span class="empty-icon"><Package size={27} strokeWidth={1.6} /></span><h3>Your catalog starts here</h3><p>Add a product like Bismati rice, then receive stock before your first sale.</p><button class="secondary" onclick={() => productDrawer = true}><Plus size={17} /> Add first product</button></div>{:else}<div class="empty">No products match your search.</div>{/if}{/each}</div></section>
      <section class="panel cart-panel"><h2>Current sale</h2><div class="cart-head"><span>Item</span><span>Qty</span><span>Unit price (RWF)</span><span>Subtotal (RWF)</span></div><div class="cart-lines">{#each cart as line}{@const cartProduct = $products.find((product) => product.id === line.productId)}{@const stockIssue = line.quantity > (cartProduct?.stock ?? 0)}<div class:stock-invalid={stockIssue} class="cart-row"><div class="product-name"><strong>{cartProduct?.name}</strong><small>{cartProduct?.category} · {cartProduct?.unit}</small></div><div class="quantity-cell"><input class:invalid={stockIssue} class="qty-input" data-qty={line.productId} type="number" min="1" step="1" value={line.quantity} onchange={(e) => updateLine(line.productId, 'quantity', e.currentTarget.value)} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); updateLine(line.productId, 'quantity', e.currentTarget.value); searchInput?.focus(); } }} aria-label="Quantity" />{#if stockIssue}<small class="stock-warning">{(cartProduct?.stock ?? 0) <= 0 ? 'Out of stock' : `Only ${cartProduct?.stock} available`}</small>{/if}</div><div class="price-cell"><input type="text" inputmode="numeric" value={money(line.unitPrice)} oninput={(e) => updateLine(line.productId, 'unitPrice', String(readMoneyInput(e.currentTarget)))} aria-label="Unit price" /><small>Today’s price: {rwf(cartProduct?.price ?? 0)}</small></div><strong class="subtotal">{money(line.quantity * line.unitPrice)}</strong><button class="icon-button" aria-label="Remove item" onclick={() => removeLine(line.productId)}><Trash2 size={20} /></button></div>{:else}<div class="cart-empty">Choose a product to start a sale.</div>{/each}</div><div class="cart-bottom"><div class="total-line"><strong>Total</strong><strong>{rwf(total)}</strong></div>{#if !paymentOpen}<button class="primary end-sale" disabled={!cart.length || hasStockIssue} onclick={openPaymentPanel}>End sale <ArrowRight size={26} /></button>{/if}</div></section>
      {#if paymentOpen}
        <section class="panel payment-panel">
          <div class="payment-title"><div><h2>Payment</h2><p>Choose one method, or split the payment between several.</p></div><button class="icon-button" aria-label="Close payment" onclick={closePaymentPanel}><X size={21} /></button></div>
          <div class="payment-summary"><span>Amount due</span><strong>{rwf(total)}</strong></div>
          <div class="payment-picker">
            <span>Payment method</span><small>Choose up to three</small>
            <div class="payment-choice-grid">{#each ['cash', 'momo', 'bank'] as method}{@const typedMethod = method as PaymentMethod}{@const selected = selectedPaymentMethods.includes(typedMethod)}<button type="button" class:selected aria-pressed={selected} onclick={() => togglePaymentMethod(typedMethod)}><Wallet size={18} /><span>{method === 'momo' ? 'MoMo' : method[0].toUpperCase() + method.slice(1)}</span><b>{selected ? '✓' : ''}</b></button>{/each}</div>
          </div>
          {#if selectedPaymentMethods.length === 1}
            <div class="single-payment"><span><strong>{selectedPaymentMethods[0] === 'momo' ? 'MoMo' : selectedPaymentMethods[0][0].toUpperCase() + selectedPaymentMethods[0].slice(1)}</strong><small>Full amount assigned automatically</small></span><strong>{rwf(total)}</strong></div>
          {:else if selectedPaymentMethods.length >= 2}
            <div class="payment-methods split-payment">
              {#each selectedPaymentMethods as method, index}
                {@const isAutomatic = index === selectedPaymentMethods.length - 1}
                <label>
                  <span class="method-label"><Wallet size={18} />{method === 'momo' ? 'MoMo' : method[0].toUpperCase() + method.slice(1)}</span>
                  <div class:automatic={isAutomatic} class="money-input"><span>RWF</span><input type="text" inputmode="numeric" readonly={isAutomatic} value={money(payment[method])} oninput={(e) => { const amount = Math.max(0, Math.min(total, readMoneyInput(e.currentTarget))); e.currentTarget.value = money(amount); if (index === 0) splitPaymentAmount = amount; else if (index === 1) secondSplitPaymentAmount = amount; }} /></div>
                  <small>{isAutomatic ? 'Remaining amount filled automatically' : `Enter payment amount ${index + 1}`}</small>
                </label>
              {/each}
            </div>
          {:else}<p class="payment-empty">Select how the customer is paying to continue.</p>{/if}
          <div class="payment-foot"><div class="payment-summary remaining"><span>{selectedPaymentMethods.length >= 2 && !validPaymentChoice ? 'Enter split amounts' : 'Remaining'}</span><strong>{rwf(remaining)}</strong></div><div class:enabled={canConfirm} class:near-complete={dragProgress > 0.55} class="slide-track" style={`--slide-progress: ${dragProgress * 100}%`} bind:this={sliderElement} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={() => { dragging = false; dragProgress = 0; }} role="button" tabindex="0" aria-label="Slide to confirm sale" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void finishSale(); } }}><span class="slide-fill"></span><span class="slide-text">Slide to confirm sale</span><span class="slide-handle" style={`transform: translateX(${dragProgress * (sliderElement?.clientWidth ? sliderElement.clientWidth - 56 : 0)}px)`}><ArrowRight size={21} /></span></div><button class="text-action" disabled={!canConfirm} onclick={finishSale}>Or click to confirm</button></div>
        </section>
      {/if}</div>
    {:else if page === 'inventory'}
      <div class="page-card">
        <div class="section-heading"><div><h2>Inventory</h2><p>Products, costed stock batches and supplier balances.</p></div><div class="actions"><button class="secondary damage-button" onclick={openDamageDrawer}><TriangleAlert size={17} /> Record damage</button><button class="secondary" onclick={() => productDrawer = true}><Plus size={17} /> New product</button><button class="primary compact" onclick={() => { stockForm.productId = $products[0]?.id ?? ''; stockDrawer = true; }}><Plus size={17} /> Add stock</button></div></div>
        <div class="tabs"><button class:chosen={inventoryTab === 'products'} onclick={() => inventoryTab = 'products'}>Products</button><button class:chosen={inventoryTab === 'history'} onclick={() => inventoryTab = 'history'}>Stock history</button><button class:chosen={inventoryTab === 'balances'} onclick={() => inventoryTab = 'balances'}>Supplier balances</button></div>
        {#if inventoryTab === 'history'}
          <div class="sales-filters inventory-filters">
            <label><span>From</span><input type="date" max={stockTo || undefined} bind:value={stockFrom} /></label>
            <label><span>To</span><input type="date" min={stockFrom || undefined} bind:value={stockTo} /></label>
            <label><span>Category</span><select bind:value={stockCategory}><option value="all">All categories</option>{#each productCategories as category}<option value={category}>{category}</option>{/each}</select></label>
            <label><span>Product</span><select bind:value={stockProduct}><option value="all">All products</option>{#each [...$products].sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit)) as product}<option value={product.id}>{product.name} · {product.unit}</option>{/each}</select></label>
            <label><span>Sort</span><select bind:value={stockSort}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="category">Category A–Z</option><option value="product-asc">Product A–Z</option><option value="product-desc">Product Z–A</option><option value="cost-high">Highest unit cost</option></select></label>
          </div>
          <div class="results-count">{sortedStockEntries.length} {sortedStockEntries.length === 1 ? 'batch' : 'batches'} shown · FIFO cost tracking</div>
        {:else}
          <div class="inventory-toolbar"><span>{inventoryTab === 'products' ? `${$products.length} products` : `${balances.length} suppliers`}</span><label>Sort by
            {#if inventoryTab === 'products'}<select bind:value={productSort}><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="category">Category</option><option value="stock-low">Lowest stock</option><option value="stock-high">Highest stock</option><option value="price-low">Lowest price</option><option value="price-high">Highest price</option></select>
            {:else}<select bind:value={balanceSort}><option value="supplier">Supplier A–Z</option><option value="due-high">Highest amount due</option></select>{/if}
          </label></div>
        {/if}
        {#if inventoryTab === 'products'}
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Unit</th><th>In stock</th><th>Today’s price</th><th>Status</th></tr></thead><tbody>{#each sortedProducts as product}<tr><td class="strong">{product.name}</td><td>{product.category}</td><td>{product.unit}</td><td class="stock-figure">{money(product.stock)}</td><td class="price-figure">{rwf(product.price)}</td><td><span class:danger={product.stock <= 0} class:warning={product.stock > 0 && product.stock < 10} class="badge">{product.stock <= 0 ? 'Out of stock' : product.stock < 10 ? 'Low stock' : 'Active'}</span></td></tr>{/each}</tbody></table></div>
        {:else if inventoryTab === 'history'}
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>Batch</th><th>Date added</th><th>Category</th><th>Quantity</th><th>Unit cost</th><th>Supplier</th><th>Paid</th></tr></thead><tbody>{#each sortedStockEntries as entry}<tr><td class="strong">{entry.productName}</td><td><span class="batch-reference" title={batchReference(entry)} aria-label={`Batch ${batchReference(entry)}`}>#{batchReference(entry).split('-').at(-1)}</span></td><td>{shortDate(entry.at)}</td><td>{stockCategoryFor(entry)}</td><td class="numeric-strong">+{entry.quantity}</td><td class="numeric-strong">{rwf(entry.unitCost)}</td><td>{entry.supplier || '—'}</td><td class="numeric-strong">{rwf(entry.paid)}</td></tr>{:else}<tr><td colspan="8" class="empty-cell">No deliveries recorded yet.</td></tr>{/each}</tbody></table></div>
        {:else}
          <div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Amount due</th></tr></thead><tbody>{#each sortedBalances as balance}<tr><td class="strong">{balance.supplier}</td><td>{rwf(balance.due)}</td></tr>{:else}<tr><td colspan="2" class="empty-cell">No supplier balances yet.</td></tr>{/each}</tbody></table></div>
        {/if}
      </div>
    {:else if page === 'sales'}
      <div class="page-card"><div class="section-heading"><div><h2>Sales history</h2><p>Choose a date range, then narrow it by category or payment method.</p></div><button class="secondary" onclick={exportCsv}>Export CSV</button></div><div class="sales-filters range-filters"><label><span>From</span><input type="date" max={salesTo || undefined} bind:value={salesFrom} /></label><label><span>To</span><input type="date" min={salesFrom || undefined} bind:value={salesTo} /></label><label><span>Category</span><select bind:value={salesCategory}><option value="all">All categories</option>{#each productCategories as category}<option value={category}>{category}</option>{/each}</select></label><label><span>Payment</span><select bind:value={salesPayment}><option value="all">All payments</option><option value="cash">Cash</option><option value="momo">MoMo</option><option value="bank">Bank</option></select></label><label><span>Sort</span><select bind:value={salesOrder}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><button class="filter-reset" onclick={() => { salesFrom = today(); salesTo = today(); salesCategory = 'all'; salesPayment = 'all'; salesOrder = 'newest'; }}>Today</button></div><div class="results-count">{visibleSales.length} {visibleSales.length === 1 ? 'sale' : 'sales'} shown</div><div class="table-wrap"><table><thead><tr><th>Client</th><th>Products</th><th>Payment</th><th>Total</th><th>Sync</th></tr></thead><tbody>{#each visibleSales as sale}{@const itemCount = sale.lines.reduce((sum, line) => sum + line.quantity, 0)}<tr><td><button class="sale-link client-link" title="Open sale details" onclick={() => showSale(sale)}>{clientLabel(sale)}</button></td><td><button class="sale-products-link" title="View all products in this sale" onclick={() => showSale(sale)}><strong>{itemCount} {itemCount === 1 ? 'item' : 'items'} sold</strong><ChevronRight size={16} /></button></td><td>{sale.payments.map((p) => p.method === 'momo' ? 'MoMo' : p.method).join(' + ')}</td><td class="sale-total">{rwf(sale.total)}</td><td><span class:warning={sale.sync === 'queued'} class="badge">{sale.sync === 'queued' ? 'Queued' : 'Synced'}</span></td></tr>{:else}<tr><td colspan="5" class="empty-cell">No sales match this date range and filters.</td></tr>{/each}</tbody></table></div></div>
    {:else if page === 'expenses'}
      <div class="content-grid expense-simple-grid">
        <section class="page-card"><div class="section-heading"><div><h2>Record expense</h2><p>Add today’s operating cost and keep moving.</p></div></div><form class="form-grid" onsubmit={(e) => { e.preventDefault(); void submitExpense(); }}><label>Category<select bind:value={expenseForm.category}><option>Transport</option><option>Wages</option><option>Utilities</option><option>Rent</option><option>Packaging</option><option>Repairs</option><option>Tax</option><option>Other</option></select></label><label>Amount (RWF)<input type="text" inputmode="numeric" value={money(expenseForm.amount)} oninput={(e) => expenseForm.amount = readMoneyInput(e.currentTarget)} required /></label><label class="wide">Description<input bind:value={expenseForm.description} placeholder="What was this for?" /></label><label>Payment account<select bind:value={expenseForm.method}><option value="cash">Cash</option><option value="momo">MoMo</option><option value="bank">Bank</option></select></label><button class="primary compact" disabled={working}>Save expense <ArrowRight size={18} /></button></form></section>
        <section class="page-card expense-recent-card"><div class="section-heading"><div><h2>Today’s expenses</h2><p>{dayExpenses.length} {dayExpenses.length === 1 ? 'expense' : 'expenses'} recorded</p></div><span class="expense-total-pill">{rwf(expenseTotal)}</span></div><div class="simple-list expense-list">{#each recentDayExpenses as expense}<div><div><strong>{expense.category}</strong><small>{expense.description || 'No description'} · {expense.method === 'momo' ? 'MoMo' : expense.method[0].toUpperCase() + expense.method.slice(1)}</small></div><strong>{rwf(expense.amount)}</strong></div>{:else}<div class="expense-empty"><span class="empty-icon"><CreditCard size={22} /></span><p>No expenses recorded today.</p></div>{/each}</div></section>
      </div>
    {:else if page === 'reports'}
      <div class="report-workspace">
        <section class="page-card report-controls">
          <div class="report-heading-row">
            <div class="tabs report-tabs report-tabs-inline"><button class:chosen={reportTab === 'revenue'} onclick={() => reportTab = 'revenue'}>Revenue</button><button class:chosen={reportTab === 'cash'} onclick={() => reportTab = 'cash'}>Payments & losses</button></div>
            <div class="report-heading-actions"><span class="report-period">{reportRangeLabel}</span><button class="secondary report-pdf-button" disabled={working} onclick={downloadReportPdf}><FileDown size={16} /> Export PDF</button></div>
          </div>
          <div class:payments-only={reportTab === 'cash'} class="date-range-bar report-filter-grid">
            <label><span>From</span><input type="date" max={reportTo} bind:value={reportFrom} /></label>
            <label><span>To</span><input type="date" min={reportFrom} max={today()} bind:value={reportTo} /></label>
            {#if reportTab === 'revenue'}
              <label><span>Product</span><select value={reportProductId} onchange={(event) => { reportProductId = event.currentTarget.value; reportBatchId = 'all'; }}><option value="all">All products</option>{#each [...$products].sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit)) as product}<option value={product.id}>{product.name} · {product.unit}</option>{/each}</select></label>
              <label><span>Stock delivery</span><select value={reportBatchId} disabled={batchReportLoading} onchange={(event) => { reportBatchId = event.currentTarget.value; const batch = batchProfitRows.find((item) => item.id === reportBatchId); if (batch) reportProductId = batch.productId; }}><option value="all">All stock deliveries</option>{#each reportProductBatches as batch}<option value={batch.id}>{batchName(batch)}</option>{/each}</select></label>
            {/if}
            <div class="range-presets"><button class="secondary" onclick={() => setReportRange(1)}>Today</button><button class="secondary" onclick={() => setReportRange(7)}>7 days</button><button class="secondary" onclick={() => setReportRange(30)}>30 days</button></div>
          </div>
          {#if batchReportError}<div class="report-filter-error">Stock delivery filtering is unavailable: {batchReportError}</div>{/if}
        </section>
        {#if reportTab === 'revenue'}
          <div class="report-summary-grid">
            <div class="metric tone-blue"><span>Sales revenue</span><strong>{rwf(reportRevenue)}</strong><small>{reportSelectedBatch ? batchName(reportSelectedBatch) : `${reportSales.length} completed sales`}</small></div>
            <div class="metric tone-neutral"><span>FIFO cost of goods</span><strong>{profitVerified ? rwf(reportCost) : 'Pending cost'}</strong><small>{reportUnitsSold} units sold{reportSelectedBatch ? ' from this delivery' : ` across ${reportSales.length} sales`}</small></div>
            <div class="metric tone-green"><span>Gross profit</span><strong>{profitVerified ? rwf(reportGrossProfit) : 'Pending cost'}</strong><small>Revenue − FIFO cost</small></div>
            <div class="metric tone-amber"><span>Operating expenses</span><strong>{reportScopedProductId === 'all' ? rwf(reportExpenseTotal) : 'Not allocated'}</strong><small>{reportScopedProductId === 'all' ? `${reportExpenses.length} running costs` : 'Tracked for the whole business only'}</small></div>
            <div class="metric tone-red"><span>Stock loss</span><strong>{rwf(reportStockLossTotal)}</strong><small>{reportStockLosses.length} damage or loss entries</small></div>
            <div class="metric tone-green-strong"><span>{reportScopedProductId === 'all' ? 'Net profit' : 'Realized result'}</span><strong>{profitVerified ? rwf(reportProfit) : 'Pending cost'}</strong><small>{reportScopedProductId === 'all' ? 'Gross profit − expenses − stock loss' : 'Gross profit − stock loss'}</small></div>
          </div>
          <section class="page-card report-trend-card">
            <div class="section-heading financial-trend-head"><div><h2>{reportSelectedBatch ? 'Stock delivery result' : 'Revenue and profit'}</h2><p>{reportSelectedBatch ? batchName(reportSelectedBatch) : reportTrendIsDaily ? 'Each bar group is one day in the selected week.' : 'Longer periods are grouped by month for a clearer comparison.'}</p></div><div class="trend-legend"><span><i class="revenue-dot"></i>Revenue</span><span><i class="profit-dot"></i>Profit</span></div></div>
            <div class="financial-trend" style={`grid-template-columns:repeat(${Math.max(1, reportTrend.length)},minmax(74px,1fr))`} aria-label="Revenue and profit in the selected date range">{#each reportTrend as period}<button type="button" class="financial-period" aria-label={`${period.detail}: revenue ${rwf(period.revenue)}, profit ${rwf(period.profit)}`}><span class="trend-tooltip" role="tooltip"><strong>{period.detail}</strong><span><i class="revenue-dot"></i><em>revenue</em><b>{rwf(period.revenue)}</b></span><span><i class="profit-dot"></i><em>profit</em><b class:danger-text={period.profit < 0}>{rwf(period.profit)}</b></span></span><span class="financial-bars"><i class="financial-bar revenue-bar" style={`height:${period.revenue > 0 ? Math.max(8, period.revenue / reportTrendMax * 100) : 0}%`}></i><i class:negative-bar={period.profit < 0} class="financial-bar profit-bar" style={`height:${period.profit !== 0 ? Math.max(8, Math.abs(period.profit) / reportTrendMax * 100) : 0}%`}></i></span><span class="financial-period-label">{period.label}</span></button>{/each}</div>
            {#if reportTrend.every((period) => period.revenue === 0 && period.profit === 0)}<p class="chart-empty">No sales or profit were recorded in this period.</p>{/if}
          </section>
        {:else}
          <div class="cash-loss-grid">
            <section class="page-card"><div class="section-heading"><div><h2>Payments collected</h2><p>Sales money received during {reportRangeLabel}.</p></div></div><div class="account-flow-list">{#each ['cash', 'momo', 'bank'] as method}{@const collected = reportPeriodSales.flatMap((sale) => sale.payments).filter((payment) => payment.method === method).reduce((sum, payment) => sum + payment.amount, 0)}{@const spent = reportExpenses.filter((expense) => expense.method === method).reduce((sum, expense) => sum + expense.amount, 0)}<div><span><strong>{method === 'momo' ? 'MoMo' : method[0].toUpperCase() + method.slice(1)}</strong><small>Sales {rwf(collected)} · Expenses {rwf(spent)}</small></span><strong>{rwf(collected - spent)}</strong></div>{/each}</div><p class="muted report-note">The right-hand amount is sales collected minus operating expenses paid from that account. Supplier payments are not included because stock deliveries do not yet record a payment account.</p></section>
            <section class="page-card"><div class="section-heading"><div><h2>Stock and trading losses</h2><p>Losses calculated automatically from FIFO costs.</p></div><span class="count-pill">{reportPeriodStockLosses.length} adjustments</span></div><div class="loss-summary"><span><small>Damaged or missing stock</small><strong>{rwf(reportPeriodStockLossTotal)}</strong></span><span><small>Sales below FIFO cost</small><strong>{rwf(reportPeriodTradingLossTotal)}</strong></span></div>{#each reportPeriodStockLosses as entry}<div class="attention-row"><span><strong>{entry.productName}</strong><small>{entry.quantity} × {entry.unit} · {entry.reason} · {shortDate(entry.at)}</small></span><strong>{rwf(entry.cost)}</strong></div>{:else}<div class="attention-empty compact-empty"><span class="empty-icon"><TriangleAlert size={22} /></span><p>No stock loss was recorded in this period.</p></div>{/each}<button class="text-link" onclick={openDamageDrawer}>Record stock damage <ArrowRight size={15} /></button></section>
          </div>
        {/if}
      </div>
    {:else}<div class="page-card"><div class="section-heading"><div><h2>Activity log</h2><p>Choose a period to review changes and transactions.</p></div></div><div class="sales-filters activity-filters"><label><span>From</span><input type="date" max={activityTo || undefined} bind:value={activityFrom} /></label><label><span>To</span><input type="date" min={activityFrom || undefined} bind:value={activityTo} /></label><label><span>Sort</span><select bind:value={activityOrder}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><button class="filter-reset" onclick={() => { activityFrom = dateOffset(today(), -6); activityTo = today(); activityOrder = 'newest'; }}>7 days</button></div><div class="results-count">{visibleActivities.length} activities shown</div><div class="activity-list">{#each visibleActivities as item}<div class="activity-row"><span class="activity-dot"></span><div><strong>{item.action}</strong><p>{item.detail}</p></div><time>{shortDate(item.at)}</time></div>{:else}<p class="muted">No activity in this date range.</p>{/each}</div></div>{/if}
    </main></div>
  {#if closeDayOpen && closingPreview}<div class="overlay" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !working) closeDayOpen = false; }}><form class="drawer close-day-drawer" onsubmit={(event) => { event.preventDefault(); void submitCloseDay(); }}><div class="drawer-head"><div><span class="eyebrow">END OF DAY · {closingPreview.date}</span><h2>Review and close the day</h2><p>Confirm the business result, remaining stock, and physical cash before locking today.</p></div><button type="button" class="icon-button" aria-label="Close day review" disabled={working} onclick={() => closeDayOpen = false}><X size={21} /></button></div><div class="drawer-scroll close-day-scroll">
    {#if closeDayBlocked}<div class="close-blocker"><TriangleAlert size={19} /><span><strong>The day cannot close yet</strong><small>{!$online ? 'Reconnect to the internet first.' : queuedSalesToday > 0 ? `${queuedSalesToday} queued ${queuedSalesToday === 1 ? 'sale needs' : 'sales need'} to sync first.` : 'Resolve the pending FIFO stock cost first.'}</small></span></div>{/if}
    <div class="close-summary-grid"><span><small>Sales</small><strong>{closingPreview.salesCount}</strong><em>{closingPreview.unitsSold} units sold</em></span><span><small>Sales revenue</small><strong>{rwf(closingPreview.salesRevenue)}</strong><em>{rwf(closingPreview.costOfGoods)} FIFO cost</em></span><span><small>Net profit</small><strong class:danger-text={closingPreview.netProfit < 0}>{rwf(closingPreview.netProfit)}</strong><em>After expenses and losses</em></span><span><small>Operating expenses</small><strong>{rwf(closingPreview.expenseTotal)}</strong><em>Today’s running costs</em></span><span><small>Stock loss</small><strong>{rwf(closingPreview.stockLossTotal)}</strong><em>Damaged or missing stock</em></span></div>
    <section class="close-review-section"><div class="close-section-title"><div><h3>Payment totals</h3><p>Money collected from today’s completed sales.</p></div></div><div class="payment-close-grid"><span><small>Cash</small><strong>{rwf(closingPreview.payments.cash)}</strong></span><span><small>MoMo</small><strong>{rwf(closingPreview.payments.momo)}</strong></span><span><small>Bank</small><strong>{rwf(closingPreview.payments.bank)}</strong></span></div></section>
    <section class="close-review-section cash-reconciliation"><div class="close-section-title"><div><h3>Count physical cash</h3><p>Expected cash is cash sales minus cash operating expenses.</p></div><strong>{rwf(closingPreview.expectedCash)} expected</strong></div><label>Counted cash in the drawer<div class="money-input"><span>RWF</span><input type="text" inputmode="numeric" value={money(countedCash)} oninput={(event) => { countedCash = readMoneyInput(event.currentTarget); }} required /></div></label><div class:negative={closingPreview.cashDifference < 0} class:positive={closingPreview.cashDifference > 0} class="cash-difference"><span>{closingPreview.cashDifference === 0 ? 'Cash matches' : closingPreview.cashDifference > 0 ? 'Cash over' : 'Cash short'}</span><strong>{rwf(closingPreview.cashDifference)}</strong></div><p class="cash-note">Supplier payments and any opening cash float are not included because they do not yet have a payment account in the system.</p></section>
    <section class="close-review-section"><div class="close-section-title"><div><h3>Stock remaining</h3><p>Saved in the closing record and included in its PDF.</p></div><span class="count-pill">{closingPreview.stockRemaining.length} products</span></div><div class="closing-stock-list"><div class="closing-stock-head"><span>Product</span><span>Category</span><span>Remaining</span></div>{#each closingPreview.stockRemaining as item}<div><span><strong>{item.name}</strong><small>{item.unit}</small></span><span>{item.category}</span><strong>{money(item.quantity)}</strong></div>{/each}</div></section>
  </div><div class="drawer-footer close-day-actions"><button type="button" class="secondary" disabled={working} onclick={() => closeDayOpen = false}>Cancel</button><button class="primary" disabled={working || closeDayBlocked}><LockKeyhole size={17} /> Close day and download PDF</button></div></form></div>{/if}
  {#if startDayOpen}<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) startDayOpen = false; }}><section class="drawer"><div class="drawer-head"><div><h2>{$businessDay?.date === today() && $businessDay.status === 'closed' ? 'Reopen day' : dayIsOpen ? 'Daily prices' : 'Start day'}</h2><p>{$businessDay?.date === today() && $businessDay.status === 'closed' ? 'Record why this business day is being reopened.' : dayIsOpen ? 'Update the selling prices used for new sales today.' : 'Review today’s selling prices before taking sales.'}</p></div><button class="icon-button" aria-label="Close" onclick={() => startDayOpen = false}><X size={21} /></button></div><div class="drawer-scroll">{#if $businessDay?.date === today() && $businessDay.status === 'closed'}<div class="form-stack"><label>Reason<input bind:value={reopenReason} minlength="5" placeholder="Why is the day being reopened?" required /></label></div>{:else}<div class="price-list">{#each $products.filter((p) => p.active) as product}<label><span><strong>{product.name}</strong><small>{product.category} · {product.unit}</small></span><div class="money-input"><span>RWF</span><input type="text" inputmode="numeric" value={money(priceDraft[product.id])} oninput={(e) => priceDraft[product.id] = readMoneyInput(e.currentTarget)} /></div></label>{/each}</div>{/if}</div><div class="drawer-footer"><button class="primary" disabled={working} onclick={submitDay}>{$businessDay?.date === today() && $businessDay.status === 'closed' ? 'Reopen day' : dayIsOpen ? 'Save daily prices' : 'Confirm prices and open day'} <ArrowRight size={19} /></button></div></section></div>{/if}
  {#if selectedSale}<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) selectedSale = null; }}><section class="drawer sale-detail-drawer"><div class="drawer-head"><div><span class="eyebrow">{clientLabel(selectedSale)}</span><h2>Sale details</h2><p>{shortDate(selectedSale.at)}</p></div><button type="button" class="icon-button" aria-label="Close sale details" onclick={() => selectedSale = null}><X size={21} /></button></div><div class="drawer-scroll">
    {#if editingSale}<div class="sale-edit-list">{#each saleLinesDraft as line}<div class="sale-edit-row"><div><strong>{selectedSale.lines.find((item) => item.productId === line.productId)?.name}</strong><small>{$products.find((product) => product.id === line.productId)?.unit}</small></div><label>Qty<input type="number" min="1" step="1" value={line.quantity} oninput={(e) => saleLinesDraft = saleLinesDraft.map((item) => item.productId === line.productId ? { ...item, quantity: Math.max(1, Math.round(Number(e.currentTarget.value) || 1)) } : item)} /></label><label>Unit price<input type="text" inputmode="numeric" value={money(line.unitPrice)} oninput={(e) => { const unitPrice = readMoneyInput(e.currentTarget); saleLinesDraft = saleLinesDraft.map((item) => item.productId === line.productId ? { ...item, unitPrice } : item); }} /></label></div>{/each}</div><div class="sale-payment-edit"><h3>Payment split</h3>{#each ['cash', 'momo', 'bank'] as method}<label><span>{method === 'momo' ? 'MoMo' : method[0].toUpperCase() + method.slice(1)}</span><div class="money-input"><span>RWF</span><input type="text" inputmode="numeric" value={money(salePaymentDraft[method as PaymentMethod])} oninput={(e) => salePaymentDraft = { ...salePaymentDraft, [method]: readMoneyInput(e.currentTarget) }} /></div></label>{/each}<div class:danger-text={saleDraftPaid !== saleDraftTotal} class="payment-check"><span>Payments</span><strong>{rwf(saleDraftPaid)} / {rwf(saleDraftTotal)}</strong></div></div>
    {:else}<div class="sale-summary-strip"><span><small>Total</small><strong>{rwf(selectedSale.total)}</strong></span><span><small>Payment</small><strong>{selectedSale.payments.map((payment) => payment.method === 'momo' ? 'MoMo' : payment.method).join(' + ')}</strong></span></div><div class="sale-detail-list"><div class="sale-detail-head"><span>Item</span><span>Qty</span><span>Price</span><span>Subtotal</span></div>{#each selectedSale.lines as line}<div class="sale-detail-row"><span><strong>{line.name}</strong><small>{$products.find((product) => product.id === line.productId)?.unit}</small></span><span>{line.quantity}</span><span>{rwf(line.unitPrice)}</span><strong>{rwf(line.quantity * line.unitPrice)}</strong></div>{/each}</div><div class="sale-payment-list"><h3>Payment received</h3>{#each selectedSale.payments as payment}<div><span>{payment.method === 'momo' ? 'MoMo' : payment.method[0].toUpperCase() + payment.method.slice(1)}</span><strong>{rwf(payment.amount)}</strong></div>{/each}</div>{/if}
  </div><div class="drawer-footer sale-detail-actions">{#if editingSale}<button class="secondary" onclick={() => editingSale = false}>Cancel</button><button class="primary" disabled={working || saleDraftPaid !== saleDraftTotal} onclick={saveSaleEdit}>Save correction <ArrowRight size={19} /></button>{:else}{#if selectedSaleIsEditable}<button class="primary" onclick={() => editingSale = true}>Edit this sale <ArrowRight size={19} /></button>{:else}<p class="closed-sale-note">This sale is view-only because its business day is closed.</p>{/if}{/if}</div></section></div>{/if}
  {#if damageDrawer}<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) damageDrawer = false; }}><form class="drawer" onsubmit={(e) => { e.preventDefault(); void submitDamage(); }}><div class="drawer-head"><div><h2>Record stock damage</h2><p>Reduce stock and calculate its FIFO loss automatically.</p></div><button type="button" class="icon-button" aria-label="Close" onclick={() => damageDrawer = false}><X size={21} /></button></div><div class="drawer-scroll form-stack"><div class="damage-note"><TriangleAlert size={19} /><span><strong>No amount to type</strong><small>The oldest available cost batches are used automatically. This loss appears in Reports and the activity log.</small></span></div><label>Product<select bind:value={damageForm.productId} required>{#each $products.filter((product) => product.active) as product}<option value={product.id}>{product.name} · {product.unit} · {product.stock} available</option>{/each}</select></label><div class="form-grid"><label>Quantity<input type="number" min="1" max={$products.find((product) => product.id === damageForm.productId)?.stock ?? 0} step="1" bind:value={damageForm.quantity} required /></label><label>Reason<select bind:value={damageForm.reason}><option>Damaged</option><option>Expired</option><option>Stolen</option><option>Missing</option><option>Other</option></select></label></div><label>Note<input bind:value={damageForm.note} placeholder="Optional explanation" /></label>{#if damageEstimate.missing > 0}<p class="damage-error">Purchase cost is missing for {damageEstimate.missing} item{damageEstimate.missing === 1 ? '' : 's'}. Add the costed stock before recording this loss.</p>{/if}<div class="drawer-total"><span>Automatic FIFO loss</span><strong>{rwf(damageEstimate.cost)}</strong></div></div><div class="drawer-footer"><button class="primary" disabled={working || damageEstimate.missing > 0 || damageForm.quantity <= 0 || damageForm.quantity > ($products.find((product) => product.id === damageForm.productId)?.stock ?? 0)}>Record and reduce stock <ArrowRight size={19} /></button></div></form></div>{/if}
  {#if stockDrawer}<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) stockDrawer = false; }}><form class="drawer" onsubmit={(e) => { e.preventDefault(); void submitStock(); }}><div class="drawer-head"><div><h2>Add stock</h2><p>Record a new supplier delivery.</p></div><button type="button" class="icon-button" aria-label="Close" onclick={() => stockDrawer = false}><X size={21} /></button></div><div class="drawer-scroll form-stack"><div class="automatic-batch-note"><Clock3 size={19} /><span><strong>Automatic batch record</strong><small>A unique batch reference and its exact arrival time are created when you save. Its unit cost is used for FIFO profit.</small></span></div><label>Product<select bind:value={stockForm.productId} required>{#each $products as product}<option value={product.id}>{product.name} · {product.unit}</option>{/each}</select></label><div class="form-grid"><label>Quantity<input type="number" min="1" step="1" bind:value={stockForm.quantity} required /></label><label>Unit cost (RWF)<input type="text" inputmode="numeric" value={money(stockForm.unitCost)} oninput={(e) => stockForm.unitCost = readMoneyInput(e.currentTarget)} required /></label></div><label>Supplier<input bind:value={stockForm.supplier} placeholder="Supplier name" /></label><label>Amount paid now (RWF)<input type="text" inputmode="numeric" value={money(stockForm.paid)} oninput={(e) => stockForm.paid = readMoneyInput(e.currentTarget)} /></label><label>Note<input bind:value={stockForm.note} placeholder="Optional delivery note" /></label><div class="drawer-total"><span>Total cost</span><strong>{rwf(stockForm.quantity * stockForm.unitCost)}</strong></div></div><div class="drawer-footer"><button class="primary" disabled={working}>Save delivery <ArrowRight size={19} /></button></div></form></div>{/if}
  {#if productDrawer}<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) productDrawer = false; }}><form class="drawer" onsubmit={(e) => { e.preventDefault(); void submitProduct(); }}><div class="drawer-head"><div><h2>New product</h2><p>Keep names short and easy to find.</p></div><button type="button" class="icon-button" aria-label="Close" onclick={() => productDrawer = false}><X size={21} /></button></div><div class="drawer-scroll form-stack"><label>Product name<input bind:value={productForm.name} placeholder="Meru" required /></label><label>Category<input list="product-categories" bind:value={productForm.category} placeholder="Choose or type a category" required /><datalist id="product-categories">{#each [...new Set($products.map((product) => product.category))].sort() as category}<option value={category}></option>{/each}</datalist></label><label>Measurement / unit<input list="product-units" bind:value={productForm.unit} placeholder="For example: 5 L bottle" required /><datalist id="product-units">{#each [...new Set($products.map((product) => product.unit))].sort() as unit}<option value={unit}></option>{/each}</datalist><small class="field-hint">Choose an existing measurement or type a new one. The same product name can use different measurements.</small></label><label>Suggested selling price (RWF)<input type="text" inputmode="numeric" value={money(productForm.price)} oninput={(e) => productForm.price = readMoneyInput(e.currentTarget)} /></label></div><div class="drawer-footer"><button class="primary" disabled={working}>Create product <ArrowRight size={19} /></button></div></form></div>{/if}
{/if}
