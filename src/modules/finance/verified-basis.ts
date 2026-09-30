/**
 * ONE basis for every finance total — PDF SCR-050: "Financial totals use
 * verified records".
 *
 * Before this file each screen summed its own thing: the overview added up
 * `invoices.paid_minor` (money somebody RECORDED, verified or not), the
 * payments screen added up captured payments, the tax screen added up
 * receipts. Three "received" figures for the same books (₹21,000 / ₹9,999.99
 * / ₹7,500), and three "net" figures with them.
 *
 * The rule here, and the only one:
 *
 *   received  = `invoices.verified_minor` — the database's own
 *               `finance.net_verified_minor`: captured payments that a person
 *               verified, less refunds recorded. It is what decides whether
 *               an invoice is paid and whether the next milestone opens, so a
 *               total that disagrees with it is a total about something else.
 *   recorded but not yet verified is REPORTED BESIDE the figure
 *               (`awaitingVerificationMinor`), never added to it.
 *   outstanding = what the live invoices total, less received.
 *   net         = received less expenses recorded (cash basis).
 *
 * Pure and dependency-free: the screens, the CSV routes and the tests all call
 * these, so they cannot disagree. Amounts stay in minor units.
 */

export type BasisInvoice = {
  id: string;
  status: string;
  currency: string;
  total_minor: number;
  paid_minor: number;
  verified_minor: number;
  project_id: string | null;
};

export type BasisPayment = {
  invoiceId: string;
  currency: string;
  amount_minor: number;
  status: string;
  captured_at: string | null;
  verified_at: string | null;
};

export type BasisExpense = { currency: string; amountMinor: number };

/** Invoices that are bills: everything but a draft, a pending approval or a void one. */
export const LIVE_INVOICE_STATUSES: ReadonlySet<string> = new Set(['issued', 'partially_paid', 'paid', 'overdue']);

export function isLiveInvoice(status: string): boolean {
  return LIVE_INVOICE_STATUSES.has(status);
}

/** What has been verified on one invoice, clamped to what the invoice totals. */
export function verifiedOn(invoice: Pick<BasisInvoice, 'total_minor' | 'verified_minor'>): number {
  return Math.min(Math.max(invoice.verified_minor, 0), invoice.total_minor);
}

/** What is still owed on one invoice, on the verified basis. */
export function owedOn(invoice: Pick<BasisInvoice, 'total_minor' | 'verified_minor'>): number {
  return Math.max(0, invoice.total_minor - verifiedOn(invoice));
}

/** A payment counts as money only once a person verified it and it was not refunded whole. */
export function isVerifiedPayment(p: Pick<BasisPayment, 'status' | 'verified_at'>): boolean {
  return p.status === 'captured' && p.verified_at !== null;
}

export type FinanceBasis = {
  currency: string;
  invoiceCount: number;
  invoicedMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
  /** Recorded on an invoice but not yet verified by a person: shown beside the figures, never in them. */
  awaitingVerificationMinor: number;
  expensesMinor: number;
  netMinor: number;
  /** Share of invoiced that is verified, whole percent, or null when nothing is invoiced. */
  collectionPercent: number | null;
  /** Net as a share of received, whole percent, or null when nothing is received. */
  marginPercent: number | null;
  pendingInvoiceCount: number;
  overdueInvoiceCount: number;
  overdueMinor: number;
  paidInvoiceMinor: number;
};

/** Every headline figure of the finance overview for one currency, on the one basis. */
export function financeBasis(input: {
  invoices: readonly BasisInvoice[];
  expenses: readonly BasisExpense[];
  currency: string;
}): FinanceBasis {
  const { currency } = input;
  const live = input.invoices.filter((i) => isLiveInvoice(i.status) && i.currency === currency);
  const invoicedMinor = live.reduce((n, i) => n + i.total_minor, 0);
  const receivedMinor = live.reduce((n, i) => n + verifiedOn(i), 0);
  const awaitingVerificationMinor = live.reduce((n, i) => n + Math.max(0, Math.min(i.paid_minor, i.total_minor) - verifiedOn(i)), 0);
  const expensesMinor = input.expenses.filter((e) => e.currency === currency).reduce((n, e) => n + e.amountMinor, 0);
  const netMinor = receivedMinor - expensesMinor;
  const pending = live.filter((i) => owedOn(i) > 0);
  const overdue = live.filter((i) => i.status === 'overdue');
  return {
    currency,
    invoiceCount: live.length,
    invoicedMinor,
    receivedMinor,
    outstandingMinor: invoicedMinor - receivedMinor,
    awaitingVerificationMinor,
    expensesMinor,
    netMinor,
    collectionPercent: invoicedMinor > 0 ? Math.round((receivedMinor / invoicedMinor) * 100) : null,
    marginPercent: receivedMinor > 0 ? Math.round((netMinor / receivedMinor) * 100) : null,
    pendingInvoiceCount: pending.length,
    overdueInvoiceCount: overdue.length,
    overdueMinor: overdue.reduce((n, i) => n + owedOn(i), 0),
    paidInvoiceMinor: live.filter((i) => owedOn(i) === 0).reduce((n, i) => n + i.total_minor, 0),
  };
}

/** The currency with the most invoiced — the one the headline figures are in. */
export function principalCurrency(invoices: readonly BasisInvoice[], fallback = 'INR'): string {
  const byCurrency = new Map<string, number>();
  for (const i of invoices) if (isLiveInvoice(i.status)) byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? 0) + i.total_minor);
  return [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

/** Verified money by project; invoices with no project pool under `null` rather than vanishing. */
export function receivedByProject(invoices: readonly BasisInvoice[], currency: string): Map<string | null, number> {
  const by = new Map<string | null, number>();
  for (const i of invoices) {
    if (!isLiveInvoice(i.status) || i.currency !== currency) continue;
    const v = verifiedOn(i);
    if (v > 0) by.set(i.project_id, (by.get(i.project_id) ?? 0) + v);
  }
  return by;
}

/** Verified payments by calendar month (`YYYY-MM` of `keyOf(verified_at)`), for the income series. */
export function verifiedByMonth(
  payments: readonly BasisPayment[],
  currency: string,
  monthKey: (iso: string) => string,
): Map<string, number> {
  const by = new Map<string, number>();
  for (const p of payments) {
    if (!isVerifiedPayment(p) || p.currency !== currency || !p.verified_at) continue;
    const k = monthKey(p.verified_at);
    by.set(k, (by.get(k) ?? 0) + p.amount_minor);
  }
  return by;
}

export type BasisDisagreement = {
  invoiceId: string;
  /** What the invoice row says was verified. */
  verifiedOnInvoice: number;
  /** What the verified payments behind it add up to. */
  verifiedPayments: number;
  /** What the invoice says was paid (recorded) — may exceed verified, legitimately. */
  paidOnInvoice: number;
  kind: 'paid_without_payment' | 'verified_without_payment';
};

/**
 * Invoices whose stored amounts are not backed by payment rows. Two shapes,
 * both data problems rather than business states:
 *   - `paid_without_payment`: `paid_minor` > 0 but no payment row exists at all;
 *   - `verified_without_payment`: `verified_minor` exceeds the verified payments
 *     behind it by more than refunds could explain (refunds only reduce it).
 * The overview names them instead of quietly folding them into a total.
 */
export function basisDisagreements(
  invoices: readonly BasisInvoice[],
  payments: readonly BasisPayment[],
): BasisDisagreement[] {
  const rowsByInvoice = new Map<string, BasisPayment[]>();
  for (const p of payments) rowsByInvoice.set(p.invoiceId, [...(rowsByInvoice.get(p.invoiceId) ?? []), p]);
  const out: BasisDisagreement[] = [];
  for (const i of invoices) {
    if (i.status === 'void' || i.status === 'draft') continue;
    const rows = rowsByInvoice.get(i.id) ?? [];
    const verifiedPayments = rows.filter(isVerifiedPayment).reduce((n, p) => n + p.amount_minor, 0);
    if (i.paid_minor > 0 && rows.length === 0) {
      out.push({ invoiceId: i.id, verifiedOnInvoice: i.verified_minor, verifiedPayments, paidOnInvoice: i.paid_minor, kind: 'paid_without_payment' });
    } else if (i.verified_minor > verifiedPayments) {
      out.push({ invoiceId: i.id, verifiedOnInvoice: i.verified_minor, verifiedPayments, paidOnInvoice: i.paid_minor, kind: 'verified_without_payment' });
    }
  }
  return out;
}
