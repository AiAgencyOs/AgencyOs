import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { quotationFontBytes } from './fonts';

/**
 * The GST & tax report as a PDF — SCR-056 "Export PDF".
 *
 * The same figures the page and the CSV show, laid out for a person who
 * files or audits: the period, the totals per currency split by confirmed
 * billing mode, the cash-basis profit and loss, and the invoice register.
 * Pure over its input, like the invoice renderer: the route hands in what
 * the page computed, so the file cannot disagree with the screen.
 */

export type TaxReportPdfInput = {
  organizationName: string;
  gstin: string | null;
  periodLabel: string;
  generatedAt: string;
  splits: {
    currency: string;
    all: { count: number; subtotal: number; tax: number; total: number; paid: number };
    gst: { count: number; subtotal: number; tax: number; total: number; paid: number };
    nonGst: { count: number; subtotal: number; tax: number; total: number; paid: number };
    unconfirmed: { count: number; subtotal: number; tax: number; total: number; paid: number };
  }[];
  pnl: { currency: string; invoiced: number; received: number; expenses: number; net: number; expensesByCategory: { category: string; amount: number }[] }[];
  register: {
    number: string;
    status: string;
    issuedAt: string | null;
    billingMode: 'gst' | 'non_gst' | null;
    gstin: string | null;
    currency: string;
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    paidMinor: number;
  }[];
};

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.45, 0.45, 0.5);
const LINE = rgb(0.85, 0.85, 0.87);

function moneyFormatter(currency: string) {
  const f = new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
  return (minor: number) => f.format(minor / 100);
}

export function taxReportPdfFilename(periodLabel: string): string {
  const slug = periodLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `tax-report-${slug || 'all'}.pdf`;
}

export async function renderTaxReportPdf(input: TaxReportPdfInput): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = quotationFontBytes();
  const regular = await doc.embedFont(fontBytes.regular, { subset: false });
  const bold = await doc.embedFont(fontBytes.bold, { subset: false });
  const charset = new Set(regular.getCharacterSet());
  const clean = (text: string) =>
    Array.from(text.replace(/\s+/g, ' ').trim(), (ch) => (charset.has(ch.codePointAt(0)!) ? ch : '?')).join('');

  let page = doc.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;
  let pages = 1;

  const newPage = () => {
    page = doc.addPage([A4.width, A4.height]);
    pages += 1;
    y = A4.height - MARGIN;
  };
  const ensure = (height: number) => {
    if (y - height < MARGIN) newPage();
  };
  const text = (value: string, opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; right?: number } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 9.5;
    const cleaned = clean(value);
    const x = opts.right !== undefined ? opts.right - font.widthOfTextAtSize(cleaned, size) : (opts.x ?? MARGIN);
    page.drawText(cleaned, { x, y, size, font, color: opts.color ?? INK });
  };
  const line = (height = 14) => {
    y -= height;
  };
  const rule = () => {
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: A4.width - MARGIN, y: y + 4 }, thickness: 0.5, color: LINE });
  };
  const heading = (value: string) => {
    ensure(40);
    line(18);
    text(value, { size: 12, font: bold });
    line(6);
    rule();
    line(12);
  };

  // ── header ──────────────────────────────────────────────────────────────
  text(input.organizationName, { size: 16, font: bold });
  line(18);
  text('GST & tax report', { size: 11, color: MUTED });
  text(`Period: ${input.periodLabel}`, { right: A4.width - MARGIN, size: 10 });
  line(14);
  text(input.gstin ? `GSTIN ${input.gstin}` : 'GSTIN not recorded', { size: 9, color: MUTED });
  text(`Generated ${input.generatedAt}`, { right: A4.width - MARGIN, size: 9, color: MUTED });
  line(10);
  rule();

  // ── totals by mode ──────────────────────────────────────────────────────
  for (const split of input.splits) {
    const money = moneyFormatter(split.currency);
    heading(`Invoices issued in the period (${split.currency})`);
    const cols = [MARGIN, 200, 290, 380, 470];
    const head = ['Billing mode', 'Invoices', 'Taxable value', 'Tax', 'Total'];
    head.forEach((h, i) => text(h, { x: cols[i], size: 8.5, font: bold, color: MUTED }));
    line(13);
    const rows: [string, typeof split.all][] = [
      ['GST', split.gst],
      ['Non-GST', split.nonGst],
      ...(split.unconfirmed.count > 0 ? ([['Unconfirmed mode', split.unconfirmed]] as [string, typeof split.all][]) : []),
      ['All', split.all],
    ];
    for (const [label, t] of rows) {
      ensure(14);
      const isTotal = label === 'All';
      text(label, { x: cols[0], font: isTotal ? bold : regular });
      text(String(t.count), { x: cols[1] });
      text(money(t.subtotal), { x: cols[2] });
      text(money(t.tax), { x: cols[3] });
      text(money(t.total), { x: cols[4], font: isTotal ? bold : regular });
      line(13);
    }
    text(`${money(split.all.paid)} of ${money(split.all.total)} received against these invoices.`, { size: 8.5, color: MUTED });
    line(10);
  }
  if (input.splits.length === 0) {
    heading('Invoices issued in the period');
    text('Nothing was issued in this period.', { color: MUTED });
    line(10);
  }

  // ── profit and loss ─────────────────────────────────────────────────────
  for (const row of input.pnl) {
    const money = moneyFormatter(row.currency);
    heading(`Profit & loss, cash basis (${row.currency})`);
    const entries: [string, number, boolean][] = [
      ['Invoiced', row.invoiced, false],
      ['Received (verified payments)', row.received, false],
      ['Expenses', row.expenses, false],
      ['Net (received − expenses)', row.net, true],
    ];
    for (const [label, amount, strong] of entries) {
      ensure(14);
      text(label, { font: strong ? bold : regular });
      text(money(amount), { right: A4.width - MARGIN, font: strong ? bold : regular });
      line(13);
    }
    if (row.expensesByCategory.length > 0) {
      line(4);
      text('Expenses by category', { size: 8.5, font: bold, color: MUTED });
      line(12);
      for (const c of row.expensesByCategory) {
        ensure(13);
        text(c.category, { x: MARGIN + 12, color: MUTED });
        text(money(c.amount), { right: A4.width - MARGIN, color: MUTED });
        line(12);
      }
    }
  }

  // ── register ────────────────────────────────────────────────────────────
  heading(`Invoice register (${input.register.length})`);
  const rcols = [MARGIN, 120, 170, 225, 310, 380, 440, 500];
  const rhead = ['Invoice', 'Status', 'Issued', 'Mode / GSTIN', 'Subtotal', 'Tax', 'Total', 'Verified'];
  const drawRegisterHead = () => {
    rhead.forEach((h, i) => text(h, { x: rcols[i], size: 8, font: bold, color: MUTED }));
    line(12);
  };
  drawRegisterHead();
  for (const r of input.register) {
    if (y - 12 < MARGIN) {
      newPage();
      drawRegisterHead();
    }
    const money = moneyFormatter(r.currency);
    text(r.number, { x: rcols[0], size: 8 });
    text(r.status, { x: rcols[1], size: 8 });
    text(r.issuedAt ? r.issuedAt.slice(0, 10) : '—', { x: rcols[2], size: 8 });
    text(r.billingMode === 'gst' ? `GST ${r.gstin ?? ''}` : r.billingMode === 'non_gst' ? 'Non-GST' : 'Unconfirmed', { x: rcols[3], size: 8 });
    text(money(r.subtotalMinor), { x: rcols[4], size: 8 });
    text(money(r.taxMinor), { x: rcols[5], size: 8 });
    text(money(r.totalMinor), { x: rcols[6], size: 8 });
    text(money(r.paidMinor), { x: rcols[7], size: 8 });
    line(11);
  }
  if (input.register.length === 0) {
    text('No invoice in the register for this period.', { color: MUTED });
  }

  // ── footer on every page ────────────────────────────────────────────────
  const all = doc.getPages();
  all.forEach((p: PDFPage, i: number) => {
    const footer = clean(`${input.organizationName} · GST & tax report · ${input.periodLabel} · page ${i + 1} of ${all.length}`);
    p.drawText(footer, { x: MARGIN, y: MARGIN / 2, size: 7.5, font: regular, color: MUTED });
  });

  return { bytes: await doc.save(), pages };
}
