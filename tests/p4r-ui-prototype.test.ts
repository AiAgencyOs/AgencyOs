// Phase 4 UI Designer and Prototype, round 4 (docs/phase-4-ui-prototype-round4-log.md). Text checks of the migration's shape and of the wiring (they fail if a
// connection is removed), plus behaviour of the pure parts against a stand-in. The doors themselves are proved on a real Postgres by
// scripts/verify-p4r-ui-prototype.sql; this file says so and does not pretend to be that.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { designInputsLine } from '../src/modules/projects/p4r-inputs.ts';
import { prototypeBuildSchema } from '../src/modules/projects/schema.ts';
import type { P4uiAdmin } from '../src/modules/projects/p4ui.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION_NAME = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find((f) => f.startsWith('20261201000000_p4r_'));
const MIGRATION = read(`supabase/migrations/${MIGRATION_NAME ?? 'MISSING'}`);

// ── the migration ──
test('the round-4 migration exists, is in the allotted timestamp range, and names every object p4r_', () => {
  assert.ok(MIGRATION_NAME, 'migration 20261201000000_p4r_* exists');
  const created = [...MIGRATION.matchAll(/create (?:or replace )?function projects\.([a-z0-9_]+)\(/gi)].map((m) => m[1] ?? '');
  const mine = created.filter((n) => n.startsWith('p4r_'));
  for (const n of ['p4r_plan_revision_build', 'p4r_record_design_inputs', 'p4r_check_token_consistency', 'p4r_prototype_state_report', 'p4r_follow_build_state', 'p4r_prototype_artifact_content_frozen']) {
    assert.ok(mine.includes(n), `${n} is created`);
  }
  // the only functions not prefixed are the three existing doors this migration re-defines with the same signature
  const others = created.filter((n) => !n.startsWith('p4r_')).sort();
  assert.deepEqual([...new Set(others)], ['p4ui_start_governed_revision', 'p4ui_sync_build_status', 'revise_ui_version']);
});

test('every door is revoked from public and anon, then granted; the new table has the tenancy guards, forced RLS and an internal-only read', () => {
  for (const sig of ['p4r_plan_revision_build\\(uuid\\)', 'p4r_record_design_inputs\\(uuid, jsonb, text\\[\\], text\\[\\], text\\)', 'p4r_check_token_consistency\\(uuid\\)', 'p4r_prototype_state_report\\(uuid\\)']) {
    assert.match(MIGRATION, new RegExp(`revoke all on function projects\\.${sig} from public, anon;`), `${sig} is revoked from public`);
    assert.match(MIGRATION, new RegExp(`grant execute on function projects\\.${sig} to authenticated, service_role;`), `${sig} is granted`);
  }
  assert.match(MIGRATION, /enforce_parent_org\('project_id', 'projects\.projects'\)/);
  assert.match(MIGRATION, /enforce_parent_org\('phase_four_id', 'projects\.phase_four'\)/);
  assert.match(MIGRATION, /freeze_org_p4r_design_inputs[\s\S]{0,120}freeze_organization_id\(\)/);
  assert.match(MIGRATION, /alter table projects\.p4r_design_inputs force row level security;/);
  assert.match(MIGRATION, /using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/);
  assert.doesNotMatch(MIGRATION, /create policy[^;]*for (insert|update|delete|all)/i, 'no write policy: every write is a door');
});

test('no migration here sets session_replication_role, and every security definer function pins its search_path', () => {
  assert.doesNotMatch(MIGRATION, /session_replication_role/);
  const defs = MIGRATION.split(/create or replace function /).slice(1);
  for (const d of defs) {
    const head = d.split(/\bas \$\$|\bas \$function\$/)[0] ?? '';
    if (/security definer/.test(head)) assert.match(head, /set search_path = ''/, `search_path pinned: ${head.slice(0, 60)}`);
  }
});

test('the revision build inherits the plan, supersedes only a build that was sent back, and is left building for the attach door', () => {
  const body = MIGRATION.split('create or replace function projects.p4r_plan_revision_build')[1]?.split('comment on function projects.p4r_plan_revision_build')[0] ?? '';
  assert.ok(body.length > 500);
  assert.match(body, /revision_of_build_id/);
  assert.match(body, /set status = 'input_validation' where id = v_new/);
  assert.match(body, /set status = 'building' where id = v_new/);
  assert.match(body, /v_prev\.status in \('qa_changes_required', 'changes_requested'\) then\s+update projects\.p4ui_prototype_builds set status = 'superseded'/);
  assert.match(body, /'prior_build_not_sent_back'/);
  assert.match(body, /'already_attached'/);
  // it decides no gate and approves nothing
  assert.doesNotMatch(body, /qa_pass|admin_approved|client_review|'locked'|verdict|decide_/);
});

test('a revision that changes nothing is refused at both revision doors, before any round is counted', () => {
  assert.match(MIGRATION, /if p_screens = v_latest\.screens then\s+return query select 'no_content_change'::text, v_latest\.id; return;\s+end if;\s+\n\s+v_is_qa :=/);
  assert.match(MIGRATION, /if p_screens = v_src\.screens then return query select 'no_content_change'::text, v_src\.id; return; end if;/);
});

test('the sync reads a QA send-back before a superseded deliverable (the machine has no qa_review to superseded edge)', () => {
  assert.match(MIGRATION, /when v_a\.status = 'qa_changes_required' and v_b\.status in \('build_ready', 'qa_review'\) then 'qa_changes_required'\s+when v_del\.status = 'approved' then 'locked'/);
});

test('phase_four.state follows the build only from a working state, never from a stop or a completed workspace', () => {
  const body = MIGRATION.split('create or replace function projects.p4r_follow_build_state')[1]?.split('create trigger p4r_prototype_builds_follow_state')[0] ?? '';
  assert.match(body, /new\.status = 'client_review'/);
  assert.match(body, /set state = 'prototype_review'[\s\S]{0,120}state in \('ui_locked', 'prototype_build'\)/);
  assert.match(body, /set state = 'prototype_locked'[\s\S]{0,140}state in \('ui_locked', 'prototype_build', 'prototype_review'\)/);
  assert.doesNotMatch(body.replace(/--[^\n]*/g, ''), /scope_escalation|revision_limit_escalation|completed/, 'the code (comments aside) names no stop and no completed state');
  assert.match(MIGRATION, /create trigger p4r_prototype_builds_follow_state after update of status on projects\.p4ui_prototype_builds/);
});

test('the approved artifact\'s content is frozen by a trigger that fires only when screens or lineage actually change', () => {
  assert.match(MIGRATION, /create trigger p4r_prototype_artifact_content_frozen before update of screens, ui_version_id, deliverable_id on projects\.prototype_artifacts/);
  assert.match(MIGRATION, /when \(old\.screens is distinct from new\.screens or old\.ui_version_id is distinct from new\.ui_version_id or old\.deliverable_id is distinct from new\.deliverable_id\)/);
});

// ── the verifier is registered, and carries its own positive twins ──
test('the verifier is part of db:verify:phase4 and uses only p4r_ helper names', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['db:verify:phase4'] ?? '', /-f scripts\/verify-p4r-ui-prototype\.sql/);
  const v = read('scripts/verify-p4r-ui-prototype.sql');
  assert.doesNotMatch(v, /pg_temp\.(?!p4r_)[a-z_]+\(/, 'every pg_temp helper is prefixed p4r_');
  assert.doesNotMatch(v, /set_config\('session_replication_role'/, 'only the top-level fixture precedent, never a function or DO block');
  assert.match(v, /PASS verify-p4r-ui-prototype/);
  // every negative has its positive twin in the file
  for (const [neg, pos] of [
    ['no_content_change', "= 'revised'"],
    ['prior_build_has_no_artifact', "= 'planned'"],
    ['person_required', "= 'recorded'"],
  ] as const) {
    assert.ok(v.includes(neg) && v.includes(pos), `${neg} is asserted beside ${pos}`);
  }
});

// ── the wiring: each connection fails a test if it is removed ──
test('wiring: the attach handler plans the revision build before attaching, and records the lineage on the build it planned', () => {
  const p4ui = read('src/modules/projects/p4ui.ts');
  const attach = p4ui.split('export async function attachBuiltPrototype')[1]?.split('export async function syncBuildForDeliverable')[0] ?? '';
  assert.ok(attach.length > 1000);
  const plan = attach.indexOf("'p4r_plan_revision_build'");
  const attachDoor = attach.indexOf("'p4ui_attach_build_artifact'");
  const lineage = attach.indexOf("'p4ui_record_build_revision'");
  assert.ok(plan > 0 && attachDoor > plan && lineage > attachDoor, 'plan, then attach, then lineage');
  assert.match(attach, /build = reloaded;/);
});

test('wiring: Design QA\'s token check runs inside the Designer\'s detail job, before the lineage is derived', () => {
  const p4ui = read('src/modules/projects/p4ui.ts');
  const detail = p4ui.split('export async function detailUiVersion')[1]?.split('// ═══ planPrototypeBuild')[0] ?? '';
  const token = detail.indexOf("'p4r_check_token_consistency'");
  const lineage = detail.indexOf("'p4ui_derive_version_meta'");
  assert.ok(token > 0 && lineage > token);
});

test('wiring: the draft workflow gives the Designer the recorded inputs and stops on an unreadable record', () => {
  const wf = read('app/api/jobs/run/workflows.ts');
  const draft = wf.split("jobKind: 'ui.version_draft'")[1]?.split("jobKind: 'ui.version_revise'")[0] ?? '';
  assert.ok(draft.length > 3000);
  assert.match(draft, /await designInputsLine\(admin as unknown as P4uiAdmin, \{ organizationId: job\.organization_id, phaseFourId: phaseFour\.id \}\)/);
  assert.match(draft, /if \(!inputs\.ok\) \{\s+await failJob\(admin, job, inputs\.detail\);/);
  assert.match(draft, /\$\{screenLines\}\$\{tokenLine\}\$\{inputs\.line\}/);
});

test('wiring: the UI revision workflow reports a no-content answer as a job that did not do the work, not as success', () => {
  const wf = read('app/api/jobs/run/workflows.ts');
  const revise = wf.split("jobKind: 'ui.version_revise'")[1]?.split('const CLASSIFY_CLIENT_FEEDBACK_PROMPT')[0] ?? '';
  assert.match(revise, /outcome === 'no_content_change'/);
  assert.match(revise, /no new version was made \(no_content_change\)/);
  assert.match(revise, /if \(outcome !== 'revised' && outcome !== 'already_revised' && outcome !== 'revision_limit_reached'\)/);
});

test('wiring: a person can record the Designer\'s inputs (action, service, form and panel are connected)', () => {
  assert.match(read('src/modules/projects/p4ui-actions.ts'), /export async function recordDesignInputsAction/);
  assert.match(read('src/modules/projects/p4ui-service.ts'), /'p4r_record_design_inputs'/);
  assert.match(read('app/(internal)/projects/[projectId]/p4ui-forms.tsx'), /recordDesignInputsAction/);
  assert.match(read('app/(internal)/projects/[projectId]/p4ui-design-panel.tsx'), /<DesignInputsForm /);
  const q = read('src/modules/projects/p4ui-queries.ts');
  assert.match(q, /from\('p4r_design_inputs'\)/);
  assert.match(q, /unreadable\('loadP4uiDesignView\.designInputs', inErr\)/);
});

// ── behaviour of the pure parts ──
function fakeInputs(row: Record<string, unknown> | null, error: { message: string } | null = null) {
  const filters: Record<string, unknown> = {};
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => {
      filters[c] = v;
      return q;
    },
    maybeSingle: () => Promise.resolve({ data: row, error }),
  };
  const admin = { schema: () => ({ from: () => q, rpc: () => Promise.resolve({ data: null, error: null }) }) } as unknown as P4uiAdmin;
  return { admin, filters };
}

test('designInputsLine: the recorded brief is rendered, read for the job organization and workspace', async () => {
  const { admin, filters } = fakeInputs({
    brand_assets: [{ name: 'Client logo (SVG)' }, { name: 'Brand pattern', placeholderApproved: true }],
    accessibility_targets: ['wcag_aa'],
    device_targets: ['mobile'],
    planning_note: 'Mobile first.',
  });
  const out = await designInputsLine(admin, { organizationId: 'org1', phaseFourId: 'f1' });
  assert.equal(out.ok, true);
  const line = out.ok ? out.line : '';
  assert.match(line, /Client logo \(SVG\)/);
  assert.match(line, /Brand pattern \(approved placeholder\)/);
  assert.match(line, /Accessibility targets: wcag_aa/);
  assert.match(line, /design only these\): mobile/);
  assert.match(line, /Planning note: Mobile first\./);
  assert.equal(filters.organization_id, 'org1');
  assert.equal(filters.phase_four_id, 'f1');
});

test('designInputsLine: no record is an empty line; an unreadable record is an error, never an empty line', async () => {
  const none = await designInputsLine(fakeInputs(null).admin, { organizationId: 'o', phaseFourId: 'f' });
  assert.deepEqual(none, { ok: true, line: '' });
  const broken = await designInputsLine(fakeInputs(null, { message: 'boom' }).admin, { organizationId: 'o', phaseFourId: 'f' });
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.detail, /boom/);
});

test('the prototype vocabulary: states, responsive variants and an input\'s validation are accepted; an unknown state is not; an older build still validates', () => {
  const base = { screens: [{ screenKey: 'home', elements: [{ type: 'button', label: 'Go', navigatesTo: 'checkout' }] }] };
  assert.equal(prototypeBuildSchema.safeParse(base).success, true, 'a build without the new fields still validates');
  const rich = {
    screens: [
      {
        screenKey: 'checkout',
        states: ['default', 'error', 'validation_error'],
        responsiveVariants: ['mobile', 'desktop'],
        elements: [{ type: 'input', label: 'Card number', validation: '16 digits' }, { type: 'text', label: 'Card declined', stateVariant: 'error' }],
      },
    ],
  };
  assert.equal(prototypeBuildSchema.safeParse(rich).success, true);
  assert.equal(prototypeBuildSchema.safeParse({ screens: [{ screenKey: 'checkout', states: ['sparkly'], elements: [{ type: 'text', label: 'x' }] }] }).success, false);
  assert.equal(prototypeBuildSchema.safeParse({ screens: [{ screenKey: 'checkout', responsiveVariants: ['watch'], elements: [{ type: 'text', label: 'x' }] }] }).success, false);
  assert.equal(prototypeBuildSchema.safeParse({ screens: [{ screenKey: 'checkout', elements: [{ type: 'text', label: 'x', onclick: 'steal()' }] }] }).success, false, 'still strict: no field can become markup');
});
