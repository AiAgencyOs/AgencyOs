import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { constantTimeEquals } from '../src/lib/constant-time.ts';
import { CRON_UNAUTHORIZED, authorizeCronRequest } from '../src/lib/cron-auth.ts';

/**
 * Every secret comparison is constant-time — gap G-131.
 *
 * The repository had three shared-secret comparisons and two were constant-
 * time: the WhatsApp subscription token and the webhook HMAC both went through
 * a private helper that documented the tradeoff. `CRON_SECRET` used `!==`, and
 * `cron-auth.ts` documented the whole-header comparison, the fail-closed
 * behaviour and that nothing logs the secret — while saying nothing about
 * timing, which is what marked it as an oversight rather than a decision.
 *
 * The tests that matter here are the ones that stop a *fourth* edge from
 * repeating it, so the invariant is asserted across the source rather than
 * only through the two functions that exist today.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const cronAuth = read('../src/lib/cron-auth.ts');
const whatsappVerify = read('../src/lib/whatsapp/verify.ts');
const helper = read('../src/lib/constant-time.ts');

describe('A. the helper does what it claims', () => {
  test('equal strings compare equal', () => {
    assert.equal(constantTimeEquals('Bearer abcdef123456', 'Bearer abcdef123456'), true);
  });

  test('different strings of the same length do not', () => {
    assert.equal(constantTimeEquals('Bearer abcdef123456', 'Bearer abcdef123457'), false);
  });

  test('different lengths return false rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch. A comparison helper that
    // throws on the attacker-controlled input is a denial of service, not a
    // safety feature.
    assert.doesNotThrow(() => constantTimeEquals('short', 'a much longer value'));
    assert.equal(constantTimeEquals('short', 'a much longer value'), false);
  });

  test('the empty string is not equal to a real secret', () => {
    assert.equal(constantTimeEquals('', 'Bearer s3cret'), false);
  });

  test('and it is byte-wise, not locale-wise', () => {
    // Unicode normalisation would make two different byte sequences compare
    // equal, which for a secret is a way in.
    assert.equal(constantTimeEquals('é', 'é'), false);
  });
});

describe('B. no secret in this repository is compared with !==', () => {
  test('cron-auth uses the shared helper', () => {
    assert.match(cronAuth, /constantTimeEquals\(presented, `Bearer \$\{secret\}`\)/);
  });

  test('and does not compare the header with a plain operator', () => {
    // Asserted as an absence so any future rewrite fails here, not only the
    // exact expression that was replaced.
    assert.ok(
      !/presented\s*[!=]==\s*`Bearer/.test(cronAuth),
      'the cron secret is compared with a plain operator again',
    );
  });

  test('both WhatsApp comparisons use it too', () => {
    assert.match(whatsappVerify, /constantTimeEquals\(presented, token\)/);
    assert.match(whatsappVerify, /constantTimeEquals\(digest, expected\)/);
  });

  test('and neither file keeps a private copy of the primitive', () => {
    // Two copies of a security primitive drift. The point of the shared module
    // is that there is one.
    for (const [name, source] of [
      ['cron-auth.ts', cronAuth],
      ['whatsapp/verify.ts', whatsappVerify],
    ] as const) {
      assert.ok(
        !/timingSafeEqual/.test(source),
        `${name} implements its own constant-time compare instead of importing one`,
      );
    }
    assert.match(helper, /timingSafeEqual/);
  });
});

describe('C. behaviour is unchanged by the refactor', () => {
  const SECRET = 'a-cron-secret-that-is-long-enough';

  test('the right header is still accepted', () => {
    assert.deepEqual(authorizeCronRequest(`Bearer ${SECRET}`, SECRET), { ok: true });
  });

  test('a missing header is still 401, not a crash', () => {
    // `presented` is null when the header is absent, and the helper needs a
    // string — a null must reach the same refusal as a wrong value.
    const r = authorizeCronRequest(null, SECRET);
    assert.deepEqual(r, { ok: false, status: 401, error: CRON_UNAUTHORIZED });
  });

  test('a bare secret without the scheme is still refused', () => {
    assert.equal(authorizeCronRequest(SECRET, SECRET).ok, false);
  });

  test('a differently-cased scheme is still refused', () => {
    assert.equal(authorizeCronRequest(`bearer ${SECRET}`, SECRET).ok, false);
  });

  test('and an unset secret is 503 — disabled, not forbidden', () => {
    // The runner is inert rather than open, and the distinction is the honest
    // answer to an operator reading the status code.
    const r = authorizeCronRequest(`Bearer ${SECRET}`, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.ok ? null : r.status, 503);
  });

  test('an unset secret refuses even an empty presented value', () => {
    assert.equal(authorizeCronRequest('', undefined).ok, false);
  });
});

describe('D. the honest note about what this is worth', () => {
  test('the helper records that this is defence in depth, not a closed exploit', () => {
    // Overstating a security fix is its own kind of false claim. Remotely
    // timing a JS string comparison across the internet is extremely
    // difficult, and the file says so.
    assert.match(helper, /defence in depth/i);
    assert.match(helper, /network jitter/i);
  });

  test('and it records the length leak rather than implying there is none', () => {
    assert.match(helper, /leaks the length/i);
  });
});
