import { z } from 'zod';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, like 2026-09-01');

/**
 * "Generate period report" — SCR-056, owner decision Q-D2 of 2026-10-01: it
 * stores a dated snapshot of the period that "Export history" lists and that a
 * period lock may refer to (migration 20261009300200). The period is half-open
 * `[periodStart, periodEnd)`, the shape the tax page, the lock and
 * finance.reconciliations use. The figures are never supplied by the caller:
 * the database door computes them from the ledger.
 */
export const generatePeriodReportSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    label: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.periodEnd > v.periodStart, { message: 'The period must end after it starts.' });
export type GeneratePeriodReportInput = z.input<typeof generatePeriodReportSchema>;

type Figures = { count?: number; subtotal_minor?: number; tax_minor?: number; total_minor?: number; paid_minor?: number };
export type SnapshotCurrency = {
  currency: string;
  invoices: Figures;
  by_mode?: Record<string, Figures>;
  expenses?: { count?: number; amount_minor?: number };
  /** R3-2: payments received on the verified basis (absent in snapshots taken before it). */
  payments?: { count?: number; received_minor?: number; refunded_minor?: number; net_received_minor?: number };
  /** R3-2: revenue (verified receipts net of refunds), expenses and net for the period. */
  profit_and_loss?: { revenue_minor?: number; expenses_minor?: number; net_minor?: number };
};

/** The snapshot column as a list of currencies, tolerant of anything the database might hold. */
export function snapshotCurrencies(snapshot: unknown): SnapshotCurrency[] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter((c): c is SnapshotCurrency => typeof c === 'object' && c !== null && typeof (c as SnapshotCurrency).currency === 'string' && typeof (c as SnapshotCurrency).invoices === 'object');
}

/** A short line for the export history: "3 invoices · taxable INR 1,00,000.00, tax INR 18,000.00, expenses INR 4,000.00, payments received …, profit and loss: revenue …, expenses …, net …". */
export function describeSnapshot(snapshot: unknown, invoiceCount: number, format: (minor: number, currency: string) => string): string {
  const currencies = snapshotCurrencies(snapshot);
  const head = `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}`;
  if (currencies.length === 0) return `${head} · nothing issued or spent in the period`;
  const parts = currencies.map((c) => {
    const bits = [`taxable ${format(c.invoices.subtotal_minor ?? 0, c.currency)}`, `tax ${format(c.invoices.tax_minor ?? 0, c.currency)}`];
    if ((c.expenses?.count ?? 0) > 0) bits.push(`expenses ${format(c.expenses?.amount_minor ?? 0, c.currency)}`);
    if (c.payments) bits.push(`payments received ${format(c.payments.net_received_minor ?? c.payments.received_minor ?? 0, c.currency)}`);
    if (c.profit_and_loss) bits.push(`profit and loss: revenue ${format(c.profit_and_loss.revenue_minor ?? 0, c.currency)}, expenses ${format(c.profit_and_loss.expenses_minor ?? 0, c.currency)}, net ${format(c.profit_and_loss.net_minor ?? 0, c.currency)}`);
    return bits.join(', ');
  });
  return `${head} · ${parts.join(' · ')}`;
}

/** The reports of exactly this window, newest first — what a lock may refer to. */
export function reportsOfPeriod<T extends { periodStart: string; periodEnd: string; generatedAt: string }>(reports: readonly T[], start: string, end: string): T[] {
  return reports.filter((r) => r.periodStart === start && r.periodEnd === end).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
