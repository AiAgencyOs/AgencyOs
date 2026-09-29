import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { paginate } from '../src/ui/primitives/paginate.ts';

/**
 * A `?page=` link goes stale the moment a filter narrows the list underneath
 * it, or someone edits the query string by hand. `paginate` is the one place
 * every DataTable list screen resolves that — clamp first, then slice — so a
 * stale link lands on the real last page instead of rendering a table with a
 * header and zero rows while the page still claims there is data.
 */

describe('paginate', () => {
  test('a requested page inside range is returned unchanged, with its slice', () => {
    const rows = Array.from({ length: 30 }, (_, i) => i);
    const result = paginate(rows, 2, 10);
    assert.equal(result.page, 2);
    assert.equal(result.pageCount, 3);
    assert.deepEqual(result.rows, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test('a page past the end clamps to the last real page', () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    const result = paginate(rows, 99, 10);
    assert.equal(result.page, 2);
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.rows, [10, 11]);
  });

  test('page 0 or negative clamps up to page 1, not an empty slice before the start', () => {
    const rows = [1, 2, 3];
    assert.equal(paginate(rows, 0, 10).page, 1);
    assert.equal(paginate(rows, -5, 10).page, 1);
  });

  test('an empty list is one page of nothing, not zero pages', () => {
    const result = paginate([], 1, 10);
    assert.equal(result.pageCount, 1);
    assert.equal(result.page, 1);
    assert.deepEqual(result.rows, []);
  });
});
