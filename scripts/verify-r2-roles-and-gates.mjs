// ═══════════════════════════════════════════════════════════════════════════
// Round 3, stream R2 — proven against real Postgres through PostgREST
// (migrations 20261009200000 and 20261009200100):
//   A. Q-B1  a task reaches Completed only from In review, for every writer
//   B. Q-B2  project roles bind on that project: observer read-only,
//            contributor own tasks only, everyone else per agency role
//   C. Q-B4  default assignees per project role: a role-gated, audited door,
//            tenancy guards on the table
//   D. Q-C3  Start Task is gated by the requirement check and the dependency
//            check (R2-1: per task, the failing task is named), and the failing
//            reason is returned
// Plants its own users, project, plan and organisation under a marker (the CI
// database has only the seeded owner and organisation) and removes them.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('round 3 R2: completion, project roles, default assignees, gated start', 'zztest-r2');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');
const extra = { orgs: [] };

try {
  const owner = await k.makeUser('owner');
  const lead = await k.makeUser('delivery_lead');
  const contributor = await k.makeUser('member');
  const observer = await k.makeUser('member');
  const developer = await k.makeUser('member');
  const plain = await k.makeUser('member');
  const project = await k.makeProject('r2');

  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);
  const mkTask = async (title, extraFields = {}) => {
    const r = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `zztest-r2 ${title}`, ...extraFields });
    const row = one(r);
    if (!row?.id) k.fail(`could not create a task: ${JSON.stringify(r.json)}`);
    return row;
  };
  const statusOf = async (id) => one(await rest('GET', 'projects', `tasks?id=eq.${id}&select=status`))?.status;
  const patch = (id, body, token) => rest('PATCH', 'projects', `tasks?id=eq.${id}`, body, token);

  // ── A. Completed only from In review ─────────────────────────────────────
  section('A. a task is completed only from In review');
  for (const from of ['todo', 'in_progress', 'blocked']) {
    const t = await mkTask(`from ${from}`, from === 'blocked' ? { status: 'blocked', blocked_reason: 'waiting on the client' } : { status: from });
    const person = await patch(t.id, { status: 'done', completed_at: new Date().toISOString() }, lead.token);
    check(said(person, 'task_completion_requires_review'), `a delivery lead cannot complete a task that is ${from}`, JSON.stringify(person.json).slice(0, 100));
    const system = await patch(t.id, { status: 'done', completed_at: new Date().toISOString() });
    check(said(system, 'task_completion_requires_review'), `nor can a system writer (${from})`, JSON.stringify(system.json).slice(0, 100));
    check((await statusOf(t.id)) === from, `and the task is still ${from}`);
  }
  const reviewed = await mkTask('reviewed', { status: 'in_review' });
  const ev = one(await projects('submit_task_evidence', { p_task_id: reviewed.id, p_kind: 'test', p_title: 'zztest-r2 suite', p_note: 'green' }, plain.token));
  check(ev?.outcome === 'submitted', 'evidence is submitted on the reviewed task', ev?.outcome);
  const accepted = await patch(reviewed.id, { status: 'done', completed_at: new Date().toISOString() }, lead.token);
  check(accepted.ok && (await statusOf(reviewed.id)) === 'done', 'from In review a delivery lead completes it', `HTTP ${accepted.status}`);
  const again = await patch(reviewed.id, { title: 'zztest-r2 reviewed, renamed', status: 'done' }, lead.token);
  check(again.ok, 'a task that is already completed can be written again (no new transition)');

  // ── B. project roles bind on that project ────────────────────────────────
  section('B. a project role narrows the agency role on that project');
  const roster = (user, project_role) => rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: user.id, project_role });
  for (const [u, r] of [[contributor, 'contributor'], [observer, 'observer'], [developer, 'developer'], [lead, 'observer']]) {
    const res = await roster(u, r);
    if (!res.ok) k.fail(`could not add a ${r} to the roster: ${JSON.stringify(res.json)}`);
  }
  const own = await mkTask('contributor own', { assignee_id: contributor.id });
  const other = await mkTask('held by the lead', { assignee_id: lead.id });
  const mine = await mkTask('observer own', { assignee_id: observer.id });
  const unheld = await mkTask('unassigned');

  const own1 = await patch(own.id, { title: 'zztest-r2 contributor own, edited' }, contributor.token);
  check(own1.ok && one(own1)?.id === own.id, 'a contributor changes a task assigned to them');
  const other1 = await patch(other.id, { title: 'zztest-r2 nope' }, contributor.token);
  check(said(other1, 'project_role_contributor_own_tasks'), 'a contributor cannot change a task held by somebody else', JSON.stringify(other1.json).slice(0, 110));
  const unheld1 = await patch(unheld.id, { title: 'zztest-r2 nope' }, contributor.token);
  check(said(unheld1, 'project_role_contributor_own_tasks'), 'nor an unassigned one', JSON.stringify(unheld1.json).slice(0, 110));
  const takeOver = await patch(unheld.id, { assignee_id: contributor.id }, contributor.token);
  check(said(takeOver, 'project_role_contributor_own_tasks'), 'nor take it over by assigning it to themself');
  const born = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: 'zztest-r2 for someone else', assignee_id: lead.id }, contributor.token);
  check(said(born, 'project_role_contributor_own_tasks'), 'a contributor cannot create a task for somebody else');
  const bornOwn = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: 'zztest-r2 for myself', assignee_id: contributor.id }, contributor.token);
  check(bornOwn.ok, 'but can create one for themself');

  const obs1 = await patch(mine.id, { title: 'zztest-r2 nope' }, observer.token);
  check(said(obs1, 'project_role_observer_read_only'), 'an observer cannot change even a task assigned to them', JSON.stringify(obs1.json).slice(0, 110));
  const obsNew = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: 'zztest-r2 observer new' }, observer.token);
  check(said(obsNew, 'project_role_observer_read_only'), 'an observer cannot create a task');
  const obsDel = await rest('DELETE', 'projects', `tasks?id=eq.${mine.id}`, undefined, observer.token);
  check(!obsDel.ok || (Array.isArray(obsDel.json) && obsDel.json.length === 0), 'nor delete one');
  const obsEvidence = await projects('submit_task_evidence', { p_task_id: mine.id, p_kind: 'test', p_title: 'zztest-r2 nope', p_note: 'x' }, observer.token);
  check(said(obsEvidence, 'project_role_observer_read_only'), 'nor add evidence', JSON.stringify(obsEvidence.json).slice(0, 110));
  const obsStart = one(await projects('start_task', { p_task_id: mine.id }, observer.token));
  check(obsStart?.outcome === 'project_role_observer_read_only', 'the start door answers with the project-role refusal', obsStart?.outcome);
  const conStart = one(await projects('start_task', { p_task_id: other.id }, contributor.token));
  check(conStart?.outcome === 'project_role_contributor_own_tasks', 'and the same for a contributor on a task that is not theirs', conStart?.outcome);

  const dev1 = await patch(other.id, { title: 'zztest-r2 edited by a developer' }, developer.token);
  check(dev1.ok && one(dev1)?.id === other.id, 'a developer on the roster is governed by the agency role as before');
  const plain1 = await patch(other.id, { title: 'zztest-r2 edited by an unlisted member' }, plain.token);
  check(plain1.ok && one(plain1)?.id === other.id, 'so is a member who is not on the roster');
  const leadBound = await patch(other.id, { title: 'zztest-r2 edited by the lead' }, lead.token);
  check(leadBound.ok && one(leadBound)?.id === other.id, 'a delivery lead who keeps the roster is not bound by it, even listed as an observer');
  check((await statusOf(own.id)) === 'todo', 'no refused write changed a status');

  // ── C. default assignees per project role ────────────────────────────────
  section('C. a project has a default assignee for each project role');
  const setDefault = (role, userId, token) => projects('set_project_default_assignee', { p_project_id: project.id, p_project_role: role, p_user_id: userId }, token);
  check(one(await setDefault('developer', developer.id, plain.token))?.outcome === 'forbidden', 'a member cannot set a default assignee');
  check(one(await setDefault('wizard', developer.id, lead.token))?.outcome === 'bad_role', 'only the six project roles are accepted');
  check(one(await setDefault('developer', randomUUID(), lead.token))?.outcome === 'not_internal', 'the person must be an active internal member');
  check(one(await setDefault('developer', developer.id, lead.token))?.outcome === 'set', 'a delivery lead sets the developer default');
  check(one(await setDefault('qa', plain.id, owner.token))?.outcome === 'set', 'the owner sets the QA default');
  check(one(await setDefault('developer', plain.id, lead.token))?.outcome === 'set', 'a role has one default: setting it again replaces it');
  const rows = (await rest('GET', 'projects', `project_default_assignees?project_id=eq.${project.id}&select=project_role,user_id&order=project_role.asc`, undefined, plain.token)).json ?? [];
  check(rows.length === 2 && rows.find((r) => r.project_role === 'developer')?.user_id === plain.id, 'an internal reader sees the defaults', JSON.stringify(rows).slice(0, 120));
  const direct = await rest('POST', 'projects', 'project_default_assignees', { organization_id: ORG, project_id: project.id, project_role: 'designer', user_id: plain.id }, lead.token);
  check(!direct.ok, 'a direct write is refused: the door is the only way in', `HTTP ${direct.status}`);
  check(one(await setDefault('developer', null, lead.token))?.outcome === 'cleared', 'a default can be cleared');
  const audits = (await rest('GET', 'audit', `audit_log?subject_id=eq.${project.id}&action=like.project.default_assignee_*&select=action,after`)).json ?? [];
  const actions = audits.map((a) => a.action);
  check(actions.filter((a) => a === 'project.default_assignee_set').length === 3 && actions.includes('project.default_assignee_cleared'), 'each set and the clear are audited', actions.join(' · '));

  // Tenancy guards on the new table.
  const org2 = one(await rest('POST', 'core', 'organizations', { name: `zztest-r2 ${randomUUID().slice(0, 6)}`, slug: `zztest-r2-${randomUUID().slice(0, 8)}` }));
  if (!org2?.id) k.fail(`could not create the fixture organisation: ${JSON.stringify(org2)}`);
  extra.orgs.push(org2.id);
  const crossOrg = await rest('POST', 'projects', 'project_default_assignees', { organization_id: org2.id, project_id: project.id, project_role: 'designer', user_id: plain.id });
  check(!crossOrg.ok, 'a row cannot name a project of another organisation', JSON.stringify(crossOrg.json).slice(0, 100));
  const moved = await rest('PATCH', 'projects', `project_default_assignees?project_id=eq.${project.id}&project_role=eq.qa`, { organization_id: org2.id });
  check(!moved.ok, 'a row cannot be moved to another organisation', JSON.stringify(moved.json).slice(0, 100));

  // ── D. Start Task is gated ───────────────────────────────────────────────
  section('D. Start Task needs a requirement and every task it depends on done');
  // The Phase 5 gate: a development task (one on a module or feature) starts only on a verified-paid M2, so the fixture
  // project gets one - an M1, an M2, and an M2 invoice an Admin has verified in full. (The gate itself is proven in
  // scripts/verify-phase-five-gate.sql; this script is about the requirement and dependency checks.)
  await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: 'zztest-r2 M1', position: 1, amount_minor: 50000, currency: 'INR' });
  const gateM2 = one(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: 'zztest-r2 M2', position: 2, amount_minor: 100000, currency: 'INR' }));
  const gateInv = one(await rest('POST', 'finance', 'invoices', { organization_id: ORG, client_account_id: project.client_account_id, project_id: project.id, milestone_id: gateM2?.id, number: `zztest-r2-M2-${randomUUID().slice(0, 6)}`, kind: 'milestone', status: 'issued', currency: 'INR', subtotal_minor: 100000, total_minor: 100000, issued_at: new Date().toISOString() }));
  if (!gateM2?.id || !gateInv?.id) k.fail('could not create the fixture M2 milestone and invoice');
  await rest('PATCH', 'finance', `invoices?id=eq.${gateInv.id}`, { paid_minor: 100000, verified_minor: 100000, status: 'paid', paid_at: new Date().toISOString() });

  const bare = await mkTask('no requirement');
  const chk0 = one(await projects('task_start_check', { p_task_id: bare.id }, plain.token));
  check(chk0?.startable === false && chk0?.requirement_ok === false && /Requirement check failed/.test(chk0?.reason ?? ''), 'a task linked to nothing fails the requirement check, with the reason', chk0?.reason?.slice(0, 80));
  check(one(await projects('start_task', { p_task_id: bare.id }, plain.token))?.outcome === 'no_requirement', 'and Start refuses it');
  check((await statusOf(bare.id)) === 'todo', 'the task stays to do');

  const sv = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', source: 'onboarding' }));
  const mod = one(await rest('POST', 'projects', 'modules', { organization_id: ORG, project_id: project.id, name: 'zztest-r2 module' }));
  const featIn = one(await rest('POST', 'projects', 'features', { organization_id: ORG, project_id: project.id, module_id: mod?.id, name: 'zztest-r2 included' }));
  const featOut = one(await rest('POST', 'projects', 'features', { organization_id: ORG, project_id: project.id, module_id: mod?.id, name: 'zztest-r2 excluded' }));
  if (!sv?.id || !mod?.id || !featIn?.id || !featOut?.id) k.fail('could not create the scope fixtures');
  await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, feature_id: featIn.id, title: 'zztest-r2 login', inclusion: 'included', position: 0 });
  await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, feature_id: featOut.id, title: 'zztest-r2 vendor portal', inclusion: 'excluded', position: 1 });

  const onExcluded = await mkTask('feature with only an excluded item', { feature_id: featOut.id });
  check(one(await projects('start_task', { p_task_id: onExcluded.id }, plain.token))?.outcome === 'no_requirement', 'a feature carrying only an excluded scope item is not a requirement');

  // R2-1: the plan's own dependencies no longer gate a task; the task's own dependencies do.
  const plan = one(await rest('POST', 'projects', 'project_plans', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', scope_version_id: sv.id }));
  const dep = one(await rest('POST', 'projects', 'plan_dependencies', { organization_id: ORG, plan_id: plan.id, kind: 'client_information', description: 'zztest-r2 brand pack', needed_by_phase: 'phase_4', owner_role: 'project_manager', status: 'pending' }));
  if (!plan?.id || !dep?.id) k.fail('could not create the plan fixtures');

  const linked = await mkTask('linked to a requirement', { feature_id: featIn.id });
  const chk0b = one(await projects('task_start_check', { p_task_id: linked.id }, plain.token));
  check(chk0b?.startable === true && chk0b?.open_dependencies === 0, 'a pending plan dependency does not stop a linked task: the plan-level check is replaced', JSON.stringify(chk0b)?.slice(0, 100));

  const waitsFor = await mkTask('prerequisite');
  const addDep = one(await projects('add_task_dependency', { p_task_id: linked.id, p_depends_on_task_id: waitsFor.id }, plain.token));
  check(addDep?.outcome === 'added', 'a dependency on another task is added', addDep?.outcome);
  const chk1 = one(await projects('task_start_check', { p_task_id: linked.id }, plain.token));
  check(chk1?.requirement_ok === true && chk1?.open_dependencies === 1 && chk1?.startable === false && /waiting on "zztest-r2 prerequisite" \(todo\)/.test(chk1?.reason ?? ''), 'linked, but it waits for an unfinished task: the reason names that task', chk1?.reason?.slice(0, 120));
  const refused = one(await projects('start_task', { p_task_id: linked.id }, plain.token));
  check(refused?.outcome === 'dependencies_open' && /zztest-r2 prerequisite/.test(refused?.detail ?? ''), 'Start refuses with dependencies_open and names the task', refused?.detail?.slice(0, 100));
  check((await statusOf(linked.id)) === 'todo', 'the task stays to do');

  for (const status of ['in_progress', 'blocked']) {
    await rest('PATCH', 'projects', `tasks?id=eq.${waitsFor.id}`, status === 'blocked' ? { status, blocked_reason: 'zztest-r2 waiting' } : { status });
    check(one(await projects('start_task', { p_task_id: linked.id }, plain.token))?.outcome === 'dependencies_open', `a prerequisite that is ${status} still counts as outstanding`);
  }
  await patch(waitsFor.id, { status: 'in_progress' });
  await projects('submit_task_evidence', { p_task_id: waitsFor.id, p_kind: 'test', p_title: 'zztest-r2 prerequisite suite', p_note: 'green' }, plain.token);
  await projects('mark_task_ready_for_qa', { p_task_id: waitsFor.id }, plain.token);
  check(one(await rest('GET', 'projects', `tasks?id=eq.${waitsFor.id}&select=status`))?.status === 'in_review', 'the prerequisite reaches In review through the hand-off, and is still outstanding');
  check(one(await projects('start_task', { p_task_id: linked.id }, plain.token))?.outcome === 'dependencies_open', 'a prerequisite in review still counts as outstanding');
  const finished = await patch(waitsFor.id, { status: 'done', completed_at: new Date().toISOString() }, lead.token);
  check(finished.ok, 'the prerequisite is completed from In review', JSON.stringify(finished.json).slice(0, 160));
  const chk2 = one(await projects('task_start_check', { p_task_id: linked.id }, plain.token));
  check(chk2?.startable === true && chk2?.reason === null, 'once the prerequisite is done the task can start', JSON.stringify(chk2)?.slice(0, 100));
  check(one(await projects('start_task', { p_task_id: linked.id }, plain.token))?.outcome === 'started', 'and Start succeeds');
  check((await statusOf(linked.id)) === 'in_progress', 'the task is in progress');
  check(one(await projects('start_task', { p_task_id: linked.id }, plain.token))?.outcome === 'wrong_state', 'a started task is not started twice');
  const startAudit = (await rest('GET', 'audit', `audit_log?subject_id=eq.${linked.id}&action=eq.task.started&select=id`)).json ?? [];
  check(startAudit.length === 1, 'the start is audited once');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      await rest('DELETE', 'finance', `invoices?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `milestones?project_id=eq.${id}`);
      const plans = await rest('GET', 'projects', `project_plans?project_id=eq.${id}&select=id`);
      for (const pl of Array.isArray(plans.json) ? plans.json : []) {
        await rest('DELETE', 'projects', `plan_dependencies?plan_id=eq.${pl.id}`);
        await rest('DELETE', 'projects', `project_plans?id=eq.${pl.id}`);
      }
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) {
        await rest('DELETE', 'projects', `task_evidence?task_id=eq.${t.id}`);
        await rest('DELETE', 'projects', `task_dependencies?task_id=eq.${t.id}`);
      }
      await rest('DELETE', 'projects', `tasks?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `scope_items?scope_version_id=in.(${((await rest('GET', 'projects', `scope_versions?project_id=eq.${id}&select=id`)).json ?? []).map((v) => v.id).join(',') || randomUUID()})`);
      await rest('DELETE', 'projects', `scope_versions?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `features?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `modules?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `project_default_assignees?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `project_members?project_id=eq.${id}`);
    }
    for (const id of extra.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
  });
}
k.finish();
