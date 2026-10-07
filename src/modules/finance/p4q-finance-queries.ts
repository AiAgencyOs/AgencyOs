import 'server-only';

import { createClient } from '@/lib/db/server';
import { looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

/**
 * Reads of the Phase 4 finance records for internal screens (W-F3, W-F4). Row-level security scopes both tables to the caller's organization and to
 * internal roles; a role that reads no finance gets nothing back, and a read that failed is a failure (`unreadable`), never an empty answer.
 */
export type PaymentMatch = {
  recommendation: 'MATCH' | 'REVIEW' | 'REJECT' | 'EXCEPTION';
  matchClass: string;
  reasons: string[];
  expectedMinor: number;
  submittedMinor: number;
  computedAt: string;
};

const RECOMMENDATIONS = new Set(['MATCH', 'REVIEW', 'REJECT', 'EXCEPTION']);

/** The newest automatic match of one payment claim (advice for the person who verifies), or null when none was prepared. */
export async function readPaymentMatch(submissionId: string): Promise<PaymentMatch | null> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'finance')
    .from('p4q_payment_match_results')
    .select('recommendation, match_class, reasons, expected_minor, submitted_minor, computed_at')
    .eq('submission_id', submissionId)
    .order('computed_at', { ascending: false })
    .limit(1);
  if (error) unreadable('readPaymentMatch', error);
  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null | undefined;
  if (!row || !RECOMMENDATIONS.has(String(row.recommendation))) return null;
  return {
    recommendation: row.recommendation as PaymentMatch['recommendation'],
    matchClass: String(row.match_class ?? ''),
    reasons: Array.isArray(row.reasons) ? row.reasons.filter((r): r is string => typeof r === 'string') : [],
    expectedMinor: Number(row.expected_minor ?? 0),
    submittedMinor: Number(row.submitted_minor ?? 0),
    computedAt: String(row.computed_at ?? ''),
  };
}

export type SnapshotAccount = {
  accountId: string;
  kind: string;
  label: string;
  /** Masked: account numbers show only their last four digits. */
  instructions: Record<string, string>;
  changedSinceIssue: boolean;
  noLongerActive: boolean;
};

/** The receiving accounts an invoice was issued with (masked), each flagged when it has changed or stopped being active since. Empty before the invoice is issued. */
export async function readInvoicePaymentSnapshot(invoiceId: string): Promise<SnapshotAccount[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'finance').rpc('p4q_invoice_payment_snapshot', { p_invoice_id: invoiceId });
  if (error) unreadable('readInvoicePaymentSnapshot', error);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.map((r) => ({
    accountId: String(r.account_id),
    kind: String(r.kind ?? ''),
    label: String(r.label ?? ''),
    instructions: Object.fromEntries(Object.entries((r.instructions ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
    changedSinceIssue: r.changed_since_issue === true,
    noLongerActive: r.no_longer_active === true,
  }));
}
