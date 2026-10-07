import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { resolveFinanceAttachmentUrl } from '@/modules/finance/attachment-download';
import { routeError } from '@/lib/route-errors';

/**
 * An uploaded payment proof or expense receipt — owner decision 5 of
 * 2026-10-01. Behind the session: the row is read under RLS (owner, ops_admin
 * and the finance role, the three that read the money), the object is signed
 * under the bucket's own policy, and this redirects to the five-minute URL.
 * A signed-out request is answered 401 as JSON, because the caller is a link
 * on a page that expects a file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (!(await getAuthContext())) return routeError('UNAUTHORIZED', 'Sign in to download a file.');
  const result = await resolveFinanceAttachmentUrl(kind, id);
  if (!result.ok) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'PROVIDER_ERROR' ? 503 : 400;
    return routeError(result.error.code, result.error.message, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(result.data.url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
