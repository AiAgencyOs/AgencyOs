import type { createAdminClient } from '@/lib/db/admin';

import { firstRow, looseSchema } from './loose-client';

/**
 * P1-BLUEPRINT-032 (A26): every sender asks the SAME question before it notifies, so the modules cannot drift apart:
 *
 *   `const verdict = await notificationVerdict(admin, { organizationId, eventClass: 'meeting_reminder', channel: 'whatsapp', severity: 'normal', lastSentAt })`
 *
 * The answer is `core.p13_notification_decision`. If the rules cannot be read the verdict is ALLOWED with `degraded: true` (the module's own default
 * applies and the log says so): a rules outage must not silence an incident. A sender that wants to be stricter for client-facing sends may treat
 * `degraded` as "hold".
 */
type Admin = ReturnType<typeof createAdminClient>;

export const NOTIFICATION_EVENT_CLASSES = ['admin_alert', 'sales', 'approval', 'meeting_reminder', 'escalation', 'incident', 'client_followup'] as const;
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp'] as const;
export type NotificationEventClass = (typeof NOTIFICATION_EVENT_CLASSES)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationVerdict = { allowed: boolean; reason: 'ok' | 'no_rule' | 'disabled' | 'quiet_hours' | 'too_soon' | 'unreadable'; degraded: boolean };

const REASONS = new Set(['ok', 'no_rule', 'disabled', 'quiet_hours', 'too_soon']);

export async function notificationVerdict(
  admin: Admin,
  input: { organizationId: string; eventClass: NotificationEventClass; channel: NotificationChannel; severity?: 'normal' | 'critical'; at?: Date; lastSentAt?: Date | null },
): Promise<NotificationVerdict> {
  try {
    const { data, error } = await looseSchema(admin as never, 'core').rpc('p13_notification_decision', {
      p_organization_id: input.organizationId,
      p_event_class: input.eventClass,
      p_channel: input.channel,
      p_severity: input.severity ?? 'normal',
      p_at: (input.at ?? new Date()).toISOString(),
      p_last_sent_at: input.lastSentAt ? input.lastSentAt.toISOString() : null,
    });
    if (error) throw new Error(error.message);
    const row = firstRow(data);
    if (!row || typeof row.allowed !== 'boolean' || !REASONS.has(String(row.reason))) throw new Error('p13_notification_decision answered nothing usable');
    return { allowed: row.allowed, reason: row.reason as NotificationVerdict['reason'], degraded: false };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', scope: 'notification-gate', degraded: true, detail: e instanceof Error ? e.message : 'unknown' }));
    return { allowed: true, reason: 'unreadable', degraded: true };
  }
}
