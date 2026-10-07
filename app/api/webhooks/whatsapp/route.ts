import { after, NextResponse, type NextRequest } from 'next/server';

import { nudgeRunner } from '@/lib/jobs/nudge';
import { createAdminClient } from '@/lib/db/admin';
import { limitPublicRoute } from '@/lib/security/rate-limit';
import { resolveSecret } from '@/lib/secrets/resolve';
import { newCorrelationId } from '@/lib/errors';
import { admitDelivery, bodyEventKey, rejectDelivery, settleDelivery } from '@/lib/p13/webhook-guard';
import { parseDelivery } from '@/lib/whatsapp/payload';
import {
  authorizeSignature,
  authorizeSubscription,
  SIGNATURE_HEADER,
} from '@/lib/whatsapp/verify';
import { ingestGroupMessage, ingestInboundMessage, recordDeliveryReceipt } from '@/modules/crm/ingest';
import { routeError, codeForStatus } from '@/lib/route-errors';

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
 * This route never sends, and that is unchanged — but the sentence that used
 * to follow it was not. It said *"a reply is a later, human-gated step that
 * does not exist yet"*, which stopped being true at ADM-91: `reply.due` →
 * `sales:answerClient` answers a client with nobody reading it first, when the
 * organization has switched that on. A zero-trust audit found the comment
 * still saying otherwise, which is a trap for the next reader — the route
 * itself was right the whole time.
 *
 * What is true: nothing is SENT from here. The ingest records the message and
 * emits; every send happens later, in the runner, behind the consent
 * chokepoint and the organization's own switch.
 */

/** Answered for a delivery whose body is not JSON. */
const MALFORMED = 'malformed payload';

/**
 * The largest inbound body this endpoint will hold. A real Meta delivery is a
 * few kilobytes; 256 KiB is generous headroom and far below anything that
 * would pressure memory on the serverless runtime. The endpoint is
 * unauthenticated at the network layer, so the bound is a defence, not a
 * courtesy.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Reads the request body as text with a hard byte ceiling, streaming.
 *
 * `request.text()` would buffer the whole body first — up to the platform's
 * own limit — before any ceiling of ours could apply, which on an
 * unauthenticated endpoint is memory an attacker controls. This consumes the
 * body a chunk at a time and stops the moment the running byte total exceeds
 * the ceiling, so an oversized POST is refused rather than held.
 *
 * The byte total is the fact; a JS string's `.length` is UTF-16 code units and
 * would under- or over-count a multibyte body. The bytes are decoded to text
 * only after they are known to fit, and UTF-8 round-trips exactly, so the HMAC
 * over the decoded string matches the bytes received.
 */
async function readBoundedBody(
  request: NextRequest,
  maxBytes: number,
): Promise<{ text: string; tooLarge: false } | { text: null; tooLarge: true }> {
  const body = request.body;
  if (!body) return { text: '', tooLarge: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { text: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), tooLarge: false };
}

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
  const WHATSAPP_VERIFY_TOKEN = (await resolveSecret('WHATSAPP_VERIFY_TOKEN')) ?? undefined;

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
 *   200  everything else, including four cases worth naming: a replay, a
 *        delivery carrying no message at all, a message for a phone_number_id
 *        no organization claims, and one the ingest will never accept. None
 *        becomes true by being sent again.
 *
 * That last one is a 200 the response has to be honest about. A malformed
 * message cannot be stored and cannot be retried into existence, so the only
 * options are to acknowledge it or to loop forever — but acknowledging it
 * silently, as `skipped`, made a customer's lost message look identical to a
 * delivery that was simply not ours. It is counted as `rejected` and logged at
 * error level instead. The counts in the response are the contract: `ingested`
 * and `replayed` reached the transcript, `skipped` was not ours, `ignored`
 * carried nothing to store, and `rejected` is content that did not survive.
 */
export async function POST(request: NextRequest) {
  // P1-DOD-064: before the body is read. Generous (a provider may redeliver a backlog); it exists to stop a flood, not to shape normal traffic. Fails open.
  const blocked = await limitPublicRoute(request, createAdminClient(), 'webhook-whatsapp', 1200, 60);
  if (blocked) return blocked;
  const WHATSAPP_APP_SECRET = (await resolveSecret('WHATSAPP_APP_SECRET')) ?? undefined;
  const correlationId = newCorrelationId();

  // Read the body with a hard byte ceiling, streaming, so an oversized POST is
  // refused WITHOUT being buffered whole. This endpoint is unauthenticated at
  // the network layer — anyone can POST, and the signature is only checkable
  // once the bytes are in hand — so the bound cannot wait for the parse and
  // must not trust the Content-Length header (which an attacker omits or
  // under-declares). A real Meta delivery is a few kilobytes; 256 KiB is
  // generous headroom. The HMAC needs the exact bytes, so the body is never
  // re-serialised — that would reorder keys and the digest would never match.
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (read.tooLarge) {
    return routeError('VALIDATION', 'payload too large', { status: 413, correlationId });
  }
  const rawBody = read.text;

  const auth = authorizeSignature(rawBody, request.headers.get(SIGNATURE_HEADER), WHATSAPP_APP_SECRET);
  if (!auth.ok) {
    // W5: a rejected signature is on record too (best effort; the answer is unchanged).
    if (auth.status === 401) await rejectDelivery(createAdminClient(), { provider: 'whatsapp', signatureHeader: request.headers.get(SIGNATURE_HEADER), body: rawBody });
    return routeError(codeForStatus(auth.status), auth.error, { status: auth.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return routeError('VALIDATION', MALFORMED, { status: 400, correlationId });
  }

  // W5 (P1-MP3-030): the delivery is recorded in the webhook ledger before anything is acted on. A replay of one already processed is answered from the
  // ledger; a replay of one that failed is processed again (see src/lib/p13/webhook-guard.ts).
  const admin = createAdminClient();
  const gate = await admitDelivery(admin, { provider: 'whatsapp', eventKey: bodyEventKey(rawBody), rawBody });
  if (!gate.proceed) return NextResponse.json({ received: 0, duplicate: true, correlationId }, { status: gate.status });
  const response = await processDelivery(admin, payload, correlationId);
  await settleDelivery(admin, gate.eventId, response.status, 'whatsapp');
  return response;
}

async function processDelivery(admin: ReturnType<typeof createAdminClient>, payload: unknown, correlationId: string): Promise<NextResponse> {
  const { messages, statuses, ignored } = parseDelivery(payload);

  // No message-count ceiling: the 256 KiB body bound already limits how many
  // messages one delivery can carry, and every message here PASSED the
  // signature — it is genuinely from Meta. Refusing a large legitimate batch
  // with 413 would make Meta redeliver the same batch forever, losing every
  // message in it; processing them all (idempotently, so a timeout-and-retry
  // is safe) is the only choice that does not drop a real message.

  if (messages.length === 0 && statuses.length === 0) {
    // A non-text message, a reaction, or an envelope for another product.
    // Acknowledged: there is nothing to do and nothing went wrong.
    return NextResponse.json({ received: 0, ignored, correlationId });
  }

  // ── delivery-status receipts (C10) ─────────────────────────────────────────
  // Recorded first, and independently of messages: a delivery is usually pure
  // status receipts and carries no message at all. Each receipt is idempotent
  // and monotonic in the database, so a redelivery — including one provoked by
  // a 500 in the message loop below — reprocesses them harmlessly. A receipt is
  // provider telemetry, not a customer's words, so a failure to record one is
  // counted and left, never escalated to a retry that would risk the real
  // messages a batch might also carry.
  let receiptsRecorded = 0;
  let receiptsUnmatched = 0;
  let receiptsIgnored = 0;
  for (const receipt of statuses) {
    const result = await recordDeliveryReceipt(admin, receipt);
    if (!result.ok) {
      receiptsIgnored += 1;
      continue;
    }
    if (result.data.outcome === 'recorded') receiptsRecorded += 1;
    else if (result.data.outcome === 'unmatched') receiptsUnmatched += 1;
    else receiptsIgnored += 1;
  }

  if (messages.length === 0) {
    // Pure status delivery — the common case. Acknowledged with what became of
    // each receipt, so the response says what happened rather than "0".
    return NextResponse.json({
      received: 0,
      receiptsRecorded,
      receiptsUnmatched,
      receiptsIgnored,
      ignored,
      correlationId,
    });
  }

  let ingested = 0;
  let replayed = 0;
  /** Acknowledged, but for somebody else: no organization claims the number. */
  let skipped = 0;
  /** Acknowledged, and lost: the provider sent something that cannot be stored. */
  let rejected = 0;

  // Sequential on purpose. Messages in one delivery can belong to the same
  // conversation, and their order in the envelope is the order they were sent;
  // ingesting them concurrently would let the transcript record them out of
  // order even though the database keeps the positions contiguous.
  for (const message of messages) {
    /**
     * A group message goes somewhere else entirely — G-115.
     *
     * `ingestInboundMessage` creates a contact, a lead and a `direct`
     * conversation unconditionally, because it was written when every
     * conversation was 1:1. Sending a group message through it opens a **sales
     * lead on whoever sent it**, so a colleague typing "morning" in the
     * internal approval group would become a prospect. This branch is the only
     * thing standing between the parser learning about `group_id` and that
     * happening.
     */
    const result = message.groupId
      ? await ingestGroupMessage(admin, { ...message, groupId: message.groupId })
      : await ingestInboundMessage(admin, message);

    if (result.ok) {
      // A group this system does not track: acknowledged and counted as
      // skipped, because the number can legitimately be in groups nobody has
      // linked, and it is not a message we lost.
      if (result.data.status === 'unknown_group') {
        skipped += 1;
        continue;
      }
      if (result.data.status === 'ingested') ingested += 1;
      else replayed += 1;
      continue;
    }

    // No organization claims this business number. Not our message, and not a
    // failure of ours: acknowledged, counted, and left at warn.
    if (result.error.code === 'NOT_FOUND') {
      console.warn(
        JSON.stringify({
          level: 'warn',
          scope: 'whatsapp.webhook',
          detail: 'NOT_FOUND',
          externalRef: message.externalRef,
          correlationId,
        }),
      );
      skipped += 1;
      continue;
    }

    /**
     * The provider sent something the ingest will never accept.
     *
     * Still a 200, and for the same reason as before: redelivery cannot make a
     * malformed message valid, so asking Meta to retry would only loop. What
     * changes is that it is no longer indistinguishable from an unclaimed
     * number. This is a customer's message that will never reach the
     * transcript, which is a failure worth naming — counted separately, logged
     * at error rather than warn, and reported with the fields that failed so it
     * can be diagnosed without guessing.
     *
     * The body is never logged: it is customer content, and the whole problem
     * here is content going somewhere it should not.
     */
    if (result.error.code === 'VALIDATION') {
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'whatsapp.webhook',
          detail: 'VALIDATION',
          fields: Object.keys(result.error.details ?? {}),
          externalRef: message.externalRef,
          bodyLength: message.body.length,
          correlationId,
        }),
      );
      rejected += 1;
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
    return routeError('INTERNAL', 'ingest failed', { status: 500, correlationId, extra: { ingested, replayed, skipped, rejected } });
  }

  /**
   * Wake the runner now rather than at the next minute — G-209.
   *
   * `after()` runs once the response above has been sent, so Meta is answered
   * at exactly the speed it was before: this cannot slow the webhook down, and
   * a webhook that answers slowly is one Meta retries.
   *
   * Only when a message was actually taken in. A delivery receipt, a replay of
   * something already stored, or a payload with nothing in it creates no work,
   * and a doorbell rung for no reason is a tick spent finding an empty queue.
   */
  if (ingested > 0) {
    after(async () => {
      /**
       * Only for an agency that asked for it — G-209.
       *
       * Read here rather than cached, because it is an operator control: the
       * switch that turns this off has to work without a deploy, which is the
       * whole reason it is a setting. One row, after the response has already
       * gone, so it costs the client nothing.
       *
       * A failed read leaves it OFF. The default is the behaviour every
       * deployment has today, and defaulting a capability ON because a query
       * failed is how a system acquires behaviour nobody chose.
       */
      const { data, error } = await admin
        .schema('core')
        .from('organizations')
        .select('id')
        .eq('wake_runner_on_inbound', true)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          JSON.stringify({ level: 'warn', scope: 'wakeRunnerOnInbound', detail: error.message }),
        );
        return;
      }
      if (!data) return;

      await nudgeRunner('whatsapp.inbound');
    });
  }

  return NextResponse.json({
    received: messages.length,
    ingested,
    replayed,
    skipped,
    rejected,
    receiptsRecorded,
    receiptsUnmatched,
    receiptsIgnored,
    ignored,
    correlationId,
  });
}
