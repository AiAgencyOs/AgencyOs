import { NextResponse } from 'next/server';

import { quotationPdfForProposal } from '@/modules/sales/service';

/**
 * The quotation as a document, for whoever is looking at it in AgencyOS —
 * brief §12, gap G-156.
 *
 * The first authenticated download in this repository, and the service owns
 * every decision: `quotationPdfForProposal` checks the session, the
 * capability (`lead.read`, the same gate every proposal-showing page uses),
 * reads under RLS and renders. This file only translates its answer into
 * HTTP — a route.ts is the controller layer, the HTTP-facing equivalent of
 * actions.ts.
 *
 * `requireInternal` redirects an anonymous request to /login, which is the
 * right answer for a link clicked in a browser — this URL exists on pages,
 * not in scripts. The refusals a signed-in caller can earn come back as
 * JSON with the honest status.
 *
 * `inline`, not `attachment`: the browser shows the document and its own
 * viewer offers the save, which is how a person checks a quotation before
 * deciding to keep it. The filename still travels for when they do.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS_FOR = { NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION: 400 } as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ proposalId: string }> },
) {
  const { proposalId } = await params;

  const result = await quotationPdfForProposal(proposalId);

  if (!result.ok) {
    const status = STATUS_FOR[result.error.code as keyof typeof STATUS_FOR] ?? 500;
    return NextResponse.json({ error: result.error.message }, { status });
  }

  return new NextResponse(Buffer.from(result.data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.data.filename}"`,
      // A draft's band must never outlive the draft: the same URL serves a
      // different document the moment the status moves.
      'Cache-Control': 'no-store',
    },
  });
}
