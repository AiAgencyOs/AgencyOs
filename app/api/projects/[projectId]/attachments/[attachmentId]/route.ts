import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { resolveAttachedFileUrl } from '@/modules/projects/attached-files-queries';
import { routeError } from '@/lib/route-errors';

/**
 * A file attached to a build, a test run or a bug — owner decisions Q-C1 and
 * Q-C6 of 2026-10-01. Behind the session: the row is read under RLS (internal
 * people of the tenant), the object is signed under the bucket's own policy,
 * and this redirects to the five-minute URL. A signed-out request is answered
 * 401 as JSON, because the caller is a link on a page that expects a file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string; attachmentId: string }> }) {
  const { projectId, attachmentId } = await params;
  if (!(await getAuthContext())) return routeError('UNAUTHORIZED', 'Sign in to download a file.');
  const result = await resolveAttachedFileUrl(projectId, attachmentId);
  if (!result.ok) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'PROVIDER_ERROR' ? 503 : 400;
    return routeError(result.error.code, result.error.message, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(result.data.url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
