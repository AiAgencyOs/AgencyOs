import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

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
    assert.match(PAGE, /<PhaseFourPanel view=\{phaseFour\} projectId=\{projectId\} \/>/);
  });
});

describe('E. the Client UI Review gate now has forms, not just a read', () => {
  test('the panel says which gate stopped being read-only, and why the rest still is', () => {
    const prose = PANEL.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /Read-only for everything but the Client UI Review gate/);
    assert.match(prose, /now have a form each/);
  });

  test('it renders ClientReviewForms against the version it is already reading', () => {
    assert.match(PANEL, /import \{ ClientReviewForms \} from '\.\/phase-four-forms'/);
    assert.match(
      PANEL,
      /<ClientReviewForms projectId=\{projectId\} uiVersionId=\{uiVersion\.id\} status=\{uiVersion\.status\} \/>/,
    );
  });
});

describe('F. "HOW MANY REVISIONS?" — Master\'s own question, now answered', () => {
  test('both revision counters are read from phase_four and shown, not just displayed as a limit', () => {
    assert.match(
      QUERIES,
      /'id, state, blocked_reason, started_at, completed_at, ui_revision_count, ui_revision_limit, prototype_revision_count, prototype_revision_limit'/,
    );
    assert.match(PANEL, /workspace\.uiRevisionCount/);
    assert.match(PANEL, /workspace\.uiRevisionLimit/);
    assert.match(PANEL, /workspace\.prototypeRevisionCount/);
    assert.match(PANEL, /workspace\.prototypeRevisionLimit/);
  });
});

describe('G. the prototype revision loop (20260924110000) broke the old single-row read; this fixes it', () => {
  test('prototype_artifacts is read by the latest deliverable version, never .maybeSingle() over ui_version_id alone', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readPhaseFourOverview'),
      QUERIES.length,
    );
    assert.match(fn, /\.eq\('ui_version_id', version\.id\)/);
    assert.match(fn, /\.order\('version', \{ foreignTable: 'deliverables', ascending: false \}\)/);
    assert.doesNotMatch(fn, /\.eq\('ui_version_id', version\.id\)\s*\n\s*\.maybeSingle\(\)/);
  });
});

describe('H. "WHAT DID CLIENT REQUEST? WHAT DID ADMIN APPROVE?" — the round itself, not just a count', () => {
  test('every ui_versions round is read, oldest first, not only the latest', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readPhaseFourOverview'),
      QUERIES.length,
    );
    assert.match(fn, /\.from\('ui_versions'\)/);
    assert.match(fn, /\.order\('version', \{ ascending: true \}\)/);
  });

  test('every prototype deliverable round is read too, filtered to kind=prototype', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readPhaseFourOverview'),
      QUERIES.length,
    );
    assert.match(fn, /\.from\('deliverables'\)\s*\n\s*\.select\('version, status'\)/);
    assert.match(fn, /\.eq\('kind', 'prototype'\)/);
  });

  test('a workspace that does not exist yet still returns empty histories, not undefined', () => {
    assert.match(QUERIES, /uiVersionHistory: \[\], prototype: null, prototypeHistory: \[\]/);
  });

  test('the panel only shows the timeline once a second round actually exists', () => {
    const fn = region(PANEL, 'function RevisionTimeline', TO_END);
    assert.match(fn, /if \(rounds\.length <= 1\) return null;/);
  });

  test('the panel renders both timelines, fed by the history the query now returns', () => {
    assert.match(PANEL, /<RevisionTimeline rounds=\{uiVersionHistory\} tone=\{UI_VERSION_TONE\} \/>/);
    assert.match(PANEL, /<RevisionTimeline rounds=\{prototypeHistory\} tone=\{UI_VERSION_TONE\} \/>/);
  });
});
