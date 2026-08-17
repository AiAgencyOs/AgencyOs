import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isValidTimeZone } from '../src/lib/admin/timezone.ts';

/**
 * The timezone setter's gatekeeper. It is the first line before the write, and
 * the same answer the database's IANA CHECK gives one layer down — so it must
 * accept exactly the zones the runtime (and Postgres) recognise, and refuse the
 * malformed input that would otherwise reach the database as an error.
 */
describe('isValidTimeZone', () => {
  test('accepts real IANA zones', () => {
    for (const z of ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'UTC']) {
      assert.equal(isValidTimeZone(z), true, `${z} is valid`);
    }
  });

  test('trims surrounding whitespace', () => {
    assert.equal(isValidTimeZone('  Asia/Kolkata  '), true);
  });

  test('refuses malformed or empty input', () => {
    for (const z of ['', '   ', 'Not A Zone!', 'Mars/Olympus', 'Asia/Nowhere']) {
      assert.equal(isValidTimeZone(z), false, `${JSON.stringify(z)} is invalid`);
    }
  });
});
