import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * "WHAT IS BLOCKED?" — Master's own Admin Panel checklist, answered across
 * the whole organization rather than one project at a time. A stopped Task 2
 * workspace was real, already-stored state (`phase_four.state` in
 * `blocked_requirement`/`scope_escalation`/`revision_limit_escalation`) with
 * no reader beyond that one project's own overview panel — findable only by
 * already knowing to look, the identical gap `20260924140000` closed for the
 * WhatsApp side of the same fact.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES_TS = read('src/modules/projects/queries.ts');
const PAGE = read('app/(internal)/projects/escalations/page.tsx');
const LAYOUT = read('app/(internal)/layout.tsx');

const queryFn = region(QUERIES_TS, 'export async function listPhaseFourEscalations', TO_END);

describe('A. the query reads every stop state, org-wide, not one project', () => {
  test('all three stop states are included', () => {
    assert.match(queryFn, /'blocked_requirement', 'scope_escalation', 'revision_limit_escalation'/);
  });

  test('there is no project_id filter — this is cross-project by design', () => {
    assert.doesNotMatch(queryFn, /\.eq\('project_id'/);
  });

  test('a failed read is guarded (G-054), not presented as "nothing is blocked"', () => {
    assert.match(queryFn, /if \(workspacesError\) unreadable\(/);
    assert.match(queryFn, /if \(projectsError\) unreadable\(/);
  });

  test('an empty result short-circuits before a second, wasted read', () => {
    assert.match(queryFn, /if \(rows\.length === 0\) return \[\];/);
  });
});

describe('B. it renders only trusted React children, never raw markup', () => {
  test('no dangerouslySetInnerHTML anywhere on the page', () => {
    assert.doesNotMatch(PAGE, /dangerouslySetInnerHTML/);
  });
});

describe('C. it is read-only, matching Master\'s own rule for this stop', () => {
  test('the page says why there is no resume button', () => {
    const prose = PAGE.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /nothing resumes the loop automatically/);
  });

  test('there is no form or server action import on the page', () => {
    assert.doesNotMatch(PAGE, /'use server'|useActionState|<form/);
  });
});

describe('D. it is reachable — gated the same way the Projects list is, and in the nav', () => {
  test('the page gates on project.read, the same capability /projects itself uses', () => {
    assert.match(PAGE, /can\(context\.role, 'project\.read'\)/);
  });

  test('it is a real page under the internal route group, not orphaned', () => {
    assert.match(PAGE, /export default async function EscalationsPage/);
  });

  test('it is linked from the sidebar', () => {
    assert.match(LAYOUT, /\{ href: '\/projects\/escalations', label: 'Escalations', capability: 'project\.read' \}/);
  });
});
