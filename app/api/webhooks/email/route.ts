import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { limitPublicRoute } from '@/lib/security/rate-limit';
import { authorizeEmailSignature } from '@/lib/email-inbound/verify';
import { serverEnv } from '@/lib/env';
import { httpStatusFor, newCorrelationId } from '@/lib/errors';
import { admitDelivery, rejectDelivery, settleDelivery } from '@/lib/p13/webhook-guard';
import { ingestEmailLead } from '@/modules/crm/ingest-email';
import { routeError, codeForStatus } from '@/lib/route-errors';

/**
 * /api/webhooks/email — inbound email — audit step 1.1.
 *
 * The third of the sanctioned service-role call sites' pattern (see
 * app/api/webhooks/whatsapp/route.ts's own note on ARCHITECTURE.md §7.3):
 * this has no session, so tenancy is resolved from the payload — the mailbox
 * the message was delivered to — inside `crm.ingest_email_lead`.
 *
 * ── provider shape: an assumption, not a verified integration ─────────────
 *
 * No email provider is configured anywhere else in this codebase. This is
 * written against Mailgun's documented "Inbound Route" webhook (a
 * `multipart/form-data` POST carrying `sender`, `recipient`, `subject`,
 * `body-plain`, `Message-Id`, `timestamp`, `token`, `signature`), because it
 * is a real, standard, documented shape — not because it is confirmed to be
 * the agency's actual provider. `src/lib/email-inbound/verify.ts` isolates the
 * verification scheme so swapping providers means replacing that file and
 * this route's field-extraction block, not `ingest-email.ts` or the SQL
 * function underneath it.
 *
 * Thin by the same rule the WhatsApp webhook follows: authenticate, record
 * durably, acknowledge. What an email means belongs to
 * `src/modules/crm/ingest-email.ts`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A real inbound email is rarely more than a few kilobytes of plain text; 512 KiB is generous headroom on an unauthenticated endpoint. */
const MAX_BODY_BYTES = 512 * 1024;

function firstOf(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === 'string' ? value : null;
}

export async function POST(request: NextRequest) {
  // P1-DOD-064: before anything is read. Fails open; see src/lib/security/rate-limit.ts.
  const blocked = await limitPublicRoute(request, createAdminClient(), 'webhook-email', 600, 60);
  if (blocked) return blocked;
  const { EMAIL_INBOUND_SIGNING_KEY } = serverEnv();
  const correlationId = newCorrelationId();

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return routeError('VALIDATION', 'payload too large', { status: 413, correlationId });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return routeError('VALIDATION', 'malformed payload', { status: 400, correlationId });
  }

  const auth = authorizeEmailSignature(
    firstOf(form, 'timestamp'),
    firstOf(form, 'token'),
    firstOf(form, 'signature'),
    EMAIL_INBOUND_SIGNING_KEY,
  );
  if (!auth.ok) {
    // W5: a rejected signature is on record too (best effort; the answer is unchanged).
    if (auth.status === 401) await rejectDelivery(createAdminClient(), { provider: 'email', signatureHeader: firstOf(form, 'signature') });
    return routeError(codeForStatus(auth.status), auth.error, { status: auth.status, correlationId });
  }

  const mailbox = firstOf(form, 'recipient');
  const fromEmail = firstOf(form, 'sender');
  const messageId = firstOf(form, 'Message-Id') ?? firstOf(form, 'message-id');

  if (!mailbox || !fromEmail || !messageId) {
    // Acknowledged rather than retried: a delivery missing these fields will
    // never parse, on any retry.
    console.error(
      JSON.stringify({ level: 'error', scope: 'email.webhook', detail: 'missing required field', correlationId }),
    );
    return NextResponse.json({ received: 0, rejected: 1, correlationId });
  }

  // W5 (P1-MP3-030): the delivery is keyed by the message id and recorded before ingest; a replay already processed is answered from the ledger, one
  // that failed is processed again. The ledger stores a hash of the key fields, never the message.
  const admin = createAdminClient();
  const gate = await admitDelivery(admin, { provider: 'email', eventKey: messageId, rawBody: `${mailbox}\n${fromEmail}\n${messageId}` });
  if (!gate.proceed) return NextResponse.json({ received: 0, duplicate: true, correlationId }, { status: gate.status });
  const response = await ingestAndAnswer(admin, form, { mailbox, fromEmail, messageId }, correlationId);
  await settleDelivery(admin, gate.eventId, response.status, 'email');
  return response;
}

async function ingestAndAnswer(
  admin: ReturnType<typeof createAdminClient>,
  form: FormData,
  m: { mailbox: string; fromEmail: string; messageId: string },
  correlationId: string,
): Promise<NextResponse> {
  const { mailbox, fromEmail, messageId } = m;
  const result = await ingestEmailLead(admin, {
    mailbox,
    fromEmail,
    fromName: firstOf(form, 'from') ?? undefined,
    subject: firstOf(form, 'subject') ?? undefined,
    body: firstOf(form, 'body-plain') ?? firstOf(form, 'stripped-text') ?? '',
    externalRef: messageId,
  });

  if (!result.ok) {
    // NOT_FOUND: no organization claims this mailbox — acknowledged, not
    // retried, the same as WhatsApp's unclaimed phone_number_id.
    if (result.error.code === 'NOT_FOUND') {
      console.warn(
        JSON.stringify({ level: 'warn', scope: 'email.webhook', detail: 'NOT_FOUND', correlationId }),
      );
      return NextResponse.json({ received: 0, skipped: 1, correlationId });
    }
    const status = httpStatusFor(result.error.code);
    console.error(
      JSON.stringify({ level: 'error', scope: 'email.webhook', detail: result.error.code, correlationId }),
    );
    return routeError(result.error.code, result.error.message, { status, correlationId });
  }

  return NextResponse.json({
    received: 1,
    status: result.data.status,
    leadId: result.data.leadId,
    correlationId,
  });
}
