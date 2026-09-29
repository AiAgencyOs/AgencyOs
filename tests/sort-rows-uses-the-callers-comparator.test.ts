import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sortRows } from '../src/ui/primitives/sort-rows.ts';

/**
 * `DataTable`'s sortable columns — a shared table primitive has no idea what
 * an "Amount" column means for a given page (`total_minor`? `amountMinor`?),
 * so `sortRows` takes the caller's own comparators rather than inventing a
 * field-name convention every column would have to match.
 */

type Row = { id: string; n: number };

describe('sortRows', () => {
  const rows: Row[] = [
    { id: 'c', n: 3 },
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
  ];
  const comparators = { n: (a: Row, b: Row) => a.n - b.n };

  test('ascending uses the comparator as given', () => {
    assert.deepEqual(
      sortRows(rows, 'n', 'asc', comparators).map((r) => r.id),
      ['a', 'b', 'c'],
    );
  });

  test('descending reverses the ascending order', () => {
    assert.deepEqual(
      sortRows(rows, 'n', 'desc', comparators).map((r) => r.id),
      ['c', 'b', 'a'],
    );
  });

  test('no sortKey leaves the original order untouched', () => {
    assert.deepEqual(
      sortRows(rows, undefined, 'asc', comparators).map((r) => r.id),
      ['c', 'a', 'b'],
    );
  });

  test('a sortKey with no matching comparator degrades to unsorted, not a crash', () => {
    assert.deepEqual(
      sortRows(rows, 'unknown_column', 'asc', comparators).map((r) => r.id),
      ['c', 'a', 'b'],
    );
  });

  test('does not mutate the input array', () => {
    const copy = [...rows];
    sortRows(rows, 'n', 'asc', comparators);
    assert.deepEqual(rows, copy);
  });
});
