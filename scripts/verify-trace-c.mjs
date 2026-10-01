// ═══════════════════════════════════════════════════════════════════════════
// Trace C (PDF pages 46 to 63) — two lines the line-by-line trace found unbuilt,
// proven against real Postgres (migration 20261008130000):
//   A. SCR-041 "Developer cannot decide own work is finally accepted" and
//      "Task completion requires evidence and downstream QA where applicable":
//      a person's session reaches `done` only through a delivery-management
//      role, with evidence on the task, and with no unverified defect against it.
//      The service role (system writers) is unchanged.
//   B. SCR-040 "Request missing client dependency through PM": a planner records
//      the request, once while open; the PM acknowledges; both are audited.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('a finished task is accepted; a client dependency is requested of the PM', 'zztest-tc');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');

try {
  const owner = await k.makeUser('owner');
  const lead = await k.makeUser('delivery_lead');
  const member = await k.makeUser('member');
  const contractor = await k.makeUser('contractor');
  const project = await k.makeProject('tc');

  const mkTask = async (title, extra = {}) => {
    const r = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `zztest-tc ${title}`, status: 'in_review', ...extra });
    const row = one(r);
    if (!row?.id) k.fail(`could not create a task: ${JSON.stringify(r.json)}`);
    return row;
  };
  const setDone = (id, token) => rest('PATCH', 'projects', `tasks?id=eq.${id}`, { status: 'done', completed_at: new Date().toISOString() }, token);
  const statusOf = async (id) => one(await rest('GET', 'projects', `tasks?id=eq.${id}&select=status`))?.status;
  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);

  // ── A. a finished task is accepted ───────────────────────────────────────
  section('A. a task is done only when a delivery role accepts it, with evidence, and no unverified defect');
  const t1 = await mkTask('accepted');

  for (const [who, u] of [['a member', member], ['a contractor', contractor]]) {
    const r = await setDone(t1.id, u.token);
    check(said(r, 'task_acceptance_not_yours') || r.status === 403 || r.status === 404 || (r.ok && Array.isArray(r.json) && r.json.length === 0), `${who} cannot mark a task done`, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
  }
  check((await statusOf(t1.id)) === 'in_review', 'the task is still in review after those attempts');

  const noEvidence = await setDone(t1.id, lead.token);
  check(said(noEvidence, 'task_needs_evidence'), 'a delivery lead cannot accept a task with no evidence on it', JSON.stringify(noEvidence.json).slice(0, 110));
  check((await statusOf(t1.id)) === 'in_review', 'and the task is unchanged');

  const submitted = one(await projects('submit_task_evidence', { p_task_id: t1.id, p_kind: 'test', p_title: 'zztest-tc ran the suite', p_note: 'all green' }, member.token));
  check(submitted?.outcome === 'submitted', 'the developer submits evidence', submitted?.outcome);

  const bornDone = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: 'zztest-tc born done', status: 'done' }, lead.token);
  check(said(bornDone, 'task_needs_evidence'), 'a task cannot be created already done by a person', JSON.stringify(bornDone.json).slice(0, 110));

  // A defect raised against the task is downstream QA the task waits for.
  const defect = one(await rest('POST', 'qa', 'defects', { organization_id: ORG, project_id: project.id, task_id: t1.id, severity: 'minor', title: 'zztest-tc defect', reproduction: 'open the page' }));
  check(Boolean(defect?.id), 'a defect is raised against the task', JSON.stringify(defect)?.slice(0, 80));
  check(said(await setDone(t1.id, lead.token), 'task_has_unverified_defect'), 'an open defect holds the task back');
  await rest('PATCH', 'qa', `defects?id=eq.${defect.id}`, { status: 'fixed', resolution: 'patched' });
  check(said(await setDone(t1.id, lead.token), 'task_has_unverified_defect'), 'a fixed defect nobody verified still holds it back');
  await rest('PATCH', 'qa', `defects?id=eq.${defect.id}`, { status: 'verified', resolution: 'patched', verified_by: lead.id, verified_at: new Date().toISOString() });

  const accepted = await setDone(t1.id, lead.token);
  check(accepted.ok && (await statusOf(t1.id)) === 'done', 'with evidence and the defect verified, a delivery lead accepts it', `HTTP ${accepted.status}`);
  const ownerAgain = await setDone(t1.id, owner.token);
  check(ownerAgain.ok, 'a task that is already done can be written again (no new transition)');

  // The system path is unchanged.
  const t2 = await mkTask('system path');
  const system = await setDone(t2.id);
  check(system.ok && (await statusOf(t2.id)) === 'done', 'the service role (the job runner, verifiers) is not bound by this rule', `HTTP ${system.status}`);

  // The agent verification gate still speaks first for an unverified agent task.
  const t3 = await mkTask('agent work', { status: 'in_progress' });
  await projects('mark_task_agent_generated', { p_task_id: t3.id, p_agent: true }, owner.token);
  const agent = await setDone(t3.id, owner.token);
  check(said(agent, 'agent_task_unverified'), 'an unverified agent task still answers agent_task_unverified', JSON.stringify(agent.json).slice(0, 110));

  // ── B. a client dependency is requested of the PM ────────────────────────
  section('B. a planner asks the PM to request a missing client dependency');
  const sv = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', source: 'onboarding' }));
  const plan = one(await rest('POST', 'projects', 'project_plans', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft', scope_version_id: sv.id }));
  const dep = (kind, status = 'pending') => rest('POST', 'projects', 'plan_dependencies', { organization_id: ORG, plan_id: plan.id, kind, description: `zztest-tc ${kind}`, needed_by_phase: 'phase_4', owner_role: kind.startsWith('client') ? 'project_manager' : 'engineering', status });
  const clientDep = one(await dep('client_information'));
  const techDep = one(await dep('external_service'));
  const receivedDep = one(await dep('client_access', 'received'));
  if (!clientDep?.id || !techDep?.id || !receivedDep?.id) k.fail('could not create the fixture dependencies');

  const ask = (id, token, note = 'we need the brand pack before design') => projects('request_client_dependency', { p_dependency_id: id, p_note: note }, token);
  check(one(await ask(clientDep.id, undefined))?.outcome === 'no_actor' || !(await ask(clientDep.id, undefined)).ok, 'no session, no request');
  check(one(await ask(randomUUID(), member.token))?.outcome === 'not_found', 'an unknown dependency is not found');
  check(one(await ask(techDep.id, member.token))?.outcome === 'not_a_client_dependency', 'only a client dependency is requested through the PM');
  check(one(await ask(receivedDep.id, member.token))?.outcome === 'not_outstanding', 'a dependency the client already supplied is not requested again');
  const finance = await k.makeUser('finance');
  check(one(await ask(clientDep.id, finance.token))?.outcome === 'forbidden', 'a role that cannot write projects may not raise the request');

  const first = one(await ask(clientDep.id, member.token));
  check(first?.outcome === 'requested' && first?.event_id, 'a member who plans raises the request', first?.outcome);
  check(one(await ask(clientDep.id, lead.token))?.outcome === 'already_open', 'it is open once, not once per click');
  const ev = one(await rest('GET', 'projects', `development_events?id=eq.${first.event_id}&select=kind,status,detail,reason,raised_by,project_id`));
  check(ev?.kind === 'dependency_requested' && ev?.status === 'open' && ev?.detail?.dependencyId === clientDep.id && ev?.project_id === project.id && ev?.raised_by === member.id, 'the event names the dependency, the project and who asked', JSON.stringify(ev)?.slice(0, 140));
  const row = one(await rest('GET', 'projects', `plan_dependencies?id=eq.${clientDep.id}&select=status`));
  check(row?.status === 'pending', 'the plan row itself is not edited by the request');

  const ack = (id, token) => projects('acknowledge_escalation', { p_event_id: id }, token);
  check(one(await ack(first.event_id, member.token))?.outcome === 'forbidden', 'only the PM acknowledges (a member may not)');
  check(one(await ack(first.event_id, lead.token))?.outcome === 'acknowledged', 'a delivery lead (the PM) acknowledges');
  check(one(await ack(first.event_id, lead.token))?.outcome === 'not_open', 'and only once');
  const again = one(await ask(clientDep.id, member.token));
  check(again?.outcome === 'requested', 'once acknowledged, a fresh request can be raised if the client still has not supplied it', again?.outcome);

  const audits = await rest('GET', 'audit', `audit_log?subject_id=eq.${clientDep.id}&select=action,actor_id&order=id.asc`);
  const actions = (Array.isArray(audits.json) ? audits.json : []).map((a) => a.action);
  check(actions.includes('plan.dependency_requested') && actions.includes('plan.dependency_request_acknowledged'), 'the request and its acknowledgement are audited', actions.join(' · '));
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      const plans = await rest('GET', 'projects', `project_plans?project_id=eq.${id}&select=id`);
      for (const pl of Array.isArray(plans.json) ? plans.json : []) {
        await rest('DELETE', 'projects', `plan_dependencies?plan_id=eq.${pl.id}`);
        await rest('DELETE', 'projects', `project_plans?id=eq.${pl.id}`);
      }
      await rest('DELETE', 'projects', `development_events?project_id=eq.${id}`);
      await rest('DELETE', 'qa', `defects?project_id=eq.${id}`);
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) await rest('DELETE', 'projects', `task_evidence?task_id=eq.${t.id}`);
      await rest('DELETE', 'projects', `scope_versions?project_id=eq.${id}`);
    }
  });
}
k.finish();
