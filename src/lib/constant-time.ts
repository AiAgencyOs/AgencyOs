import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison, for every secret this application compares.
 *
 * Gap G-131. This repository had **three** shared-secret comparisons and two
 * of them were constant-time: the WhatsApp subscription token and the webhook
 * HMAC signature both went through a private `equals` in
 * `src/lib/whatsapp/verify.ts`, which documented the tradeoff carefully. The
 * job runner's `CRON_SECRET` check used `!==`.
 *
 * `src/lib/cron-auth.ts` documented that the header is compared whole, that an
 * unset secret fails closed, and that nothing logs the secret — and said
 * nothing at all about timing, which is what marked it as an oversight rather
 * than a decision somebody had weighed.
 *
 * So the helper lives here rather than in either caller. Two copies of a
 * security primitive drift, and a private one invites the next edge to write
 * `!==` again because the safe version is not visible from where it is needed.
 *
 * ── on the length leak ────────────────────────────────────────────────────
 *
 * `timingSafeEqual` throws on a length mismatch, so length is compared first
 * and returns early. That leaks the length of the expected value. For a
 * fixed-width hex digest the length is already public; for a configured token
 * it is not worth the branchless gymnastics of hiding, and the same judgement
 * was already recorded when the WhatsApp path was written.
 *
 * ── on how much this is worth ─────────────────────────────────────────────
 *
 * Recorded honestly, because overstating it would be its own kind of false
 * claim: remotely timing a JavaScript string comparison across the public
 * internet is extremely difficult, and network jitter swamps the nanosecond
 * differences involved. This is **defence in depth and consistency**, not the
 * closing of an exploited hole. It is worth doing because the cost is one
 * function call, the primitive already existed, and a reader comparing the two
 * edges would reasonably ask why they differ.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
