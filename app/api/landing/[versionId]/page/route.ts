import { NextResponse } from 'next/server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { renderApprovedPage } from '@/modules/acquisition/landing';
import { routeError } from '@/lib/route-errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approved landing page, rendered exactly as the engine would send it, for a person to upload by hand. Internal managers only, and
 * only the organisation's own versions: the render reads the immutable version row, so what is downloaded is what was approved.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const context = await requireInternal('/lead-generation/google');
  if (!can(context, 'acquisition.manage') || !context.organizationId) {
    return routeError('FORBIDDEN', 'You do not have permission to manage lead generation.');
  }
  const { versionId } = await params;
  if (!UUID.test(versionId)) return routeError('NOT_FOUND', 'Not found.');
  const page = await renderApprovedPage(createAdminClient(), context.organizationId, versionId);
  if (!page) return routeError('NOT_FOUND', 'Not found.');
  return new NextResponse(page.html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${page.slug}.html"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
