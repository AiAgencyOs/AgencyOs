// ═══════════════════════════════════════════════════════════════════════════
// Round 3c, stream T1 — proven against real Postgres through PostgREST
// (migration 20261009600000):
//   A. S2-1  task attachments obey the project role (observer refused, contributor
//            only on a task assigned to them, roster managers exempt by the union)
//   B. S2-2  the roster (project_members) and the default-assignee doors read the
//            role UNION; the project's one default assignee has an audited door
//   C. S2-3  a dependency on a finished task is satisfied, an unfinished one is
//            open, a dependency across projects stays refused
// Plants its own users and projects under a marker (the CI database has only the
// seeded owner and organisation) and removes them in a finally.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('round 3c T1: attachments obey the project role, the roster reads the role union, a finished dependency is satisfied', 'zztest-t1');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');

try {
  const lead = await k.makeUser('delivery_lead');
  const contributor = await k.makeUser('member');
  const observer = await k.makeUser('member');
  const developer = await k.makeUser('member');
  const secondaryLead = await k.makeUser('member'); // primary member, secondary delivery_lead
  const plainMember = await k.makeUser('member'); // primary member, secondary member (no manager role)
  const project = await k.makeProject('t1');
  const otherProject = await k.makeProject('t1-other');

  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);
  const mkTask = async (title, fields = {}, proj = project) => {
    const r = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: proj.id, title: `zztest-t1 ${title}`, ...fields });
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
  await roster(plainMember, 'observer');
  for (const [user, role] of [[secondaryLead, 'delivery_lead'], [plainMember, 'member']]) {
    const m = one(await rest('GET', 'core', `memberships?user_id=eq.${user.id}&select=id`));
    const g = await rest('POST', 'core', 'membership_roles', { organization_id: ORG, membership_id: m?.id, role });
    if (!g.ok) k.fail(`could not grant the secondary ${role}: ${JSON.stringify(g.json)}`);
  }

  // ── A. attachments ───────────────────────────────────────────────────────
  section('A. a project role binds task attachments');
  const mine = await mkTask('contributor own', { assignee_id: contributor.id });
  const theirs = await mkTask('somebody else', { assignee_id: developer.id });
  const attach = (task, user) => rest('POST', 'projects', 'task_attachments', { organization_id: ORG, task_id: task.id, title: 'zztest-t1 spec', url: 'https://example.com/zztest-t1', added_by: user.id }, user.token);

  check(said(await attach(theirs, observer), 'project_role_observer_read_only'), 'an observer cannot attach a link');
  check(said(await attach(mine, observer), 'project_role_observer_read_only'), 'nor to a task assigned to another person');
  check(said(await attach(theirs, contributor), 'project_role_contributor_own_tasks'), 'a contributor cannot attach to a task that is not theirs');
  const own = await attach(mine, contributor);
  check(own.ok, 'a contributor attaches a link to their own task', JSON.stringify(own.json).slice(0, 90));
  check((await attach(theirs, developer)).ok, 'a developer on the roster is governed by the agency role');
  check((await attach(theirs, lead)).ok, 'a delivery lead attaches to anyone\'s task');
  check((await attach(theirs, secondaryLead)).ok, 'a member who is secondary delivery lead (listed as an observer) is exempt by the role union');
  check(said(await attach(theirs, plainMember), 'project_role_observer_read_only'), 'while a member with only a secondary member role is still bound');
  const sys = await rest('POST', 'projects', 'task_attachments', { organization_id: ORG, task_id: theirs.id, title: 'zztest-t1 system', url: 'https://example.com/zztest-t1-sys' });
  check(sys.ok, 'a system writer (no person) is not bound by the roster');

  const row = one(await rest('GET', 'projects', `task_attachments?task_id=eq.${theirs.id}&title=eq.zztest-t1 spec&select=id&limit=1`));
  const edit = await rest('PATCH', 'projects', `task_attachments?id=eq.${row.id}`, { title: 'zztest-t1 renamed' }, observer.token);
  check(said(edit, 'project_role_observer_read_only') || (Array.isArray(edit.json) && edit.json.length === 0), 'an observer cannot rename one');
  const edit2 = await rest('PATCH', 'projects', `task_attachments?id=eq.${row.id}`, { title: 'zztest-t1 renamed' }, contributor.token);
  check(said(edit2, 'project_role_contributor_own_tasks'), 'a contributor cannot rename one on a task that is not theirs');
  const del = await rest('DELETE', 'projects', `task_attachments?id=eq.${row.id}`, undefined, observer.token);
  check(said(del, 'project_role_observer_read_only') || (Array.isArray(del.json) && del.json.length === 0), 'nor remove one');
  const stillThere = (await rest('GET', 'projects', `task_attachments?id=eq.${row.id}&select=id,title`)).json ?? [];
  check(stillThere.length === 1 && stillThere[0].title === 'zztest-t1 spec', 'the refused writes changed nothing');
  const ownDel = await rest('DELETE', 'projects', `task_attachments?id=eq.${one(own)?.id}`, undefined, contributor.token);
  check(ownDel.ok, 'a contributor removes a link from their own task');
  check((await rest('DELETE', 'projects', `task_attachments?id=eq.${row.id}`, undefined, secondaryLead.token)).ok, 'the secondary delivery lead removes one from anyone\'s task');

  // ── B. the roster and default assignees read the role union ──────────────
  section('B. the roster and the default-assignee doors read the role union');
  const outcome = async (promise) => one(await promise)?.outcome;
  const newcomer = await k.makeUser('member');
  const addMember = (user, who) => rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: who.id, project_role: 'qa' }, user.token);
  const refusedAdd = await addMember(plainMember, newcomer);
  check(!refusedAdd.ok, 'a member whose secondary role is only member cannot change the roster', `HTTP ${refusedAdd.status}`);
  const okAdd = await addMember(secondaryLead, newcomer);
  check(okAdd.ok, 'a member who is secondary delivery lead adds a person to the roster', JSON.stringify(okAdd.json).slice(0, 90));
  const moved = await rest('PATCH', 'projects', `project_members?project_id=eq.${project.id}&user_id=eq.${newcomer.id}`, { project_role: 'designer' }, secondaryLead.token);
  check(moved.ok && one(moved)?.project_role === 'designer', 'and changes their project role');
  const gone = await rest('DELETE', 'projects', `project_members?project_id=eq.${project.id}&user_id=eq.${newcomer.id}`, undefined, secondaryLead.token);
  check(gone.ok && one(gone)?.user_id === newcomer.id, 'and removes them');

  const setRole = (role, userId, token) => projects('set_project_default_assignee', { p_project_id: project.id, p_project_role: role, p_user_id: userId }, token);
  check((await outcome(setRole('designer', developer.id, plainMember.token))) === 'forbidden', 'the per-role default door refuses a plain member');
  check((await outcome(setRole('designer', developer.id, secondaryLead.token))) === 'set', 'and admits the secondary delivery lead');
  check((await outcome(setRole('designer', null, secondaryLead.token))) === 'cleared', 'who can also clear it');

  const setFallback = (userId, token) => projects('set_project_fallback_assignee', { p_project_id: project.id, p_user_id: userId }, token);
  check((await outcome(setFallback(developer.id, plainMember.token))) === 'forbidden', 'the project\'s one default assignee is refused to a plain member');
  check((await outcome(setFallback(developer.id, observer.token))) === 'forbidden', 'and to an observer');
  check((await outcome(setFallback(developer.id, secondaryLead.token))) === 'set', 'and set by the secondary delivery lead');
  check(one(await rest('GET', 'projects', `projects?id=eq.${project.id}&select=default_assignee_id`))?.default_assignee_id === developer.id, 'the project now names that default');
  check((await outcome(setFallback(developer.id, lead.token))) === 'set', 'a delivery lead sets it too');
  check((await outcome(projects('set_project_fallback_assignee', { p_project_id: project.id, p_user_id: randomUUID() }, lead.token))) === 'not_internal', 'a stranger cannot be the default');
  check((await outcome(setFallback(null, lead.token))) === 'cleared', 'and it can be cleared');
  const audits = ((await rest('GET', 'audit', `audit_log?subject_id=eq.${project.id}&action=like.project.fallback_assignee_*&select=action`)).json ?? []).map((r) => r.action);
  check(audits.filter((a) => a === 'project.fallback_assignee_set').length === 2 && audits.includes('project.fallback_assignee_cleared'), 'each set and the clear are audited', audits.join(' · '));

  // ── C. a finished dependency is satisfied ────────────────────────────────
  section('C. a done dependency is satisfied; an unfinished one is open; another project stays refused');
  const waiter = await mkTask('waiter');
  const pre = await mkTask('prerequisite');
  const foreign = await mkTask('other project', {}, otherProject);
  check((await outcome(projects('add_task_dependency', { p_task_id: waiter.id, p_depends_on_task_id: pre.id }, developer.token))) === 'added', 'a dependency is added');
  const openCheck = one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token));
  check(openCheck?.open_dependencies === 1 && openCheck?.startable === false, 'an unfinished prerequisite is open', JSON.stringify(openCheck)?.slice(0, 120));
  await rest('PATCH', 'projects', `tasks?id=eq.${pre.id}`, { status: 'in_progress' });
  await projects('submit_task_evidence', { p_task_id: pre.id, p_kind: 'test', p_title: 'zztest-t1 suite', p_note: 'green' }, developer.token);
  await projects('mark_task_ready_for_qa', { p_task_id: pre.id }, developer.token);
  check(one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token))?.open_dependencies === 1, 'a prerequisite in review is still open');
  const finished = await rest('PATCH', 'projects', `tasks?id=eq.${pre.id}`, { status: 'done', completed_at: new Date().toISOString() }, lead.token);
  check(finished.ok, 'the prerequisite is completed from In review', JSON.stringify(finished.json).slice(0, 120));
  check(one(await projects('task_start_check', { p_task_id: waiter.id }, developer.token))?.open_dependencies === 0, 'a done prerequisite is satisfied');
  const cancelled = await rest('PATCH', 'projects', `tasks?id=eq.${pre.id}`, { status: 'cancelled' });
  check(!cancelled.ok, 'tasks have no cancelled status yet (the check admits one the day it exists)', `HTTP ${cancelled.status}`);
  check((await outcome(projects('add_task_dependency', { p_task_id: waiter.id, p_depends_on_task_id: foreign.id }, developer.token))) === 'other_project', 'a dependency across projects is still refused');
  const direct = await rest('POST', 'projects', 'task_dependencies', { organization_id: ORG, task_id: waiter.id, depends_on_task_id: foreign.id });
  check(said(direct, 'task_dependency_other_project'), 'even a system writer cannot cross projects');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) {
        await rest('DELETE', 'projects', `task_dependencies?task_id=eq.${t.id}`);
        await rest('DELETE', 'projects', `task_attachments?task_id=eq.${t.id}`);
      }
      await rest('DELETE', 'projects', `project_default_assignees?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `project_members?project_id=eq.${id}`);
    }
  });
}
k.finish();
