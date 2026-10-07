// P3-PM-006 / P3-PM-005: the deterministic design-context guard. No model is involved; the handler is driven against a scripted database view.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assessDesignContext, guardDesignContext } from '../src/modules/projects/design-context-guard.ts';

type Reply = { data: unknown; error: { message: string } | null };

function fakeAdmin(tables: Record<string, Reply>, rpcs: Record<string, Reply> = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const builder = (reply: Reply) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
    b.maybeSingle = () => b;
    b.then = (ok: (r: Reply) => unknown) => Promise.resolve(reply).then(ok);
    return b;
  };
  const admin = {
    schema: (schema: string) => ({
      from: (table: string) => builder(tables[`${schema}.${table}`] ?? { data: null, error: null }),
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(rpcs[fn] ?? { data: null, error: null });
      },
    }),
  };
  return { admin: admin as never, rpcCalls };
}

const job = { id: 'j', organization_id: 'org', correlation_id: null, payload: { subjectId: 'bl-1' } };
const baseline = (over: Record<string, unknown> = {}) => ({ data: { id: 'bl-1', project_id: 'p-1', screen_count: 6, status: 'finalized', ...over }, error: null });

test('a complete context has no gaps; each missing piece is named, and only scope and screens block', () => {
  assert.deepEqual(assessDesignContext({ activeScope: true, screenCount: 3, coverageAreas: ['platforms', 'design_expectations'] }), []);
  const gaps = assessDesignContext({ activeScope: false, screenCount: 0, coverageAreas: [] });
  assert.deepEqual(gaps.map((g) => `${g.key}:${g.blocking}`), ['scope:true', 'screens:true', 'platforms:false', 'design_expectations:false']);
});

test('a project with no screens is BLOCKED with a reason, and the client-fillable gaps are raised as clarifications', async () => {
  const { admin, rpcCalls } = fakeAdmin(
    {
      'projects.screen_baselines': baseline({ screen_count: 0 }),
      'projects.phase_three': { data: { id: 'ph-1', state: 'context_loading' }, error: null },
      'projects.scope_versions': { data: [{ id: 'sv' }], error: null },
      'projects.projects': { data: { opportunity_id: 'op' }, error: null },
      'sales.opportunities': { data: { lead_id: 'ld' }, error: null },
      'crm.qualification_coverage': { data: [{ area: 'platforms' }], error: null },
    },
    { p13_raise_design_clarification: { data: [{ outcome: 'raised', clarification_id: 'c' }], error: null }, p13_block_design_requirement: { data: 'blocked', error: null } },
  );
  const result = await guardDesignContext(admin, job);
  assert.equal(result.status, 'succeeded');
  assert.ok(result.status === 'succeeded' && result.outcome === 'blocked:blocked');
  const raised = rpcCalls.filter((c) => c.fn === 'p13_raise_design_clarification');
  assert.equal(raised.length, 1, 'only design_expectations is missing from the client answers');
  assert.match(String(raised[0]?.args.p_question), /look and feel/);
  const block = rpcCalls.find((c) => c.fn === 'p13_block_design_requirement');
  assert.equal(block?.args.p_phase_three_id, 'ph-1');
  assert.match(String(block?.args.p_reason), /no screens/);
});

test('a complete context does nothing: no block, no question', async () => {
  const { admin, rpcCalls } = fakeAdmin({
    'projects.screen_baselines': baseline(),
    'projects.phase_three': { data: { id: 'ph-1', state: 'screen_definition' }, error: null },
    'projects.scope_versions': { data: [{ id: 'sv' }], error: null },
    'projects.projects': { data: { opportunity_id: 'op' }, error: null },
    'sales.opportunities': { data: { lead_id: 'ld' }, error: null },
    'crm.qualification_coverage': { data: [{ area: 'platforms' }, { area: 'design_expectations' }], error: null },
  });
  const result = await guardDesignContext(admin, job);
  assert.ok(result.status === 'succeeded' && result.outcome === 'context_complete');
  assert.equal(rpcCalls.length, 0);
});

test('only client-fillable gaps raise questions and do not block', async () => {
  const { admin, rpcCalls } = fakeAdmin(
    {
      'projects.screen_baselines': baseline(),
      'projects.phase_three': { data: { id: 'ph-1', state: 'screen_definition' }, error: null },
      'projects.scope_versions': { data: [{ id: 'sv' }], error: null },
      'projects.projects': { data: { opportunity_id: null }, error: null },
    },
    { p13_raise_design_clarification: { data: [{ outcome: 'already_open', clarification_id: 'c' }], error: null } },
  );
  const result = await guardDesignContext(admin, job);
  assert.ok(result.status === 'succeeded' && result.outcome === 'clarifications_raised');
  assert.equal(rpcCalls.filter((c) => c.fn === 'p13_block_design_requirement').length, 0);
  assert.equal(rpcCalls.length, 2);
});

test('a superseded baseline, a vanished baseline and a missing phase settle without acting', async () => {
  const sup = fakeAdmin({ 'projects.screen_baselines': baseline({ status: 'superseded' }) });
  assert.ok((await guardDesignContext(sup.admin, job)).status === 'succeeded');
  const gone = fakeAdmin({ 'projects.screen_baselines': { data: null, error: null } });
  assert.ok((await guardDesignContext(gone.admin, job)).status === 'succeeded');
  const nophase = fakeAdmin({ 'projects.screen_baselines': baseline(), 'projects.phase_three': { data: null, error: null } });
  const r = await guardDesignContext(nophase.admin, job);
  assert.ok(r.status === 'succeeded' && r.outcome === 'no_phase');
  assert.equal(sup.rpcCalls.length + gone.rpcCalls.length + nophase.rpcCalls.length, 0);
});

test('an unreadable row fails the job as RETRYABLE; it is never read as "complete"', async () => {
  const { admin } = fakeAdmin({ 'projects.screen_baselines': { data: null, error: { message: 'db down' } } });
  const r = await guardDesignContext(admin, job);
  assert.ok(r.status === 'failed' && r.permanent === false && /db down/.test(r.detail));
  const noSubject = await guardDesignContext(admin, { ...job, payload: {} });
  assert.ok(noSubject.status === 'failed' && noSubject.permanent === true);
});

test('a phase already past drafting is reported, not interrupted (the door answers wrong_state)', async () => {
  const { admin } = fakeAdmin(
    {
      'projects.screen_baselines': baseline({ screen_count: 0 }),
      'projects.phase_three': { data: { id: 'ph-1', state: 'admin_review' }, error: null },
      'projects.scope_versions': { data: [{ id: 'sv' }], error: null },
      'projects.projects': { data: { opportunity_id: null }, error: null },
    },
    { p13_raise_design_clarification: { data: [{ outcome: 'raised' }], error: null }, p13_block_design_requirement: { data: 'wrong_state', error: null } },
  );
  const r = await guardDesignContext(admin, job);
  assert.ok(r.status === 'succeeded' && r.outcome === 'blocked:wrong_state');
});
