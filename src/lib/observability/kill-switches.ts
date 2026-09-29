import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Emergency controls — SCR-068, `core.kill_switches` (20261001150000).
 *
 * Three switches an owner throws with a reason: agents_paused (no agent job
 * is claimed or continued past its next step), outbound_paused (every send
 * through crm.send_outbound_message is refused), jobs_paused (no job of any
 * kind is claimed). Owner only here (`hasRole(context, 'owner')`, the
 * union) and again inside `core.set_kill_switch`; audited as
 * kill_switch.engaged / kill_switch.released.
 */

export const KILL_SWITCHES = ['agents_paused', 'outbound_paused', 'jobs_paused'] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number];

export const KILL_SWITCH_LABEL: Record<KillSwitch, string> = {
  agents_paused: 'Pause AI agents',
  outbound_paused: 'Pause outbound messaging',
  jobs_paused: 'Pause the job queue',
};

export const KILL_SWITCH_EFFECT: Record<KillSwitch, string> = {
  agents_paused: 'No agent job is claimed; a running agent stops at its next step and its job returns to the queue.',
  outbound_paused: 'Every WhatsApp send is refused at the chokepoint — quotations, reminders, announcements, follow-ups — until released.',
  jobs_paused: 'No job of any kind is claimed by the runner. Work waits; nothing is lost.',
};

export type KillSwitchRow = {
  switch: KillSwitch;
  active: boolean;
  reason: string | null;
  setAt: string | null;
  setByName: string | null;
};

export async function listKillSwitches(): Promise<KillSwitchRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('kill_switches').select('switch, active, reason, set_at, set_by');
  if (error) unreadable('listKillSwitches', error);

  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.set_by).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
    if (usersError) unreadable('listKillSwitches.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }
  const byKey = new Map(rows.map((r) => [r.switch, r]));
  return KILL_SWITCHES.map((key) => {
    const r = byKey.get(key);
    return {
      switch: key,
      active: r?.active ?? false,
      reason: r?.reason ?? null,
      setAt: r?.set_at ?? null,
      setByName: r?.set_by ? (names.get(r.set_by) ?? r.set_by.slice(0, 8)) : null,
    };
  });
}

/** True when any switch is engaged — for the Operations strip and the banner. */
export async function anyKillSwitchActive(): Promise<KillSwitchRow[]> {
  return (await listKillSwitches()).filter((s) => s.active);
}

export async function setKillSwitch(input: { switch: string; active: boolean; reason: string }): Promise<Result<{ switch: KillSwitch; active: boolean }>> {
  if (!(KILL_SWITCHES as readonly string[]).includes(input.switch)) return err('VALIDATION', 'Not an emergency control this system has.');
  const reason = input.reason.trim();
  if (!reason) return err('VALIDATION', 'Say why — the reason is what the audit row and the banner carry.');
  if (reason.length > 500) return err('VALIDATION', 'Keep the reason under 500 characters.');

  const context = await requireInternal();
  if (!hasRole(context, 'owner') || !can(context, 'organization.settings')) {
    return err('FORBIDDEN', 'Only the owner may throw an emergency control.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('set_kill_switch', {
    p_switch: input.switch,
    p_active: input.active,
    p_reason: reason,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setKillSwitch', detail: error.message }));
    return err('INTERNAL', 'Could not change the emergency control.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ switch: input.switch as KillSwitch, active: input.active });
    case 'unchanged':
      return err('CONFLICT', input.active ? 'That control is already engaged.' : 'That control is already released.');
    case 'no_reason':
      return err('VALIDATION', 'Say why.');
    case 'bad_switch':
      return err('VALIDATION', 'Not an emergency control this system has.');
    default:
      return err('FORBIDDEN', 'Only the owner may throw an emergency control.');
  }
}
