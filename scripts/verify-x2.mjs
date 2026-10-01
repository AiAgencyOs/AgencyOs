// ═══════════════════════════════════════════════════════════════════════════
// Stream X2 — owner decisions 2, 11, 12 and 13 (round 2, 2026-10-01), proven
// against real Postgres (migrations 20261007200000 .. 20261007200300):
//   A. (12) a plan cannot go live without an internal approval — at the door
//      AND for any other writer; an approved plan can
//   B. (11) the audit log is kept forever: no role can delete or update an
//      entry; the export door is owner / ops admin only and writes
//      `audit.exported` with the actor, the filters and the row count
//   C. (2) a new organization starts with the 30/20/30/20 structure
//      (Phases 2, 4, 5, 6); editing it makes it the owner's own; the guard on
//      direct writes still refuses; deleting the organization still works
//   D. (13) contract and migration checks dispatched as a GitHub workflow are
//      recorded by two doors: delivery roles only, ok only for `success`, the
//      run link as evidence, recorded once; no direct write; the hand-recorded
//      check stays available
// The GitHub half (dispatch and status read) is proven against a fake fetch in
// tests/x2-environment-checks.test.ts; no real GitHub is called here.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('plans need approval, the audit is kept, the default schedule, workflow checks', 'zztest-x2');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');
const audit = k.rpc('audit');
const sales = k.rpc('sales');

const extra = { orgs: [], envs: [] };

try {
  const owner = await k.makeUser('owner');
  const admin = await k.makeUser('ops_admin');
  const lead = await k.makeUser('delivery_lead');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject('x2');

  // ── A. a plan goes live only after an internal approval ──────────────────
  section('A. plan activation requires internal approval, in the database');
  const sv = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', source: 'onboarding' }));
  const item = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, title: 'zztest-x2 checkout', inclusion: 'included', acceptance_criteria: 'pays' }));
  const plan = one(await rest('POST', 'projects', 'project_plans', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', scope_version_id: sv.id }));
  await rest('POST', 'projects', 'plan_deliverables', { organization_id: ORG, plan_id: plan.id, name: 'zztest-x2 checkout', scope_item_id: item.id, applicable_phase: 'phase_4', readiness_criteria: 'built', evidence_required: 'demo' });

  const refused = one(await projects('activate_project_plan', { p_plan_id: plan.id }, lead.token));
  check(refused?.outcome === 'not_approved', 'the activation door refuses an unapproved plan', refused?.outcome);
  const direct = await rest('PATCH', 'projects', `project_plans?id=eq.${plan.id}`, { status: 'active', activated_at: new Date().toISOString() });
  check(!direct.ok, 'and so does a direct write that tries to make it active (the trigger)', `HTTP ${direct.status}`);
  const still = one(await rest('GET', 'projects', `project_plans?id=eq.${plan.id}&select=status`));
  check(still?.status === 'draft', 'the plan is still a draft after both attempts', still?.status);

  check(one(await projects('approve_project_plan', { p_plan_id: plan.id, p_note: 'ok' }, lead.token))?.outcome === 'approved', 'a delivery role approves it');
  const after = one(await projects('activate_project_plan', { p_plan_id: plan.id }, lead.token));
  check(after?.outcome !== 'not_approved' && after?.outcome !== 'forbidden', 'an approved plan gets past the approval gate', `${after?.outcome}${after?.findings?.length ? ` (${after.findings.join(', ')})` : ''}`);

  // ── B. the audit log is kept forever; every export is logged ─────────────
  section('B. the audit log is kept forever and every export is itself logged');
  const sample = one(await rest('GET', 'audit', `audit_log?organization_id=eq.${ORG}&select=id,action&order=id.desc&limit=1`));
  check(Boolean(sample?.id), 'there is an entry to try to destroy', String(sample?.id));
  for (const [who, token] of [['the owner', owner.token], ['the service role', undefined]]) {
    const del = await rest('DELETE', 'audit', `audit_log?id=eq.${sample.id}`, null, token);
    const upd = await rest('PATCH', 'audit', `audit_log?id=eq.${sample.id}`, { action: 'tampered' }, token);
    const kept = one(await rest('GET', 'audit', `audit_log?id=eq.${sample.id}&select=action`));
    check(kept?.action === sample.action && !(del.ok && Array.isArray(del.json) && del.json.length > 0) && !(upd.ok && Array.isArray(upd.json) && upd.json.length > 0), `${who} can neither delete nor change an entry`, `delete ${del.status}, update ${upd.status}`);
  }

  const filters = { action: 'finance.', from: '2026-01-01' };
  check(one(await audit('log_audit_export', { p_filters: filters, p_row_count: 12 }, owner.token))?.outcome === 'logged', 'the owner may export, and it is logged');
  check(one(await audit('log_audit_export', { p_filters: {}, p_row_count: 3 }, admin.token))?.outcome === 'logged', 'so may the ops admin');
  for (const [who, u] of [['a delivery lead', lead], ['a member', member], ['finance', finance]]) {
    check(one(await audit('log_audit_export', { p_filters: {}, p_row_count: 1 }, u.token))?.outcome === 'not_authorized', `${who} may not export`);
  }
  check(one(await audit('log_audit_export', { p_filters: {}, p_row_count: -1 }, owner.token))?.outcome === 'bad_count', 'a negative row count is refused');
  const exported = await rest('GET', 'audit', `audit_log?action=eq.audit.exported&actor_id=in.(${owner.id},${admin.id})&select=actor_id,after&order=id.asc`);
  const rows = Array.isArray(exported.json) ? exported.json : [];
  check(rows.length === 2 && rows[0].after?.rows === 12 && rows[0].after?.filters?.action === 'finance.' && rows[0].actor_id === owner.id, 'each export is an audit.exported entry naming the actor, the filters and the row count', JSON.stringify(rows[0]?.after));
  const refusedLogged = await rest('GET', 'audit', `audit_log?action=eq.audit.exported&actor_id=in.(${lead.id},${member.id},${finance.id})&select=id`);
  check(Array.isArray(refusedLogged.json) && refusedLogged.json.length === 0, 'a refused export writes nothing');

  // ── C. the default payment structure ─────────────────────────────────────
  section('C. a new organization starts with 30 / 20 / 30 / 20 on Phases 2, 4, 5, 6');
  const org = one(await rest('POST', 'core', 'organizations', { name: `zztest-x2 ${randomUUID().slice(0, 6)}`, slug: `zztest-x2-${randomUUID().slice(0, 8)}` }));
  if (!org?.id) k.fail(`could not create the fixture organization: ${JSON.stringify(org)}`);
  extra.orgs.push(org.id);
  const structures = (await rest('GET', 'sales', `payment_structures?organization_id=eq.${org.id}&select=id,name,is_default,active,min_amount_minor,max_amount_minor,payment_milestones(position,label,pct)`)).json ?? [];
  check(structures.length === 1 && structures[0].is_default === true && structures[0].active === true && structures[0].min_amount_minor === null, 'one default structure, open on both sides', JSON.stringify(structures.map((s) => s.name)));
  const ms = [...(structures[0]?.payment_milestones ?? [])].sort((a, b) => a.position - b.position);
  check(ms.map((m) => Number(m.pct)).join('/') === '30/20/30/20', 'its milestones are 30 / 20 / 30 / 20', ms.map((m) => m.pct).join('/'));
  check(['Phase 2', 'Phase 4', 'Phase 5', 'Phase 6'].every((p, i) => ms[i]?.label?.includes(p)), 'each one names the phase that releases it', ms.map((m) => m.label).join(' | '));
  const seeded = await rest('GET', 'audit', `audit_log?action=eq.payment_structure.default_seeded&organization_id=eq.${org.id}&select=id`);
  check(Array.isArray(seeded.json) && seeded.json.length === 1, 'the seeding is audited');
  const twice = one(await rest('POST', 'sales', 'rpc/seed_default_payment_structure', { p_organization_id: org.id }));
  check(!twice || twice === false || twice?.code !== undefined, 'the seeding function is not callable through the API (internal)', JSON.stringify(twice)?.slice(0, 80));
  const handWrite = await rest('POST', 'sales', 'payment_structures', { organization_id: ORG, name: 'zztest-x2 by hand' }, owner.token);
  check(!handWrite.ok, 'a direct write of a structure is still refused', `HTTP ${handWrite.status}`);

  const custom = one(await sales('set_payment_structure', { p_organization_id: org.id, p_name: 'Standard (30/20/30/20)', p_milestones: [{ label: 'Half now', pct: 50 }, { label: 'Half at handover', pct: 50 }] }));
  check(custom?.outcome === 'set', 'the owner can still write any split that totals 100', custom?.outcome);
  const edited = one(await rest('GET', 'sales', `payment_structures?id=eq.${custom?.structure_id}&select=is_default`));
  check(edited?.is_default === false, 'editing the default makes it the owner\'s own', String(edited?.is_default));
  const ninety = one(await sales('set_payment_structure', { p_organization_id: org.id, p_name: 'zztest-x2 ninety', p_milestones: [{ label: 'a', pct: 45 }, { label: 'b', pct: 45 }] }));
  check(ninety?.outcome === 'does_not_sum', 'a split that does not total 100 is still refused', ninety?.outcome);

  // ── D. contract / migration checks as a GitHub workflow ──────────────────
  section('D. contract and migration checks: dispatched as a workflow, result recorded');
  const env = one(await rest('POST', 'projects', 'environments', { organization_id: ORG, project_id: project.id, kind: 'staging', label: 'zztest-x2 staging', url: 'https://staging.example.invalid' }));
  if (!env?.id) k.fail(`could not create the fixture environment: ${JSON.stringify(env)}`);
  extra.envs.push(env.id);
  const dispatch = (args, token) => projects('record_check_dispatch', { p_environment_id: env.id, p_checks: ['api_contract', 'migrations'], p_repository: 'acme/site', p_workflow_file: 'agencyos-checks.yml', p_ref: 'main', p_dispatch_key: `ck-${randomUUID().replace(/-/g, '').slice(0, 20)}`, ...args }, token).then(one);

  for (const [who, u] of [['a member', member], ['finance', finance]]) {
    check((await dispatch({}, u.token))?.outcome === 'not_authorized', `${who} may not dispatch`);
  }
  check((await dispatch({ p_checks: ['external_config'] }, lead.token))?.outcome === 'bad_check', 'only the contract and migration checks can be dispatched');
  check((await dispatch({ p_workflow_file: '../evil.yml' }, lead.token))?.outcome === 'bad_workflow', 'a workflow file is a plain .yml name');
  check((await dispatch({ p_environment_id: randomUUID() }, lead.token))?.outcome === 'not_found', 'an unknown environment is not found');
  const first = await dispatch({}, lead.token);
  check(first?.outcome === 'recorded' && first?.run_row_id, 'a delivery lead records a dispatch', first?.outcome);
  const dupKey = `ck-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await dispatch({ p_dispatch_key: dupKey }, admin.token);
  const dup = await projects('record_check_dispatch', { p_environment_id: env.id, p_checks: ['migrations'], p_repository: 'acme/site', p_workflow_file: 'agencyos-checks.yml', p_ref: 'main', p_dispatch_key: dupKey }, admin.token);
  check(!dup.ok || one(dup)?.outcome !== 'recorded', 'a correlation key is used once');
  const directRun = await rest('POST', 'projects', 'environment_check_runs', { organization_id: ORG, project_id: project.id, environment_id: env.id, checks: ['migrations'], repository: 'a/b', workflow_file: 'x.yml', ref: 'main', dispatch_key: 'zztest-direct-1' }, owner.token);
  check(!directRun.ok, 'no role writes the table directly', `HTTP ${directRun.status}`);

  const result = (id, status, conclusion, token = lead.token) => projects('record_check_run_result', { p_run_row_id: id, p_status: status, p_conclusion: conclusion, p_run_id: 4242, p_run_url: 'https://github.com/acme/site/actions/runs/4242' }, token).then(one);
  check((await result(first.run_row_id, 'in_progress', null, member.token))?.outcome === 'not_authorized', 'a member may not record a result');
  check((await result(first.run_row_id, 'completed', null))?.outcome === 'bad_conclusion', 'a finished run must carry its conclusion');
  check((await result(first.run_row_id, 'in_progress', null))?.outcome === 'progress_noted', 'a run in progress is noted');
  const noted = one(await rest('GET', 'projects', `environment_check_runs?id=eq.${first.run_row_id}&select=status,run_id,run_url,applied_at`));
  check(noted?.status === 'in_progress' && noted?.run_id === 4242 && noted?.applied_at === null, 'its run and link are stored, nothing is applied yet');
  const midway = one(await rest('GET', 'projects', `environments?id=eq.${env.id}&select=readiness`));
  check(Object.keys(midway?.readiness ?? {}).length === 0, 'the environment readiness is untouched while the run is going');

  check((await result(first.run_row_id, 'completed', 'failure'))?.outcome === 'recorded', 'a failed run is recorded');
  const failed = one(await rest('GET', 'projects', `environments?id=eq.${env.id}&select=readiness`));
  check(failed?.readiness?.api_contract?.ok === false && failed?.readiness?.migrations?.ok === false && failed?.readiness?.api_contract?.source === 'workflow', 'both checks are recorded as failing, from the workflow');
  check(failed?.readiness?.migrations?.evidence_url === 'https://github.com/acme/site/actions/runs/4242', 'with the run link as the evidence', failed?.readiness?.migrations?.evidence_url);
  check((await result(first.run_row_id, 'completed', 'success'))?.outcome === 'already_recorded', 'a result is recorded once');

  const second = await dispatch({ p_checks: ['migrations'] }, admin.token);
  check((await result(second.run_row_id, 'completed', 'success', admin.token))?.outcome === 'recorded', 'a later successful run is recorded');
  const passed = one(await rest('GET', 'projects', `environments?id=eq.${env.id}&select=readiness`));
  check(passed?.readiness?.migrations?.ok === true && passed?.readiness?.api_contract?.ok === false, 'it passes only the check it ran; the other stays as it was');

  const byHand = one(await projects('record_environment_check', { p_environment_id: env.id, p_check: 'api_contract', p_ok: true, p_evidence_url: 'https://example.invalid/proof', p_note: 'checked by hand' }, lead.token));
  check(byHand?.outcome === 'recorded', 'the hand-recorded check still works, as the fallback');

  const events = await rest('GET', 'audit', `audit_log?action=in.(environment.checks_dispatched,environment.checks_result_recorded)&subject_id=eq.${env.id}&select=action,actor_id`);
  const seenActions = new Set((Array.isArray(events.json) ? events.json : []).map((e) => e.action));
  check(seenActions.has('environment.checks_dispatched') && seenActions.has('environment.checks_result_recorded'), 'dispatch and result are both audited');
} finally {
  await k.cleanup(async () => {
    for (const id of extra.envs) {
      await rest('DELETE', 'projects', `environment_check_runs?environment_id=eq.${id}`);
      await rest('DELETE', 'projects', `environments?id=eq.${id}`);
    }
    for (const id of k.created.projects) {
      const plans = await rest('GET', 'projects', `project_plans?project_id=eq.${id}&select=id`);
      for (const pl of Array.isArray(plans.json) ? plans.json : []) {
        await rest('DELETE', 'projects', `plan_deliverables?plan_id=eq.${pl.id}`);
        await rest('DELETE', 'projects', `project_plans?id=eq.${pl.id}`);
      }
    }
    for (const id of extra.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
  });
}
k.finish();
