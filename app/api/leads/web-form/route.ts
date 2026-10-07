import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { httpStatusFor, newCorrelationId } from '@/lib/errors';
import { ingestWebFormLead } from '@/modules/crm/ingest-web-form';
import { routeError } from '@/lib/route-errors';

/**
 * /api/leads/web-form — the agency's own public "Contact us" form —
 * audit step 1.1.
 *
 * Unlike the other two channels this migration adds, there is no third-party
 * provider to verify a cryptographic signature FROM: a visitor's browser posts
 * here directly, so there is nothing upstream signing the request the way Meta
 * signs a webhook delivery. Two things stand in for that instead:
 *
 *   1. `formKey` identifies the organization (resolved inside
 *      `crm.ingest_web_form_lead`, the same role `phone_number_id` plays for
 *      WhatsApp) — not a secret, so its exposure in a public HTML form is not
 *      a security boundary.
 *   2. A honeypot field (`website`, never rendered to a real visitor by the
 *      embed, filled only by a bot filling every field it can see) — a
 *      submission with it populated is silently accepted and dropped, exactly
 *      the way the WhatsApp webhook always answers 200 rather than letting a
 *      failure teach an attacker anything.
 *
 * Still thin by the same rule ARCHITECTURE.md §5 gives the WhatsApp webhook:
 * authenticate (here, "identify the tenant and reject an obvious bot"),
 * record durably, acknowledge. What a submission means belongs to
 * `src/modules/crm/ingest-web-form.ts` and `crm.ingest_web_form_lead`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A contact-form submission is a few hundred bytes; 32 KiB is generous headroom against an attacker-controlled body on an unauthenticated endpoint. */
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: NextRequest) {
  const correlationId = newCorrelationId();

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return routeError('VALIDATION', 'payload too large', { status: 413, correlationId });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return routeError('VALIDATION', 'malformed payload', { status: 400, correlationId });
  }

  if (typeof payload !== 'object' || payload === null) {
    return routeError('VALIDATION', 'malformed payload', { status: 400, correlationId });
  }
  const body = payload as Record<string, unknown>;

  // The honeypot. Accepted and silently dropped — a 200 that created nothing
  // teaches a scraping bot nothing about what would have worked.
  if (typeof body.website === 'string' && body.website.trim().length > 0) {
    return NextResponse.json({ received: true, correlationId });
  }

  const admin = createAdminClient();
  const result = await ingestWebFormLead(admin, {
    formKey: typeof body.formKey === 'string' ? body.formKey : '',
    fullName: typeof body.fullName === 'string' ? body.fullName : '',
    email: typeof body.email === 'string' ? body.email : undefined,
    phone: typeof body.phone === 'string' ? body.phone : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    externalRef: typeof body.externalRef === 'string' ? body.externalRef : undefined,
    pageUrl: typeof body.pageUrl === 'string' ? body.pageUrl : undefined,
    utmSource: typeof body.utmSource === 'string' ? body.utmSource : undefined,
    utmCampaign: typeof body.utmCampaign === 'string' ? body.utmCampaign : undefined,
  });

  if (!result.ok) {
    // NOT_FOUND (unknown formKey) is answered the same as success from the
    // visitor's point of view would be dishonest UX, but from a security
    // point of view a stale or forged form key should not distinguish itself
    // from a validation failure — both are 4xx, neither leaks which.
    const status = httpStatusFor(result.error.code);
    console.error(
      JSON.stringify({ level: 'error', scope: 'web-form.webhook', detail: result.error.code, correlationId }),
    );
    return routeError(result.error.code, result.error.message, { status, correlationId });
  }

  return NextResponse.json({
    received: true,
    status: result.data.status,
    leadId: result.data.leadId,
    correlationId,
  });
}
