import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * The override centre — SCR-068, `core.overrides` (20261001150000).
 *
 * Every domain override — a project started before it was ready, a scope
 * baseline unfrozen, a release paid for by override — lands here by a
 * trigger on the audit trail, in the transaction that took it; this file
 * only reads them. The one write is `recordManualOverride`, for an
 * exception no domain door covers: owner only, a reason of ten characters
 * or more, `manual.<slug>` as its kind, audited as override.recorded.
 */

export type OverrideRow = {
  id: string;
  subjectType: string;
  subjectId: string | null;
  kind: string;
  reason: string;
  actorName: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export const OVERRIDE_KIND_LABEL: Record<string, string> = {
  'project.start_before_ready': 'Project started before ready',
  'scope.unfreeze': 'Scope baseline unfrozen',
  'release.payment_override': 'Release signed off over an unpaid invoice',
};

export function overrideKindLabel(kind: string): string {
  if (OVERRIDE_KIND_LABEL[kind]) return OVERRIDE_KIND_LABEL[kind] as string;
  if (kind.startsWith('manual.')) return `Manual exception · ${kind.slice(7).replace(/_/g, ' ')}`;
  return kind;
}

export type OverrideFilters = { kind?: string; limit?: number };

export async function listOverrides(filters: OverrideFilters = {}): Promise<OverrideRow[]> {
  const supabase = await createClient();
  let query = supabase
    .schema('core')
    .from('overrides')
    .select('id, subject_type, subject_id, kind, reason, actor_id, expires_at, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 200);
  if (filters.kind) query = query.eq('kind', filters.kind);
  const { data, error } = await query;
  if (error) unreadable('listOverrides', error);

  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
    if (usersError) unreadable('listOverrides.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    kind: r.kind,
    reason: r.reason,
    actorName: r.actor_id ? (names.get(r.actor_id) ?? r.actor_id.slice(0, 8)) : null,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

/** The distinct kinds on record, for the filter rail — from the rows, never a fixed list. */
export async function listOverrideKinds(): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('overrides').select('kind').order('created_at', { ascending: false }).limit(1_000);
  if (error) unreadable('listOverrideKinds', error);
  return [...new Set((data ?? []).map((r) => r.kind))].sort();
}

export async function recordManualOverride(input: {
  subjectType: string;
  subjectId?: string;
  kind: string;
  reason: string;
  expiresAt?: string;
}): Promise<Result<{ id: string }>> {
  const subjectType = input.subjectType.trim();
  const reason = input.reason.trim();
  const slug = input.kind.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z_]{1,40}$/.test(subjectType)) return err('VALIDATION', 'Say what kind of thing the exception is about (letters and underscores).');
  if (!slug || !/^[a-z][a-z0-9_]*$/.test(slug)) return err('VALIDATION', 'Give the exception a short kind, like "late_invoice".');
  if (reason.length < 10) return err('VALIDATION', 'Say why, in at least ten characters.');
  if (reason.length > 2000) return err('VALIDATION', 'Keep the reason under 2000 characters.');
  if (input.subjectId && !/^[0-9a-f-]{36}$/i.test(input.subjectId)) return err('VALIDATION', 'The subject id must be a UUID, or empty.');
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) return err('VALIDATION', 'The expiry is not a date.');

  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', 'Only the owner may record an exception.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('record_manual_override', {
    p_subject_type: subjectType,
    ...(input.subjectId ? { p_subject_id: input.subjectId } : {}),
    p_kind: `manual.${slug}`,
    p_reason: reason,
    ...(input.expiresAt ? { p_expires_at: new Date(input.expiresAt).toISOString() } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordManualOverride', detail: error.message }));
    return err('INTERNAL', 'Could not record the exception.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ id: row.id as string });
    case 'no_reason':
      return err('VALIDATION', 'Say why, in at least ten characters.');
    case 'bad_kind':
      return err('VALIDATION', 'Give the exception a short kind, like "late_invoice".');
    case 'bad_subject':
      return err('VALIDATION', 'Say what kind of thing the exception is about.');
    default:
      return err('FORBIDDEN', 'Only the owner may record an exception.');
  }
}
