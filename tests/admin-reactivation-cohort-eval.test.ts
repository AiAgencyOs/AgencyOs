import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { interpretAddOutcome, interpretRemoveOutcome } from '../src/lib/admin/reactivation-cohort-eval.ts';

/**
 * The app-layer half of "cannot bypass consent." The database refuses to enrol
 * a lead whose contact has no granted WhatsApp consent (`no_consent`); this
 * proves the interpreter NEVER turns that refusal — or any unknown verdict —
 * into an enrolment.
 */
describe('interpretAddOutcome', () => {
  test('no_consent is a VALIDATION error and never an enrolment', () => {
    const d = interpretAddOutcome('no_consent');
    assert.equal(d.kind, 'error');
    assert.notEqual(d.kind, 'enrolled');
    if (d.kind === 'error') {
      assert.equal(d.code, 'VALIDATION');
      assert.match(d.message, /consent/i);
    }
  });

  test('added and already_in both succeed (idempotent)', () => {
    for (const o of ['added', 'already_in']) {
      assert.equal(interpretAddOutcome(o).kind, 'enrolled');
    }
  });

  test('forbidden and not_found map to their codes', () => {
    assert.deepEqual(
      { c: (interpretAddOutcome('forbidden') as { code: string }).code },
      { c: 'FORBIDDEN' },
    );
    assert.equal((interpretAddOutcome('not_found') as { code: string }).code, 'NOT_FOUND');
  });

  test('an unknown or missing verdict is an INTERNAL error, not a silent success', () => {
    for (const o of [undefined, '', 'weird', 'granted']) {
      const d = interpretAddOutcome(o);
      assert.equal(d.kind, 'error');
      if (d.kind === 'error') assert.equal(d.code, 'INTERNAL');
    }
  });
});

describe('interpretRemoveOutcome', () => {
  test('removed and not_in both succeed (idempotent), never error', () => {
    for (const o of ['removed', 'not_in']) {
      assert.equal(interpretRemoveOutcome(o).kind, 'removed');
    }
  });

  test('removal has no consent concept — no branch mentions it', () => {
    // Whatever the verdict, removal never emits a consent message; taking a
    // lead out is always safe.
    for (const o of ['removed', 'not_in', 'forbidden', 'not_found', undefined]) {
      const d = interpretRemoveOutcome(o);
      if (d.kind === 'error') assert.doesNotMatch(d.message, /consent/i);
    }
  });

  test('an unknown verdict is INTERNAL, not a silent success', () => {
    const d = interpretRemoveOutcome('weird');
    assert.equal(d.kind, 'error');
    if (d.kind === 'error') assert.equal(d.code, 'INTERNAL');
  });
});
