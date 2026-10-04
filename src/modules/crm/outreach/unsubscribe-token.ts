import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The unsubscribe link in every outreach email carries WHO and FOR WHICH ORGANISATION, signed.
 * Nobody can unsubscribe somebody else by editing a URL, and the link needs no login (a recipient
 * has none). Pure: the key is passed in, so the worker, the public route and the tests share one
 * implementation and none of them reads the environment here.
 *
 * The token never expires: an old email's link must still work - refusing to honour an unsubscribe
 * because the email is old is the worst failure this feature can have.
 */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export type UnsubscribeClaim = { organizationId: string; email: string };

function mac(key: string, payload: string): string {
  return createHmac('sha256', createHmac('sha256', 'agencyos:outreach-unsubscribe:v1').update(key).digest()).update(payload).digest('base64url');
}

export function signUnsubscribe(claim: UnsubscribeClaim, key: string): string {
  if (!key) throw new Error('no signing key: an outreach email must never be sent without a working unsubscribe link');
  const payload = b64(JSON.stringify({ o: claim.organizationId, e: claim.email.trim().toLowerCase() }));
  return `${payload}.${mac(key, payload)}`;
}

export function verifyUnsubscribe(token: string, key: string): UnsubscribeClaim | null {
  if (!key || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(key, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const parsed = JSON.parse(unb64(payload)) as { o?: unknown; e?: unknown };
    if (typeof parsed.o !== 'string' || typeof parsed.e !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.e)) return null;
    return { organizationId: parsed.o, email: parsed.e };
  } catch {
    return null;
  }
}
