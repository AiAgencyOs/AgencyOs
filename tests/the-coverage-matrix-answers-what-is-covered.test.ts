import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * Master's own Coverage Matrix screen (UID §18) — Screen × State, not the
 * flat `stateGaps` sentence Design QA already writes for its own verdict.
 *
 * The point of this unit: `buildUiCoverageMatrix` recomputes NOTHING QA
 * did not already decide. It reads the exact same locked baseline
 * (`phase_three_handoffs.payload.screenBaseline.screens`) and the exact
 * same `statesAddressed` field `handleReviewUIVersion` (`src/modules/qa/
 * handlers.ts`) already compares to reach `qa_pass`/`qa_changes_required` —
 * a second, independently-computed rule here could disagree with the
 * verdict already stored, which would be worse than no matrix at all.
 *
 * Logic correctness verified directly (see session record): a screen
 * declaring loading+empty, drafted with only default+empty, correctly shows
 * loading as a gap; a screen never drafted at all shows every declared
 * state as a gap and 'default' still declared (baseline never declares it,
 * it is universal) but unaddressed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES_TS = read('src/modules/projects/queries.ts');
const PANEL = read('app/(internal)/projects/[projectId]/phase-four-panel.tsx');
const HANDLERS_TS = read('src/modules/qa/handlers.ts');

const matrixFn = region(QUERIES_TS, 'function buildUiCoverageMatrix');

describe('A. the matrix reuses the exact fields Design QA already compares', () => {
  test('reads statesAddressed, the same field handleReviewUIVersion reads', () => {
    assert.match(matrixFn, /drafted\?\.statesAddressed/);
    const qaFn = region(HANDLERS_TS, 'export async function handleReviewUIVersion', '\ntype BuildScreen');
    assert.match(qaFn, /drafted\.statesAddressed/);
  });

  test('reads baseline.states the same shape (empty/loading/error/success), not a reinvented set', () => {
    assert.match(matrixFn, /baseline\.states\?\.empty/);
    assert.match(matrixFn, /baseline\.states\?\.loading/);
    assert.match(matrixFn, /baseline\.states\?\.error/);
    assert.match(matrixFn, /baseline\.states\?\.success/);
  });

  test('default is always declared, since the baseline never bothers naming it — matching QA\'s own assumption', () => {
    assert.match(matrixFn, /\{ name: 'default', declared: true \}/);
  });
});

describe('B. a screen not drafted at all still appears, marked as such', () => {
  test('drafted is false when no matching screenKey exists in the draft', () => {
    assert.match(matrixFn, /drafted: Boolean\(drafted\)/);
  });

  test('the panel labels an undrafted screen rather than rendering a silent blank row', () => {
    // '(not drafted)' is a unique literal in this file — the whole-file check
    // is exact without needing to bound a region that happens to be the last
    // function in the file.
    assert.match(PANEL, /\(not drafted\)/);
  });
});

describe('C. it renders only trusted output, never raw markup', () => {
  test('no dangerouslySetInnerHTML in the matrix component', () => {
    // Already asserted for the WHOLE panel in phase-four-admin-overview.test
    // section A; this repeats the narrower claim for CoverageMatrix's own
    // markup specifically, without regioning a whole-file-to-the-end slice
    // for a component that happens to be declared last.
    assert.doesNotMatch(PANEL, /function CoverageMatrix[\s\S]*dangerouslySetInnerHTML/);
  });
});

describe('D. it is wired into the real overview, fed by the real read', () => {
  test('readPhaseFourOverview reads the locked baseline via the workspace\'s own phase_three_handoff_id', () => {
    // Unique literal in the file — readPhaseFourOverview is also this file's
    // last function, so a bounded region here would need to run to the very
    // end of the file regardless; the literal is specific enough that a
    // whole-file check is exact without that.
    assert.match(QUERIES_TS, /\.eq\('id', workspace\.phase_three_handoff_id\)/);
  });

  test('the panel renders CoverageMatrix against the version it is already reading', () => {
    assert.match(PANEL, /<CoverageMatrix rows=\{uiVersion\.coverageMatrix\} \/>/);
  });
});
