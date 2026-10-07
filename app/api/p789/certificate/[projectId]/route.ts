import { NextResponse } from 'next/server';

import { appError, httpStatusFor } from '@/lib/errors';

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
  if (!(await getAuthContext())) return NextResponse.json(appError('UNAUTHORIZED', 'Sign in to download a file.'), { status: httpStatusFor('UNAUTHORIZED') });
  if (!UUID.test(projectId)) return NextResponse.json(appError('NOT_FOUND', 'Not found.'), { status: httpStatusFor('NOT_FOUND') });
  const doc = await readCertificateDocument(projectId);
  if (!doc) return NextResponse.json(appError('NOT_FOUND', 'No certificate has been rendered for this project.'), { status: httpStatusFor('NOT_FOUND'), headers: { 'Cache-Control': 'no-store' } });
  return new Response(doc.html, { status: 200, headers: documentHeaders(`certificate-${doc.number}`, doc.sha256) });
}
