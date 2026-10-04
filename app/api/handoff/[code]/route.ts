import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { clientEnv } from '@/lib/env';
import { hashHandoffCode, normalizeHandoffCode, whatsappDeepLink } from '@/modules/acquisition/handoff-code';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The link a prospect follows from email, a profile or a marketplace message to continue on WhatsApp.
 *
 * Public by nature, so it answers almost nothing: a valid, unused reference redirects into WhatsApp with the
 * reference pre-filled; EVERYTHING else (unknown, expired, used, cancelled, no number configured, malformed) is the
 * same redirect to the home page, so the route is not an oracle for which references exist. The reference carries no
 * data; the only effect of following it is marking the handoff OPENED. Real authority is the WhatsApp message that
 * carries it, which ingest binds and consumes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const home = NextResponse.redirect(new URL('/', clientEnv.NEXT_PUBLIC_APP_URL ?? request.url), 302);
  const { code: raw } = await params;
  const code = normalizeHandoffCode(decodeURIComponent(raw));
  if (!code) return home;
  const { data, error } = await createAdminClient().schema('crm').rpc('open_channel_handoff', { p_token_hash: hashHandoffCode(code) });
  if (error) return home;
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; business_number?: string | null } | undefined;
  if (row?.outcome !== 'open' || !row.business_number) return home;
  return NextResponse.redirect(whatsappDeepLink(row.business_number, code), 302);
}
