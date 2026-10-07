import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { recordBuildReport } from '@/modules/projects/build-report-service';
import { buildReportSchema, maskReport, verifyBuildReport } from '@/modules/projects/github-build';
import { routeError } from '@/lib/route-errors';

/**
 * The build worker's signed report (GitHub Actions). Nothing unsigned, stale or malformed is accepted, and a report is only ever recorded for a
 * build request that exists for that deliverable and commit. The secret is read from the environment by name and never echoed.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.BUILD_REPORT_SECRET;
  if (!secret) return routeError('INTERNAL', 'build reports are not configured on this deployment', { status: 503 });

  // refuse an oversized body BEFORE reading it (the declared length), and again on what was actually read
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > 200_000) return routeError('VALIDATION', 'report too large', { status: 413 });
  const rawBody = await request.text();
  if (rawBody.length > 200_000) return routeError('VALIDATION', 'report too large', { status: 413 });

  const verdict = verifyBuildReport({
    secret,
    rawBody,
    signature: request.headers.get('x-agencyos-signature'),
    timestamp: request.headers.get('x-agencyos-timestamp'),
    now: new Date(),
  });
  if (!verdict.ok) return routeError(verdict.reason === 'stale' ? 'VALIDATION' : 'UNAUTHORIZED', `report refused: ${verdict.reason}`, { status: verdict.reason === 'stale' ? 408 : 401 });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return routeError('VALIDATION', 'report is not JSON', { status: 400 });
  }
  const parsed = buildReportSchema.safeParse(json);
  if (!parsed.success) return routeError('VALIDATION', `report is malformed: ${parsed.error.issues[0]?.message ?? 'unparseable'}`, { status: 400 });

  const outcome = await recordBuildReport(createAdminClient(), maskReport(parsed.data));
  if (outcome.status === 'refused') {
    return routeError(outcome.reason === 'no_open_request' ? 'CONFLICT' : 'VALIDATION', outcome.detail, { status: outcome.reason === 'no_open_request' ? 409 : 422, extra: { reason: outcome.reason } });
  }
  return NextResponse.json({ recorded: true, build: outcome.build, detail: outcome.detail });
}
