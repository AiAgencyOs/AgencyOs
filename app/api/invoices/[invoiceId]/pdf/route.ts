import { NextResponse } from 'next/server';

import { httpStatusFor } from '@/lib/errors';
import { invoicePdfForInvoice } from '@/modules/finance/pdf-service';
import { routeError } from '@/lib/route-errors';

/**
 * The invoice as a document — SCR-051, the twin of
 * `app/api/quotations/[proposalId]/pdf`. The service owns every decision
 * (session, `invoice.read`, RLS, render); this file translates its answer
 * into HTTP. `inline` so the browser shows it and offers the save.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;

  const result = await invoicePdfForInvoice(invoiceId);

  if (!result.ok) {
    const status = httpStatusFor(result.error.code);
    return routeError(result.error.code, result.error.message, { status });
  }

  return new NextResponse(Buffer.from(result.data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.data.filename}"`,
      // A draft's watermark must never outlive the draft.
      'Cache-Control': 'no-store',
    },
  });
}
