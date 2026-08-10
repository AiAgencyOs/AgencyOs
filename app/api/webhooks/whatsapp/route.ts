import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';
import { parseDelivery } from '@/lib/whatsapp/payload';
import {
  authorizeSignature,
  authorizeSubscription,
  SIGNATURE_HEADER,
} from '@/lib/whatsapp/verify';
import { ingestInboundMessage } from '@/modules/crm/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/webhooks/whatsapp — inbound WhatsApp Cloud API.
 *
 * The second of the four sanctioned service-role call sites (ARCHITECTURE.md
 * §7.3, and the list in src/lib/db/admin.ts). It holds the service key because
 * an inbound webhook has no session: there is no signed-in principal to scope
 * by, so tenancy is resolved from the payload — `metadata.phone_number_id`
 * matched against `core.organizations.settings` — inside the ingest itself.
 *
 * Thin by rule (ARCHITECTURE.md §5, rule 1) and by §5.6, which is the pattern
 * every inbound integration follows: authenticate, record durably, acknowledge
 * fast. Nothing is decided here. What a message *means* — which contact, which
 * lead, which conversation, whether it is a replay — belongs to
 * src/modules/crm/ingest.ts and its one SQL statement.
 *
 * This route never sends. ARCHITECTURE.md §6.1 forbids an agent committing
 * client communication without a recorded human approval, and the
 * requirement_collector agent is L1 — it proposes, a human sends. Ingest
 * queues an extraction; a reply is a later, human-gated step that does not
 * exist yet.
 */

/** Answered for a delivery whose body is not JSON. */
const MALFORMED = 'malformed payload';

/**
 * GET — Meta's subscription handshake.
 *
 * Called once when the webhook URL is saved in the app dashboard, and again
 * whenever the subscription is re-verified. Meta sends a random `hub.challenge`
 * and requires it echoed back as a bare body; echoing it is what proves we own
 * the endpoint, so it happens only when `hub.verify_token` matches.
 *
 * The challenge is returned as text/plain, unquoted. Meta compares the body
 * verbatim, so a JSON-encoded challenge fails verification.
 */
export async function GET(request: NextRequest) {
  const { WHATSAPP_VERIFY_TOKEN } = serverEnv();

  const auth = authorizeSubscription(request.nextUrl.searchParams, WHATSAPP_VERIFY_TOKEN);

  if (!auth.ok) {
    return new NextResponse(auth.error, {
      status: auth.status,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
    });
  }

  return new NextResponse(auth.challenge ?? '', {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
  });
}

/**
 * POST — one delivery of inbound events.
 *
 * ── on status codes ──────────────────────────────────────────────────────
 *
 * Meta redelivers anything that is not a 2xx, so the code is a decision about
 * whether *retrying could help*, not about whether everything went perfectly:
 *
 *   401  the signature did not check out. Not ours; never retry into it.
 *   400  the body is not JSON. Redelivery cannot fix a payload that will
 *        never parse.
 *   500  the ingest failed for a reason that might pass later — a database
 *        that was briefly unreachable. Retry is exactly what we want, and it
 *        is safe because every message carries a provider id and the ingest
 *        is idempotent on it.
 *   200  everything else, including three cases worth naming: a replay, a
 *        delivery carrying no message at all, and a message for a
 *        phone_number_id no organization claims. None of the three is a
 *        failure of ours, and none becomes true by being sent again.
 */
export async function POST(request: NextRequest) {
  const { WHATSAPP_APP_SECRET } = serverEnv();
  const correlationId = newCorrelationId();

  // Read once, as text. The HMAC is over the exact bytes received, so the
  // parsed object is never re-serialised — that would reorder keys and the
  // digest would never match.
  const rawBody = await request.text();

  const auth = authorizeSignature(rawBody, request.headers.get(SIGNATURE_HEADER), WHATSAPP_APP_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: MALFORMED, correlationId }, { status: 400 });
  }

  const { messages, ignored } = parseDelivery(payload);

  if (messages.length === 0) {
    // A status receipt, a non-text message, or an envelope for another
    // product. Acknowledged: there is nothing to do and nothing went wrong.
    return NextResponse.json({ received: 0, ignored, correlationId });
  }

  const admin = createAdminClient();

  let ingested = 0;
  let replayed = 0;
  let skipped = 0;

  // Sequential on purpose. Messages in one delivery can belong to the same
  // conversation, and their order in the envelope is the order they were sent;
  // ingesting them concurrently would let the transcript record them out of
  // order even though the database keeps the positions contiguous.
  for (const message of messages) {
    const result = await ingestInboundMessage(admin, message);

    if (result.ok) {
      if (result.data.status === 'ingested') ingested += 1;
      else replayed += 1;
      continue;
    }

    // NOT_FOUND: no organization claims this business number. VALIDATION: the
    // provider sent something the ingest will never accept. Neither improves
    // on redelivery, so both are acknowledged rather than retried.
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION') {
      console.warn(
        JSON.stringify({
          level: 'warn',
          scope: 'whatsapp.webhook',
          detail: result.error.code,
          externalRef: message.externalRef,
          correlationId,
        }),
      );
      skipped += 1;
      continue;
    }

    // Anything else may pass on a retry. Answering non-2xx is what asks for
    // one; the messages already recorded in this delivery will replay
    // harmlessly.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'whatsapp.webhook',
        detail: result.error.code,
        externalRef: message.externalRef,
        correlationId,
      }),
    );
    return NextResponse.json(
      { error: 'ingest failed', ingested, replayed, correlationId },
      { status: 500 },
    );
  }

  return NextResponse.json({
    received: messages.length,
    ingested,
    replayed,
    skipped,
    ignored,
    correlationId,
  });
}
