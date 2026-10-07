import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { limitPublicRoute } from '@/lib/security/rate-limit';
import { serverEnv } from '@/lib/env';
import { httpStatusFor, newCorrelationId } from '@/lib/errors';
import { fetchLeadgenFields } from '@/lib/facebook/graph';
import {
  authorizeSignature,
  authorizeSubscription,
  SIGNATURE_HEADER,
} from '@/lib/whatsapp/verify';
import { ingestFacebookLead } from '@/modules/crm/ingest-facebook';

/**
 * /api/webhooks/facebook-leads — inbound Facebook/Instagram Lead Ads —
 * audit step 1.1.
 *
 * Meta's Lead Ads webhook is the same Graph API Webhooks product WhatsApp's
 * inbound webhook already speaks — the subscription handshake
 * (`hub.mode`/`hub.verify_token`/`hub.challenge`) and the delivery signature
 * (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body) are identical schemes,
 * just configured under a different Meta app (or the same app, at the
 * owner's choice) with its own verify token and app secret. So this route
 * imports `authorizeSignature`/`authorizeSubscription` from
 * `src/lib/whatsapp/verify.ts` directly rather than writing a second copy —
 * both already take the secret/token as arguments rather than reading the
 * environment, which is what makes reusing them for a second product correct
 * rather than a WhatsApp-specific assumption leaking in.
 *
 * A Lead Ads delivery carries only `leadgen_id` (plus `page_id`, `form_id`,
 * `ad_id`) — the form answers are fetched separately via
 * `src/lib/facebook/graph.ts`, the Graph API call `crm.ingest_facebook_lead`
 * itself deliberately does not make (a SQL function should not need an
 * outbound HTTP call to do one atomic insert).
 *
 * Thin by the same rule as WhatsApp's webhook: authenticate, fetch what the
 * webhook only pointed at, record durably, acknowledge.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

type LeadgenChange = {
  value?: {
    leadgen_id?: string;
    page_id?: string;
    form_id?: string;
    ad_id?: string;
    created_time?: number;
  };
};

type LeadgenEntry = { id?: string; changes?: LeadgenChange[] };

async function readBoundedBody(request: NextRequest, maxBytes: number): Promise<{ text: string; tooLarge: boolean }> {
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
        return { text: '', tooLarge: true };
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

/** GET — Meta's subscription handshake, identical shape to the WhatsApp webhook's. */
export async function GET(request: NextRequest) {
  const { FACEBOOK_VERIFY_TOKEN } = serverEnv();
  const auth = authorizeSubscription(request.nextUrl.searchParams, FACEBOOK_VERIFY_TOKEN);

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

/** POST — one delivery of leadgen change notifications. */
export async function POST(request: NextRequest) {
  // P1-DOD-064: before the body is read. Fails open; see src/lib/security/rate-limit.ts.
  const blocked = await limitPublicRoute(request, createAdminClient(), 'webhook-facebook-leads', 600, 60);
  if (blocked) return blocked;
  const { FACEBOOK_APP_SECRET } = serverEnv();
  const correlationId = newCorrelationId();

  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (read.tooLarge) {
    return NextResponse.json({ error: 'payload too large', correlationId }, { status: 413 });
  }
  const rawBody = read.text;

  const auth = authorizeSignature(rawBody, request.headers.get(SIGNATURE_HEADER), FACEBOOK_APP_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'malformed payload', correlationId }, { status: 400 });
  }

  const entries = Array.isArray((payload as { entry?: unknown }).entry)
    ? ((payload as { entry: LeadgenEntry[] }).entry)
    : [];

  const leadgenIds: { leadgenId: string; pageId: string }[] = [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const leadgenId = change.value?.leadgen_id;
      const pageId = change.value?.page_id ?? entry.id;
      if (leadgenId && pageId) leadgenIds.push({ leadgenId, pageId });
    }
  }

  if (leadgenIds.length === 0) {
    return NextResponse.json({ received: 0, ignored: 1, correlationId });
  }

  const admin = createAdminClient();
  let ingested = 0;
  let replayed = 0;
  let skipped = 0;
  let rejected = 0;

  for (const { leadgenId, pageId } of leadgenIds) {
    const fetched = await fetchLeadgenFields(leadgenId);
    if (!fetched.ok) {
      // A permanent Graph failure (bad token, unknown/expired lead) cannot be
      // fixed by Meta redelivering the same webhook — counted and logged, not
      // retried. A transient one (429/5xx/network) asks for a retry.
      console.error(
        JSON.stringify({ level: 'error', scope: 'facebook-leads.webhook', detail: fetched.message, leadgenId, correlationId }),
      );
      if (fetched.permanent) {
        rejected += 1;
        continue;
      }
      return NextResponse.json(
        { error: 'graph fetch failed', ingested, replayed, skipped, rejected, correlationId },
        { status: 500 },
      );
    }

    const result = await ingestFacebookLead(admin, {
      pageId: fetched.pageId || pageId,
      leadgenId,
      fullName: fetched.fullName ?? undefined,
      email: fetched.email ?? undefined,
      phone: fetched.phone ?? undefined,
      adId: fetched.adId ?? undefined,
      adName: fetched.adName ?? undefined,
      formId: fetched.formId ?? undefined,
      formName: fetched.formName ?? undefined,
      fieldData: fetched.fieldData,
    });

    if (result.ok) {
      if (result.data.status === 'ingested') ingested += 1;
      else replayed += 1;
      continue;
    }

    if (result.error.code === 'NOT_FOUND') {
      console.warn(
        JSON.stringify({ level: 'warn', scope: 'facebook-leads.webhook', detail: 'NOT_FOUND', leadgenId, correlationId }),
      );
      skipped += 1;
      continue;
    }

    if (result.error.code === 'VALIDATION') {
      console.error(
        JSON.stringify({ level: 'error', scope: 'facebook-leads.webhook', detail: 'VALIDATION', leadgenId, correlationId }),
      );
      rejected += 1;
      continue;
    }

    console.error(
      JSON.stringify({ level: 'error', scope: 'facebook-leads.webhook', detail: result.error.code, leadgenId, correlationId }),
    );
    return NextResponse.json(
      { error: 'ingest failed', ingested, replayed, skipped, rejected, correlationId },
      { status: httpStatusFor(result.error.code) },
    );
  }

  return NextResponse.json({ received: leadgenIds.length, ingested, replayed, skipped, rejected, correlationId });
}
