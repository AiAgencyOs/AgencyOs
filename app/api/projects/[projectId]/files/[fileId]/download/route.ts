import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { signedDownloadUrl } from '@/modules/projects/files-storage-service';

/**
 * An internal download — decision 5 of 2026-09-29. Behind the session:
 * `signedDownloadUrl` requires an internal user with `project.read`, reads
 * the row under RLS and signs the object under the bucket's own policy,
 * then this redirects to the five-minute URL. A signed-out request is
 * answered 401 as JSON rather than sent to /login, because the caller is a
 * link on a page that expects a file.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string; fileId: string }> }) {
  const { fileId } = await params;
  if (!(await getAuthContext())) return NextResponse.json({ error: 'Sign in to download a file.' }, { status: 401 });
  const result = await signedDownloadUrl(fileId);
  if (!result.ok) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : result.error.code === 'FORBIDDEN' ? 403 : result.error.code === 'PROVIDER_ERROR' ? 503 : 400;
    return NextResponse.json({ error: result.error.message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.redirect(result.data.url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
