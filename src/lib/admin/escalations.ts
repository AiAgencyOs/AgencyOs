import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { ESCALATION_ROLES, type Escalation, type EscalationRole, type EscalationState } from './escalation-types';

/**
 * Escalations — SCR-001 "Acknowledge / escalate an operational item" and
 * SCR-003 "Escalate to owner or ops admin" (`core.escalations`, migration
 * 20261001100000). Until bucket F the inbox's Escalate was a link to
 * /approvals and nothing recorded that anybody escalated anything; this is
 * the record, with the two doors that write it.
 *
 * The subject is an Action Center row's stable key — the same string
 * `app/(internal)/notifications/action-items.ts` derives — so an
 * escalation follows the row it was raised on wherever it is shown (the
 * dashboard feed, the inbox, the drawer). Lives in `lib/admin` like
 * `notification-state.ts`: a core table with no owning business module.
 */

async function userNames(supabase: Awaited<ReturnType<typeof createClient>>, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', unique);
  if (error) unreadable('escalations.users', error);
  return new Map((data ?? []).map((u) => [u.id, u.full_name || u.email]));
}

const SELECT =
  'id, subject_type, subject_key, title, from_user, to_role, reason, state, acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution_note, created_at';

type Row = {
  id: string;
  subject_type: string;
  subject_key: string;
  title: string;
  from_user: string;
  to_role: string;
  reason: string;
  state: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
};

async function toEscalations(supabase: Awaited<ReturnType<typeof createClient>>, rows: Row[]): Promise<Escalation[]> {
  const names = await userNames(
    supabase,
    rows.flatMap((r) => [r.from_user, ...(r.acknowledged_by ? [r.acknowledged_by] : []), ...(r.resolved_by ? [r.resolved_by] : [])]),
  );
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subject_type,
    subjectKey: r.subject_key,
    title: r.title,
    fromUserName: names.get(r.from_user) ?? null,
    toRole: r.to_role as EscalationRole,
    reason: r.reason,
    state: r.state as EscalationState,
    acknowledgedByName: r.acknowledged_by ? (names.get(r.acknowledged_by) ?? null) : null,
    acknowledgedAt: r.acknowledged_at,
    resolvedByName: r.resolved_by ? (names.get(r.resolved_by) ?? null) : null,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at,
  }));
}

/** Every escalation not yet resolved, newest first — the owner's and ops admin's queue. */
export async function listOpenEscalations(limit = 100): Promise<Escalation[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('escalations')
    .select(SELECT)
    .neq('state', 'resolved')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listOpenEscalations', error);
  return toEscalations(supabase, (data ?? []) as Row[]);
}

/** The latest escalation per Action Center key (open or acknowledged), so a row can say "escalated to the owner". */
export async function readEscalationsByKey(): Promise<Map<string, Escalation>> {
  const rows = await listOpenEscalations(500);
  const map = new Map<string, Escalation>();
  for (const e of rows) if (!map.has(e.subjectKey)) map.set(e.subjectKey, e);
  return map;
}

export const escalateSchema = z.object({
  subjectType: z.string().regex(/^[a-z_]{1,40}$/, 'Unknown item type.'),
  subjectKey: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  toRole: z.enum(ESCALATION_ROLES),
  reason: z.string().trim().min(1, 'Say why this needs escalating.').max(2000),
});

export type EscalateInput = z.input<typeof escalateSchema>;

/**
 * The raising door. Every internal role may escalate (an inbox is every
 * internal role's), so the gate is `requireInternal` and then the database:
 * `core.escalate` is security invoker, so `escalations_insert` decides again
 * and the audit row (`escalation.raised`) commits with the change.
 */
export async function escalate(input: EscalateInput): Promise<Result<{ escalationId: string; alreadyOpen: boolean }>> {
  const parsed = escalateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid escalation.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('escalate', {
    p_organization_id: context.organizationId,
    p_subject_type: parsed.data.subjectType,
    p_subject_key: parsed.data.subjectKey,
    p_title: parsed.data.title,
    p_to_role: parsed.data.toRole,
    p_reason: parsed.data.reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'escalate', detail: error.message }));
    return err('INTERNAL', 'The escalation could not be recorded.');
  }
  const row = (data as { outcome: string; escalation_id: string | null }[] | null)?.[0];
  switch (row?.outcome) {
    case 'raised':
      return ok({ escalationId: row.escalation_id!, alreadyOpen: false });
    case 'already_open':
      return ok({ escalationId: row.escalation_id!, alreadyOpen: true });
    case 'forbidden':
      return err('FORBIDDEN', 'You do not have permission to escalate.');
    case 'invalid':
      return err('VALIDATION', 'The escalation is missing a reason, a title or a role.');
    default:
      return err('INTERNAL', `The database refused the escalation (${row?.outcome ?? 'no answer'}).`);
  }
}

export const acknowledgeEscalationSchema = z.object({
  escalationId: z.uuid(),
  state: z.enum(['acknowledged', 'resolved']),
  note: z.string().trim().max(2000).nullable().default(null),
});

export type AcknowledgeEscalationInput = z.input<typeof acknowledgeEscalationSchema>;

/**
 * The answering door — owner or ops admin (`organization.settings` or
 * `audit.read` resolve to exactly those two, and `core.is_admin()` says it
 * again inside `core.acknowledge_escalation`).
 */
export async function acknowledgeEscalation(input: AcknowledgeEscalationInput): Promise<Result<{ state: EscalationState }>> {
  const parsed = acknowledgeEscalationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  if (!can(context, 'audit.read')) return err('FORBIDDEN', 'Only the owner or the ops admin may answer an escalation.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('acknowledge_escalation', {
    p_organization_id: context.organizationId,
    p_escalation_id: parsed.data.escalationId,
    p_state: parsed.data.state,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'acknowledgeEscalation', detail: error.message }));
    return err('INTERNAL', 'The escalation could not be updated.');
  }
  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome ?? 'no answer';
  switch (outcome) {
    case 'acknowledged':
    case 'resolved':
      return ok({ state: outcome });
    case 'forbidden':
      return err('FORBIDDEN', 'Only the owner or the ops admin may answer an escalation.');
    case 'not_found':
      return err('NOT_FOUND', 'That escalation no longer exists.');
    case 'already':
      return err('CONFLICT', 'That escalation was already answered.');
    default:
      return err('INTERNAL', `The database refused the change (${outcome}).`);
  }
}
