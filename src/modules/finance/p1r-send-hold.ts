import type { createAdminClient } from '@/lib/db/admin';
import { heldByNotificationRules } from '@/lib/p13/notification-hold';
import { err, type Result } from '@/lib/result';

/**
 * P1-BLUEPRINT-032 (A26), the last client-facing senders: a manual invoice send asks the organisation's notification rules BEFORE anything leaves.
 *
 * `core.p13_notification_decision` is granted to `authenticated` and reads the caller's own organisation, so the signed-in person's client is enough;
 * no service-role client is needed on a path that accepts user input. The gate is client-facing: rules that cannot be read HOLD the send (a bill is
 * never mailed on the strength of a rulebook that could not be read). A hold sends nothing and records nothing; the person is told why and may try again.
 */
type Asker = ReturnType<typeof createAdminClient>;

export async function invoiceSendHold(
  client: unknown,
  organizationId: string | undefined,
  channel: 'email' | 'whatsapp',
): Promise<Result<never> | null> {
  if (!organizationId) return err('CONFLICT', 'Your session has no organisation, so the notification rules cannot be checked. Sign in again.');
  const held = await heldByNotificationRules(client as Asker, { organizationId, eventClass: 'client_followup', channel, clientFacing: true });
  if (!held) return null;
  return err('CONFLICT', `Not sent. ${held.detail}.`.replace(/\.\.$/, '.'));
}
