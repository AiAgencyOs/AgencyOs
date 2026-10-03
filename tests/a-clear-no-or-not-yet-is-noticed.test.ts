import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { NURTURE_REASONS } from '../src/modules/crm/schema.ts';
import {
  OUTCOME_NURTURE_REASONS,
  decideOutcome,
  leadOutcomeReadingSchema,
  type LeadOutcomeReading,
} from '../src/modules/sales/lead-outcome.ts';
import { LOST_CATEGORIES } from '../src/modules/sales/schema.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const reading = (over: Partial<LeadOutcomeReading> = {}): LeadOutcomeReading => ({
  outcome: 'declined',
  certainty: 'clear',
  conditional: false,
  quote: "I don't want to proceed",
  lostCategory: 'chose_competitor',
  nurtureReason: null,
  returnInDays: null,
  ...over,
});
const facts = (over: Partial<Parameters<typeof decideOutcome>[1]> = {}) => ({
  messageBody: "Thanks, but I don't want to proceed. We went with another agency.",
  leadStatus: 'qualifying',
  hasOpenDeal: false,
  hasAcceptedQuotation: false,
  ...over,
});

// The owner (2026-10-03): the agent marks the CLEAR cases itself; anything it
// is unsure of it proposes and leaves alone. The safety is these rules, not the
// model's judgment — each has a negative and its positive twin.

describe('A. a clear decline', () => {
  test('a lead with no deal is disqualified, with the reason the client gave and their exact words', () => {
    assert.deepEqual(decideOutcome(reading(), facts()), { act: 'disqualify_lead', category: 'chose_competitor', quote: "I don't want to proceed" });
  });

  test('a lead with an open deal loses the deal instead', () => {
    assert.equal(decideOutcome(reading(), facts({ hasOpenDeal: true })).act, 'lose_deal');
  });

  test('no reason given falls to "other", never to a guess', () => {
    const a = decideOutcome(reading({ lostCategory: null }), facts());
    assert.equal(a.act === 'disqualify_lead' && a.category, 'other');
  });
});

describe('B. what is never marked', () => {
  test('a no with a condition is a negotiation, not a loss', () => {
    const r = reading({ conditional: true, quote: '50% kam karo, warna nahi' });
    assert.equal(decideOutcome(r, facts({ messageBody: '50% kam karo, warna nahi' })).act, 'none');
  });

  test('words the client did not write: the reading is discarded', () => {
    assert.equal(decideOutcome(reading({ quote: 'we are cancelling the project' }), facts()).act, 'none');
    assert.equal(decideOutcome(reading({ quote: '' }), facts()).act, 'none');
  });

  test('...but the same quote with different spacing or case IS the client\'s words', () => {
    assert.equal(decideOutcome(reading({ quote: "I DON'T   want to proceed" }), facts()).act, 'disqualify_lead');
  });

  test('"none" is none, and an unsure reading is only a proposal', () => {
    assert.equal(decideOutcome(reading({ outcome: 'none' }), facts()).act, 'none');
    assert.equal(decideOutcome(reading({ certainty: 'unclear' }), facts()).act, 'suggest');
  });

  test('a lead that is already settled, or whose quotation was accepted, is left alone', () => {
    for (const status of ['converted', 'disqualified']) assert.equal(decideOutcome(reading(), facts({ leadStatus: status })).act, 'none', status);
    assert.equal(decideOutcome(reading(), facts({ hasAcceptedQuotation: true, hasOpenDeal: true })).act, 'none');
    // the positive twin: a nurture lead that declines IS closed
    assert.equal(decideOutcome(reading(), facts({ leadStatus: 'nurture' })).act, 'disqualify_lead');
  });
});

describe('C. not yet', () => {
  const postponed = (over: Partial<LeadOutcomeReading> = {}) =>
    reading({ outcome: 'postponed', lostCategory: null, nurtureReason: 'budget_later', returnInDays: 60, quote: '2 mahine baad', ...over });
  const body = 'Project karna hai but 2 mahine baad';

  test('a timeframe in the client\'s words moves the lead to nurture with that many days', () => {
    assert.deepEqual(decideOutcome(postponed(), facts({ messageBody: body })), { act: 'nurture', reason: 'budget_later', days: 60, quote: '2 mahine baad' });
  });

  test('no timeframe, or one outside a week to a year, is only proposed — the date is not ours to invent', () => {
    for (const days of [null, 0, 3, 400]) {
      assert.equal(decideOutcome(postponed({ returnInDays: days }), facts({ messageBody: body })).act, 'suggest', String(days));
    }
    assert.equal(decideOutcome(postponed({ nurtureReason: null }), facts({ messageBody: body })).act, 'suggest');
  });

  test('a lead already in nurture is not moved again', () => {
    assert.equal(decideOutcome(postponed(), facts({ messageBody: body, leadStatus: 'nurture' })).act, 'none');
  });
});

describe('D. the vocabulary and the wiring', () => {
  test('the local reason lists equal the real ones', () => {
    assert.deepEqual([...OUTCOME_NURTURE_REASONS], [...NURTURE_REASONS]);
    assert.ok(leadOutcomeReadingSchema.safeParse(reading()).success);
    for (const c of LOST_CATEGORIES) assert.ok(leadOutcomeReadingSchema.safeParse(reading({ lostCategory: c })).success, c);
    assert.ok(!leadOutcomeReadingSchema.safeParse({ ...reading(), outcome: 'won' }).success, 'WON is not an outcome this path can produce');
  });

  test('it reads every client message, and never writes the WON stage', () => {
    assert.match(read('src/lib/events/catalog.ts'), /'message\.received': \[[^\]]*'sales:readLeadOutcome'/);
    const w = read('app/api/jobs/run/workflows.ts');
    const wf = w.slice(w.indexOf('const LEAD_OUTCOME_READ: AgentWorkflow'), w.indexOf('const TEST_PLAN_PROMPT'));
    assert.match(wf, /jobKind: 'lead\.outcome_read'/);
    assert.ok(!/stage: 'won'/.test(wf));
    assert.match(wf, /\.eq\('status', from\)/, 'the lead write is compare-and-swap');
    assert.match(wf, /\.eq\('stage', openDeal!\.stage\)/, 'and so is the deal write');
    assert.match(wf, /raiseAlert\(/);
    // Found live: nurture is not reachable from `new`, so the job failed and retried forever.
    assert.match(wf, /if \(from === 'new'\) \{[\s\S]{0,500}status: 'qualifying'[\s\S]{0,500}from = 'qualifying';/);
  });
});
