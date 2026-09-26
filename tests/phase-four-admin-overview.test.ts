import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 4 Overview — Impl §10; Master's own Admin Panel checklist.
 * docs/phase-4-gap-analysis.md step 7.
 *
 * Not browser-verified this session (see docs/phase-4-implementation-
 * traceability.md and the session record): the dev server here is wired to
 * the real production Supabase, and creating test data there without
 * explicit authorization was declined. What is checked here is what a
 * regex safely can — the panel never renders raw content via
 * dangerouslySetInnerHTML, every status it displays comes from the stored
 * row, and the read function never presents "not started" for a workspace
 * it failed to read.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const PANEL = read('app/(internal)/projects/[projectId]/phase-four-panel.tsx');
const QUERIES = read('src/modules/projects/queries.ts');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');

describe('A. it renders only trusted React children, never raw markup', () => {
  test('no dangerouslySetInnerHTML anywhere in the panel', () => {
    assert.doesNotMatch(PANEL, /dangerouslySetInnerHTML/);
  });
});

describe('B. a failed read is not presented as "not started" (G-054)', () => {
  test('every read in readPhaseFourOverview is guarded', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readPhaseFourOverview'),
      QUERIES.length,
    );
    const errorChecks = (fn.match(/if \(\w+Error\) unreadable\(/g) ?? []).length;
    assert.ok(errorChecks >= 4, `expected at least 4 guarded reads, found ${errorChecks}`);
  });

  test('a workspace that does not exist is distinguished from one this function failed to read', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readPhaseFourOverview'),
      QUERIES.indexOf('export async function readPhaseFourOverview') + 800,
    );
    assert.match(fn, /if \(workspaceError\) unreadable\(/);
    assert.match(fn, /if \(!workspace\) \{/);
  });
});

describe('C. it answers Master\'s own Admin Panel questions directly', () => {
  test('current macro-stage, UI version status, prototype status and the Phase 5 gate are all shown', () => {
    assert.match(PANEL, /workspace\.state/);
    assert.match(PANEL, /uiVersion\.status/);
    assert.match(PANEL, /prototype\.deliverableStatus/);
    assert.match(PANEL, /phaseFiveGate\.outcome/);
  });

  test('QA findings are shown, not hidden behind a generic status word', () => {
    assert.match(PANEL, /uiVersion\.qaFindings/);
    assert.match(PANEL, /prototype\.qaFindings/);
  });

  test('the prototype preview link uses the real artifact_url, not a guessed path', () => {
    assert.match(PANEL, /href=\{prototype\.artifactUrl\}/);
  });
});

describe('D. it is wired into the real project page, not an orphaned component', () => {
  test('the page imports and renders it, fed by the real query', () => {
    assert.match(PAGE, /import \{ PhaseFourPanel \} from '\.\/phase-four-panel'/);
    assert.match(PAGE, /const phaseFour = await readPhaseFourOverview\(projectId\)/);
    assert.match(PAGE, /<PhaseFourPanel view=\{phaseFour\} \/>/);
  });
});

describe('E. what this pass does not build, named rather than silently assumed', () => {
  test('the panel says it is read-only, and why', () => {
    const prose = PANEL.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /Read-only in this pass/);
    assert.match(prose, /Building those forms is real, separate frontend work/);
  });
});
