// ═══════════════════════════════════════════════════════════════════════════
// Round 3e, stream V1 — proven against real Postgres through PostgREST
// (migration 20261009800000):
//   A. U1-1  an archived task is read-only: its status, fields, comments, time
//            logs, checklist items, attachments, evidence and dependencies (on it
//            and pointing at it) cannot change, even for a roster manager,
//            until it is unarchived; unarchive is the one move it accepts
//   B. U1-2  cancelling needs a non-empty reason (kept on the task and in the
//            audit row); the assignee is told (event task.cancelled and the
//            inbox read door), unless there is no assignee or the assignee
//            cancelled it themselves
//   C. U1-3  a roster change through a door writes ONE audit row; a direct
//            service-role write keeps the table trigger's row
// Plants its own users and projects under a marker (the CI database has only the
// seeded owner and organisation) and removes them in a finally.
// ═══════════════════════════════════════════════════════════════════════════

import { ORG, startKit } from './verify-kit-r1.mjs';

const k = await startKit('round 3e V1: archived tasks are read-only, a cancel says why, a roster change is audited once', 'zztest-v1');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');

try {
  const lead = await k.makeUser('delivery_lead');
  const developer = await k.makeUser('member');
  const newcomer = await k.makeUser('member');
  const project = await k.makeProject('v1');

  const said = (r, code) => !r.ok && JSON.stringify(r.json).includes(code);
  const refused = (r) => said(r, 'task_archived_read_only');
  const outcome = async (promise) => one(await promise)?.outcome;
  const mkTask = async (title, fields = {}) => {
    const row = one(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `zztest-v1 ${title}`, ...fields }));
    if (!row?.id) k.fail(`could not create a task: ${title}`);
    return row;
  };
  const audits = async (subjectId, like) => ((await rest('GET', 'audit', `audit_log?subject_id=eq.${subjectId}&action=like.${like}&select=action,after`)).json ?? []);
  const add = (who, role, token) => projects('add_project_member', { p_project_id: project.id, p_user_id: who, p_project_role: role }, token);

  const added = await add(developer.id, 'developer', lead.token);
  if (one(added)?.outcome !== 'added') k.fail(`could not add the developer: ${JSON.stringify(added.json)}`);

  // ── A. an archived task is read-only ─────────────────────────────────────
  section('A. an archived task is read-only until it is unarchived');
  const task = await mkTask('subject', { assignee_id: developer.id });
  const other = await mkTask('other');
  const comment = one(await rest('POST', 'projects', 'task_comments', { organization_id: ORG, task_id: task.id, author_id: lead.id, body: 'zztest-v1 before' }, lead.token));
  const step = one(await rest('POST', 'projects', 'task_checklist_items', { organization_id: ORG, task_id: task.id, label: 'zztest-v1 step' }, lead.token));
  const attachment = one(await rest('POST', 'projects', 'task_attachments', { organization_id: ORG, task_id: task.id, title: 'zztest-v1 link', url: 'https://example.invalid/v1', added_by: lead.id }, lead.token));
  const logged = one(await rest('POST', 'projects', 'time_logs', { organization_id: ORG, project_id: project.id, task_id: task.id, person_id: lead.id, hours: 1, logged_on: '2026-10-01', note: 'zztest-v1' }, lead.token));
  check(Boolean(comment?.id && step?.id && attachment?.id && logged?.id), 'a live task takes a comment, a checklist item, an attachment and a time log');
  check((await outcome(projects('add_task_dependency', { p_task_id: other.id, p_depends_on_task_id: task.id }, lead.token))) === 'added', 'and a dependency pointing at it');

  check((await outcome(projects('set_task_archived', { p_task_id: task.id, p_archived: true }, lead.token))) === 'archived', 'a delivery lead archives it');

  for (const [who, token] of [['a delivery lead', lead.token], ['the assignee', developer.token]]) {
    check(refused(await rest('PATCH', 'projects', `tasks?id=eq.${task.id}`, { status: 'in_progress' }, token)), `${who} cannot change its status`);
    check(refused(await rest('PATCH', 'projects', `tasks?id=eq.${task.id}`, { title: 'zztest-v1 renamed' }, token)), `${who} cannot edit its fields`);
  }
  check(refused(await rest('DELETE', 'projects', `tasks?id=eq.${task.id}`, undefined, lead.token)), 'nor delete it');
  check(refused(await rest('POST', 'projects', 'task_comments', { organization_id: ORG, task_id: task.id, author_id: lead.id, body: 'zztest-v1 after' }, lead.token)), 'a comment cannot be added');
  const edited = await rest('PATCH', 'projects', `task_comments?id=eq.${comment.id}`, { body: 'zztest-v1 edited' }, lead.token);
  check(refused(edited) || (edited.ok && (edited.json ?? []).length === 0), 'nor edited (no policy lets a person edit one, and the trigger refuses it anyway)');
  check(refused(await rest('POST', 'projects', 'task_checklist_items', { organization_id: ORG, task_id: task.id, label: 'zztest-v1 more' }, lead.token)), 'a checklist item cannot be added');
  check(refused(await rest('PATCH', 'projects', `task_checklist_items?id=eq.${step.id}`, { done_at: new Date().toISOString() }, lead.token)), 'nor ticked');
  check(refused(await rest('DELETE', 'projects', `task_checklist_items?id=eq.${step.id}`, undefined, lead.token)), 'nor removed');
  check(refused(await rest('POST', 'projects', 'task_attachments', { organization_id: ORG, task_id: task.id, title: 'zztest-v1 two', url: 'https://example.invalid/two', added_by: lead.id }, lead.token)), 'an attachment cannot be added');
  check(refused(await rest('DELETE', 'projects', `task_attachments?id=eq.${attachment.id}`, undefined, lead.token)), 'nor removed');
  check(refused(await rest('POST', 'projects', 'time_logs', { organization_id: ORG, project_id: project.id, task_id: task.id, person_id: lead.id, hours: 2, logged_on: '2026-10-01' }, lead.token)), 'time cannot be logged');
  check(refused(await rest('DELETE', 'projects', `time_logs?id=eq.${logged.id}`, undefined, lead.token)), 'nor a time log removed');
  const evidence = await projects('submit_task_evidence', { p_task_id: task.id, p_kind: 'test', p_title: 'zztest-v1 suite', p_note: 'green' }, developer.token);
  check(refused(evidence), 'evidence cannot be submitted');
  check(refused(await rest('PATCH', 'projects', `task_dependencies?depends_on_task_id=eq.${task.id}`, { created_by: lead.id }, lead.token)) || (await outcome(projects('remove_task_dependency', { p_task_id: other.id, p_depends_on_task_id: task.id }, lead.token))) === 'task_archived_read_only', 'a dependency pointing at it cannot be removed');
  check((await outcome(projects('add_task_dependency', { p_task_id: task.id, p_depends_on_task_id: other.id }, lead.token))) === 'task_archived_read_only', 'a dependency on it cannot be added');
  check((await outcome(projects('add_task_dependency', { p_task_id: other.id, p_depends_on_task_id: task.id }, lead.token))) === 'task_archived_read_only', 'nor one pointing at it');
  check((await outcome(projects('start_task', { p_task_id: task.id }, developer.token))) === 'wrong_state', 'Start Task does not start it');
  check((await rest('GET', 'projects', `task_comments?task_id=eq.${task.id}&select=body`, undefined, developer.token)).json?.[0]?.body === 'zztest-v1 before', 'its content is still readable and unchanged');

  // The one move it accepts: unarchive, by a roster manager, with nothing else changing.
  check((await outcome(projects('set_task_archived', { p_task_id: task.id, p_archived: false }, developer.token))) === 'forbidden', 'a developer cannot restore it');
  const mixed = await rest('PATCH', 'projects', `tasks?id=eq.${task.id}`, { archived_at: null, title: 'zztest-v1 sneaked' }, lead.token);
  check(refused(mixed), 'a restore that also changes a field is refused');
  check((await outcome(projects('set_task_archived', { p_task_id: task.id, p_archived: false }, lead.token))) === 'unarchived', 'a delivery lead restores it');
  check((await rest('PATCH', 'projects', `tasks?id=eq.${task.id}`, { title: 'zztest-v1 renamed' }, lead.token)).ok, 'and then it can be edited again');
  check((await rest('POST', 'projects', 'task_comments', { organization_id: ORG, task_id: task.id, author_id: lead.id, body: 'zztest-v1 after restore' }, lead.token)).ok, 'and commented on');
  // V1-1: nothing is added under an archived task, by the door or by a direct insert.
  check((await outcome(projects('add_subtask', { p_parent_id: other.id, p_title: 'zztest-v1 sub' }, lead.token))) === 'added', 'a live task takes a subtask through the door');
  check((await outcome(projects('set_task_archived', { p_task_id: other.id, p_archived: true }, lead.token))) === 'archived', 'a lead archives the parent');
  check((await outcome(projects('add_subtask', { p_parent_id: other.id, p_title: 'zztest-v1 sub two' }, lead.token))) === 'task_archived_read_only', 'the door refuses a subtask under an archived task');
  check(refused(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, parent_task_id: other.id, title: 'zztest-v1 sub three' }, lead.token)), 'and so does a direct insert by a person');
  check((await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, parent_task_id: other.id, title: 'zztest-v1 sub by system' })).ok, 'a system writer is not bound');
  await projects('set_task_archived', { p_task_id: other.id, p_archived: false }, lead.token);
  check((await outcome(projects('add_subtask', { p_parent_id: other.id, p_title: 'zztest-v1 sub four' }, lead.token))) === 'added', 'after a restore a subtask can be added again');
  await projects('set_task_archived', { p_task_id: other.id, p_archived: true }, lead.token);
  // The service role (seed, verifiers, the runner) is not bound.
  check((await rest('PATCH', 'projects', `tasks?id=eq.${other.id}`, { description: 'zztest-v1 by the service' })).ok, 'a system writer (service role) is not bound');

  // ── B. a cancel says why; the assignee is told ───────────────────────────
  section('B. cancelling needs a reason, keeps it, and tells the assignee');
  const mine = await mkTask('cancel me', { assignee_id: developer.id });
  const noReason = await rest('PATCH', 'projects', `tasks?id=eq.${mine.id}`, { status: 'cancelled' }, lead.token);
  check(said(noReason, 'task_cancel_requires_reason'), 'a cancel without a reason is refused');
  check(said(await rest('PATCH', 'projects', `tasks?id=eq.${mine.id}`, { status: 'cancelled', cancel_reason: '   ' }, lead.token), 'task_cancel_requires_reason'), 'a blank reason is refused');
  check(said(await rest('PATCH', 'projects', `tasks?id=eq.${mine.id}`, { status: 'cancelled' }), 'task_cancel_requires_reason'), 'even a system writer cannot cancel without one');
  check(one(await rest('GET', 'projects', `tasks?id=eq.${mine.id}&select=status`))?.status === 'todo', 'nothing changed');
  const cancelled = await rest('PATCH', 'projects', `tasks?id=eq.${mine.id}`, { status: 'cancelled', cancel_reason: '  Client dropped the feature  ' }, lead.token);
  check(cancelled.ok && one(cancelled)?.cancel_reason === 'Client dropped the feature', 'a cancel with a reason is kept (trimmed) on the task');
  const trail = (await audits(mine.id, 'task.cancelled')).filter((a) => a.after?.cancel_reason === 'Client dropped the feature');
  check(trail.length === 1, 'and in the audit row', `${trail.length} row(s)`);
  const events = (await rest('GET', 'core', `outbox_events?subject_id=eq.${mine.id}&type=eq.task.cancelled&select=payload`)).json ?? [];
  check(events.length === 1 && events[0].payload?.assigneeId === developer.id && events[0].payload?.reason === 'Client dropped the feature', 'task.cancelled is emitted for the assignee', JSON.stringify(events[0]?.payload));
  const inbox = (await projects('task_cancellations', {}, developer.token)).json ?? [];
  const told = inbox.find((r) => r.task_id === mine.id);
  check(Boolean(told) && told.reason === 'Client dropped the feature', 'the assignee\'s inbox lists it with the reason', JSON.stringify(told));
  check(((await projects('task_cancellations', {}, lead.token)).json ?? []).every((r) => r.task_id !== mine.id), 'the person who cancelled it is not told');

  check((await rest('PATCH', 'projects', `tasks?id=eq.${mine.id}`, { status: 'todo' }, lead.token)).ok, 'a roster manager reopens it');
  check(one(await rest('GET', 'projects', `tasks?id=eq.${mine.id}&select=cancel_reason`))?.cancel_reason === null, 'and the reason is cleared');

  const own = await mkTask('own cancel', { assignee_id: developer.id });
  check((await rest('PATCH', 'projects', `tasks?id=eq.${own.id}`, { status: 'cancelled', cancel_reason: 'No longer needed' }, developer.token)).ok, 'the assignee cancels their own task with a reason');
  check(((await rest('GET', 'core', `outbox_events?subject_id=eq.${own.id}&type=eq.task.cancelled&select=id`)).json ?? []).length === 0, 'and is not sent an event about it');
  const nobody = await mkTask('no assignee');
  check((await rest('PATCH', 'projects', `tasks?id=eq.${nobody.id}`, { status: 'cancelled', cancel_reason: 'Duplicate' }, lead.token)).ok, 'a task with no assignee cancels');
  check(((await rest('GET', 'core', `outbox_events?subject_id=eq.${nobody.id}&type=eq.task.cancelled&select=id`)).json ?? []).length === 0, 'and emits no event');
  // A cancelled task is archived and restored without being asked for the reason again.
  check((await outcome(projects('set_task_archived', { p_task_id: nobody.id, p_archived: true }, lead.token))) === 'archived', 'a cancelled task can be archived');
  check((await outcome(projects('set_task_archived', { p_task_id: nobody.id, p_archived: false }, lead.token))) === 'unarchived', 'and restored');

  // ── C. a roster change through a door is audited once ────────────────────
  section('C. a roster change through a door writes one audit row');
  const addedMember = await add(newcomer.id, 'qa', lead.token);
  const memberId = one(addedMember)?.member_id;
  check(one(addedMember)?.outcome === 'added' && Boolean(memberId), 'a delivery lead adds a person');
  const sinceAdd = await audits(project.id, 'project.member_%');
  const rowsFor = async (like) => ((await rest('GET', 'audit', `audit_log?subject_id=eq.${memberId}&action=like.${like}&select=action`)).json ?? []).length;
  check(sinceAdd.filter((a) => a.action === 'project.member_added').length === 2, 'the door wrote its row (one per added person)');
  check((await rowsFor('project_member.%')) === 0, 'and the table trigger wrote none');
  await projects('change_project_member_role', { p_member_id: memberId, p_project_role: 'designer' }, lead.token);
  check((await rowsFor('project_member.%')) === 0, 'a role change writes no trigger row either');
  check((await audits(project.id, 'project.member_role_changed')).length === 1, 'only the door\'s project.member_role_changed');
  await projects('remove_project_member', { p_member_id: memberId }, lead.token);
  check((await rowsFor('project_member.%')) === 0, 'nor does a removal');
  check((await audits(project.id, 'project.member_removed')).length === 1, 'only the door\'s project.member_removed');

  const direct = one(await rest('POST', 'projects', 'project_members', { organization_id: ORG, project_id: project.id, user_id: newcomer.id, project_role: 'qa' }));
  check(Boolean(direct?.id), 'a direct service-role insert works');
  check((await ((async () => ((await rest('GET', 'audit', `audit_log?subject_id=eq.${direct.id}&action=eq.project_member.added&select=action`)).json ?? []).length)())) === 1, 'and keeps the trigger\'s project_member.added row');
  await rest('PATCH', 'projects', `project_members?id=eq.${direct.id}`, { project_role: 'observer' });
  check(((await rest('GET', 'audit', `audit_log?subject_id=eq.${direct.id}&action=eq.project_member.role_set&select=action`)).json ?? []).length === 1, 'a direct update keeps project_member.role_set');
  // A door right after must not leave the flag behind: a direct write in a later request is still audited (separate transactions).
  check((await outcome(projects('change_project_member_role', { p_member_id: direct.id, p_project_role: 'qa' }, lead.token))) === 'changed', 'a door call on the same row still works');
  await rest('PATCH', 'projects', `project_members?id=eq.${direct.id}`, { project_role: 'designer' });
  check(((await rest('GET', 'audit', `audit_log?subject_id=eq.${direct.id}&action=eq.project_member.role_set&select=action`)).json ?? []).length === 2, 'and a later direct write is audited again');
} finally {
  await k.cleanup(async () => {
    for (const id of k.created.projects) {
      const tasks = await rest('GET', 'projects', `tasks?project_id=eq.${id}&select=id`);
      for (const t of Array.isArray(tasks.json) ? tasks.json : []) await rest('DELETE', 'projects', `task_dependencies?task_id=eq.${t.id}`);
      await rest('DELETE', 'projects', `project_members?project_id=eq.${id}`);
    }
  });
}
k.finish();
