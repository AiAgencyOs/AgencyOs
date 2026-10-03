import type { PaymentLedgerRow } from './types';
import { displayPaymentReference } from './schema';

/**
 * The payments register's filters and its file — PDF SCR-053 "filters" and
 * "export". Pure: the page, the export route and the tests share it, so the
 * CSV is exactly the rows the screen filtered to.
 */

export type PaymentFilter = {
  status?: string;
  /** The payment's provider: `manual`, `razorpay`, … */
  method?: string;
  /** Inclusive calendar days (YYYY-MM-DD), compared with the day of capture. */
  from?: string;
  to?: string;
  /** Substring of the client's name, case-insensitive. */
  client?: string;
  /** `verified` = a person confirmed it; `unverified` = recorded only. */
  verification?: 'verified' | 'unverified';
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parsePaymentFilter(raw: Record<string, string | undefined>): PaymentFilter {
  const day = (v: string | undefined) => (v && DAY.test(v) ? v : undefined);
  return {
    status: raw.status || undefined,
    method: raw.method || undefined,
    from: day(raw.from),
    to: day(raw.to),
    client: raw.client?.trim() || undefined,
    verification: raw.verification === 'verified' || raw.verification === 'unverified' ? raw.verification : undefined,
  };
}

export function filterPayments(rows: readonly PaymentLedgerRow[], f: PaymentFilter): PaymentLedgerRow[] {
  const needle = f.client?.toLowerCase();
  return rows.filter((p) => {
    if (f.status && p.status !== f.status) return false;
    if (f.method && p.provider !== f.method) return false;
    if (needle && !p.clientName.toLowerCase().includes(needle)) return false;
    if (f.verification === 'verified' && !(p.verified_at && p.status === 'captured')) return false;
    if (f.verification === 'unverified' && !(p.status === 'captured' && !p.verified_at)) return false;
    const day = p.captured_at ? p.captured_at.slice(0, 10) : null;
    if ((f.from || f.to) && day === null) return false;
    if (f.from && day !== null && day < f.from) return false;
    if (f.to && day !== null && day > f.to) return false;
    return true;
  });
}

/** The query string that carries a filter across sort, pagination and export links. */
export function paymentFilterQuery(f: PaymentFilter, q?: string): string {
  const p = new URLSearchParams();
  if (f.status) p.set('status', f.status);
  if (f.method) p.set('method', f.method);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.client) p.set('client', f.client);
  if (f.verification) p.set('verification', f.verification);
  if (q) p.set('q', q);
  return p.toString();
}

export function paymentFilterLabel(f: PaymentFilter): string {
  const parts = [f.status && `status ${f.status}`, f.method && `method ${f.method}`, f.verification, f.from && `from ${f.from}`, f.to && `to ${f.to}`, f.client && `client ~ ${f.client}`].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'All time';
}

export const PAYMENT_CSV_HEADER = ['invoice', 'client', 'status', 'verified', 'method', 'reference', 'amount', 'currency', 'captured_at', 'verified_at'] as const;

export function paymentCsvRows(rows: readonly PaymentLedgerRow[]): (string | null)[][] {
  return rows.map((p) => [
    p.invoiceNumber,
    p.clientName,
    p.status,
    p.verified_at && p.status === 'captured' ? 'yes' : 'no',
    p.provider,
    displayPaymentReference(p.provider_payment_id),
    (p.amount_minor / 100).toFixed(2),
    p.currency,
    p.captured_at,
    p.verified_at,
  ]);
}
