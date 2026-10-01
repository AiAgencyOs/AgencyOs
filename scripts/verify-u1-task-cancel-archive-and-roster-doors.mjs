// ═══════════════════════════════════════════════════════════════════════════
// Round 3d, stream U1 — proven against real Postgres through PostgREST
// (migration 20261009700000):
//   A. T1-1  a task can be cancelled (open statuses only, by its assignee or a
//            roster manager), cancelled is terminal except a roster manager
//            reopens it to To do; Q-B1 (done only from review) still holds
//   B. T1-1  archive / unarchive is the roster managers' audited door; a
//            cancelled or archived dependency is satisfied
//   C. T1-1  a cancelled or archived task is not outstanding work: phase
//            readiness, module progress and the QA hand-off gate do not count it
//   D. T1-2  the roster is written only through the audited doors (add, change
//            role, remove); a direct write is refused for a signed-in person
// Plants its own users and projects under a marker (the CI database has only the
// seeded owner and organisation) and removes them in a finally.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('round 3d U1: cancelled and archived tasks, the roster doors', 'zztest-u1');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');

try {
  const lead = await k.makeUser('delivery_lead');
  const developer = await k.makeUser('member');
  const otherDev = await k.makeUser('member');
  const observer = await k.makeUser('member');
  const newcomer = await k.makeUser('member');
  const project = await k.makeProject('u1');

  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);
  const outcome = async (promise) => one(await promise)?.outcome;
  const mkTask = async (title, fields = {}) => {
    const r = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `zztest-u1 ${title}`, ...fields });
    const row = one(r);
    if (!row?.id) k.fail(`could not create a task: ${JSON.stringify(r.json)}`);
    return row;
  };
  const setStatus = (task, status, token) => rest('PATCH', 'projects', `tasks?id=eq.${task.id}`, { status }, token);
  const statusOf = async (task) => one(await rest('GET', 'projects', `tasks?id=eq.${task.id}&select=status,archived_at`));
  const audits = async (subjectId, like) => ((await rest('GET', 'audit', `audit_log?subject_id=eq.${subjectId}&action=like.${like}&select=action`)).json ?? []).map((r) => r.action);

  for (const [user, role] of [[developer, 'developer'], [otherDev, 'developer'], [observer, 'observer']]) {
    const r = await projects('add_project_member', { p_project_id: project.id, p_user_id: user.id, p_project_role: role }, lead.token);
    if (one(r)?.outcome !== 'added') k.fail(`could not add a ${role}: ${JSON.stringify(r.json)}`);
  }

  // ── A. cancel and reopen ─────────────────────────────────────────────────
  section('A. cancel from an open status; cancelled is terminal except a roster manager reopens it');
  const mine = await mkTask('mine', { assignee_id: developer.id });
  const theirs = await mkTask('theirs', { assignee_id: otherDev.id });
  check(said(await setStatus(theirs, 'cancelled', developer.token), 'task_cancel_requires_owner_or_lead'), 'a developer cannot cancel a task assigned to somebody else');
  check((await statusOf(theirs)).status === 'todo', 'and nothing changed');
  check(said(await setStatus(mine, 'cancelled', observer.token), 'project_role_observer_read_only'), 'an observer cannot cancel (project role still binds)');
  check((await setStatus(mine, 'cancelled', developer.token)).ok, 'the assignee cancels their own task');
  check((await statusOf(mine)).status === 'cancelled', 'it is cancelled');
  check(said(await setStatus(mine, 'todo', developer.token), 'task_cancelled_is_terminal'), 'the assignee cannot reopen it');
  check(said(await setStatus(mine, 'in_progress', lead.token), 'task_cancelled_is_terminal'), 'a lead cannot move it anywhere but To do');
  check((await setStatus(mine, 'todo', lead.token)).ok && (await statusOf(mine)).status === 'todo', 'a roster manager reopens it to To do');
  check((await setStatus(theirs, 'cancelled', lead.token)).ok, 'a delivery lead cancels anyone\'s task');

  const wip = await mkTask('wip', { assignee_id: developer.id });
  check((await setStatus(wip, 'in_progress', lead.token)).ok && (await setStatus(wip, 'cancelled', lead.token)).ok, 'an in-progress task can be cancelled');
  const blockedTask = await mkTask('blocked', { assignee_id: developer.id });
  const blocked = await rest('PATCH', 'projects', `tasks?id=eq.${blockedTask.id}`, { status: 'blocked', blocked_reason: 'zztest-u1', blocker_type: 'other', blocker_owner: 'zztest-u1', blocker_next_action: 'ask' }, lead.token);
  check(blocked.ok && (await setStatus(blockedTask, 'cancelled', lead.token)).ok, 'a blocked task can be cancelled');
  const afterBlocked = one(await rest('GET', 'projects', `tasks?id=eq.${blockedTask.id}&select=blocked_reason,blocker_type`));
  check(afterBlocked?.blocked_reason === null && afterBlocked?.blocker_type === null, 'and its blocker facts are cleared');

  // Q-B1 and a cancel from done.
  const review = await mkTask('review', { assignee_id: developer.id });
  await setStatus(review, 'in_progress', lead.token);
  await projects('submit_task_evidence', { p_task_id: review.id, p_kind: 'test', p_title: 'zztest-u1 suite', p_note: 'green' }, developer.token);
  await projects('mark_task_ready_for_qa', { p_task_id: review.id }, developer.token);
  const shortcut = await mkTask('shortcut', { assignee_id: developer.id });
  check(said(await setStatus(shortcut, 'done', lead.token), 'task_completion_requires_review'), 'Q-B1 still holds: completion only from In review');
  check((await setStatus(review, 'done', lead.token)).ok, 'a task in review is completed');
  check(said(await setStatus(review, 'cancelled', lead.token), 'task_cancel_from_open_only'), 'a completed task cannot be cancelled');
  const inReview = await mkTask('in review', { assignee_id: developer.id });
  await setStatus(inReview, 'in_progress', lead.token);
  await projects('submit_task_evidence', { p_task_id: inReview.id, p_kind: 'test', p_title: 'zztest-u1 suite 2', p_note: 'green' }, developer.token);
  await projects('mark_task_ready_for_qa', { p_task_id: inReview.id }, developer.token);
  check((await setStatus(inReview, 'cancelled', lead.token)).ok, 'a task in review can be cancelled');

  // ── B. archive and a closed dependency ───────────────────────────────────
  section('B. archive is the roster managers\' audited door; a cancelled or archived dependency is satisfied');
  const prereq = await mkTask('prerequisite');
  const waiter = await mkTask('waiter', { assignee_id: developer.id });
  check((await outcome(projects('add_task_dependency', { p_task_id: waiter.id, p_depends_on_task_id: prereq.id }, developer.token))) === 'added', 'a dependency is added');
  const open0 = one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token));
  check(open0?.open_dependencies === 1, 'an open prerequisite is open');

  check((await outcome(projects('set_task_archived', { p_task_id: prereq.id, p_archived: true }, developer.token))) === 'forbidden', 'a developer cannot archive');
  check((await outcome(projects('set_task_archived', { p_task_id: prereq.id, p_archived: true }, observer.token))) === 'forbidden', 'nor an observer');
  const direct = await rest('PATCH', 'projects', `tasks?id=eq.${prereq.id}`, { archived_at: new Date().toISOString() }, developer.token);
  check(said(direct, 'task_archive_requires_roster_manager') || (Array.isArray(direct.json) && direct.json.length === 0), 'a direct archived_at write by a developer is refused');
  check((await statusOf(prereq)).archived_at === null, 'nothing changed');
  check((await outcome(projects('set_task_archived', { p_task_id: randomUUID(), p_archived: true }, lead.token))) === 'not_found', 'an unknown task is not found');
  check((await outcome(projects('set_task_archived', { p_task_id: prereq.id, p_archived: true }, lead.token))) === 'archived', 'a delivery lead archives it');
  check((await outcome(projects('set_task_archived', { p_task_id: prereq.id, p_archived: true }, lead.token))) === 'unchanged', 'archiving twice changes nothing');
  check(one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token))?.open_dependencies === 0, 'an archived prerequisite satisfies the dependency');
  check((await outcome(projects('start_task', { p_task_id: waiter.id }, developer.token))) !== 'dependencies_open', 'so Start Task is not refused for it');
  check((await outcome(projects('set_task_archived', { p_task_id: prereq.id, p_archived: false }, lead.token))) === 'unarchived', 'it is restored');
  check(one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token))?.open_dependencies === 1, 'and the dependency is open again');
  check((await setStatus(prereq, 'cancelled', lead.token)).ok, 'cancelling the prerequisite');
  check(one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token))?.open_dependencies === 0, 'satisfies the dependency');
  const archiveAudit = await audits(prereq.id, 'task.%archived');
  check(archiveAudit.includes('task.archived') && archiveAudit.includes('task.unarchived'), 'archive and restore are audited', archiveAudit.join(' · '));

  // ── C. not outstanding work ──────────────────────────────────────────────
  section('C. a cancelled or archived task is not outstanding work');
  const mod = one(await rest('POST', 'projects', 'modules', { organization_id: ORG, project_id: project.id, name: 'zztest-u1 module' }));
  if (!mod?.id) k.fail(`could not create a module: ${JSON.stringify(mod)}`);
  const devA = await mkTask('dev a', { module_id: mod.id });
  const devB = await mkTask('dev b', { module_id: mod.id });
  const devC = await mkTask('dev c', { module_id: mod.id });
  const readiness = async () => one(await projects('phase_readiness', { p_project_id: project.id, p_phase: 5 }, lead.token));
  const before = await readiness();
  check(before?.facts?.developmentTasks === 3 && before?.facts?.openDevelopmentTasks === 3, 'three open development tasks', JSON.stringify(before?.facts));
  await setStatus(devB, 'cancelled', lead.token);
  await projects('set_task_archived', { p_task_id: devC.id, p_archived: true }, lead.token);
  const after = await readiness();
  check(after?.facts?.developmentTasks === 1 && after?.facts?.openDevelopmentTasks === 1, 'a cancelled and an archived task do not count in Phase 5 readiness', JSON.stringify(after?.facts));
  const progress = (await projects('module_progress', { p_project_id: project.id }, lead.token)).json?.find((m) => m.module_id === mod.id);
  check(Number(progress?.tasks_total) === 1, 'module progress counts only the live task', JSON.stringify(progress));
  await setStatus(devA, 'cancelled', lead.token);
  const none = await readiness();
  check(none?.facts?.developmentTasks === 0 && (none?.missing ?? []).some((m) => /No development task/.test(m)), 'with every task cancelled or archived none is outstanding', JSON.stringify(none?.missing));

  // The QA hand-off gate: an archived To-do task is not unfinished work.
  const gate0 = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: 'zztest-u1 gate' });
  const gateTask = one(gate0);
  const refused = one(await projects('start_qa_handoff', { p_project_id: project.id }, lead.token));
  check(refused?.outcome === 'gate_refused' && refused?.not_ready >= 1, 'an open To-do task refuses the QA hand-off', JSON.stringify(refused));
  await projects('set_task_archived', { p_task_id: gateTask.id, p_archived: true }, lead.token);
  // Archive the other open fixtures too: nothing live is left, so the gate opens.
  const live = (await rest('GET', 'projects', `tasks?project_id=eq.${project.id}&archived_at=is.null&status=in.(todo,in_progress,blocked)&select=id`)).json ?? [];
  for (const t of live) await projects('set_task_archived', { p_task_id: t.id, p_archived: true }, lead.token);
  const started = one(await projects('start_qa_handoff', { p_project_id: project.id }, lead.token));
  check(started?.outcome === 'started', 'archived tasks no longer hold the hand-off back', JSON.stringify(started));

  // ── D. the roster doors ──────────────────────────────────────────────────
  section('D. the roster is written only through the audited doors');
  const add = (who, role, token) => projects('add_project_member', { p_project_id: project.id, p_user_id: who, p_project_role: role }, token);
  check((await outcome(add(newcomer.id, 'qa', developer.token))) === 'forbidden', 'a developer cannot add to the roster');
  check((await outcome(add(newcomer.id, 'wizard', lead.token))) === 'bad_role', 'an unknown role is refused');
  check((await outcome(add(randomUUID(), 'qa', lead.token))) === 'not_internal', 'a person without an internal membership is refused');
  check((await outcome(projects('add_project_member', { p_project_id: randomUUID(), p_user_id: newcomer.id, p_project_role: 'qa' }, lead.token))) === 'not_found', 'an unknown project is not found');
  const added = await add(newcomer.id, 'qa', lead.token);
  const memberId = one(added)?.member_id;
  check(one(added)?.outcome === 'added' && Boolean(memberId), 'a delivery lead adds a person');
  check((await outcome(add(newcomer.id, 'qa', lead.token))) === 'already_member', 'adding twice is refused');
  check((await outcome(projects('change_project_member_role', { p_member_id: memberId, p_project_role: 'designer' }, developer.token))) === 'forbidden', 'a developer cannot change a role');
  check((await outcome(projects('change_project_member_role', { p_member_id: memberId, p_project_role: 'designer' }, lead.token))) === 'changed', 'a delivery lead changes the role');
  check((await outcome(projects('change_project_member_role', { p_member_id: memberId, p_project_role: 'designer' }, lead.token))) === 'unchanged', 'the same role changes nothing');
  check((await outcome(projects('change_project_member_role', { p_member_id: randomUUID(), p_project_role: 'designer' }, lead.token))) === 'not_found', 'an unknown member is not found');
  check((await outcome(projects('remove_project_member', { p_member_id: memberId }, developer.token))) === 'forbidden', 'a developer cannot remove');
  check((await outcome(projects('remove_project_member', { p_member_id: memberId }, lead.token))) === 'removed', 'a delivery lead removes the person');
  check((await outcome(projects('remove_project_member', { p_member_id: memberId }, lead.token))) === 'not_found', 'removing twice finds nothing');
  const roster = await audits(project.id, 'project.member_%');
  check(['project.member_added', 'project.member_role_changed', 'project.member_removed'].every((a) => roster.includes(a)), 'each change is audited', roster.join(' · '));

  const directInsert = await rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: newcomer.id, project_role: 'qa' }, lead.token);
  check(!directInsert.ok, 'a direct insert into the roster is refused even for a delivery lead', `HTTP ${directInsert.status}`);
  const directUpdate = await rest('PATCH', 'projects', `project_members?project_id=eq.${project.id}&user_id=eq.${developer.id}`, { project_role: 'observer' }, lead.token);
  check(!directUpdate.ok, 'and a direct update', `HTTP ${directUpdate.status}`);
  const directDelete = await rest('DELETE', 'projects', `project_members?project_id=eq.${project.id}&user_id=eq.${developer.id}`, undefined, lead.token);
  check(!directDelete.ok, 'and a direct delete', `HTTP ${directDelete.status}`);
  const readBack = (await rest('GET', 'projects', `project_members?project_id=eq.${project.id}&select=user_id,project_role`, undefined, developer.token)).json ?? [];
  check(readBack.length === 3 && readBack.find((m) => m.user_id === developer.id)?.project_role === 'developer', 'the roster is still readable and unchanged', `${readBack.length} members`);
  const viaService = await rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: newcomer.id, project_role: 'qa' });
  check(viaService.ok, 'the service role (seed, verifiers) still writes the roster directly');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) await rest('DELETE', 'projects', `task_dependencies?task_id=eq.${t.id}`);
      await rest('DELETE', 'projects', `development_events?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `modules?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `project_members?project_id=eq.${id}`);
    }
  });
}
k.finish();
