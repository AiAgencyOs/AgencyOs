import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { limitPublicRoute } from '@/lib/security/rate-limit';
import { authorizeEmailSignature } from '@/lib/email-inbound/verify';
import { serverEnv } from '@/lib/env';
import { httpStatusFor, newCorrelationId } from '@/lib/errors';
import { ingestEmailLead } from '@/modules/crm/ingest-email';

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
    return NextResponse.json({ error: 'payload too large', correlationId }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'malformed payload', correlationId }, { status: 400 });
  }

  const auth = authorizeEmailSignature(
    firstOf(form, 'timestamp'),
    firstOf(form, 'token'),
    firstOf(form, 'signature'),
    EMAIL_INBOUND_SIGNING_KEY,
  );
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error, correlationId }, { status: auth.status });
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

  const admin = createAdminClient();
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
    return NextResponse.json({ error: result.error.message, correlationId }, { status });
  }

  return NextResponse.json({
    received: 1,
    status: result.data.status,
    leadId: result.data.leadId,
    correlationId,
  });
}
