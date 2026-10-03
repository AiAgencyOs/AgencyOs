import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { bandFor, bandLines, bandsProblem, describeBudget, parseBandLines, STARTING_BANDS } from '../src/modules/crm/budget-bands.ts';

/** Q-BAND (owner, round 3): bands are the owner's; a budget shows in its band; the figure and "Not recorded" stay. */

const rupees = (minor: number) => `₹${minor / 100}`;

describe('a budget falls in exactly one band', () => {
  const bands = parseBandLines('0 Small\n50,000 Medium\n200000 Large').bands;

  test('a band starts at its figure and runs to the next one', () => {
    assert.equal(bandFor(0, bands)?.label, 'Small');
    assert.equal(bandFor(4_999_999, bands)?.label, 'Small');
    assert.equal(bandFor(5_000_000, bands)?.label, 'Medium');
    assert.equal(bandFor(19_999_999, bands)?.label, 'Medium');
    assert.equal(bandFor(20_000_000, bands)?.label, 'Large');
    assert.equal(bandFor(9_000_000_000, bands)?.label, 'Large');
  });

  test('no recorded budget has no band, and reads Not recorded', () => {
    assert.equal(bandFor(null, bands), null);
    assert.deepEqual(describeBudget(null, bands, rupees), { band: null, figure: null, text: 'Not recorded' });
    assert.equal(describeBudget(undefined, bands, rupees).text, 'Not recorded');
  });

  test('a recorded budget shows its band and its figure', () => {
    assert.equal(describeBudget(7_500_000, bands, rupees).text, 'Medium (₹75000)');
  });

  test('the owner’s bands replace the starting ones', () => {
    assert.equal(bandFor(7_500_000, STARTING_BANDS)?.label, '₹50K to ₹2L');
    assert.equal(bandFor(7_500_000, [{ label: 'Everything', minMinor: 0 }])?.label, 'Everything');
  });
});

describe('the text the owner types is checked', () => {
  test('it round-trips', () => {
    const text = bandLines(STARTING_BANDS);
    assert.deepEqual(parseBandLines(text).bands, [...STARTING_BANDS]);
  });

  test('the first band must start at 0', () => {
    assert.match(parseBandLines('100 Small').problem ?? '', /start at 0/);
  });

  test('bands must rise, and a name is used once', () => {
    assert.match(parseBandLines('0 A\n500 B\n500 C').problem ?? '', /higher/);
    assert.match(parseBandLines('0 A\n500 a').problem ?? '', /twice/);
  });

  test('a line without a figure and a name is refused', () => {
    assert.match(parseBandLines('Small').problem ?? '', /rupee figure/);
    assert.match(parseBandLines('0').problem ?? '', /rupee figure/);
  });

  test('blank text clears the setting', () => {
    assert.deepEqual(parseBandLines('  \n '), { bands: [], problem: null });
    assert.equal(bandsProblem([]), null);
  });

  test('no more than twelve bands', () => {
    const many = Array.from({ length: 13 }, (_, i) => `${i * 10} Band ${i}`).join('\n');
    assert.match(parseBandLines(many).problem ?? '', /At most 12/);
  });
});
