import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * UID §18's "UI Versions" Admin surface — the other half of the Coverage
 * Matrix (`the-coverage-matrix-answers-what-is-covered.test.ts`): that grid
 * answers WHICH screens and states exist; this page answers what was
 * actually proposed for each. `readPhaseFourOverview` only ever surfaced a
 * screen count; nothing before this let an Admin read `layoutSummary`/
 * `keyComponents`/`statesAddressed` without querying the database directly.
 *
 * Mirrors the already-reviewed prototype preview page
 * (`prototype/preview/[uiVersionId]/page.tsx`) in every structural choice:
 * staff-only for the identical, named reason (no client-facing renderer
 * exists yet), read by the version's own id, and no
 * `dangerouslySetInnerHTML` because the content is plain strings and arrays
 * React already escapes.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES_TS = read('src/modules/projects/queries.ts');
const PAGE = read('app/(internal)/projects/[projectId]/ui-versions/[uiVersionId]/page.tsx');
const PANEL = read('app/(internal)/projects/[projectId]/phase-four-panel.tsx');

describe('A. the query reads real content, not a re-derived summary', () => {
  test('getUiVersionDetail reads layoutSummary, keyComponents and statesAddressed', () => {
    assert.match(QUERIES_TS, /export type UiVersionDraftScreen = \{/);
    assert.match(QUERIES_TS, /layoutSummary: string;/);
    assert.match(QUERIES_TS, /keyComponents: string\[\];/);
    assert.match(QUERIES_TS, /statesAddressed: string\[\];/);
  });

  test('it is read by the version\'s own id, the same shape getPrototypeArtifactByUiVersion uses', () => {
    assert.match(QUERIES_TS, /export async function getUiVersionDetail\(uiVersionId: string\)/);
    assert.match(QUERIES_TS, /\.eq\('id', uiVersionId\)/);
  });

  test('a failed read is guarded (G-054)', () => {
    const start = QUERIES_TS.indexOf('export async function getUiVersionDetail');
    const region = QUERIES_TS.slice(start, start + 2100);
    assert.match(region, /if \(error\) unreadable\('getUiVersionDetail', error\);/);
    assert.match(region, /if \(handoffError\) unreadable\('getUiVersionDetail\.handoff', handoffError\);/);
  });

  test('the matrix is judged against the ROUND\'s own baseline, not the workspace\'s current one', () => {
    const start = QUERIES_TS.indexOf('export async function getUiVersionDetail');
    const region = QUERIES_TS.slice(start, start + 2100);
    assert.match(region, /source_phase_three_handoff_id/);
    assert.match(region, /buildUiCoverageMatrix\(baselineScreens, \(data\.screens \?\? \[\]\) as DraftedScreen\[\]\)/);
    assert.match(region, /coverageMatrix,/);
  });
});

describe('B. the page is gated and scoped the same way the prototype preview page is', () => {
  test('staff-only, matching the identical named boundary', () => {
    assert.match(PAGE, /can\(context, 'project\.read'\)/);
    const prose = PAGE.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /Staff-only, matching the identical, already-reviewed boundary/);
  });

  test('a version from a different project is a 404, not a cross-project leak', () => {
    assert.match(PAGE, /if \(!version \|\| version\.projectId !== projectId\) notFound\(\);/);
  });

  test('no dangerouslySetInnerHTML anywhere on the page', () => {
    assert.doesNotMatch(PAGE, /dangerouslySetInnerHTML/);
  });

  test('it renders this round\'s own Coverage Matrix, sharing the one component the overview panel uses', () => {
    assert.match(PAGE, /import \{ CoverageMatrix \} from '\.\.\/\.\.\/phase-four-panel'/);
    assert.match(PAGE, /<CoverageMatrix rows=\{version\.coverageMatrix\} \/>/);
    assert.match(PANEL, /export function CoverageMatrix/);
  });
});

describe('C. it is reachable from the overview, not an orphaned route', () => {
  test('the current version links to its own detail page', () => {
    assert.match(PANEL, /href=\{`\/projects\/\$\{projectId\}\/ui-versions\/\$\{uiVersion\.id\}`\}/);
  });

  test('every round in the revision timeline links to its own detail page too', () => {
    assert.match(PANEL, /hrefFor=\{\(r\) => `\/projects\/\$\{projectId\}\/ui-versions\/\$\{r\.id\}`\}/);
  });
});
