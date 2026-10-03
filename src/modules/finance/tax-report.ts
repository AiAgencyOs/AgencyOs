/**
 * Pure arithmetic for the GST & tax screen (SCR-056) and its CSV export.
 * No database, no dates from the clock: the caller hands in the rows and
 * the period, and gets back the split it prints. Kept out of queries.ts so
 * it is unit-testable and so the route handler and the page cannot disagree.
 */

import type { ExpenseRow, ReceiptRow, TaxReportInvoice } from './queries';
import { isVerifiedPayment, type BasisPayment } from './verified-basis';

export type TaxPeriod = { from: string | null; to: string | null; label: string };

/**
 * Resolves `?period=` into an ISO date window. Accepts `YYYY-MM`, `YYYY-Qn`,
 * `FYYYYY` (Indian financial year, April–March), `all`, or `from..to`.
 * Anything unparseable falls back to everything, and says so in the label.
 */
export function resolveTaxPeriod(raw: string | undefined, today: Date): TaxPeriod {
  const value = (raw ?? '').trim();
  if (!value || value === 'all') return { from: null, to: null, label: 'All time' };

  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (m >= 1 && m <= 12) {
      const from = new Date(Date.UTC(y, m - 1, 1));
      const to = new Date(Date.UTC(y, m, 1));
      return { from: from.toISOString(), to: to.toISOString(), label: from.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    }
  }

  const quarter = /^(\d{4})-Q([1-4])$/i.exec(value);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    const from = new Date(Date.UTC(y, (q - 1) * 3, 1));
    const to = new Date(Date.UTC(y, q * 3, 1));
    return { from: from.toISOString(), to: to.toISOString(), label: `Q${q} ${y}` };
  }

  const fy = /^FY(\d{4})$/i.exec(value);
  if (fy) {
    const y = Number(fy[1]);
    const from = new Date(Date.UTC(y, 3, 1));
    const to = new Date(Date.UTC(y + 1, 3, 1));
    return { from: from.toISOString(), to: to.toISOString(), label: `FY ${y}–${String(y + 1).slice(2)}` };
  }

  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (range) {
    const from = new Date(`${range[1]}T00:00:00Z`);
    const to = new Date(`${range[2]}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from) {
      return { from: from.toISOString(), to: to.toISOString(), label: `${range[1]} → ${range[2]}` };
    }
  }

  void today;
  return { from: null, to: null, label: 'All time' };
}

/** Period choices the selector offers: this month, last month, the current and previous quarter, this FY, all. */
export function taxPeriodOptions(today: Date): { value: string; label: string }[] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const q = Math.floor(m / 3) + 1;
  const prevQ = q === 1 ? { y: y - 1, q: 4 } : { y, q: q - 1 };
  const fyYear = m >= 3 ? y : y - 1;
  const lastMonth = m === 0 ? { y: y - 1, m: 12 } : { y, m };
  const options = [
    { value: `${y}-${pad(m + 1)}`, label: 'This month' },
    { value: `${lastMonth.y}-${pad(lastMonth.m)}`, label: 'Last month' },
    { value: `${y}-Q${q}`, label: `This quarter (Q${q})` },
    { value: `${prevQ.y}-Q${prevQ.q}`, label: `Last quarter (Q${prevQ.q} ${prevQ.y})` },
    { value: `FY${fyYear}`, label: `This financial year (FY ${fyYear}–${String(fyYear + 1).slice(2)})` },
    { value: `FY${fyYear - 1}`, label: `Last financial year (FY ${fyYear - 1}–${String(fyYear).slice(2)})` },
    { value: 'all', label: 'All time' },
  ];
  // Dedupe when this month == a quarter start etc. — values differ so keep all.
  return options;
}

function inPeriod(at: string | null, period: TaxPeriod): boolean {
  if (!period.from || !period.to) return true;
  if (!at) return false;
  return at >= period.from && at < period.to;
}

export function invoicesInPeriod(rows: readonly TaxReportInvoice[], period: TaxPeriod): TaxReportInvoice[] {
  return rows.filter((r) => inPeriod(r.issuedAt, period));
}
export function receiptsInPeriod(rows: readonly ReceiptRow[], period: TaxPeriod): ReceiptRow[] {
  return rows.filter((r) => inPeriod(r.issuedAt, period));
}
/**
 * The money received in the window, on the ONE verified basis: payments a
 * person verified, dated by the day they verified them. Receipts are issued on
 * verification, so this is the same money a receipt records — but it needs no
 * read of the receipts table, which the finance role could not always see, and
 * it is the same figure Finance Overview calls Total Received.
 */
export function verifiedReceivedInPeriod(
  rows: readonly BasisPayment[],
  period: TaxPeriod,
): { currency: string; amountMinor: number }[] {
  return rows
    .filter((p) => isVerifiedPayment(p) && inPeriod(p.verified_at, period))
    .map((p) => ({ currency: p.currency, amountMinor: p.amount_minor }));
}
export function expensesInPeriod(rows: readonly ExpenseRow[], period: TaxPeriod): ExpenseRow[] {
  return rows.filter((r) => inPeriod(`${r.incurredOn}T00:00:00.000Z`, period));
}

export type TaxTotals = { count: number; subtotal: number; tax: number; total: number; paid: number };

const zero = (): TaxTotals => ({ count: 0, subtotal: 0, tax: 0, total: 0, paid: 0 });

function add(t: TaxTotals, r: TaxReportInvoice): void {
  t.count += 1;
  t.subtotal += r.subtotalMinor;
  t.tax += r.taxMinor;
  t.total += r.totalMinor;
  t.paid += r.paidMinor;
}

export type TaxSplit = {
  currency: string;
  all: TaxTotals;
  gst: TaxTotals;
  nonGst: TaxTotals;
  /** Invoices whose project never confirmed a mode — a gap to fix, not a tax category. */
  unconfirmed: TaxTotals;
};

/** GST vs non-GST by the *confirmed* billing mode, per currency. */
export function splitByMode(rows: readonly TaxReportInvoice[]): TaxSplit[] {
  const byCurrency = new Map<string, TaxSplit>();
  for (const r of rows) {
    const split = byCurrency.get(r.currency) ?? { currency: r.currency, all: zero(), gst: zero(), nonGst: zero(), unconfirmed: zero() };
    add(split.all, r);
    if (r.billingMode === 'gst') add(split.gst, r);
    else if (r.billingMode === 'non_gst') add(split.nonGst, r);
    else add(split.unconfirmed, r);
    byCurrency.set(r.currency, split);
  }
  return [...byCurrency.values()];
}

export type ProfitAndLoss = {
  currency: string;
  invoiced: number;
  received: number;
  expenses: number;
  /** Received minus expenses — cash basis, the only basis the ledger supports. */
  net: number;
  expensesByCategory: { category: string; amount: number }[];
};

export function profitAndLoss(
  invoices: readonly TaxReportInvoice[],
  /** Money received — verified payments (`verifiedReceivedInPeriod`) or receipts: anything with a currency and an amount. */
  receipts: readonly { currency: string; amountMinor: number; [extra: string]: unknown }[],
  expenses: readonly ExpenseRow[],
): ProfitAndLoss[] {
  const by = new Map<string, ProfitAndLoss>();
  const get = (c: string) => {
    const row = by.get(c) ?? { currency: c, invoiced: 0, received: 0, expenses: 0, net: 0, expensesByCategory: [] };
    by.set(c, row);
    return row;
  };
  for (const i of invoices) get(i.currency).invoiced += i.totalMinor;
  for (const r of receipts) get(r.currency).received += r.amountMinor;
  const cats = new Map<string, Map<string, number>>();
  for (const e of expenses) {
    get(e.currency).expenses += e.amountMinor;
    const m = cats.get(e.currency) ?? new Map<string, number>();
    m.set(e.category, (m.get(e.category) ?? 0) + e.amountMinor);
    cats.set(e.currency, m);
  }
  for (const row of by.values()) {
    row.net = row.received - row.expenses;
    row.expensesByCategory = [...(cats.get(row.currency) ?? new Map<string, number>()).entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }
  return [...by.values()];
}

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The invoice register as CSV — one row per issued invoice, amounts in major units. */
export function taxRegisterCsv(rows: readonly TaxReportInvoice[]): string {
  const header = ['Invoice', 'Status', 'Issued', 'Billing mode', 'GSTIN', 'Currency', 'Subtotal', 'Tax', 'Total', 'Verified paid'];
  const lines = rows.map((r) =>
    [
      r.number,
      r.status,
      r.issuedAt ? r.issuedAt.slice(0, 10) : '',
      r.billingMode === 'gst' ? 'GST' : r.billingMode === 'non_gst' ? 'Non-GST' : 'Unconfirmed',
      r.gstin ?? '',
      r.currency,
      (r.subtotalMinor / 100).toFixed(2),
      (r.taxMinor / 100).toFixed(2),
      (r.totalMinor / 100).toFixed(2),
      (r.paidMinor / 100).toFixed(2),
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}
