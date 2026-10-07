// Phase 4 UI Designer / Prototype gap work: the order of events, the refusals and the writes, proved against a stand-in database and a stand-in model.
// Nothing here ran on a real model. The doors themselves are proved on a real Postgres by scripts/verify-p4ui-ui-designer.sql and verify-p4ui-prototype.sql.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachBuiltPrototype,
  detailUiVersion,
  nextBuildGate,
  nextUiGate,
  planPrototypeBuild,
  syncBuildForDeliverable,
  type P4uiAdmin,
} from '../src/modules/projects/p4ui.ts';

type Rows = Record<string, Record<string, unknown>[]>;
type Call = { kind: 'read' | 'rpc'; what: string; filters?: Record<string, unknown>; args?: Record<string, unknown> };

function fake(rows: Rows, rpc: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const admin: P4uiAdmin = {
    schema: () => ({
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const list = () => rows[table] ?? [];
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => {
            filters[c] = v;
            return q;
          },
          order: () => q,
          limit: () => q,
          maybeSingle: () => {
            calls.push({ kind: 'read', what: table, filters: { ...filters } });
            return Promise.resolve({ data: list()[0] ?? null, error: null });
          },
          then: (res: (v: unknown) => unknown) => {
            calls.push({ kind: 'read', what: table, filters: { ...filters } });
            return Promise.resolve({ data: list(), error: null }).then(res);
          },
        };
        return q as never;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ kind: 'rpc', what: fn, args });
        const answer = rpc[fn];
        return Promise.resolve({ data: answer === undefined ? [{ outcome: 'recorded', ref_id: 'x' }] : answer, error: null });
      },
    }),
  };
  return { admin, calls };
}

const rpcs = (calls: Call[]) => calls.filter((c) => c.kind === 'rpc').map((c) => c.what);

// no step of this module may reach a gate that belongs to someone else
const FORBIDDEN = /verdict|admin_review|decide_|lock_ui_version|share_ui_version|client_decision|submit_|send_prototype|approve|request_approval|verify_payment/;

const VERSION = {
  id: 'v1', phase_four_id: 'f1', status: 'draft', version: 1,
  screens: [{ screenKey: 'home' }, { screenKey: 'checkout' }],
};
const SPEC = {
  purpose: 'Browse', entryPoints: ['app open'], exitPoints: ['checkout'], dataShown: ['products'], actions: ['add'], validationRules: [],
  states: ['error', 'offline'], responsiveVariants: ['mobile'], roleVariants: [], tokensUsed: ['color.primary'],
};
const GOOD = { specs: [{ screenKey: 'home', ...SPEC }, { screenKey: 'checkout', ...SPEC }], changeSummary: 'Initial specification.' };

test('detailUiVersion: reads for the job organization, asks once, writes specs and lineage through the doors, completes the open job', async () => {
  const { admin, calls } = fake(
    { ui_versions: [VERSION], p4ui_screen_specs: [], p4ui_design_jobs: [{ id: 'j1', source_ui_version_id: null, status: 'requested' }] },
    { p4ui_requirement_trace: { orphanScreens: [] }, p4ui_derive_version_meta: [{ outcome: 'recorded' }], p4ui_complete_design_job: [{ outcome: 'delivered' }] },
  );
  let asked = 0;
  const out = await detailUiVersion(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async (prompt) => {
    asked += 1;
    assert.match(prompt, /home/);
    assert.match(prompt, /orphanScreens/);
    return { ok: true, json: GOOD };
  });
  assert.equal(out.status, 'done');
  assert.equal(asked, 1);
  assert.deepEqual(rpcs(calls), ['p4ui_requirement_trace', 'p4ui_record_screen_spec', 'p4ui_record_screen_spec', 'p4ui_derive_version_meta', 'p4ui_complete_design_job']);
  assert.equal(calls.find((c) => c.what === 'ui_versions')?.filters?.organization_id, 'org1');
  assert.equal(calls.find((c) => c.what === 'p4ui_design_jobs')?.filters?.organization_id, 'org1');
  const derive = calls.find((c) => c.what === 'p4ui_derive_version_meta');
  assert.equal(derive?.args?.p_design_job_id, 'j1');
  assert.equal(derive?.args?.p_change_summary, 'Initial specification.');
  for (const fn of rpcs(calls)) assert.doesNotMatch(fn, FORBIDDEN, `${fn} belongs to another gate`);
});

test('detailUiVersion: an invented screen is refused before any write', async () => {
  const { admin, calls } = fake({ ui_versions: [VERSION], p4ui_screen_specs: [] }, { p4ui_requirement_trace: {} });
  const out = await detailUiVersion(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: { specs: [{ screenKey: 'ghost', ...SPEC }] } }));
  assert.equal(out.status, 'failed');
  assert.match(out.status === 'failed' ? out.reason : '', /invented screen\(s\): ghost/);
  assert.equal(rpcs(calls).filter((f) => f === 'p4ui_record_screen_spec').length, 0);
  assert.equal(rpcs(calls).includes('p4ui_derive_version_meta'), false);
});

test('detailUiVersion: a state outside the vocabulary, an extra key and a duplicate screen never reach the door', async () => {
  for (const bad of [
    { specs: [{ screenKey: 'home', ...SPEC, states: ['sparkly'] }] },
    { specs: [{ screenKey: 'home', ...SPEC, approved: true }] },
    { specs: [{ screenKey: 'home', ...SPEC }, { screenKey: 'home', ...SPEC }] },
    { specs: [] },
  ]) {
    const { admin, calls } = fake({ ui_versions: [VERSION], p4ui_screen_specs: [] }, { p4ui_requirement_trace: {} });
    const out = await detailUiVersion(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: bad }));
    assert.equal(out.status, 'failed');
    assert.equal(rpcs(calls).filter((f) => f === 'p4ui_record_screen_spec').length, 0);
  }
});

test('detailUiVersion: a door that does not say recorded stops the run; a model failure is returned, not swallowed', async () => {
  const a = fake({ ui_versions: [VERSION], p4ui_screen_specs: [] }, { p4ui_requirement_trace: {}, p4ui_record_screen_spec: [{ outcome: 'version_not_draft' }] });
  const out = await detailUiVersion(a.admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: GOOD }));
  assert.equal(out.status, 'failed');
  assert.match(out.status === 'failed' ? out.reason : '', /version_not_draft/);
  const b = fake({ ui_versions: [VERSION], p4ui_screen_specs: [] }, { p4ui_requirement_trace: {} });
  const down = await detailUiVersion(b.admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: false, detail: 'AI_PROVIDER_NOT_CONFIGURED' }));
  assert.deepEqual(down, { status: 'failed', reason: 'AI_PROVIDER_NOT_CONFIGURED' });
});

test('detailUiVersion: a version past draft or already specified asks no model and rewrites no spec; its lineage is still derived', async () => {
  for (const [version, specs] of [
    [{ ...VERSION, status: 'qa_pass' }, []],
    [VERSION, [{ screen_key: 'home' }, { screen_key: 'checkout' }]],
  ] as const) {
    const { admin, calls } = fake({ ui_versions: [version], p4ui_screen_specs: [...specs], p4ui_design_jobs: [] }, { p4ui_derive_version_meta: [{ outcome: 'exists' }] });
    let asked = 0;
    const out = await detailUiVersion(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => {
      asked += 1;
      return { ok: true, json: GOOD };
    });
    assert.equal(out.status, 'done');
    assert.equal(asked, 0);
    assert.deepEqual(rpcs(calls), ['p4ui_derive_version_meta']);
  }
});

test('detailUiVersion: a vanished version is skipped, not failed', async () => {
  const { admin } = fake({ ui_versions: [] });
  assert.deepEqual(await detailUiVersion(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: GOOD })), { status: 'skipped', reason: 'the UI version no longer exists' });
});

// ── the prototype plan ──
const LOCKED = { id: 'v1', status: 'locked', screens: [{ screenKey: 'home' }, { screenKey: 'checkout' }] };
const PLAN = {
  platform: 'web', buildMode: 'in_app_preview', environment: 'review', mockPolicy: 'static_mock',
  routes: [{ screenKey: 'home', route: '/' }, { screenKey: 'checkout', route: '/checkout' }], components: ['Button'], mockSources: ['static json'],
  interactions: [{ from: 'home', control: 'Checkout', to: 'checkout' }], criticalFlows: [['home', 'checkout']], exclusions: [], requiredAssets: [],
  limitations: ['no real payments'], simulatedIntegrations: ['payment gateway'], testInstructions: 'Open home and press Checkout.',
  testData: [{ name: 'cart', edgeCase: false, payload: { items: [] } }],
};

test('planPrototypeBuild: only the locked version is planned, in order: plan door, test data, validation', async () => {
  const { admin, calls } = fake(
    { ui_versions: [LOCKED], p4ui_prototype_builds: [] },
    { p4ui_plan_prototype_build: [{ outcome: 'planned', ref_id: 'b1' }], p4ui_record_test_data: [{ outcome: 'recorded' }], p4ui_validate_build_inputs: [{ outcome: 'ready' }] },
  );
  const out = await planPrototypeBuild(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: PLAN }));
  assert.equal(out.status, 'done');
  assert.deepEqual(rpcs(calls), ['p4ui_plan_prototype_build', 'p4ui_record_test_data', 'p4ui_validate_build_inputs']);
  const plan = calls.find((c) => c.what === 'p4ui_plan_prototype_build');
  assert.equal(plan?.args?.p_platform, 'web');
  assert.equal(plan?.args?.p_build_mode, 'in_app_preview');
  assert.equal((plan?.args?.p_plan as Record<string, unknown>).testData, undefined, 'test data goes through its own door, not the plan');
  for (const fn of rpcs(calls)) assert.doesNotMatch(fn, FORBIDDEN);
});

test('planPrototypeBuild: a UI that is not locked never reaches the model', async () => {
  for (const status of ['draft', 'qa_pass', 'admin_approved', 'client_review']) {
    const { admin, calls } = fake({ ui_versions: [{ ...LOCKED, status }] });
    let asked = 0;
    const out = await planPrototypeBuild(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => {
      asked += 1;
      return { ok: true, json: PLAN };
    });
    assert.deepEqual(out, { status: 'skipped', reason: `the UI version is ${status}, not locked` });
    assert.equal(asked, 0);
    assert.equal(rpcs(calls).length, 0);
  }
});

test('planPrototypeBuild: an active build means no second plan and no model call; a failed one does not', async () => {
  const active = fake({ ui_versions: [LOCKED], p4ui_prototype_builds: [{ id: 'b1', status: 'qa_pass', build_number: 1 }] });
  let asked = 0;
  const skipped = await planPrototypeBuild(active.admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => {
    asked += 1;
    return { ok: true, json: PLAN };
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(asked, 0);
  const failedBefore = fake(
    { ui_versions: [LOCKED], p4ui_prototype_builds: [{ id: 'b1', status: 'failed', build_number: 1 }] },
    { p4ui_plan_prototype_build: [{ outcome: 'planned', ref_id: 'b2' }], p4ui_record_test_data: [{ outcome: 'recorded' }], p4ui_validate_build_inputs: [{ outcome: 'ready' }] },
  );
  assert.equal((await planPrototypeBuild(failedBefore.admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: PLAN }))).status, 'done');
});

test('planPrototypeBuild: a plan naming a screen the locked UI lacks, an unknown platform, or a missing limitation never reaches the door', async () => {
  const cases = [
    { ...PLAN, routes: [{ screenKey: 'ghost', route: '/g' }] },
    { ...PLAN, criticalFlows: [['home', 'ghost']] },
    { ...PLAN, platform: 'amiga' },
    { ...PLAN, limitations: [] },
  ];
  for (const bad of cases) {
    const { admin, calls } = fake({ ui_versions: [LOCKED], p4ui_prototype_builds: [] });
    const out = await planPrototypeBuild(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: bad }));
    assert.equal(out.status, 'failed');
    assert.equal(rpcs(calls).length, 0);
  }
});

test('planPrototypeBuild: an unnamed platform is passed as null (never inferred) and the blocker the door raises is reported', async () => {
  const { admin, calls } = fake(
    { ui_versions: [LOCKED], p4ui_prototype_builds: [] },
    { p4ui_plan_prototype_build: [{ outcome: 'planned', ref_id: 'b1' }], p4ui_record_test_data: [{ outcome: 'recorded' }], p4ui_validate_build_inputs: [{ outcome: 'blocked', detail: 'platform_missing' }] },
  );
  const out = await planPrototypeBuild(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: { ...PLAN, platform: null } }));
  assert.equal(out.status, 'done');
  assert.equal(calls.find((c) => c.what === 'p4ui_plan_prototype_build')?.args?.p_platform, null);
  assert.equal(out.status === 'done' ? out.data?.validation : null, 'blocked');
  assert.equal(out.status === 'done' ? out.data?.blockers : null, 'platform_missing');
});

test('planPrototypeBuild: test data the door calls secret-shaped fails the run loudly and validation never runs', async () => {
  const { admin, calls } = fake(
    { ui_versions: [LOCKED], p4ui_prototype_builds: [] },
    { p4ui_plan_prototype_build: [{ outcome: 'planned', ref_id: 'b1' }], p4ui_record_test_data: [{ outcome: 'secret_detected' }] },
  );
  const out = await planPrototypeBuild(admin, { organizationId: 'org1', uiVersionId: 'v1' }, async () => ({ ok: true, json: PLAN }));
  assert.equal(out.status, 'failed');
  assert.match(out.status === 'failed' ? out.reason : '', /secret-shaped/);
  assert.equal(rpcs(calls).includes('p4ui_validate_build_inputs'), false);
});

// ── attaching the artifact (no model) ──
const ARTIFACT = { id: 'a1', ui_version_id: 'v1' };

test('attachBuiltPrototype: a building build gets the artifact, then its QA handoff', async () => {
  const { admin, calls } = fake(
    { prototype_artifacts: [ARTIFACT], p4ui_prototype_builds: [{ id: 'b1', status: 'building', prototype_artifact_id: null }] },
    { p4ui_attach_build_artifact: [{ outcome: 'build_ready' }], p4ui_assemble_qa_handoff: [{ outcome: 'assembled' }] },
  );
  const out = await attachBuiltPrototype(admin, { organizationId: 'org1', prototypeArtifactId: 'a1' });
  assert.equal(out.status, 'done');
  assert.deepEqual(rpcs(calls), ['p4ui_attach_build_artifact', 'p4ui_assemble_qa_handoff']);
  assert.equal(calls.find((c) => c.what === 'prototype_artifacts')?.filters?.organization_id, 'org1');
});

test('attachBuiltPrototype: a self-check failure is reported as failed and NO handoff is assembled', async () => {
  const { admin, calls } = fake(
    { prototype_artifacts: [ARTIFACT], p4ui_prototype_builds: [{ id: 'b1', status: 'building', prototype_artifact_id: null }] },
    { p4ui_attach_build_artifact: [{ outcome: 'self_check_failed', detail: '2' }] },
  );
  const out = await attachBuiltPrototype(admin, { organizationId: 'org1', prototypeArtifactId: 'a1' });
  assert.equal(out.status === 'done' ? out.data?.attach : null, 'self_check_failed');
  assert.match(out.status === 'done' ? out.detail : '', /FAILED/);
  assert.deepEqual(rpcs(calls), ['p4ui_attach_build_artifact']);
});

test('attachBuiltPrototype: a blocked build is validated first and nothing is attached', async () => {
  const { admin, calls } = fake(
    { prototype_artifacts: [ARTIFACT], p4ui_prototype_builds: [{ id: 'b1', status: 'planned', prototype_artifact_id: null }] },
    { p4ui_validate_build_inputs: [{ outcome: 'blocked' }] },
  );
  const out = await attachBuiltPrototype(admin, { organizationId: 'org1', prototypeArtifactId: 'a1' });
  assert.equal(out.status, 'skipped');
  assert.deepEqual(rpcs(calls), ['p4ui_validate_build_inputs']);
});

test('attachBuiltPrototype: nothing planned, already attached, or past building means no call to the attach door', async () => {
  for (const builds of [[], [{ id: 'b1', status: 'building', prototype_artifact_id: 'a1' }], [{ id: 'b1', status: 'qa_pass', prototype_artifact_id: 'a0' }]]) {
    const { admin, calls } = fake({ prototype_artifacts: [ARTIFACT], p4ui_prototype_builds: builds });
    assert.equal((await attachBuiltPrototype(admin, { organizationId: 'org1', prototypeArtifactId: 'a1' })).status, 'skipped');
    assert.equal(rpcs(calls).length, 0);
  }
});

test('syncBuildForDeliverable: only the sync door is called, and only for a deliverable that has a planned build', async () => {
  const { admin, calls } = fake({ prototype_artifacts: [{ id: 'a1' }], p4ui_prototype_builds: [{ id: 'b1' }] }, { p4ui_sync_build_status: [{ outcome: 'synced', detail: 'qa_pass' }] });
  const out = await syncBuildForDeliverable(admin, { organizationId: 'org1', deliverableId: 'd1' });
  assert.equal(out.status, 'done');
  assert.deepEqual(rpcs(calls), ['p4ui_sync_build_status']);
  const none = fake({ prototype_artifacts: [] });
  assert.equal((await syncBuildForDeliverable(none.admin, { organizationId: 'org1', deliverableId: 'd1' })).status, 'skipped');
  const noBuild = fake({ prototype_artifacts: [{ id: 'a1' }], p4ui_prototype_builds: [] });
  assert.equal((await syncBuildForDeliverable(noBuild.admin, { organizationId: 'org1', deliverableId: 'd1' })).status, 'skipped');
  assert.equal(rpcs(noBuild.calls).length, 0);
});

test('the next-gate wording covers every status the database allows', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../supabase/migrations/20260923110000_the_ui_version_designs_the_locked_screens.sql', import.meta.url), 'utf8');
  const uiStatuses = [...(/status\s+text not null default 'draft' check \(status in \(([\s\S]*?)\)\)/.exec(ui)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  assert.ok(uiStatuses.length >= 11, 'the UI version statuses were read');
  for (const s of uiStatuses) assert.notEqual(nextUiGate(s), 'unknown', `no next gate for UI status ${s}`);
  const files = (await import('node:fs')).readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.startsWith('20261125100000_p4ui_'));
  const proto = readFileSync(new URL(`../supabase/migrations/${files[0]}`, import.meta.url), 'utf8');
  const buildStatuses = [...(/status\s+text not null default 'planned' check \(status in \(([\s\S]*?)\)\),/.exec(proto)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  assert.ok(buildStatuses.length >= 14, 'the build statuses were read');
  for (const s of buildStatuses) assert.notEqual(nextBuildGate(s), 'unknown', `no next gate for build status ${s}`);
});
