// ═══════════════════════════════════════════════════════════════════════════
// A project runs in sprints of a fixed length, and a task sits in one of them.
//
// Owner decision 1, migration 20261005100000. Proven against real Postgres:
//   A. a sprint is a name, a start and 1–60 days; open sprints of a project
//      never overlap; the table has no direct write path for any role
//   B. a task is placed in an open sprint of ITS OWN project, or taken out;
//      the table refuses a foreign sprint even when written directly
//   C. closing keeps the tasks where they are and refuses new placements
//   D. every door is audited and refuses a role that cannot write
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('a project runs in sprints of a fixed length', 'zztest-sprint');
const { check, rest, one, section } = k;
const rpc = k.rpc('projects');

try {
  const owner = await k.makeUser('owner');
  const member = await k.makeUser('member');
  const finance = await k.makeUser('finance');
  const project = await k.makeProject('a');
  const other = await k.makeProject('b');
  const mkTask = async (title, projectId = project.id) => one(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: projectId, title }));

  section('A. a sprint is a start and a length, and open sprints do not overlap');
  const s1 = one(await rpc('create_sprint', { p_project_id: project.id, p_name: '  Sprint 1  ', p_starts_on: '2026-10-05', p_length_days: 14 }, owner.token));
  check(s1?.outcome === 'created' && s1?.sprint_id, 'a writer creates a sprint', s1?.outcome);
  const row = one(await rest('GET', 'projects', `sprints?id=eq.${s1.sprint_id}&select=name,starts_on,length_days,closed_at,project_id`, null, owner.token));
  check(row?.name === 'Sprint 1' && row?.starts_on === '2026-10-05' && row?.length_days === 14 && row?.closed_at === null, 'the name is trimmed and start and length are stored', JSON.stringify(row));
  const overlap = one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'Clash', p_starts_on: '2026-10-18', p_length_days: 7 }, member.token));
  check(overlap?.outcome === 'overlaps', 'a sprint that starts on the last day of an open one is refused', overlap?.outcome);
  const back = one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'Clash before', p_starts_on: '2026-09-28', p_length_days: 8 }, member.token));
  check(back?.outcome === 'overlaps', 'and one that ends on its first day is refused', back?.outcome);
  const next = one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'Sprint 2', p_starts_on: '2026-10-19', p_length_days: 14 }, member.token));
  check(next?.outcome === 'created', 'the day after it ends is fine', next?.outcome);
  const elsewhere = one(await rpc('create_sprint', { p_project_id: other.id, p_name: 'Same dates', p_starts_on: '2026-10-05', p_length_days: 14 }, owner.token));
  check(elsewhere?.outcome === 'created', 'another project may run the same dates', elsewhere?.outcome);
  check(one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'x', p_starts_on: '2027-01-01', p_length_days: 0 }, owner.token))?.outcome === 'invalid_length', 'zero days is refused');
  check(one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'x', p_starts_on: '2027-01-01', p_length_days: 61 }, owner.token))?.outcome === 'invalid_length', 'sixty-one days is refused');
  check(one(await rpc('create_sprint', { p_project_id: project.id, p_name: '   ', p_starts_on: '2027-01-01', p_length_days: 7 }, owner.token))?.outcome === 'invalid_name', 'a blank name is refused');
  check(one(await rpc('create_sprint', { p_project_id: randomUUID(), p_name: 'x', p_starts_on: '2027-01-01', p_length_days: 7 }, owner.token))?.outcome === 'not_found', 'an unknown project is not found');
  check(one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'x', p_starts_on: '2027-01-01', p_length_days: 7 }, finance.token))?.outcome === 'forbidden', 'a role that cannot write tasks may not create a sprint');
  for (const [who, token] of [['owner', owner.token], ['member', member.token]]) {
    const write = await rest('POST', 'projects', 'sprints', { organization_id: ORG, project_id: project.id, name: 'direct', starts_on: '2027-02-01', length_days: 7 }, token);
    check(!write.ok, `${who}: a direct insert is refused`, `${write.status}`);
    const patch = await rest('PATCH', 'projects', `sprints?id=eq.${s1.sprint_id}`, { length_days: 30 }, token);
    check(!patch.ok || (Array.isArray(patch.json) && patch.json.length === 0), `${who}: a direct update changes nothing`, `${patch.status}`);
  }

  section('B. a task is placed in an open sprint of its own project');
  const t1 = await mkTask('Task one');
  const t2 = await mkTask('Task two');
  const foreign = await mkTask('Task on the other project', other.id);
  const placed = one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: s1.sprint_id }, member.token));
  check(placed?.outcome === 'placed', 'a writer places a task', placed?.outcome);
  await rpc('place_task_in_sprint', { p_task_id: t2.id, p_sprint_id: s1.sprint_id }, member.token);
  check(one(await rest('GET', 'projects', `tasks?id=eq.${t1.id}&select=sprint_id`))?.sprint_id === s1.sprint_id, 'the task carries the sprint');
  check(one(await rpc('place_task_in_sprint', { p_task_id: foreign.id, p_sprint_id: s1.sprint_id }, member.token))?.outcome === 'other_project', 'a task of another project cannot be placed in it');
  const direct = await rest('PATCH', 'projects', `tasks?id=eq.${foreign.id}`, { sprint_id: s1.sprint_id }, owner.token);
  check(!direct.ok, 'and the table refuses it even written directly (trigger, not only the door)', `${direct.status}`);
  check(one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: randomUUID() }, member.token))?.outcome === 'sprint_not_found', 'an unknown sprint is not found');
  check(one(await rpc('place_task_in_sprint', { p_task_id: randomUUID(), p_sprint_id: s1.sprint_id }, member.token))?.outcome === 'not_found', 'an unknown task is not found');
  check(one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: s1.sprint_id }, finance.token))?.outcome === 'forbidden', 'a role that cannot write tasks may not place one');
  const moved = one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: next.sprint_id }, member.token));
  check(moved?.outcome === 'placed' && one(await rest('GET', 'projects', `tasks?id=eq.${t1.id}&select=sprint_id`))?.sprint_id === next.sprint_id, 'a task is in ONE sprint: placing it again moves it');
  const removed = one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: null }, member.token));
  check(removed?.outcome === 'removed' && one(await rest('GET', 'projects', `tasks?id=eq.${t1.id}&select=sprint_id`))?.sprint_id === null, 'null takes it out of its sprint', removed?.outcome);

  section('C. closing a sprint keeps its tasks and refuses new ones');
  check(one(await rpc('close_sprint', { p_sprint_id: s1.sprint_id }, finance.token))?.outcome === 'forbidden', 'a role that cannot write tasks may not close a sprint');
  const closed = one(await rpc('close_sprint', { p_sprint_id: s1.sprint_id }, member.token));
  check(closed?.outcome === 'closed', 'a writer closes a sprint', closed?.outcome);
  check(one(await rpc('close_sprint', { p_sprint_id: s1.sprint_id }, member.token))?.outcome === 'already_closed', 'closing it again says so');
  check(one(await rest('GET', 'projects', `tasks?id=eq.${t2.id}&select=sprint_id`))?.sprint_id === s1.sprint_id, 'its task stays in it');
  check(one(await rpc('place_task_in_sprint', { p_task_id: t1.id, p_sprint_id: s1.sprint_id }, member.token))?.outcome === 'sprint_closed', 'no task can be placed in a closed sprint');
  const reuse = one(await rpc('create_sprint', { p_project_id: project.id, p_name: 'Reuse the dates', p_starts_on: '2026-10-05', p_length_days: 7 }, owner.token));
  check(reuse?.outcome === 'created', 'a closed sprint no longer blocks its dates', reuse?.outcome);

  section('D. every door leaves an audit row naming who did it');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(sprint.created,sprint.closed,task.sprint_set)&or=(after->>projectId.eq.${project.id},before->>projectId.eq.${project.id})&select=action,actor_id&order=id.asc`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  const actions = new Set(rows.map((a) => a.action));
  for (const a of ['sprint.created', 'sprint.closed', 'task.sprint_set']) check(actions.has(a), `${a} is recorded`);
  check(rows.length > 0 && rows.every((a) => a.actor_id === owner.id || a.actor_id === member.id), 'every row names a person who did it');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      await rest('PATCH', 'projects', `tasks?project_id=eq.${id}`, { sprint_id: null });
      await rest('DELETE', 'projects', `sprints?project_id=eq.${id}`);
    }
  });
}
k.finish();
