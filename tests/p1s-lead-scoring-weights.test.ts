import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  DEFAULT_LEAD_SCORE_WEIGHTS,
  LEAD_SCORE_WEIGHT_KEYS,
  leadScoreWeightsProblem,
  scoreLead,
  type LeadScoreInputs,
  type LeadScoreWeights,
} from '../src/modules/crm/lead-score.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * P1-CRM-019 / P1-CRM-020: the weights a lead's score is computed with are data. The pure function takes them as a parameter and defaults to the numbers the
 * model has always used; the form validates with the same rule the database enforces; the service reads the saved set and records which version scored.
 */

const rich: LeadScoreInputs = {
  source: 'referral',
  status: 'qualified',
  createdAt: '2026-09-20T10:00:00.000Z',
  lastActivityAt: '2026-09-29T09:00:00.000Z',
  asOf: '2026-09-29T10:00:00.000Z',
  budgetMinor: 500000,
  isDecisionMaker: true,
  timelineNote: 'in March',
  coveredAreas: ['timeline', 'budget', 'scope'],
  clientReplies: 5,
  dealValueMinor: 90000,
  dealStage: 'proposal',
};
const stale: LeadScoreInputs = { ...rich, status: 'new', createdAt: '2026-05-01T00:00:00.000Z', budgetMinor: null, isDecisionMaker: null, timelineNote: null, coveredAreas: [], clientReplies: 0, dealValueMinor: null, source: 'web_form' };

describe('the defaults are the model that has always been', () => {
  test('the defaults pass the model rule and add up to 100', () => {
    assert.equal(leadScoreWeightsProblem({ ...DEFAULT_LEAD_SCORE_WEIGHTS }), null);
  });

  test('scoring with the defaults explicitly is the same as scoring without weights', () => {
    assert.deepEqual(scoreLead(rich, DEFAULT_LEAD_SCORE_WEIGHTS), scoreLead(rich));
    assert.deepEqual(scoreLead(stale, DEFAULT_LEAD_SCORE_WEIGHTS), scoreLead(stale));
  });

  test('the default maxima are the figures the file header documents (25/15/15/10/15/10/5/5, penalty 10)', () => {
    const w = DEFAULT_LEAD_SCORE_WEIGHTS;
    assert.deepEqual([w.coverage_max, w.budget_known, w.decision_maker, w.timeline_stated, w.engagement_many, w.recency_fresh, w.deal_value, w.referral, w.stale_penalty], [25, 15, 15, 10, 15, 10, 5, 5, 10]);
  });
});

describe('a different set changes the points, and only the points', () => {
  const heavy: LeadScoreWeights = { ...DEFAULT_LEAD_SCORE_WEIGHTS, budget_known: 25, timeline_stated: 0, coverage_max: 20 };

  test('a budget is worth what the set says, and a set with weight 0 gives no points but still names the reason', () => {
    const a = scoreLead(rich);
    const b = scoreLead(rich, heavy);
    assert.equal(b.reasons.find((r) => r.code === 'budget_known')?.points, 25);
    assert.equal(a.reasons.find((r) => r.code === 'budget_known')?.points, 15);
    assert.equal(b.reasons.find((r) => r.code === 'timeline_stated')?.points, 0);
    assert.equal(b.reasons.find((r) => r.code === 'coverage')?.points, Math.round((3 / 15) * 20));
  });

  test('POSITIVE twin: the score moves with the weights', () => {
    assert.notEqual(scoreLead(rich, heavy).score, scoreLead(rich).score);
  });

  test('the stale penalty is the set\'s, and a zero penalty costs nothing', () => {
    assert.equal(scoreLead(stale).reasons.find((r) => r.code === 'stale')?.points, -10);
    assert.equal(scoreLead(stale, { ...DEFAULT_LEAD_SCORE_WEIGHTS, stale_penalty: 25 }).reasons.find((r) => r.code === 'stale')?.points, -25);
    const none = scoreLead(stale, { ...DEFAULT_LEAD_SCORE_WEIGHTS, stale_penalty: 0 });
    assert.equal(Math.abs(none.reasons.find((r) => r.code === 'stale')?.points ?? 1), 0);
  });

  test('a disqualified lead still scores 0 whatever the weights are', () => {
    assert.equal(scoreLead({ ...rich, status: 'disqualified' }, heavy).score, 0);
  });

  test('the engagement tiers and the recency tiers read the set', () => {
    const w = { ...DEFAULT_LEAD_SCORE_WEIGHTS, engagement_some: 3, engagement_many: 20, recency_fresh: 5, recency_recent: 1 };
    assert.equal(scoreLead({ ...rich, clientReplies: 1 }, w).reasons.find((r) => r.code === 'engagement')?.points, 3);
    assert.equal(scoreLead({ ...rich, clientReplies: 4 }, w).reasons.find((r) => r.code === 'engagement')?.points, 20);
    assert.equal(scoreLead({ ...rich, lastActivityAt: '2026-09-25T10:00:00.000Z' }, w).reasons.find((r) => r.code === 'recency')?.points, 1);
  });
});

describe('the form rule is the database rule', () => {
  const ok = { ...DEFAULT_LEAD_SCORE_WEIGHTS };
  test('refuses what the SQL validator refuses, with the same reasons', () => {
    assert.match(leadScoreWeightsProblem({ ...ok, budget_known: 30 }) ?? '', /add up to 115, not 100/);
    assert.match(leadScoreWeightsProblem({ ...ok, vibes: 1 }) ?? '', /unknown weight "vibes"/);
    const { referral: _drop, ...missing } = ok;
    assert.match(leadScoreWeightsProblem(missing) ?? '', /weight "referral" is missing/);
    assert.match(leadScoreWeightsProblem({ ...ok, budget_known: 15.5 }) ?? '', /must be a whole number/);
    assert.match(leadScoreWeightsProblem({ ...ok, budget_known: -1 }) ?? '', /must be a whole number/);
    assert.match(leadScoreWeightsProblem({ ...ok, engagement_some: 16 }) ?? '', /a few replies/);
    assert.match(leadScoreWeightsProblem({ ...ok, recency_recent: 11 }) ?? '', /week-old reply/);
    assert.match(leadScoreWeightsProblem({ ...ok, stale_penalty: 60 }) ?? '', /stale penalty/);
  });

  test('accepts a different set that still adds up', () => {
    assert.equal(leadScoreWeightsProblem({ ...ok, budget_known: 25, timeline_stated: 0 }), null);
  });

  test('every key the model weighs is a key of the set', () => {
    assert.equal(LEAD_SCORE_WEIGHT_KEYS.length, 11);
    for (const k of LEAD_SCORE_WEIGHT_KEYS) assert.ok(k in DEFAULT_LEAD_SCORE_WEIGHTS, k);
  });
});

describe('wiring: the saved set reaches the scorer, and the door is the only way to change it', () => {
  const service = read('src/modules/crm/lead-score-service.ts');
  const migration = read('supabase/migrations/20261204100000_p1s_lead_scoring_weights_are_data_an_admin_sets_with_a_reason_and_history_is_kept.sql');

  test('both scoring paths read the weights and pass them to scoreLead, and store which version scored', () => {
    assert.equal((service.match(/scoreLead\(inputs\.data, inForce\.weights\)/g) ?? []).length, 2, 'rescoreLead and rescoreAllLeads');
    assert.equal((service.match(/readLeadScoreWeights\(supabase\)/g) ?? []).length, 2);
    assert.match(service, /p_inputs: \{ \.\.\.computed\.inputs, weightsVersion \}/);
  });

  test('the reader reports a failed read and ignores a stored set that no longer passes the rule', () => {
    const src = read('src/modules/crm/lead-score-weights.ts');
    assert.match(src, /if \(error\) unreadable\('readLeadScoreWeights', error\)/);
    assert.match(src, /if \(leadScoreWeightsProblem\(stored\) !== null\) return fallback/);
  });

  test('the door is admin-only, reasoned, validated, and the table is append-only', () => {
    assert.match(migration, /not coalesce\(\(select core\.is_admin\(\)\), false\) then return query select 'not_authorized'/);
    assert.match(migration, /reason_required/);
    assert.match(migration, /v_sum <> 100/);
    assert.match(migration, /a saved lead-scoring weight set is history/);
    assert.match(migration, /grant execute on function crm\.p1s_set_lead_score_weights\(jsonb, text\) to authenticated;/);
    assert.doesNotMatch(migration, /grant (all|insert|update|delete)[^;]*p1s_lead_score_weight_sets to authenticated/);
  });

  test('the settings tab and page exist, and the action calls only the service', () => {
    assert.match(read('app/(internal)/settings/layout.tsx'), /\{ href: '\/settings\/lead-scoring', label: 'Lead scoring' \}/);
    assert.match(read('app/(internal)/settings/lead-scoring/page.tsx'), /readLeadScoreWeights\(\)/);
    assert.match(read('src/modules/crm/lead-score-weights-actions.ts'), /setLeadScoreWeights\(weights, /);
  });
});
