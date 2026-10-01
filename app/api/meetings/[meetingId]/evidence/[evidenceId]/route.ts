import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { resolveMeetingFileUrl } from '@/modules/crm/meeting-file-service';

/**
 * A recording, image, PDF or Word file kept as meeting evidence — owner
 * decision Q-D3 of 2026-10-01. Behind the session: the evidence row is read
 * under RLS (internal people of the tenant), the object is signed under the
 * bucket's own policy, and this redirects to the five-minute URL. The object's
 * key is never put in a page; a signed-out request is answered 401 as JSON,
 * because the caller is a link on a page that expects a file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ meetingId: string; evidenceId: string }> }) {
  const { meetingId, evidenceId } = await params;
  if (!(await getAuthContext())) return NextResponse.json({ error: 'Sign in to download a file.' }, { status: 401 });
  const result = await resolveMeetingFileUrl(meetingId, evidenceId);
  if (!result.ok) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'PROVIDER_ERROR' ? 503 : 400;
    return NextResponse.json({ error: result.error.message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(result.data.url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
