import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ageLabel } from '../src/ui/primitives/staleness.ts';

/**
 * The phrasing behind every stale-data warning on the admin panel —
 * Operations' scheduler tick first, and whatever reads a live signal next.
 */
describe('ageLabel', () => {
  test('null reads as "unknown", not a fabricated zero', () => {
    assert.equal(ageLabel(null), 'unknown');
  });

  test('seconds under the minute-and-a-half cutoff read as seconds', () => {
    assert.equal(ageLabel(0), '0s ago');
    assert.equal(ageLabel(45), '45s ago');
    assert.equal(ageLabel(90), '90s ago');
  });

  test('past the cutoff, minutes — rounded down, not up', () => {
    assert.equal(ageLabel(91), '1m ago');
    assert.equal(ageLabel(119), '1m ago');
    assert.equal(ageLabel(3600), '60m ago');
  });

  test('past an hour, hours — rounded down', () => {
    assert.equal(ageLabel(3601), '1h ago');
    assert.equal(ageLabel(7199), '1h ago');
    assert.equal(ageLabel(7200), '2h ago');
  });
});
