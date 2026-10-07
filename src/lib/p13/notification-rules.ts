import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { asRows, looseSchema } from './loose-client';
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENT_CLASSES } from './notification-gate';

export type NotificationRuleRow = {
  event_class: string;
  channel: string;
  enabled: boolean;
  min_interval_seconds: number;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
  critical_bypasses_quiet: boolean;
};

export async function listNotificationRules(): Promise<NotificationRuleRow[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core')
    .from('p13_notification_rules')
    .select('event_class, channel, enabled, min_interval_seconds, quiet_start, quiet_end, timezone, critical_bypasses_quiet')
    .order('event_class')
    .limit(200);
  if (error) unreadable('listNotificationRules', error);
  return asRows(data) as unknown as NotificationRuleRow[];
}

const REFUSAL: Record<string, string> = {
  not_authorized: 'Only an owner or ops admin may change notification rules.',
  quiet_hours_need_both_ends: 'Quiet hours need both a start and an end.',
  quiet_hours_empty: 'Quiet hours cannot start and end at the same time.',
  invalid_timezone: 'That timezone is not recognised.',
  invalid_interval: 'The interval must be between 0 seconds and 7 days.',
  invalid_event_class: 'Unknown event class.',
  invalid_channel: 'Unknown channel.',
};

export type SetRuleInput = {
  eventClass: string;
  channel: string;
  enabled: boolean;
  minIntervalSeconds: number;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
  criticalBypassesQuiet: boolean;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `core.p13_set_notification_rule` (owner / ops admin, audited). */
export async function setNotificationRule(input: SetRuleInput): Promise<Result<null>> {
  if (!(NOTIFICATION_EVENT_CLASSES as readonly string[]).includes(input.eventClass)) return err('VALIDATION', REFUSAL.invalid_event_class ?? 'Unknown event class.');
  if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(input.channel)) return err('VALIDATION', REFUSAL.invalid_channel ?? 'Unknown channel.');
  if ((input.quietStart && !TIME.test(input.quietStart)) || (input.quietEnd && !TIME.test(input.quietEnd))) return err('VALIDATION', 'Quiet hours are written as HH:MM.');
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'You do not have permission to change notification rules.');
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core').rpc('p13_set_notification_rule', {
    p_event_class: input.eventClass,
    p_channel: input.channel,
    p_enabled: input.enabled,
    p_min_interval_seconds: input.minIntervalSeconds,
    p_quiet_start: input.quietStart || null,
    p_quiet_end: input.quietEnd || null,
    p_timezone: input.timezone,
    p_critical_bypasses_quiet: input.criticalBypassesQuiet,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setNotificationRule', detail: error.message }));
    return err('INTERNAL', 'Could not save the rule.');
  }
  return data === 'set' ? ok(null) : err(data === 'not_authorized' ? 'FORBIDDEN' : 'VALIDATION', REFUSAL[String(data)] ?? 'The database refused the rule.');
}
