import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * W6 (the p13 builder's links): the pages that were built under their parents are linked from those parents.
 * Source-pinned: a page nothing links to is exactly the "built and unreachable" defect.
 */
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('W6 the p13 pages are linked from where a person looks for them', () => {
  test('Settings: Policy versions and Notification rules are tabs', () => {
    const layout = read('app/(internal)/settings/layout.tsx');
    assert.match(layout, /\{ href: '\/settings\/policy-versions', label: 'Policy versions' \}/);
    assert.match(layout, /\{ href: '\/settings\/notification-rules', label: 'Notification rules' \}/);
  });

  test('Operations links the task board and the cross-project blockers', () => {
    const ops = read('app/(internal)/operations/page.tsx');
    assert.match(ops, /href="\/operations\/task-board"/);
    assert.match(ops, /href="\/operations\/phase-blockers"/);
  });

  test('a lead’s requirement versions link to the compare page with the previous version', () => {
    const lead = read('app/(internal)/leads/[leadId]/page.tsx');
    assert.match(lead, /href=\{`\/requirements\/compare\?conversation=\$\{conversation\.id\}&a=\$\{previous\.version\}&b=\$\{v\.version\}`\}/);
  });

  test('the project page links the design clarifications', () => {
    assert.match(read('app/(internal)/projects/[projectId]/page.tsx'), /href=\{`\/projects\/\$\{projectId\}\/design-clarifications`\}/);
  });
});
