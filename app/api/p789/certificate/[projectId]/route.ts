import { NextResponse } from 'next/server';

import { getAuthContext } from '@/lib/auth/session';
import { documentHeaders } from '@/modules/projects/p789-document-http';
import { readCertificateDocument } from '@/modules/projects/p789-round2-queries';

/**
 * The completion certificate of a project as a DOWNLOAD (P7-ARC-01). Behind the session: the database function lets through only staff of the project's
 * organization and the owning client (not past an expired portal), so a stranger is answered 404 exactly like a project with no certificate. The body is the
 * HTML the database built once from the completion record; it is not signed and says so.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!(await getAuthContext())) return NextResponse.json({ error: 'Sign in to download a file.' }, { status: 401 });
  if (!UUID.test(projectId)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const doc = await readCertificateDocument(projectId);
  if (!doc) return NextResponse.json({ error: 'No certificate has been rendered for this project.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(doc.html, { status: 200, headers: documentHeaders(`certificate-${doc.number}`, doc.sha256) });
}
