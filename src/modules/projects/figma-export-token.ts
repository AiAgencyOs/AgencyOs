import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The code the Admin pastes into the Figma plugin. The plugin has no AgencyOS login, so it carries a signed, expiring code that
 * names ONE project of ONE organization and one purpose. It cannot be edited into another project, it expires (24 hours), and it
 * is good for exactly two things: reading that project's finalized screens and direction, and reporting what it built. Pure: the
 * key is passed in.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export const FIGMA_CODE_TTL_SECONDS = 24 * 3600;

export type FigmaExportClaim = { organizationId: string; projectId: string; expiresAt: number };

function mac(key: string, payload: string): string {
  return createHmac('sha256', createHmac('sha256', 'agencyos:figma-plugin:v1').update(key).digest()).update(payload).digest('base64url');
}

export function signFigmaCode(claim: Omit<FigmaExportClaim, 'expiresAt'>, key: string, nowSeconds: number, ttl = FIGMA_CODE_TTL_SECONDS): string {
  if (!key) throw new Error('no signing key: a plugin code cannot be issued');
  const payload = b64(JSON.stringify({ o: claim.organizationId, p: claim.projectId, x: nowSeconds + ttl, u: 'figma-import' }));
  return `${payload}.${mac(key, payload)}`;
}

export function verifyFigmaCode(token: string, key: string, nowSeconds: number): FigmaExportClaim | null {
  if (!key || typeof token !== 'string') return null;
  const [payload, sig] = token.trim().split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(key, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(unb64(payload)) as { o?: unknown; p?: unknown; x?: unknown; u?: unknown };
    if (c.u !== 'figma-import' || typeof c.o !== 'string' || typeof c.p !== 'string' || typeof c.x !== 'number') return null;
    if (c.x < nowSeconds) return null;
    return { organizationId: c.o, projectId: c.p, expiresAt: c.x };
  } catch {
    return null;
  }
}
