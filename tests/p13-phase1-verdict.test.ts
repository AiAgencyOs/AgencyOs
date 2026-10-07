// P1-DOD-117: the verdict is computed from the matrix rows. Fixture matrices prove each branch of the rule; one test pins that the real matrix parses completely.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// @ts-expect-error plain ESM script without types
import { classify, parseMatrix, verdict } from '../scripts/phase1-verdict.mjs';

const doc = (rows: string[]) => ['## Section A', '| ID | Source | Requirement | Status | Evidence |', '|---|---|---|---|---|', ...rows].join('\n');

test('EXISTS and MANUAL_EXTERNAL rows are not blocking; a buildable PARTIAL or MISSING row is', () => {
  const done = verdict(parseMatrix(doc(['| P1-AAA-001 | s | req | EXISTS | proof |', '| P1-AAA-002 | s | req | MANUAL_EXTERNAL | needs a number |'])));
  assert.equal(done.verdict, 'COMPLETE');
  const open = verdict(parseMatrix(doc(['| P1-AAA-001 | s | req | EXISTS | proof |', '| P1-AAA-003 | s | req | PARTIAL | half built. BUILDABLE |'])));
  assert.equal(open.verdict, 'BLOCKED');
  assert.equal(open.counts.buildable_open, 1);
});

test('a PARTIAL row that waits only on EXTERNAL(...) does not block, but one that names nothing does (nobody said what it waits on)', () => {
  const waiting = parseMatrix(doc(['| P1-AAA-004 | s | req | PARTIAL | needs a key. EXTERNAL(credentials) |']))[0];
  assert.equal(classify(waiting), 'waiting_on_a_person');
  const unclassified = parseMatrix(doc(['| P1-AAA-005 | s | req | MISSING | nothing found |']))[0];
  assert.equal(classify(unclassified), 'open_unclassified');
  assert.equal(verdict([waiting]).verdict, 'COMPLETE');
  assert.equal(verdict([unclassified]).verdict, 'BLOCKED');
});

test('a row with a status the script does not know BLOCKS, and an empty matrix is never COMPLETE', () => {
  const rows = parseMatrix(doc(['| P1-AAA-006 | s | req | DONE-ISH | trust me |']));
  assert.equal(rows[0].status, 'UNKNOWN');
  assert.equal(verdict(rows).verdict, 'BLOCKED');
  assert.equal(verdict([]).verdict, 'BLOCKED');
});

test('the real matrix parses to every row it declares, in sections, with no unreadable status', () => {
  const md = readFileSync(new URL('../docs/phase-1-3-implementation-traceability.md', import.meta.url), 'utf8');
  const declared = /\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/.exec(md);
  assert.ok(declared, 'the summary table has a Total row');
  const result = verdict(parseMatrix(md));
  assert.equal(result.rows, Number(declared[1]));
  assert.equal(result.counts.unreadable, 0);
  assert.ok(Object.keys(result.bySection).length >= 20);
});
