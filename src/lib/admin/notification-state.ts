import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Notification state — SCR-003's snooze / resolve / assign / mark-read and
 * their history (`core.notification_states`, `core.notification_state_events`,
 * migration 20260929150000).
 *
 * The Action Center's rows are DERIVED live from six sources and stay that
 * way; this table only annotates them, keyed by the row's own stable key
 * (`approval-<id>`, `task-<id>` …). A resolved approval that is still
 * pending is still pending — it is simply not shown as needing this person.
 *
 * Lives in `lib/admin` like `clients.ts` and `saved-views.ts`: a core table
 * with no owning business module, read directly (ARCHITECTURE.md §2).
 */

export const NOTIFICATION_STATES = ['unread', 'read', 'snoozed', 'resolved'] as const;
export type NotificationStateValue = (typeof NOTIFICATION_STATES)[number];

export type NotificationState = {
  itemKey: string;
  state: NotificationStateValue;
  snoozedUntil: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  note: string | null;
  updatedAt: string;
  /** True when this row was written by somebody else and assigned to the caller. */
  assignedToMe: boolean;
  /** Who wrote the annotation (the caller, unless `assignedToMe`). */
  byName: string | null;
};

export type NotificationEvent = {
  id: string;
  itemKey: string;
  event: string;
  fromState: string | null;
  toState: string;
  snoozedUntil: string | null;
  assignedToName: string | null;
  note: string | null;
  byName: string | null;
  createdAt: string;
};

async function userNames(supabase: Awaited<ReturnType<typeof createClient>>, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', unique);
  if (error) unreadable('notificationState.users', error);
  return new Map((data ?? []).map((u) => [u.id, u.full_name || u.email]));
}

/**
 * Whether a state still needs the person: unread always does, read and
 * resolved never do, and a snooze does again once its end has passed.
 */
export function needsAttention(state: NotificationState | null, now = Date.now()): boolean {
  if (!state) return true;
  if (state.state === 'unread') return true;
  if (state.state === 'snoozed') return !state.snoozedUntil || new Date(state.snoozedUntil).getTime() <= now;
  return false;
}

/**
 * The caller's own annotations, plus rows other people assigned to the
 * caller (which count as the caller's to act on). Own rows win when both
 * exist for one key.
 */
export async function readNotificationStates(): Promise<Map<string, NotificationState>> {
  const context = await requireInternal();
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('notification_states')
    .select('item_key, user_id, state, snoozed_until, assigned_to, note, updated_at')
    .or(`user_id.eq.${context.userId},assigned_to.eq.${context.userId}`)
    .order('updated_at', { ascending: false });
  if (error) unreadable('readNotificationStates', error);

  const rows = data ?? [];
  const names = await userNames(
    supabase,
    rows.flatMap((r) => [r.user_id, ...(r.assigned_to ? [r.assigned_to] : [])]),
  );

  const map = new Map<string, NotificationState>();
  // Own rows first, then assignments for keys the caller has not annotated.
  const ordered = [...rows.filter((r) => r.user_id === context.userId), ...rows.filter((r) => r.user_id !== context.userId)];
  for (const r of ordered) {
    const own = r.user_id === context.userId;
    if (map.has(r.item_key)) continue;
    map.set(r.item_key, {
      itemKey: r.item_key,
      state: r.state as NotificationStateValue,
      snoozedUntil: r.snoozed_until,
      assignedTo: r.assigned_to,
      assignedToName: r.assigned_to ? (names.get(r.assigned_to) ?? null) : null,
      note: r.note,
      updatedAt: r.updated_at,
      assignedToMe: !own,
      byName: names.get(r.user_id) ?? null,
    });
  }
  return map;
}

/** The history — what the caller did, and what was assigned to them — newest first. */
export async function listNotificationHistory(limit = 40): Promise<NotificationEvent[]> {
  const context = await requireInternal();
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('notification_state_events')
    .select('id, item_key, user_id, event, from_state, to_state, snoozed_until, assigned_to, note, created_at')
    .or(`user_id.eq.${context.userId},assigned_to.eq.${context.userId}`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listNotificationHistory', error);

  const rows = data ?? [];
  const names = await userNames(
    supabase,
    rows.flatMap((r) => [r.user_id, ...(r.assigned_to ? [r.assigned_to] : [])]),
  );

  return rows.map((r) => ({
    id: r.id,
    itemKey: r.item_key,
    event: r.event,
    fromState: r.from_state,
    toState: r.to_state,
    snoozedUntil: r.snoozed_until,
    assignedToName: r.assigned_to ? (names.get(r.assigned_to) ?? null) : null,
    note: r.note,
    byName: names.get(r.user_id) ?? null,
    createdAt: r.created_at,
  }));
}

export const setNotificationStateSchema = z
  .object({
    itemKeys: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
    state: z.enum(NOTIFICATION_STATES),
    snoozedUntil: z.iso.datetime({ offset: true }).nullable().default(null),
    assignedTo: z.uuid().nullable().default(null),
    note: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((v) => v.state !== 'snoozed' || v.snoozedUntil !== null, { message: 'A snooze needs an end.', path: ['snoozedUntil'] });

export type SetNotificationStateInput = z.input<typeof setNotificationStateSchema>;

/**
 * The door. Every internal role has an inbox, so the gate is
 * `requireInternal` and then the database (`core.set_notification_state`
 * is security invoker: RLS decides again, and it writes the history and —
 * for a resolution or an assignment — the audit row in the same
 * transaction). No capability is named because none of the matrix's
 * capabilities means "may keep an inbox", and every internal role may.
 */
export async function setNotificationState(input: SetNotificationStateInput): Promise<Result<{ count: number }>> {
  const parsed = setNotificationStateSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid notification state.');
  }
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_notification_state', {
    p_organization_id: context.organizationId,
    p_item_keys: parsed.data.itemKeys,
    p_state: parsed.data.state,
    ...(parsed.data.snoozedUntil ? { p_snoozed_until: parsed.data.snoozedUntil } : {}),
    ...(parsed.data.assignedTo ? { p_assigned_to: parsed.data.assignedTo } : {}),
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setNotificationState', detail: error.message }));
    return err('INTERNAL', 'The notification state could not be saved.');
  }

  const outcome = (data as { outcome: string }[] | null)?.[0]?.outcome ?? 'no answer';
  switch (outcome) {
    case 'ok':
      return ok({ count: parsed.data.itemKeys.length });
    case 'forbidden':
      return err('FORBIDDEN', 'You do not have permission to change notifications.');
    case 'not_a_member':
      return err('CONFLICT', 'That person is not an active member of this organization.');
    case 'invalid_snooze':
      return err('VALIDATION', 'A snooze must end in the future.');
    default:
      return err('INTERNAL', `The database refused the change (${outcome}).`);
  }
}
