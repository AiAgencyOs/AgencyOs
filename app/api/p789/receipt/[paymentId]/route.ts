import { NextResponse } from 'next/server';

import { appError, httpStatusFor } from '@/lib/errors';

import { getAuthContext } from '@/lib/auth/session';
import { documentHeaders } from '@/modules/projects/p789-document-http';
import { readClientReceiptDocument, readStaffReceiptDocument } from '@/modules/projects/p789-round2-queries';

/**
 * The receipt of a verified payment as a DOWNLOAD (P7-FIN-05/06). Behind the session. A client gets only its own account's receipt, for a verified payment on an
 * issued invoice (a database function filters by the account on the token); staff who may read finance (Admin, finance) get it through row security. Anyone else,
 * and a payment with no rendered document, is answered 404.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  if (!(await getAuthContext())) return NextResponse.json(appError('UNAUTHORIZED', 'Sign in to download a file.'), { status: httpStatusFor('UNAUTHORIZED') });
  if (!UUID.test(paymentId)) return NextResponse.json(appError('NOT_FOUND', 'Not found.'), { status: httpStatusFor('NOT_FOUND') });
  const doc = (await readClientReceiptDocument(paymentId)) ?? (await readStaffReceiptDocument(paymentId));
  if (!doc) return NextResponse.json(appError('NOT_FOUND', 'No receipt document is available for this payment.'), { status: httpStatusFor('NOT_FOUND'), headers: { 'Cache-Control': 'no-store' } });
  return new Response(doc.html, { status: 200, headers: documentHeaders(`receipt-${doc.number}`, doc.sha256) });
}
