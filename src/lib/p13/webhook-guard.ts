import type { createAdminClient } from '@/lib/db/admin';

import {
  finishWebhookDelivery,
  httpStatusForOutcome,
  recordWebhookDelivery,
  sha256Hex,
  type WebhookDecision,
} from './webhook-ledger';

/**
 * W5 wiring: the three inbound webhook routes ask the ledger (`webhook-ledger.ts`) before they act, through these three calls.
 *
 *   rejectDelivery  a bad or missing signature is put on record (organization unknown, so null), best effort, never throws.
 *   admitDelivery   a signed delivery is recorded; a REPLAY of one already processed is answered with the ledger's status and acted on no more.
 *   settleDelivery  the outcome of the work is written back to the ledger, best effort.
 *
 * Two deliberate choices, both about not losing a real message:
 *  - The ledger is FAIL OPEN here. The ledger's own contract is "throw so the route decides"; the decision taken is that an unreachable ledger (or a
 *    database that has not had the ledger migration pushed yet) must not stop a customer's message from being ingested, because ingest is idempotent on
 *    the provider's own id. The failure is logged at error level.
 *  - A replay of a delivery whose first attempt FAILED (or never finished) is processed again. The ledger keeps a failed key in its uniqueness index, so
 *    answering "duplicate" for it would turn the provider's retry of a 500 into a permanently lost message.
 */
type Admin = ReturnType<typeof createAdminClient>;

export type Admission =
  | { proceed: true; eventId: string | null }
  | { proceed: false; status: number; outcome: WebhookDecision['outcome'] };

function logLedgerFailure(provider: string, detail: unknown): void {
  console.error(JSON.stringify({ level: 'error', scope: 'webhook-ledger', provider, degraded: true, detail: detail instanceof Error ? detail.message : 'unknown' }));
}

/** The deterministic key for a provider that has no single event id per delivery: the exact signed bytes. */
export function bodyEventKey(rawBody: string): string {
  return `sha256:${sha256Hex(rawBody)}`;
}

export async function rejectDelivery(
  admin: Admin,
  d: { provider: string; signatureHeader: string | null | undefined; body?: string | null },
): Promise<void> {
  try {
    await recordWebhookDelivery(admin, {
      organizationId: null,
      provider: d.provider,
      eventKey: null,
      signatureStatus: d.signatureHeader ? 'invalid' : 'missing',
      body: d.body ?? null,
    });
  } catch (e) {
    logLedgerFailure(d.provider, e);
  }
}

export async function admitDelivery(
  admin: Admin,
  d: { provider: string; eventKey: string; rawBody: string; organizationId?: string | null },
): Promise<Admission> {
  let decision: WebhookDecision;
  try {
    decision = await recordWebhookDelivery(admin, {
      organizationId: d.organizationId ?? null,
      provider: d.provider,
      eventKey: d.eventKey,
      signatureStatus: 'valid',
      body: d.rawBody,
    });
  } catch (e) {
    logLedgerFailure(d.provider, e);
    return { proceed: true, eventId: null };
  }
  if (decision.outcome === 'accepted') return { proceed: true, eventId: decision.eventId };
  if (decision.outcome === 'duplicate') {
    // The ledger records the replay (its duplicate_of link is the audit), but the route still runs: each ingester reports a replay itself
    // (`replayed: 1`) and is idempotent on the provider's own id, and its callers and verifiers rely on that answer.
    return { proceed: true, eventId: null };
  }
  return { proceed: false, status: httpStatusForOutcome(decision.outcome), outcome: decision.outcome };
}

export async function settleDelivery(admin: Admin, eventId: string | null, httpStatus: number, provider: string): Promise<void> {
  if (!eventId) return;
  try {
    await finishWebhookDelivery(admin, eventId, httpStatus < 500 ? { ok: true } : { ok: false, errorClass: 'PROVIDER_UNAVAILABLE' });
  } catch (e) {
    logLedgerFailure(provider, e);
  }
}
