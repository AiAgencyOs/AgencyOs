import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { filesBucket, SIGNED_URL_SECONDS } from '@/lib/files/storage';

/**
 * A share link — decision 5 of 2026-09-29. Public: whoever holds the token
 * holds the file until the row says otherwise.
 *
 * The service-role client is used here on purpose, and this is the fifth
 * permitted site beside the four ARCHITECTURE.md §7.3 lists: there is no
 * session to carry, and the authorization IS the token —
 * `projects.resolve_file_share` (SECURITY DEFINER, executable by
 * service_role only) answers nothing for an unknown, expired or revoked
 * token or a trashed file, and this route answers 404 for all four alike.
 * Nothing is listed, nothing is written but the access count, and the
 * signed URL it redirects to lives five minutes.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) return notFound();

  const admin = createAdminClient();
  const { data, error } = await admin.schema('projects').rpc('resolve_file_share', { p_token: token });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'files.share.resolve', detail: error.message }));
    return NextResponse.json({ error: 'The link could not be checked right now.' }, { status: 503 });
  }
  const share = data?.[0];
  if (!share) return notFound();

  const { data: signed, error: signError } = await admin.storage.from(filesBucket()).createSignedUrl(share.storage_path, SIGNED_URL_SECONDS, {
    download: share.title,
  });
  if (signError || !signed?.signedUrl) {
    console.error(JSON.stringify({ level: 'error', scope: 'files.share.sign', detail: signError?.message ?? 'no url' }));
    return NextResponse.json({ error: 'Storage is not reachable, so the file cannot be fetched right now.' }, { status: 503 });
  }

  return NextResponse.redirect(signed.signedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}

function notFound() {
  return NextResponse.json({ error: 'This link is not valid. It may have expired or been revoked.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
