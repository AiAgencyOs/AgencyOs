import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for the audit-log viewer — area M of the Admin control-center audit.
 *
 * "Who changed what, and when." The append-only `audit.audit_log` already holds
 * it; nothing in the product showed it. This is RLS-scoped: `audit_log_select`
 * admits only an owner or ops_admin of the row's own organization, so this
 * reader carries no extra gate of its own — the database answers the "may I
 * read this?" question, the same one /operations relies on.
 *
 * `unreadable()` on a failed read for the G-054 reason the operations page holds:
 * a viewer that renders an empty list because the database did not answer says
 * "nothing happened" at the exact moment it has no idea.
 */

export type AuditEntry = {
  id: number;
  action: string;
  subjectType: string | null;
  subjectId: string | null;
  actorType: string | null;
  actorId: string | null;
  correlationId: string | null;
  createdAt: string;
  /** Whether a before/after diff exists — the detail itself is not summarised to the list. */
  hasChange: boolean;
};

export type AuditFilter = {
  /** Case-insensitive prefix on the action, e.g. "organization." or "consent." */
  actionPrefix?: string;
  subjectType?: string;
  limit?: number;
};

const MAX_LIMIT = 200;

export async function readAuditLog(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('audit')
    .from('audit_log')
    .select('id, action, subject_type, subject_id, actor_type, actor_id, correlation_id, created_at, before, after')
    .order('created_at', { ascending: false })
    .limit(Math.min(filter.limit ?? 100, MAX_LIMIT));

  if (filter.actionPrefix && filter.actionPrefix.trim()) {
    // PostgREST `like` with a trailing wildcard; the input is a filter facet,
    // not free SQL, and RLS bounds every row to the caller's org regardless.
    query = query.like('action', `${filter.actionPrefix.trim()}%`);
  }
  if (filter.subjectType && filter.subjectType.trim()) {
    query = query.eq('subject_type', filter.subjectType.trim());
  }

  const { data, error } = await query;
  if (error) unreadable('readAuditLog', error);

  return (data ?? []).map((r) => ({
    id: r.id,
    action: r.action,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    hasChange: r.before !== null || r.after !== null,
  }));
}

/**
 * The distinct action prefixes present, for the filter chips — e.g.
 * "organization", "consent", "message". Read cheaply from a bounded recent
 * window rather than a full scan; it is a convenience, not an authority.
 */
export async function auditActionPrefixes(): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('audit')
    .from('audit_log')
    .select('action')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return [];
  const prefixes = new Set<string>();
  for (const r of data ?? []) {
    const dot = r.action.indexOf('.');
    prefixes.add(dot > 0 ? r.action.slice(0, dot) : r.action);
  }
  return [...prefixes].sort();
}
