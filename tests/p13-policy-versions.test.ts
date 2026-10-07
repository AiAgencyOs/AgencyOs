// P1-BLUEPRINT-030/044: the pure half of the policy-version screen (diff = impact preview, index, body parsing) and the shape of its server files.
// The doors are proved against Postgres in scripts/verify-p13-policy-versions-and-approval-risk.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { diffPolicyBodies, indexByKind, parsePolicyBody, POLICY_KINDS, type PolicyVersionRow } from '../src/modules/approvals/p13-policy-model.ts';

const row = (over: Partial<PolicyVersionRow>): PolicyVersionRow => ({
  id: 'id',
  policy_kind: 'discount',
  version: 1,
  status: 'active',
  summary: 's',
  body: {},
  effective_from: null,
  activated_at: null,
  activation_reason: null,
  ...over,
});

test('the impact preview lists exactly what a draft changes, added and removed included, sorted', () => {
  const changes = diffPolicyBodies(
    { max_discount_pct: 10, stacking: 'none', caps: { high: 5, low: 1 } },
    { max_discount_pct: 15, stacking: 'none', caps: { high: 5, extra: 2 }, note: 'x' },
  );
  assert.deepEqual(
    changes.map((c) => `${c.type}:${c.path}`),
    ['added:caps.extra', 'removed:caps.low', 'changed:max_discount_pct', 'added:note'],
  );
  assert.deepEqual(diffPolicyBodies({ a: 1 }, { a: 1 }), [], 'an identical draft changes nothing');
  assert.equal(diffPolicyBodies(null, { a: 1 })[0]?.type, 'added', 'with nothing in force everything is new');
});

test('the index puts the active, the draft and the history of each kind in their own place, and every kind exists', () => {
  const idx = indexByKind([
    row({ id: 'a', version: 1, status: 'superseded' }),
    row({ id: 'b', version: 2, status: 'active' }),
    row({ id: 'c', version: 3, status: 'draft' }),
    row({ id: 'd', policy_kind: 'pricing', version: 1, status: 'active' }),
  ]);
  assert.equal(idx.discount.active?.id, 'b');
  assert.equal(idx.discount.draft?.id, 'c');
  assert.deepEqual(idx.discount.history.map((h) => h.id), ['a']);
  assert.equal(idx.pricing.active?.id, 'd');
  assert.equal(idx.trust.active, null, 'a kind with nothing in force says so');
  assert.equal(Object.keys(idx).length, POLICY_KINDS.length);
});

test('a policy body must be a JSON object', () => {
  assert.equal(parsePolicyBody('').ok, false);
  assert.equal(parsePolicyBody('[1]').ok, false);
  assert.equal(parsePolicyBody('null').ok, false);
  assert.equal(parsePolicyBody('{oops').ok, false);
  const good = parsePolicyBody('{"max_discount_pct": 12}');
  assert.ok(good.ok && good.body.max_discount_pct === 12);
});

test('the kinds the screen offers are the kinds the database accepts', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261128100000_p13_a_policy_has_versions_and_an_approval_records_the_risk_and_the_policy_it_was_judged_by.sql', import.meta.url), 'utf8');
  const m = /policy_kind\s+text not null check \(policy_kind in \(([^)]*)\)\)/.exec(sql);
  assert.ok(m);
  assert.deepEqual([...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), [...POLICY_KINDS]);
});

test('the server files keep their discipline: actions export only async functions, every read checks its error, the page guards and shows no editing to a reader', () => {
  const actions = readFileSync(new URL('../src/modules/approvals/p13-policy-actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /^'use server';/);
  assert.equal([...actions.matchAll(/^export (?!async function)/gm)].length, 0);
  const queries = readFileSync(new URL('../src/modules/approvals/p13-policy-queries.ts', import.meta.url), 'utf8');
  assert.equal([...queries.matchAll(/if \(error\)/g)].length, [...queries.matchAll(/unreadable\(/g)].length);
  const page = readFileSync(new URL('../app/(internal)/policy-versions/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requireInternal\('\/policy-versions'\)/);
  assert.match(page, /mayEdit \?/);
});
