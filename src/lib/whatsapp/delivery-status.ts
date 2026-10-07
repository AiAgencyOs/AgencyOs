/**
 * P4-PM-036 (Provider 400/401/403/timeout visible to Admin; uncertain delivery shows UNKNOWN, not SENT).
 *
 * A send that reached the provider and was refused is `failed`. A send that FAILED TO ANSWER (a timeout or a transport failure after the request may have gone
 * out) or that was accepted without an id anybody can reconcile is `unknown`: the message may or may not have reached the client, and recording it `sent` would be
 * a claim and recording it `failed` would invite a blind resend. `crm.mark_outbound_delivery` accepts `unknown` with a note (the provider-side sentence), settles it
 * to `sent` or `failed` later, and never lets it overturn a `sent`.
 *
 * Pure: no provider, no database.
 */
export type DeliveryOutcome = { ok: true } | { ok: false; uncertain?: boolean };

export type DeliveryStatus = 'sent' | 'failed' | 'unknown';

export function deliveryStatusOf(sent: DeliveryOutcome): DeliveryStatus {
  if (sent.ok) return 'sent';
  return sent.uncertain === true ? 'unknown' : 'failed';
}
