import type { createAdminClient } from '@/lib/db/admin';

import { notificationVerdict, type NotificationChannel, type NotificationEventClass } from './notification-gate';

/**
 * W8 wiring: the question every outbound sender asks before it notifies, answered in the shape a job handler returns.
 *
 *   `const held = await heldByNotificationRules(admin, { organizationId, eventClass: 'approval', channel: 'whatsapp' }); if (held) return held;`
 *
 * null means "go". Otherwise the handler returns the result unchanged:
 *   - quiet hours   -> a RETRYABLE failure, so the runner tries again later and the notice is delayed, never dropped;
 *   - disabled      -> a settled success (`held_disabled`): the organization switched this class off, nothing is wrong;
 *   - too soon      -> a settled success (`held_too_soon`): the minimum interval is a rate limit, the next event will carry the news;
 *   - degraded      -> only when `clientFacing` and the rules could not be read: held (retryable), because an unreadable rulebook must not become a
 *                      message to a client. An INTERNAL notice still goes through when the rules are unreadable, so an outage never silences an incident.
 *
 * `severity: 'critical'` passes quiet hours inside the database function itself (see `p13_notification_decision`).
 */
type Admin = ReturnType<typeof createAdminClient>;

export type HeldResult =
  | { status: 'succeeded'; outcome: string; detail: string }
  | { status: 'failed'; permanent: false; detail: string };

export async function heldByNotificationRules(
  admin: Admin,
  input: {
    organizationId: string;
    eventClass: NotificationEventClass;
    channel?: NotificationChannel;
    severity?: 'normal' | 'critical';
    clientFacing?: boolean;
    lastSentAt?: Date | null;
    at?: Date;
  },
): Promise<HeldResult | null> {
  const verdict = await notificationVerdict(admin, {
    organizationId: input.organizationId,
    eventClass: input.eventClass,
    channel: input.channel ?? 'whatsapp',
    severity: input.severity,
    lastSentAt: input.lastSentAt,
    at: input.at,
  });
  if (verdict.degraded) {
    if (input.clientFacing) return { status: 'failed', permanent: false, detail: 'the notification rules could not be read; a client-facing send is held until they can' };
    return null;
  }
  if (verdict.allowed) return null;
  if (verdict.reason === 'quiet_hours') return { status: 'failed', permanent: false, detail: 'held by the notification rules: quiet hours; it will be tried again' };
  return { status: 'succeeded', outcome: `held_${verdict.reason}`, detail: `held by the notification rules (${verdict.reason}); nothing was sent` };
}
