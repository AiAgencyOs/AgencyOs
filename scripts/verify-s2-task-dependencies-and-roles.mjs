// ═══════════════════════════════════════════════════════════════════════════
// Round 3b, stream S2 — proven against real Postgres through PostgREST
// (migration 20261009500000):
//   A. R2-1  dependencies are per task: audited add/remove doors, same project,
//            no self / loop, project-role bound, tenancy guards, no direct write
//   B. R2-2  a project role binds task comments, time logs and checklist items
//   C. R2-3  the roster-manager exemption reads the role UNION (a secondary
//            manager role exempts exactly as a primary one)
// Plants its own users, projects and organisation under a marker (the CI database
// has only the seeded owner and organisation) and removes them in a finally.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('round 3b S2: per-task dependencies and project roles on comments, time and checklists', 'zztest-s2');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');
const extra = { orgs: [] };

try {
  const lead = await k.makeUser('delivery_lead');
  const contributor = await k.makeUser('member');
  const observer = await k.makeUser('member');
  const developer = await k.makeUser('member');
  const secondaryLead = await k.makeUser('member'); // primary member, secondary delivery_lead
  const secondaryMember = await k.makeUser('member'); // primary member, secondary member (no manager role)
  const project = await k.makeProject('s2');
  const otherProject = await k.makeProject('s2-other');

  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);
  const mkTask = async (title, fields = {}, proj = project) => {
    const r = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: proj.id, title: `zztest-s2 ${title}`, ...fields });
    const row = one(r);
    if (!row?.id) k.fail(`could not create a task: ${JSON.stringify(r.json)}`);
    return row;
  };
  const roster = async (user, project_role) => {
    const r = await rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: user.id, project_role });
    if (!r.ok) k.fail(`could not add a ${project_role} to the roster: ${JSON.stringify(r.json)}`);
  };
  await roster(contributor, 'contributor');
  await roster(observer, 'observer');
  await roster(developer, 'developer');
  await roster(secondaryLead, 'observer');
  await roster(secondaryMember, 'observer');
  for (const [user, role] of [[secondaryLead, 'delivery_lead'], [secondaryMember, 'member']]) {
    const m = one(await rest('GET', 'core', `memberships?user_id=eq.${user.id}&select=id`));
    const g = await rest('POST', 'core', 'membership_roles', { organization_id: ORG, membership_id: m?.id, role });
    if (!g.ok) k.fail(`could not grant the secondary ${role}: ${JSON.stringify(g.json)}`);
  }

  // ── A. per-task dependencies ─────────────────────────────────────────────
  section('A. a task depends on its own tasks');
  const a = await mkTask('a', { assignee_id: developer.id });
  const b = await mkTask('b');
  const c = await mkTask('c');
  const foreign = await mkTask('other project', {}, otherProject);
  const add = (task, on, token) => projects('add_task_dependency', { p_task_id: task.id, p_depends_on_task_id: on.id }, token);
  const remove = (task, on, token) => projects('remove_task_dependency', { p_task_id: task.id, p_depends_on_task_id: on.id }, token);
  const outcome = async (promise) => one(await promise)?.outcome;

  check((await outcome(add(a, b, developer.token))) === 'added', 'a developer adds "a waits for b"');
  check((await outcome(add(a, b, developer.token))) === 'already', 'the same dependency is not added twice');
  check((await outcome(add(a, a, developer.token))) === 'itself', 'a task cannot wait for itself');
  check((await outcome(add(a, foreign, developer.token))) === 'other_project', 'nor for a task of another project');
  check((await outcome(add(b, a, developer.token))) === 'cycle', 'two tasks cannot wait for each other');
  check((await outcome(add(b, c, developer.token))) === 'added', '"b waits for c" is added');
  check((await outcome(add(c, a, developer.token))) === 'cycle', 'a longer loop (c, a, b, c) is refused too');
  check((await outcome(add(a, { id: randomUUID() }, developer.token))) === 'not_found', 'an unknown task is not found');

  const bound = await outcome(add(c, a, observer.token));
  check(bound === 'project_role_observer_read_only', 'an observer cannot add a dependency', bound);
  check((await outcome(add(b, c, contributor.token))) === 'project_role_contributor_own_tasks', 'a contributor cannot touch the dependencies of a task that is not theirs');
  check((await outcome(remove(a, b, observer.token))) === 'project_role_observer_read_only', 'nor can an observer remove one');
  check((await outcome(remove(a, c, developer.token))) === 'not_found', 'removing a dependency that does not exist says so');

  const direct = await rest('POST', 'projects', 'task_dependencies', { organization_id: ORG, task_id: c.id, depends_on_task_id: b.id }, developer.token);
  check(!direct.ok, 'a direct write is refused: the doors are the only way in', `HTTP ${direct.status}`);
  const reader = await rest('GET', 'projects', `task_dependencies?task_id=eq.${a.id}&select=depends_on_task_id`, undefined, observer.token);
  check(reader.ok && reader.json.length === 1 && reader.json[0].depends_on_task_id === b.id, 'an internal reader sees the dependency');

  const direct2 = await rest('POST', 'projects', 'task_dependencies', { organization_id: ORG, task_id: foreign.id, depends_on_task_id: a.id });
  check(said(direct2, 'task_dependency_other_project'), 'even a system writer cannot cross projects (trigger)', JSON.stringify(direct2.json).slice(0, 90));
  const direct3 = await rest('POST', 'projects', 'task_dependencies', { organization_id: ORG, task_id: c.id, depends_on_task_id: a.id });
  check(said(direct3, 'task_dependency_cycle'), 'nor close a loop (trigger)');
  const org2 = one(await rest('POST', 'core', 'organizations', { name: `zztest-s2 ${randomUUID().slice(0, 6)}`, slug: `zztest-s2-${randomUUID().slice(0, 8)}` }));
  if (!org2?.id) k.fail(`could not create the fixture organisation: ${JSON.stringify(org2)}`);
  extra.orgs.push(org2.id);
  const crossOrg = await rest('POST', 'projects', 'task_dependencies', { organization_id: org2.id, task_id: c.id, depends_on_task_id: b.id });
  check(!crossOrg.ok, 'a row cannot name tasks of another organisation', JSON.stringify(crossOrg.json).slice(0, 90));
  const moved = await rest('PATCH', 'projects', `task_dependencies?task_id=eq.${a.id}`, { organization_id: org2.id });
  check(!moved.ok, 'a row cannot be moved to another organisation');

  check((await outcome(remove(a, b, developer.token))) === 'removed', 'the developer removes "a waits for b"');
  const audits = (await rest('GET', 'audit', `audit_log?subject_id=eq.${a.id}&action=like.task.dependency_*&select=action,after`)).json ?? [];
  check(audits.some((r) => r.action === 'task.dependency_added' && r.after?.dependsOnTaskId === b.id) && audits.some((r) => r.action === 'task.dependency_removed'), 'the add and the remove are audited', audits.map((r) => r.action).join(' · '));
  // b still waits for c; deleting c takes the dependency with it.
  await rest('DELETE', 'projects', `tasks?id=eq.${c.id}`);
  const left = (await rest('GET', 'projects', `task_dependencies?task_id=eq.${b.id}&select=id`)).json ?? [];
  check(left.length === 0, 'deleting a task removes the dependencies that named it');

  // ── B. a project role binds comments, time logs and checklists ───────────
  section('B. observer read-only, contributor own tasks, on comments, time and checklists');
  const mine = await mkTask('contributor own', { assignee_id: contributor.id });
  const theirs = await mkTask('somebody else', { assignee_id: developer.id });
  const comment = (task, user) => rest('POST', 'projects', 'task_comments', { organization_id: ORG, task_id: task.id, author_id: user.id, body: 'zztest-s2 note' }, user.token);
  const timeLog = (task, user) => rest('POST', 'projects', 'time_logs', { organization_id: ORG, project_id: project.id, task_id: task.id, person_id: user.id, hours: 1, logged_on: '2026-10-01' }, user.token);
  const item = (task, user) => rest('POST', 'projects', 'task_checklist_items', { organization_id: ORG, task_id: task.id, label: 'zztest-s2 step' }, user.token);

  for (const [label, fn] of [['a comment', comment], ['a time entry', timeLog], ['a checklist item', item]]) {
    check(said(await fn(theirs, observer), 'project_role_observer_read_only'), `an observer cannot add ${label}`);
    check(said(await fn(theirs, contributor), 'project_role_contributor_own_tasks'), `a contributor cannot add ${label} to a task that is not theirs`);
    check((await fn(mine, contributor)).ok, `a contributor adds ${label} to their own task`);
    check((await fn(theirs, developer)).ok, `a developer on the roster is governed by the agency role: ${label} is fine`);
    check((await fn(theirs, lead)).ok, `a delivery lead adds ${label} to anyone's task`);
  }
  const ownLog = one(await timeLog(mine, contributor));
  const edited = await rest('PATCH', 'projects', `time_logs?id=eq.${ownLog.id}`, { hours: 2 }, observer.token);
  check(!edited.ok || (Array.isArray(edited.json) && edited.json.length === 0), 'an observer cannot edit a time entry that is not theirs');
  const ownEdit = await rest('PATCH', 'projects', `time_logs?id=eq.${ownLog.id}`, { hours: 3 }, contributor.token);
  check(ownEdit.ok && one(ownEdit)?.hours === 3, 'a contributor edits their own time entry on their own task');
  const strays = (await rest('GET', 'projects', `time_logs?task_id=eq.${theirs.id}&person_id=in.(${observer.id},${contributor.id})&select=id`)).json ?? [];
  // The observer's own entry on a task that is theirs-by-assignment is refused too.
  const observed = await mkTask('observer assigned', { assignee_id: observer.id });
  check(said(await timeLog(observed, observer), 'project_role_observer_read_only'), 'an observer cannot log time even on a task assigned to them');
  const cl = one(await rest('GET', 'projects', `task_checklist_items?task_id=eq.${theirs.id}&select=id&limit=1`));
  const tick = (user) => rest('PATCH', 'projects', `task_checklist_items?id=eq.${cl.id}`, { done_at: new Date().toISOString(), done_by: user.id }, user.token);
  check(said(await tick(observer), 'project_role_observer_read_only'), 'an observer cannot tick a checklist item');
  check(said(await tick(contributor), 'project_role_contributor_own_tasks'), 'a contributor cannot tick one on a task that is not theirs');
  const del = await rest('DELETE', 'projects', `task_checklist_items?id=eq.${cl.id}`, undefined, observer.token);
  check(said(del, 'project_role_observer_read_only') || (Array.isArray(del.json) && del.json.length === 0), 'an observer cannot remove one');
  check(strays.length === 0, 'the refused writes left no stray rows');
  const system = await rest('POST', 'projects', 'task_comments', { organization_id: ORG, task_id: theirs.id, body: 'zztest-s2 system note' });
  check(system.ok, 'a system writer (no person) is not bound by the roster');

  // ── C. the exemption reads the role union ────────────────────────────────
  section('C. a manager role held only as a secondary role exempts like a primary one');
  for (const [label, fn] of [['a comment', comment], ['a time entry', timeLog], ['a checklist item', item]]) {
    const r = await fn(theirs, secondaryLead);
    check(r.ok, `a member who is secondary delivery lead, listed as an observer, adds ${label}`, JSON.stringify(r.json).slice(0, 90));
    check(said(await fn(theirs, secondaryMember), 'project_role_observer_read_only'), `while a member whose secondary role is only member is still bound (${label})`);
  }
  const taskEdit = await rest('PATCH', 'projects', `tasks?id=eq.${theirs.id}`, { title: 'zztest-s2 edited by the secondary lead' }, secondaryLead.token);
  check(taskEdit.ok && one(taskEdit)?.id === theirs.id, 'the secondary delivery lead also edits a task');
  const dep = await outcome(add(theirs, mine, secondaryLead.token));
  check(dep === 'added', 'and adds a dependency, as the service would allow', dep);
  check((await outcome(add(mine, theirs, secondaryMember.token))) === 'project_role_observer_read_only', 'the secondary member does not');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) {
        await rest('DELETE', 'projects', `task_dependencies?task_id=eq.${t.id}`);
        await rest('DELETE', 'projects', `task_comments?task_id=eq.${t.id}`);
        await rest('DELETE', 'projects', `task_checklist_items?task_id=eq.${t.id}`);
        await rest('DELETE', 'projects', `time_logs?task_id=eq.${t.id}`);
      }
      await rest('DELETE', 'projects', `project_members?project_id=eq.${id}`);
    }
    for (const id of extra.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
  });
}
k.finish();
