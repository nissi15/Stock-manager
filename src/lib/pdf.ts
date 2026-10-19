import type { DayClosingSnapshot, PaymentMethod } from './types';

type PdfDocument = {
  addPage: () => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  rect: (x: number, y: number, width: number, height: number, style?: string) => void;
  save: (name: string) => void;
  setDrawColor: (...values: number[]) => void;
  setFillColor: (...values: number[]) => void;
  setFont: (family: string, style: string) => void;
  setFontSize: (size: number) => void;
  setTextColor: (...values: number[]) => void;
  getTextWidth: (text: string) => number;
  text: (text: string | string[], x: number, y: number, options?: { align?: 'left' | 'center' | 'right'; maxWidth?: number }) => void;
};

export type ReportPdfData = {
  dateRange: string;
  scope: string;
  salesCount: number;
  unitsSold: number;
  salesRevenue: number;
  costOfGoods: number;
  grossProfit: number;
  expenseTotal: number;
  stockLossTotal: number;
  netProfit: number;
  paymentDate: string;
  paymentsToday: Record<PaymentMethod, number>;
  productsSold: { label: string; units: number }[];
};

const formatNumber = (value: number) => Math.round(value).toLocaleString('en-US');
const money = (value: number) => `RWF ${formatNumber(value)}`;

function heading(doc: PdfDocument, title: string, subtitle: string) {
  doc.setTextColor(17, 20, 24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text(title, 16, 19);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(91, 101, 114);
  doc.text(subtitle, 16, 26);
  doc.setDrawColor(220, 225, 231);
  doc.line(16, 31, 194, 31);
}

function metric(doc: PdfDocument, label: string, value: string, x: number, y: number, width = 56) {
  doc.setDrawColor(222, 227, 233);
  doc.setFillColor(249, 250, 251);
  doc.rect(x, y, width, 22, 'FD');
  doc.setTextColor(91, 101, 114);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text(label, x + 4, y + 7);
  doc.setTextColor(17, 20, 24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(value, x + 4, y + 16, { maxWidth: width - 8 });
}

function section(doc: PdfDocument, title: string, y: number) {
  doc.setTextColor(17, 20, 24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(title, 16, y);
  doc.setDrawColor(226, 230, 235);
  doc.line(16, y + 3, 194, y + 3);
}

function row(doc: PdfDocument, label: string, value: string, y: number, emphasis = false) {
  doc.setTextColor(61, 68, 77);
  doc.setFont('helvetica', emphasis ? 'bold' : 'normal');
  doc.setFontSize(9);
  doc.text(label, 18, y);
  doc.setTextColor(17, 20, 24);
  doc.setFont('helvetica', 'bold');
  doc.text(value, 192, y, { align: 'right' });
}

function fittedLabel(doc: PdfDocument, label: string, maxWidth: number) {
  if (doc.getTextWidth(label) <= maxWidth) return label;
  let shortened = label;
  while (shortened.length && doc.getTextWidth(`${shortened}...`) > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}...`;
}

export async function exportDayClosingPdf(snapshot: DayClosingSnapshot, canSave: () => boolean = () => true) {
  const { jsPDF } = await import('jspdf');
  if (!canSave()) return;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as unknown as PdfDocument;
  heading(
    doc,
    'Daily closing report',
    `${snapshot.date} | Closed ${new Date(snapshot.closedAt).toLocaleString('en-GB', { timeZone: 'Africa/Khartoum' })}`
  );

  metric(doc, 'Sales revenue', money(snapshot.salesRevenue), 16, 38);
  metric(doc, 'Net profit', money(snapshot.netProfit), 77, 38);
  metric(doc, 'Cash difference', money(snapshot.cashDifference), 138, 38);

  section(doc, 'Business result', 70);
  row(doc, `Sales (${formatNumber(snapshot.salesCount)} sales / ${formatNumber(snapshot.unitsSold)} units)`, money(snapshot.salesRevenue), 80);
  row(doc, 'FIFO cost of goods', money(snapshot.costOfGoods), 88);
  row(doc, 'Gross profit', money(snapshot.grossProfit), 96);
  row(doc, 'Operating expenses', money(snapshot.expenseTotal), 104);
  row(doc, 'Stock losses', money(snapshot.stockLossTotal), 112);
  row(doc, 'Net profit', money(snapshot.netProfit), 121, true);

  section(doc, 'Money collected', 136);
  row(doc, 'Cash sales', money(snapshot.payments.cash), 146);
  row(doc, 'MoMo sales', money(snapshot.payments.momo), 154);
  row(doc, 'Bank sales', money(snapshot.payments.bank), 162);
  row(doc, 'Expected physical cash', money(snapshot.expectedCash), 173, true);
  row(doc, 'Counted physical cash', money(snapshot.countedCash), 181, true);
  row(doc, 'Cash difference', money(snapshot.cashDifference), 189, true);

  section(doc, 'Stock remaining at close', 205);
  let y = 215;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('Product', 18, y);
  doc.text('Category', 93, y);
  doc.text('Remaining', 192, y, { align: 'right' });
  y += 6;
  for (const item of snapshot.stockRemaining) {
    if (y > 282) {
      doc.addPage();
      heading(doc, 'Stock remaining', snapshot.date);
      y = 42;
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(35, 41, 48);
    doc.text(`${item.name} - ${item.unit}`, 18, y, { maxWidth: 70 });
    doc.text(item.category, 93, y, { maxWidth: 55 });
    doc.setFont('helvetica', 'bold');
    doc.text(formatNumber(item.quantity), 192, y, { align: 'right' });
    y += 7;
  }

  if (canSave()) doc.save(`day-closing-${snapshot.date}.pdf`);
}

export async function exportReportPdf(data: ReportPdfData, canSave: () => boolean = () => true) {
  const { jsPDF } = await import('jspdf');
  if (!canSave()) return;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as unknown as PdfDocument;
  heading(doc, 'Business report', `${data.dateRange} | ${data.scope}`);

  metric(doc, 'Sales revenue', money(data.salesRevenue), 16, 38);
  metric(doc, 'Gross profit', money(data.grossProfit), 77, 38);
  metric(doc, 'Net profit', money(data.netProfit), 138, 38);
  metric(doc, 'Units sold', formatNumber(data.unitsSold), 16, 65);
  metric(doc, 'Operating expenses', money(data.expenseTotal), 77, 65);
  metric(doc, 'Stock loss', money(data.stockLossTotal), 138, 65);

  section(doc, 'Products sold (units)', 101);
  const sortedProducts = data.productsSold.filter((product) => product.units > 0)
    .sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));
  const chartProducts = sortedProducts.length > 8
    ? [...sortedProducts.slice(0, 7), { label: `Other (${sortedProducts.length - 7} products)`, units: sortedProducts.slice(7).reduce((sum, product) => sum + product.units, 0) }]
    : sortedProducts;
  if (!chartProducts.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(91, 101, 114);
    doc.text('No products sold in this report period.', 18, 137);
  } else {
    const maxUnits = Math.max(...chartProducts.map((product) => product.units));
    chartProducts.forEach((product, index) => {
      const y = 117 + index * 7.1;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(47, 55, 65);
      doc.text(fittedLabel(doc, product.label, 68), 18, y);
      doc.setFillColor(236, 240, 245);
      doc.rect(91, y - 3.1, 76, 3.5, 'F');
      doc.setFillColor(34, 104, 219);
      doc.rect(91, y - 3.1, Math.max(1, product.units / maxUnits * 76), 3.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(17, 20, 24);
      doc.text(formatNumber(product.units), 192, y, { align: 'right' });
    });
  }

  section(doc, 'Summary', 182);
  row(doc, `Sales (${formatNumber(data.salesCount)})`, money(data.salesRevenue), 192);
  row(doc, 'FIFO cost of goods', money(data.costOfGoods), 200);
  row(doc, 'Gross profit', money(data.grossProfit), 208);
  row(doc, 'Operating expenses', money(data.expenseTotal), 216);
  row(doc, 'Stock loss', money(data.stockLossTotal), 224);
  row(doc, 'Net profit', money(data.netProfit), 233, true);

  section(doc, `Today's payments - ${data.paymentDate} (whole business)`, 248);
  row(doc, 'Cash', money(data.paymentsToday.cash), 258);
  row(doc, 'MoMo', money(data.paymentsToday.momo), 266);
  row(doc, 'Bank', money(data.paymentsToday.bank), 274);

  if (canSave()) doc.save(`business-report-${data.dateRange.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`);
}
