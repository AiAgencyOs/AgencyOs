import { createHmac, createHash } from 'node:crypto';

/**
 * The reference a prospect carries from another channel into WhatsApp - pure, so it is testable without a server.
 *
 *   AOS-K7QM-2X9P-4TDV-8HNC        80 bits, Crockford base32 (no I, L, O, U), typed or pasted
 *
 * It carries NO data: it is derived from a handoff id with HMAC, so a retried job regenerates the same link without
 * the plaintext ever being stored, and the database keeps only its SHA-256. Everything it resolves to is server-side.
 * Rotating the signing secret stops NEW derivations matching existing handoffs; links already sent keep working,
 * because lookup is by the hash of what was sent.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 16;

function base32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

/**
 * AOS, then four groups of four, each group contiguous - hyphens or single spaces between groups are optional. The
 * groups must be contiguous so ordinary prose ("AOS rocks and so does ...") can never be read as a reference.
 */
const SHAPE = 'AOS[-\\s]?(?:[0-9A-Z]{4}[-\\s]?){3}[0-9A-Z]{4}\\b';

const group = (raw: string) => `AOS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;

/** The reference for a handoff id. Needs a non-empty secret: an unsigned reference would be guessable from the id. */
export function deriveHandoffCode(handoffId: string, secret: string): string {
  if (!secret) throw new Error('a handoff reference cannot be derived without a signing secret');
  const digest = createHmac('sha256', secret).update(`handoff:${handoffId}`).digest();
  return group(base32(digest.subarray(0, 10), LENGTH));
}

/** Canonical form of whatever a person typed or pasted, or null if it is not a reference. Tolerates case, spaces, hyphens and I/L/O look-alikes. */
export function normalizeHandoffCode(raw: string): string | null {
  const match = new RegExp(`^\\s*${SHAPE}\\s*$`, 'i').exec(raw);
  if (!match) return null;
  const body = match[0].trim().slice(3).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (body.length !== LENGTH || [...body].some((c) => !ALPHABET.includes(c))) return null;
  return group(body);
}

/** The first reference inside a longer message ("Hi, following up. Ref AOS-...."), canonicalised, or null. */
export function extractHandoffCode(text: string): string | null {
  const match = new RegExp(`\\b${SHAPE}`, 'i').exec(text);
  return match ? normalizeHandoffCode(match[0]) : null;
}

/** What the database stores and looks up. */
export function hashHandoffCode(code: string): string {
  const canonical = normalizeHandoffCode(code);
  if (!canonical) throw new Error('not a handoff reference');
  return createHash('sha256').update(canonical).digest('hex');
}

/** The public link a prospect follows. It redirects into WhatsApp; it never shows anything. */
export function handoffLink(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/handoff/${encodeURIComponent(code)}`;
}

/** wa.me link with the reference pre-filled, so the first message carries it. */
export function whatsappDeepLink(businessNumber: string, code: string): string {
  const digits = businessNumber.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(`Hi, I'm following up on our earlier conversation. Ref ${code}`)}`;
}
