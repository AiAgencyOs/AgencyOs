// P1-BLUEPRINT-013 / P1-MP3-135: requirement version compare.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compareRequirementPayloads, quoteImpact } from '../src/modules/crm/requirement-diff.ts';

const base = {
  summary: 'A booking app for a salon',
  scopeItems: [
    { title: 'Online booking', detail: 'pick a stylist and a slot' },
    { title: 'Reminders', detail: 'sms' },
  ],
  platforms: ['Android'],
  constraints: ['Launch before Diwali'],
  exclusions: ['Payments'],
};

test('an identical payload compares as identical, even when only case and spacing differ', () => {
  const r = compareRequirementPayloads(base, { ...base, summary: '  a  booking app for a SALON ', constraints: ['launch  before diwali'] });
  assert.equal(r.identical, true);
  assert.equal(r.scopeChanged, false);
  assert.deepEqual(r.sections, []);
});

test('scope items are matched by title: added, removed and modified are different things', () => {
  const r = compareRequirementPayloads(base, {
    ...base,
    scopeItems: [
      { title: 'online booking', detail: 'pick a stylist, a slot and a service' },
      { title: 'Loyalty points', detail: '' },
    ],
  });
  const scope = r.sections.find((s) => s.key === 'scopeItems');
  assert.deepEqual(scope?.added, ['Loyalty points']);
  assert.deepEqual(scope?.removed, ['Reminders']);
  assert.deepEqual(scope?.modified.map((m) => m.name), ['online booking']);
  assert.equal(r.scopeChanged, true);
});

test('list sections report additions and removals; a change to what is built or priced marks scope changed, a change to an assumption does not', () => {
  const noisy = compareRequirementPayloads(base, { ...base, assumptions: ['the client has a logo'], openQuestions: ['who pays for SMS?'] });
  assert.equal(noisy.scopeChanged, false, 'assumptions and open questions do not change what is priced');
  assert.deepEqual(noisy.sections.map((s) => s.key).sort(), ['assumptions', 'openQuestions']);

  const priced = compareRequirementPayloads(base, { ...base, platforms: ['Android', 'iOS'], exclusions: [] });
  assert.equal(priced.scopeChanged, true);
  assert.deepEqual(priced.sections.find((s) => s.key === 'platforms')?.added, ['iOS']);
  assert.deepEqual(priced.sections.find((s) => s.key === 'exclusions')?.removed, ['Payments']);
});

test('summary and budget notes are reported as modified text', () => {
  const r = compareRequirementPayloads(base, { ...base, summary: 'A booking and payments app for a salon', timelineBudgetNotes: 'about 2 lakh' });
  assert.deepEqual(r.sections.map((s) => s.key).sort(), ['summary', 'timelineBudgetNotes']);
  assert.equal(r.scopeChanged, false, 'the wording of the summary alone does not reprice');
});

test('quote impact: not quoted, unaffected, already included, or needs review', () => {
  assert.equal(quoteImpact({ scopeChanged: true, identical: false, quotedVersion: null, fromVersion: 1, toVersion: 2 }).level, 'not_quoted');
  assert.equal(quoteImpact({ scopeChanged: false, identical: false, quotedVersion: 1, fromVersion: 1, toVersion: 2 }).level, 'none');
  assert.equal(quoteImpact({ scopeChanged: true, identical: false, quotedVersion: 2, fromVersion: 1, toVersion: 2 }).level, 'none');
  const review = quoteImpact({ scopeChanged: true, identical: false, quotedVersion: 1, fromVersion: 1, toVersion: 2 });
  assert.equal(review.level, 'review');
  assert.doesNotMatch(review.message, /will be re-?priced/i, 'the page never promises a re-price: that is a person decision');
});

test('the compare page and its readers keep their discipline: guarded, read-only, every read checked', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const page = read('app/(internal)/requirements/compare/page.tsx');
  assert.match(page, /requireInternal\('\/requirements\/compare'\)/);
  assert.doesNotMatch(page, /use server|action=|method="post"/i);
  const q = read('src/modules/crm/requirement-compare-queries.ts');
  assert.equal([...q.matchAll(/if \(error\)/g)].length, [...q.matchAll(/unreadable\(/g)].length);
  assert.equal([...q.matchAll(/unreadable\(/g)].length, 2);
  assert.doesNotMatch(read('src/ui/primitives/version-diff.tsx'), /onClick|action=|use client/);
});
