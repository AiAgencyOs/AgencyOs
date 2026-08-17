import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { interpretVerify } from '../src/lib/admin/whatsapp-eval.ts';

/**
 * The verify check must NEVER send a message and must NEVER leak a token — the
 * token never reaches this function. What it must do is turn Meta's status
 * codes into an actionable, value-free answer, and distinguish a bad token from
 * a bad number so an operator fixes the right thing.
 */
describe('interpretVerify', () => {
  test('200 with metadata reads as reachable and carries the public facts', () => {
    const r = interpretVerify(200, {
      verified_name: 'Acme',
      display_phone_number: '+91 98765 43210',
      quality_rating: 'GREEN',
    });
    assert.equal(r.ok, true);
    assert.equal(r.verifiedName, 'Acme');
    assert.equal(r.displayPhoneNumber, '+91 98765 43210');
    assert.equal(r.qualityRating, 'GREEN');
  });

  test('401/403 blames the token, not the number', () => {
    for (const s of [401, 403]) {
      const r = interpretVerify(s, { error: {} });
      assert.equal(r.ok, false);
      assert.match(r.message, /token/i);
      assert.doesNotMatch(r.message, /number/i);
    }
  });

  test('404 blames the number, not the token', () => {
    const r = interpretVerify(404, { error: {} });
    assert.equal(r.ok, false);
    assert.match(r.message, /number/i);
  });

  test('429 says it may be fine, try again', () => {
    const r = interpretVerify(429, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /again/i);
  });

  test('an unexpected status is reported by its code, not flattened', () => {
    const r = interpretVerify(500, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /500/);
  });
});
