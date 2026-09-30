import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { interpretAddOutcome } from '../src/lib/admin/reactivation-cohort-eval.ts';
import {
  applyReactivationCohortFilter,
  daysQuiet,
  DEFAULT_REACTIVATION_INACTIVE_DAYS,
  isReactivationCohortFilter,
  OPEN_FOLLOW_UP_STATUSES,
  selectReactivationCohort,
  type ReactivationCohortRow,
} from '../src/modules/crm/reactivation-types.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-2 — SCR-013's "Reactivation cohort" is a sub-screen of
 * Follow-ups, and "Enroll eligible lead with consent" is its action. The
 * audit had it PARTIAL (a link to Import). The rule for closing it:
 *
 *   1. the cohort is a real query — consent decided by the ranking function
 *      the enrolment gate shares (`crm.reactivation_priority`), no open
 *      follow-up, quiet for N days — refusing on failure, never empty;
 *   2. N is stated (30, the panel's constant; no organisation setting
 *      names one) and shown on the screen;
 *   3. enrolment goes through the EXISTING door — the lead page's form,
 *      `crm.add_lead_to_reactivation_pilot` — whose `no_consent` verdict is
 *      never turned into success;
 *   4. the tile is a count whose click opens the section on every row, and
 *      each row links to the lead and to its Import batch when one exists.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('1. membership, from facts already read', () => {
  const candidates = [
    { lead_id: 'quiet', tier_name: 'cold', last_active_at: daysAgo(45), phone: '+91' },
    { lead_id: 'exactly-n', tier_name: 'cold', last_active_at: daysAgo(30), phone: null },
    { lead_id: 'recent', tier_name: 'previously_quoted', last_active_at: daysAgo(3), phone: null },
    { lead_id: 'chased', tier_name: 'cold', last_active_at: daysAgo(90), phone: null },
    { lead_id: 'undated', tier_name: 'cold', last_active_at: 'not a date', phone: null },
  ];

  it('keeps the quiet, drops the recent, the chased and the undated', () => {
    const cohort = selectReactivationCohort(candidates, new Set(['chased']), NOW, 30);
    assert.deepEqual(cohort.map((c) => c.lead_id), ['quiet', 'exactly-n']);
  });

  it('N defaults to 30 days and is the constant the screen states', () => {
    assert.equal(DEFAULT_REACTIVATION_INACTIVE_DAYS, 30);
    const byDefault = selectReactivationCohort(candidates, new Set(), NOW);
    assert.deepEqual(byDefault.map((c) => c.lead_id), ['quiet', 'exactly-n', 'chased']);
    assert.deepEqual(selectReactivationCohort(candidates, new Set(), NOW, 60).map((c) => c.lead_id), ['chased']);
  });

  it('an open follow-up is active, escalated or stopped — the states a person still decides on', () => {
    assert.deepEqual([...OPEN_FOLLOW_UP_STATUSES], ['active', 'escalated', 'stopped']);
  });

  it('days quiet is whole days, never negative, and zero for a date that cannot be read', () => {
    assert.equal(daysQuiet(daysAgo(45), NOW), 45);
    assert.equal(daysQuiet(daysAgo(0.5), NOW), 0);
    assert.equal(daysQuiet(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW), 0);
    assert.equal(daysQuiet('nope', NOW), 0);
  });

  it('the chips are predicates over rows, and a stranger is not a chip', () => {
    const row = (leadId: string, inPilot: boolean, importBatchId: string | null): ReactivationCohortRow => ({
      leadId, title: leadId, status: 'new', tierName: 'cold', lastActiveAt: daysAgo(40), quietDays: 40, inPilot, assignedTo: null, phone: null, source: 'import', importBatchId, importSourceLabel: null,
    });
    const rows = [row('a', false, 'b1'), row('b', true, null), row('c', false, null)];
    assert.deepEqual(applyReactivationCohortFilter(rows, 'imported').map((r) => r.leadId), ['a']);
    assert.deepEqual(applyReactivationCohortFilter(rows, 'enrolled').map((r) => r.leadId), ['b']);
    assert.deepEqual(applyReactivationCohortFilter(rows, 'not_enrolled').map((r) => r.leadId), ['a', 'c']);
    assert.equal(applyReactivationCohortFilter(rows, 'all').length, 3);
    assert.equal(isReactivationCohortFilter('imported'), true);
    assert.equal(isReactivationCohortFilter('everyone'), false);
    assert.equal(isReactivationCohortFilter(undefined), false);
  });
});

describe('2. the reader: consent from the shared ranking, every failure refused', () => {
  const src = read('src/modules/crm/reactivation-queries.ts');

  it('takes its candidates from crm.reactivation_priority and never re-decides consent itself', () => {
    assert.match(src, /rpc\('reactivation_priority'/);
    assert.doesNotMatch(src, /communication_consent|contact_relationship/, 'consent and relationship are the ranking function\'s to decide');
    assert.match(src, /\.in\('status', \[\.\.\.OPEN_FOLLOW_UP_STATUSES\]\)/);
    assert.match(src, /selectReactivationCohort\(candidates, openIds, now, inactiveDays\)/);
  });

  it('every error guard is a refusal', () => {
    const guards = src.match(/if \([A-Za-z]*[eE]rror\)/g) ?? [];
    const refusals = src.match(/unreadable\(/g) ?? [];
    assert.ok(guards.length >= 6, `expected the six reads to be guarded, found ${guards.length}`);
    assert.equal(guards.length, refusals.length);
    assert.doesNotMatch(src, /if \(\w*[eE]rror\)[\s\S]{0,200}?return (?:\[\]|null|0|\{ \.\.\.base, rows: \[\] \});/);
  });

  it('joins the Import batch through import_records.committed_lead_id — the lead the desk created', () => {
    assert.match(src, /from\('import_records'\)[\s\S]*?\.in\('committed_lead_id', cohortIds\)/);
    assert.match(src, /from\('import_batches'\)/);
  });
});

describe('3. enrolment is the existing door, and no_consent is never a success', () => {
  it('the section mounts the lead page\'s EnrolLeadForm and imports no other action', () => {
    const section = read('app/(internal)/follow-ups/reactivation-cohort.tsx');
    assert.match(section, /import \{ EnrolLeadForm \} from '\.\.\/leads\/\[leadId\]\/reactivation-panel'/);
    assert.match(section, /<EnrolLeadForm leadId=\{r\.leadId\} consentEligible compact \/>/);
    assert.doesNotMatch(section, /actions'|useActionState|'use client'/, 'no new write path');
    assert.match(section, /Owner or ops admin enrols/);
    assert.match(section, /<EmptyState[\s\S]*?action=\{/);
  });

  it('EnrolLeadForm is the panel\'s own enrol half, behind enrollLeadAction, and the panel still uses it', () => {
    const panel = read('app/(internal)/leads/[leadId]/reactivation-panel.tsx');
    assert.match(panel, /export function EnrolLeadForm\(/);
    assert.match(panel, /useActionState\(enrollLeadAction, IDLE_STATE\)/);
    assert.match(panel, /<EnrolLeadForm leadId=\{leadId\} consentEligible=\{consentEligible\} \/>/);
    assert.equal((panel.match(/useActionState\(enrollLeadAction/g) ?? []).length, 1, 'one enrol form, not two');
  });

  it('the action revalidates the Follow-ups screen and the door is crm.add_lead_to_reactivation_pilot', () => {
    assert.match(read('app/(internal)/leads/[leadId]/reactivation-actions.ts'), /revalidatePath\('\/follow-ups'\)/);
    const door = read('src/lib/admin/reactivation-cohort.ts');
    assert.match(door, /can\(context, 'organization\.settings'\)/);
    assert.match(door, /rpc\('add_lead_to_reactivation_pilot'/);
  });

  it('the database\'s no_consent verdict is an error in the door\'s words, shown as such', () => {
    const verdict = interpretAddOutcome('no_consent');
    assert.equal(verdict.kind, 'error');
    if (verdict.kind === 'error') {
      assert.equal(verdict.code, 'VALIDATION');
      assert.match(verdict.message, /no granted WhatsApp consent/);
      assert.match(verdict.message, /never assumed/);
    }
    assert.equal(interpretAddOutcome('added').kind, 'enrolled');
  });
});

describe('4. the tile and the rows on the Follow-ups screen', () => {
  const page = read('app/(internal)/follow-ups/page.tsx');
  const section = read('app/(internal)/follow-ups/reactivation-cohort.tsx');

  it('the page reads the cohort next to the sequences and gates enrolment on the door\'s capability through the role union', () => {
    assert.match(page, /listReactivationCohort\(\)/);
    assert.match(page, /const mayEnrol = can\(context, 'organization\.settings'\)/);
    assert.doesNotMatch(page, /context\.role\b/);
  });

  it('the tile is a count whose click opens the section on every row', () => {
    assert.match(page, /<Stat label="Reactivation cohort" value=\{String\(cohort\.rows\.length\)\}[\s\S]{0,300}?href=\{cohortHref\('all'\)\}/);
    assert.match(page, /const cohortHref = \(f: string\) => `\/follow-ups\$\{f \? `\?cohort=\$\{f\}` : ''\}#reactivation`/);
    assert.match(page, /expanded=\{cohortFilter !== null\}/);
    assert.match(section, /<Card id="reactivation">/);
    assert.doesNotMatch(page, /href="\/import"[^>]*>\s*Reactivation cohort/, 'the header link no longer sends the reader to Import');
  });

  it('each row links to the lead and to its Import batch, and says N', () => {
    assert.match(section, /href=\{`\/leads\/\$\{r\.leadId\}`\}/);
    assert.match(section, /href=\{`\/import\/\$\{r\.importBatchId\}`\}/);
    assert.match(section, /nothing recorded for \$\{cohort\.inactiveDays\} days or more \(the panel's default — no organisation setting names a threshold\)/);
  });
});
