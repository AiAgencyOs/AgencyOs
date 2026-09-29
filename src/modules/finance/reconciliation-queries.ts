import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads over finance.reconciliations and reconciliation_items — Doc 15 §15,
 * gap row 053. Every read refuses on failure (G-054): an unreadable period
 * must not render as a period with nothing in it.
 */

export type ReconciliationRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  accountId: string | null;
  source: string;
  openedBy: string | null;
  openedAt: string;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedAt: string | null;
  /** Items, and how many still lack a reason — the exception queue's size. */
  itemCount: number;
  unresolvedCount: number;
};

export type ReconciliationItemRow = {
  id: string;
  reconciliationId: string;
  statementLine: string;
  statementDate: string;
  amountMinor: number;
  reference: string | null;
  finding: string;
  paymentId: string | null;
  reason: string | null;
  createdAt: string;
};

/** Every period, open first then newest, with its queue size. */
export async function listReconciliations(limit = 100): Promise<ReconciliationRow[]> {
  const supabase = await createClient();

  const { data, error: reconError } = await supabase
    .schema('finance')
    .from('reconciliations')
    .select('id, period_start, period_end, account_id, source, opened_by, opened_at, status, closed_by, closed_at')
    .order('status', { ascending: false })
    .order('period_start', { ascending: false })
    .limit(limit);
  if (reconError) unreadable('listReconciliations', reconError);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: items, error: itemsError } = await supabase
    .schema('finance')
    .from('reconciliation_items')
    .select('reconciliation_id, finding, reason')
    .in('reconciliation_id', rows.map((r) => r.id));
  if (itemsError) unreadable('listReconciliations.items', itemsError);

  const counts = new Map<string, { total: number; unresolved: number }>();
  for (const i of items ?? []) {
    const c = counts.get(i.reconciliation_id) ?? { total: 0, unresolved: 0 };
    c.total += 1;
    if (i.finding !== 'matched' && !(i.reason ?? '').trim()) c.unresolved += 1;
    counts.set(i.reconciliation_id, c);
  }

  return rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    accountId: r.account_id,
    source: r.source,
    openedBy: r.opened_by,
    openedAt: r.opened_at,
    status: r.status === 'closed' ? 'closed' : 'open',
    closedBy: r.closed_by,
    closedAt: r.closed_at,
    itemCount: counts.get(r.id)?.total ?? 0,
    unresolvedCount: counts.get(r.id)?.unresolved ?? 0,
  }));
}

/** The lines of one period, in statement order. */
export async function listReconciliationItems(reconciliationId: string): Promise<ReconciliationItemRow[]> {
  const supabase = await createClient();

  const { data, error: itemsError } = await supabase
    .schema('finance')
    .from('reconciliation_items')
    .select('id, reconciliation_id, statement_line, statement_date, amount_minor, reference, finding, payment_id, reason, created_at')
    .eq('reconciliation_id', reconciliationId)
    .order('statement_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (itemsError) unreadable('listReconciliationItems', itemsError);

  return (data ?? []).map((i) => ({
    id: i.id,
    reconciliationId: i.reconciliation_id,
    statementLine: i.statement_line,
    statementDate: i.statement_date,
    amountMinor: i.amount_minor,
    reference: i.reference,
    finding: i.finding,
    paymentId: i.payment_id,
    reason: i.reason,
    createdAt: i.created_at,
  }));
}

export type MatchProposal = { outcome: 'matched' | 'no_candidate' | 'ambiguous' | 'not_found'; paymentId: string | null; candidates: number };

/**
 * What `finance.propose_match` offers for one line — §29's auto-match. It
 * proposes and writes nothing; accepting it is `resolveReconciliationItem`.
 */
export async function readMatchProposal(itemId: string): Promise<MatchProposal> {
  const supabase = await createClient();

  const { data, error: matchError } = await supabase.schema('finance').rpc('propose_match', { p_item_id: itemId });
  if (matchError) unreadable('readMatchProposal', matchError);

  const row = Array.isArray(data) ? data[0] : data;
  const outcome = row?.outcome;
  return {
    outcome: outcome === 'matched' || outcome === 'no_candidate' || outcome === 'ambiguous' ? outcome : 'not_found',
    paymentId: row?.payment_id ?? null,
    candidates: Number(row?.candidates ?? 0),
  };
}
