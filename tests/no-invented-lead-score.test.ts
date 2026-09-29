import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { COVERAGE_AREA_COUNT, scoreLead, type LeadScoreInputs } from '../src/modules/crm/lead-score.ts';
import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * A number that is never invented.
 *
 * ADM-88 — Decision: reversed by the owner on 2026-09-29.
 *
 * The first rule (20260821220000) was *"no numeric lead score and no invented
 * weights"*, held as `check (score is null and score_reasons is null)`, and
 * this file pinned it. The owner reversed it: a 0–100 score, computed
 * deterministically from stated inputs by a pure function, stored by a door,
 * WITH its reasons. The file keeps its name because the thing it refuses is
 * the same thing — a bare number nobody can account for — and the rule has
 * turned from "never a number" into **"never a number without the reasons
 * and inputs that produced it"**.
 *
 * Three halves, as before: the constraint (asserted on the migration text
 * here and against real Postgres by `db:verify:noscore`), the door, and the
 * function — which is pure, so it is called rather than read.
 */

const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('a_lead_earns_its_score'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');

const baseInputs: LeadScoreInputs = {
  source: 'web_form',
  status: 'qualifying',
  createdAt: '2026-09-20T10:00:00.000Z',
  lastActivityAt: '2026-09-28T10:00:00.000Z',
  asOf: '2026-09-29T10:00:00.000Z',
  budgetMinor: null,
  isDecisionMaker: null,
  timelineNote: null,
  coveredAreas: [],
  clientReplies: 0,
  dealValueMinor: null,
  dealStage: null,
};

describe('A. the decision is a constraint, not a convention — in the new direction', () => {
  test('the old prohibition is dropped by name and the migration says the decision was reversed', () => {
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /drop constraint if exists leads_no_invented_score/);
    assert.match(migration, /ADM-88[\s\S]*?Decision: reversed by the owner on 2026-09-29/);
  });

  test('a score is stored with its reasons, its inputs and its time, or not at all', () => {
    const code = sqlCode(migration);
    const constraint = /add constraint leads_score_carries_its_reasons\s+check \(([\s\S]*?)\);/.exec(code);
    assert.ok(constraint, 'the constraint is missing');
    const body = constraint![1]!;
    // All four null together …
    assert.match(body, /score is null and score_reasons is null and score_inputs is null and scored_at is null/);
    // … or all four present, and the reasons a NON-EMPTY array, the inputs an object.
    assert.match(body, /score is not null/);
    assert.match(body, /jsonb_typeof\(score_reasons\) = 'array' and jsonb_array_length\(score_reasons\) > 0/);
    assert.match(body, /jsonb_typeof\(score_inputs\) = 'object'/);
    assert.match(body, /scored_at is not null/);
  });

  test('the columns are added rather than the old ones replaced, so the trace of both decisions survives', () => {
    assert.match(migration, /add column if not exists score_inputs jsonb/);
    assert.match(migration, /add column if not exists scored_at\s+timestamptz/);
    assert.doesNotMatch(migration, /drop column/i);
  });
});

describe('B. the door refuses a bare number before the constraint has to', () => {
  const body = region(migration, 'create or replace function crm.set_lead_score');

  test('it exists, takes the reasons and inputs as arguments, and is the only writer', () => {
    assert.match(body, /p_reasons jsonb/);
    assert.match(body, /p_inputs\s+jsonb/);
    assert.match(body, /security invoker/);
    assert.match(body, /if p_reasons is null or jsonb_typeof\(p_reasons\) <> 'array' or jsonb_array_length\(p_reasons\) = 0 then/);
    assert.match(body, /if p_inputs is null or jsonb_typeof\(p_inputs\) <> 'object' then/);
    assert.match(body, /if p_score is null or p_score < 0 or p_score > 100 then/);
  });

  test('and it is audited as a decision about the lead', () => {
    assert.match(body, /perform core\.record_audit\(v_org, 'lead\.scored', 'lead', p_lead_id/);
  });

  test('nothing in the application writes the score columns except through that door', () => {
    const offenders: string[] = [];
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir))) {
        const rel = `${dir}/${entry}`;
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        if (statSync(join(root, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || rel === 'src/lib/db/types.ts') continue;
        const code = strip(read(rel));
        // A direct write: `.update({ score` / `.insert({ … score:` / `score_reasons:` as a key
        // in an object literal handed to the client. The door's own `p_score:` is not that.
        if (/\.(update|insert|upsert)\(\s*\{[^}]*\b(score|score_reasons|score_inputs|scored_at)\s*:/s.test(code)) offenders.push(rel);
      }
    };
    walk('src');
    walk('app');
    assert.deepEqual(offenders, [], `these write a lead score without the door: ${offenders.join(', ')}`);
    assert.match(read('src/modules/crm/lead-score-service.ts'), /rpc\('set_lead_score'/);
  });
});

describe('C. the function is the model, and every score it returns carries its reasons and inputs', () => {
  test('a score is never bare — the reasons are non-empty and the inputs are the ones it was given', () => {
    const result = scoreLead(baseInputs);
    assert.ok(result.reasons.length > 0, 'a score with no reasons');
    assert.deepEqual(result.inputs, baseInputs);
    for (const r of result.reasons) {
      assert.ok(typeof r.code === 'string' && r.code.length > 0);
      assert.ok(Number.isInteger(r.points));
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0, `reason ${r.code} has no detail`);
    }
  });

  test('the reasons add up to the score, and the score is bounded 0–100', () => {
    const cases: LeadScoreInputs[] = [
      baseInputs,
      { ...baseInputs, coveredAreas: Array.from({ length: COVERAGE_AREA_COUNT }, (_, i) => `area_${i}`), budgetMinor: 1_500_000_00, isDecisionMaker: true, timelineNote: '10 weeks', clientReplies: 6, dealValueMinor: 2_000_000_00, dealStage: 'proposal', source: 'referral', lastActivityAt: baseInputs.asOf },
      { ...baseInputs, status: 'new', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' },
      { ...baseInputs, status: 'disqualified', budgetMinor: 1, isDecisionMaker: true },
    ];
    for (const inputs of cases) {
      const result = scoreLead(inputs);
      const sum = result.reasons.reduce((s, r) => s + r.points, 0);
      assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} out of range`);
      assert.equal(result.score, Math.max(0, Math.min(100, sum)), 'the reasons do not add up to the score');
    }
  });

  test('it is deterministic: the same inputs give the same score and the same reasons', () => {
    const a = scoreLead(baseInputs);
    const b = scoreLead({ ...baseInputs });
    assert.deepEqual(a, b);
  });

  test('the maximum is exactly 100, and every weight is spent on a stated fact', () => {
    const full = scoreLead({
      ...baseInputs,
      coveredAreas: Array.from({ length: COVERAGE_AREA_COUNT }, (_, i) => `area_${i}`),
      budgetMinor: 1,
      isDecisionMaker: true,
      timelineNote: 'soon',
      clientReplies: 3,
      lastActivityAt: baseInputs.asOf,
      dealValueMinor: 1,
      source: 'referral',
    });
    assert.equal(full.score, 100);
    assert.deepEqual(
      full.reasons.map((r) => r.code).sort(),
      ['budget_known', 'coverage', 'deal_value', 'decision_maker', 'engagement', 'recency', 'referral', 'timeline_stated'],
    );
  });

  test('a disqualified lead scores 0, and the reason says so rather than the number being quietly zeroed', () => {
    const result = scoreLead({ ...baseInputs, status: 'disqualified', budgetMinor: 1, isDecisionMaker: true, clientReplies: 5 });
    assert.equal(result.score, 0);
    assert.ok(result.reasons.some((r) => r.code === 'disqualified' && r.points < 0));
  });

  test('a stale lead is told it is stale', () => {
    const result = scoreLead({ ...baseInputs, status: 'new', createdAt: '2026-06-01T00:00:00.000Z' });
    assert.ok(result.reasons.some((r) => r.code === 'stale' && r.points === -10));
  });

  test('no input is guessed: an unknown decision-maker or budget earns nothing', () => {
    const unknown = scoreLead({ ...baseInputs, isDecisionMaker: null, budgetMinor: null });
    assert.ok(!unknown.reasons.some((r) => r.code === 'decision_maker' || r.code === 'budget_known'));
    const no = scoreLead({ ...baseInputs, isDecisionMaker: false, budgetMinor: 0 });
    assert.ok(!no.reasons.some((r) => r.code === 'decision_maker' || r.code === 'budget_known'));
  });
});

describe('D. what is shown is what is stored', () => {
  test('the seed still ships no score — a fresh environment computes one, it does not inherit one', () => {
    const seed = read('supabase/seed.sql');
    const leadsInsert = region(seed, 'insert into crm.leads');
    const block = leadsInsert.slice(0, leadsInsert.indexOf('\n\n'));
    assert.doesNotMatch(block, /"reasons"/, 'the seed ships score reasons');
    assert.doesNotMatch(block, /'(qualified|disqualified)',\s*\d/, 'the seed ships a score');
  });

  test('the reader refuses to render a number whose reasons do not parse', () => {
    const queries = read('src/modules/crm/lead-score-queries.ts');
    assert.match(queries, /leadScoreReasonsSchema\.safeParse\(row\.score_reasons\)/);
    assert.match(queries, /if \(!reasons\.success\) return null;/);
  });

  test('the Lead 360 expands the reasons and the inputs beside the number', () => {
    const page = read('app/(internal)/leads/[leadId]/page.tsx');
    assert.match(page, /leadScore\.reasons\.map\(/);
    assert.match(page, /Object\.entries\(leadScore\.inputs\)/);
    const list = read('app/(internal)/leads/page.tsx');
    assert.match(list, /sortKey: 'score'/);
  });
});
