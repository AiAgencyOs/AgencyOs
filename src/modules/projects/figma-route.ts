import 'server-only';

import { NextResponse } from 'next/server';

import { serverEnv } from '@/lib/env';
import type { ErrorCode } from '@/lib/errors';
import { routeError } from '@/lib/route-errors';

import { verifyFigmaCode, type FigmaExportClaim } from './figma-export-token';

/**
 * Shared by the two plugin routes. The plugin runs in an iframe with no origin of its own, so the routes answer CORS for any origin -
 * safe because nothing here is ambient: the only authority is the signed code in the Authorization header (no cookie is read, so a
 * web page cannot ride a signed-in Admin's session into these routes).
 */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

export const preflight = () => new NextResponse(null, { status: 204, headers: CORS });

export const reply = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } });

/** A failure, in the one shape every route answers failures in (`src/lib/route-errors.ts`), with the plugin's CORS headers. */
export const replyError = (code: ErrorCode, message: string, status?: number) =>
  routeError(code, message, { ...(status === undefined ? {} : { status }), headers: { ...CORS, 'Cache-Control': 'no-store' } });

/** The key plugin codes are signed with: the vault key, else the cron secret (both are server-only and already protect other signed things). */
export function figmaSigningKey(): string {
  const env = serverEnv();
  return env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '';
}

/** The claim if the Bearer code is genuine, unexpired and for THIS project; otherwise the response to send. */
export function authorise(request: Request, projectId: string): { claim: FigmaExportClaim } | { response: NextResponse } {
  const key = figmaSigningKey();
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const claim = verifyFigmaCode(token, key, Math.floor(Date.now() / 1000));
  if (!claim) return { response: replyError('UNAUTHORIZED', 'That plugin code is not valid, or it has expired. Create a new one in AgencyOS.') };
  if (claim.projectId !== projectId) return { response: replyError('FORBIDDEN', 'That plugin code is for a different project.') };
  return { claim };
}
