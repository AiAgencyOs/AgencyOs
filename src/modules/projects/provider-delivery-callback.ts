import { authorizeSignature } from '@/lib/whatsapp/verify';

/**
 * Provider delivery callback (Phase 8A second half, E2E-15 / the open "automatic delivery state from the provider" gap).
 *
 * This is the HANDLER, with the signature secret, the organization and the database door injected so a test supplies its own. The HTTP route
 * (`app/api/webhooks/delivery-callback/route.ts`) only reads the body and the environment.
 *
 * What it is: a verified, normalised callback `{ provider, channel, external_ref, event, occurred_at? }` becomes one call to
 * `projects.record_provider_delivery_callback`, which matches a ledger entry a PERSON recorded (same org, channel, external reference) and appends a fact.
 * What it is NOT: an adapter for any real provider's payload. A real provider (Meta, an email service) posts its own shape and signs it its own way; mapping
 * that shape to this contract is MANUAL_EXTERNAL (docs/phase-8a-manual-actions.md). Nothing here fakes a delivery: an unsigned request, an unconfigured
 * deployment or an unmatched reference records nothing.
 */

export const DELIVERY_CALLBACK_SIGNATURE_HEADER = 'x-agencyos-signature-256';
export const DELIVERY_CALLBACK_DISABLED = 'delivery callback disabled: not configured';
export const MAX_CALLBACK_EVENTS = 50;

export type CallbackEvent = { provider: string; channel: string; externalRef: string; event: string; occurredAt: string | null };
export type CallbackOutcome = { outcome: string };

export type CallbackDeps = {
  secret: string | undefined;
  organizationId: string | undefined;
  /** The database door, called as the service role. Returns the outcome word, or throws if the database could not be reached. */
  record: (organizationId: string, e: CallbackEvent) => Promise<string>;
};

export type CallbackResult = { status: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['whatsapp', 'email', 'portal', 'call', 'meeting']);
const EVENTS = new Set(['delivered', 'read', 'failed', 'bounced']);

/** Parse a body into events; an item that does not fit is reported, never repaired. */
export function parseCallbackBody(raw: string): { events: CallbackEvent[]; rejected: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const items = Array.isArray((json as { events?: unknown })?.events) ? ((json as { events: unknown[] }).events) : [json];
  if (items.length === 0 || items.length > MAX_CALLBACK_EVENTS) return null;
  const events: CallbackEvent[] = [];
  let rejected = 0;
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>;
    const provider = typeof o.provider === 'string' ? o.provider.trim() : '';
    const channel = typeof o.channel === 'string' ? o.channel : '';
    const externalRef = typeof o.external_ref === 'string' ? o.external_ref.trim() : '';
    const event = typeof o.event === 'string' ? o.event : '';
    const at = typeof o.occurred_at === 'string' ? o.occurred_at : null;
    const atOk = at === null || !Number.isNaN(Date.parse(at));
    if (!provider || !externalRef || !CHANNELS.has(channel) || !EVENTS.has(event) || !atOk) {
      rejected += 1;
      continue;
    }
    events.push({ provider, channel, externalRef, event, occurredAt: at });
  }
  return { events, rejected };
}

export async function handleDeliveryCallback(rawBody: string, presentedSignature: string | null, deps: CallbackDeps): Promise<CallbackResult> {
  const auth = authorizeSignature(rawBody, presentedSignature, deps.secret);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  // an unset organization is a deployment that has not said whose messages these are: disabled, never guessed
  if (!deps.organizationId || !UUID.test(deps.organizationId)) return { status: 503, body: { error: DELIVERY_CALLBACK_DISABLED } };
  const parsed = parseCallbackBody(rawBody);
  if (!parsed) return { status: 400, body: { error: 'malformed payload' } };
  if (parsed.events.length === 0) return { status: 400, body: { error: 'no valid event', rejected: parsed.rejected } };
  const counts: Record<string, number> = {};
  for (const e of parsed.events) {
    let outcome: string;
    try {
      outcome = await deps.record(deps.organizationId, e);
    } catch {
      // the database could not be reached: ask the provider to retry rather than pretend it was recorded
      return { status: 502, body: { error: 'could not record', recorded: counts.recorded ?? 0 } };
    }
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { status: 200, body: { received: parsed.events.length, rejected: parsed.rejected, outcomes: counts } };
}
