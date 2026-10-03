import 'server-only';

import { ilikeAny } from '@/lib/db/search';
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
  /** The recorded snapshots, as written. Rendered on demand, never summarised. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * The keys whose value differs between the two snapshots — what a reader
 * opening an entry wants first. A key present on one side only counts.
 */
export function changedKeys(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)).sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : value === null || value === undefined ? null : { value };
}

export type AuditFilter = {
  /** Entries about one row — a meeting's own trail on A09. RLS bounds the read to the caller's org regardless. */
  subjectId?: string;
  /** Case-insensitive prefix on the action, e.g. "organization." or "consent." */
  actionPrefix?: string;
  subjectType?: string;
  /** Entries sharing one correlation id — the audit half of an event chain (SCR-066). */
  correlationId?: string;
  /** Only entries by this actor type — person, agent, system. */
  actorType?: string;
  /** ISO date bounds on created_at, inclusive/exclusive. */
  from?: string;
  to?: string;
  limit?: number;
  /** 1-indexed page for the paged reader; with `pageSize` it replaces `limit`. */
  page?: number;
  pageSize?: number;
  /** Only these exact actions (the privileged-changes list uses it). */
  actions?: readonly string[];
  /** Search within domain (bucket G-3): the action or subject type text. Server-side. */
  q?: string;
};

const MAX_LIMIT = 200;

export const AUDIT_PAGE_SIZE = 50;

/**
 * Every entry the filter matches, one page at a time, with the true total —
 * not a fixed newest-100. `withCount: false` skips the exact total for a
 * caller that wants only the newest few (a record's own trail).
 */
export async function readAuditPage(
  filter: AuditFilter & { withCount?: boolean } = {},
): Promise<{ entries: AuditEntry[]; total: number; page: number; pageCount: number }> {
  const supabase = await createClient();
  const pageSize = Math.min(Math.max(1, filter.pageSize ?? filter.limit ?? AUDIT_PAGE_SIZE), MAX_LIMIT);
  const withCount = filter.withCount !== false;

  const run = async (page: number) => {
    const offset = (page - 1) * pageSize;
    let query = supabase
      .schema('audit')
      .from('audit_log')
      .select('id, action, subject_type, subject_id, actor_type, actor_id, correlation_id, created_at, before, after', withCount ? { count: 'exact' } : undefined)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (filter.subjectId) query = query.eq('subject_id', filter.subjectId);
    if (filter.correlationId) query = query.eq('correlation_id', filter.correlationId);
    if (filter.actions && filter.actions.length > 0) query = query.in('action', [...filter.actions]);

    if (filter.actionPrefix && filter.actionPrefix.trim()) {
      // PostgREST `like` with a trailing wildcard; the input is a filter facet,
      // not free SQL, and RLS bounds every row to the caller's org regardless.
      query = query.like('action', `${filter.actionPrefix.trim()}%`);
    }
    if (filter.subjectType && filter.subjectType.trim()) {
      query = query.eq('subject_type', filter.subjectType.trim());
    }
    if (filter.actorType && filter.actorType.trim()) {
      query = query.eq('actor_type', filter.actorType.trim());
    }
    if (filter.from) query = query.gte('created_at', filter.from);
    if (filter.to) query = query.lt('created_at', filter.to);
    if (filter.q) query = query.or(ilikeAny(['action', 'subject_type'], filter.q));

    const { data, error, count } = await query;
    if (error) unreadable('readAuditLog', error);

    const entries = (data ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      actorType: r.actor_type,
      actorId: r.actor_id,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
      hasChange: r.before !== null || r.after !== null,
      before: asRecord(r.before),
      after: asRecord(r.after),
    }));
    return { entries, total: count ?? entries.length };
  };

  const requested = Math.max(1, Math.floor(filter.page ?? 1));
  const first = await run(requested);
  const pageCount = Math.max(1, Math.ceil(first.total / pageSize));
  if (requested <= pageCount || !withCount) return { entries: first.entries, total: first.total, page: requested, pageCount };
  // A stale ?page= past the end lands on the last real page.
  const last = await run(pageCount);
  return { entries: last.entries, total: last.total, page: pageCount, pageCount };
}

export async function readAuditLog(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  return (await readAuditPage({ ...filter, page: 1, pageSize: Math.min(filter.limit ?? 100, MAX_LIMIT), withCount: false })).entries;
}

/** Names for actor ids, from `core.users` — a person is shown by name, never an id fragment. Unknown ids are absent. */
export async function actorNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', unique);
  if (error) unreadable('actorNames', error);
  for (const u of data ?? []) names.set(u.id, u.full_name ?? u.email);
  return names;
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

/** The distinct subject types and actor types in the recent window — filter chips, not an authority. */
export async function auditFacets(): Promise<{ subjectTypes: string[]; actorTypes: string[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('audit')
    .from('audit_log')
    .select('subject_type, actor_type')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { subjectTypes: [], actorTypes: [] };
  const subjectTypes = new Set<string>();
  const actorTypes = new Set<string>();
  for (const r of data ?? []) {
    if (r.subject_type) subjectTypes.add(r.subject_type);
    if (r.actor_type) actorTypes.add(r.actor_type);
  }
  return { subjectTypes: [...subjectTypes].sort(), actorTypes: [...actorTypes].sort() };
}
