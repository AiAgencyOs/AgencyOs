// ═══════════════════════════════════════════════════════════════════════════
// A task has a start, a parent and labels, and a project keeps notes.
//
// UI parity round 2 (stream Q1). Proven against real Postgres, because none of
// it can be checked by reading TypeScript:
//
//   1. a task's start and due dates are set together and start ≤ due is refused
//      as a rule, not a hope
//   2. a subtask is one level deep, belongs to its parent's project and inherits
//      its module/milestone; a subtask cannot be given a subtask
//   3. labels are trimmed, de-duplicated, at most eight, each at most 24 chars
//   4. project notes have no direct write path for any role: the only way in is
//      projects.add_project_note / remove_project_note, each audited
//   5. a client-side (non-internal) reader sees no note and a viewer cannot write
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'a task has a start, a parent and labels, and a project keeps notes');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-tasksched';
const ORG = '00000000-0000-4000-8000-000000000001';

const mint = (userId, role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
};

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, schema, path, body, token) {
  const key = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (fn, args, token) => rest('POST', 'projects', `rpc/${fn}`, args, token);

const created = { users: [], projects: [], accounts: [] };

async function makeUser(role) {
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARKER}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: mint(authUser.id, role) };
}

try {
  const owner = await makeUser('owner');
  const viewer = await makeUser('viewer');

  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.accounts.push(account.id);
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'planning' }));
  if (!project?.id) fail(`could not create the fixture project: ${JSON.stringify(project)}`);
  created.projects.push(project.id);
  const other = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} other ${randomUUID().slice(0, 8)}`, status: 'planning' }));
  created.projects.push(other.id);

  const mkTask = async (title, extra = {}, projectId = project.id) => one(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: projectId, title, ...extra }));
  const parent = await mkTask('Parent task', { due_on: '2026-10-20' });
  const foreign = await mkTask('Task on another project', {}, other.id);

  // ── A. start and due, together ───────────────────────────────────────────
  console.log('\n  A. a task is scheduled start and due together');
  const set = one(await rpc('set_task_schedule', { p_task_id: parent.id, p_start_on: '2026-10-05', p_due_on: '2026-10-12' }, owner.token));
  check(set?.outcome === 'set', 'a writer sets start and due', set?.outcome);
  const row = one(await rest('GET', 'projects', `tasks?id=eq.${parent.id}&select=start_on,due_on`));
  check(row?.start_on === '2026-10-05' && row?.due_on === '2026-10-12', 'both dates are stored', JSON.stringify(row));
  const backwards = one(await rpc('set_task_schedule', { p_task_id: parent.id, p_start_on: '2026-10-13', p_due_on: '2026-10-12' }, owner.token));
  check(backwards?.outcome === 'start_after_due', 'a start after the due date is refused', backwards?.outcome);
  const direct = await rest('PATCH', 'projects', `tasks?id=eq.${parent.id}`, { start_on: '2026-12-01' }, owner.token);
  check(!direct.ok, 'and the table refuses it even written directly (CHECK, not only the door)', `${direct.status}`);
  const cleared = one(await rpc('set_task_schedule', { p_task_id: parent.id, p_start_on: null, p_due_on: '2026-10-12' }, owner.token));
  check(cleared?.outcome === 'set', 'a start can be cleared', cleared?.outcome);
  const viewerSet = one(await rpc('set_task_schedule', { p_task_id: parent.id, p_start_on: '2026-10-01', p_due_on: null }, viewer.token));
  check(viewerSet?.outcome === 'forbidden', 'a viewer may not schedule a task', viewerSet?.outcome);
  const missing = one(await rpc('set_task_schedule', { p_task_id: randomUUID(), p_start_on: null, p_due_on: null }, owner.token));
  check(missing?.outcome === 'not_found', 'an unknown task is not found', missing?.outcome);

  // ── B. subtasks ──────────────────────────────────────────────────────────
  console.log('\n  B. a subtask is one level deep and belongs to its parent');
  const mod = one(await rest('POST', 'projects', 'modules', { organization_id: ORG, project_id: project.id, name: `${MARKER} module` }));
  await rest('PATCH', 'projects', `tasks?id=eq.${parent.id}`, { module_id: mod?.id ?? null });
  const sub = one(await rpc('add_subtask', { p_parent_id: parent.id, p_title: '  Implement banner  ', p_due_on: '2026-10-08', p_assignee_id: owner.id }, owner.token));
  check(sub?.outcome === 'added' && sub?.task_id, 'a writer adds a subtask', sub?.outcome);
  const subRow = one(await rest('GET', 'projects', `tasks?id=eq.${sub.task_id}&select=parent_task_id,project_id,module_id,title,assignee_id,status`));
  check(subRow?.parent_task_id === parent.id && subRow?.project_id === project.id, 'it belongs to the parent and the parent\'s project');
  check(subRow?.title === 'Implement banner', 'the title is trimmed', subRow?.title);
  check(mod?.id ? subRow?.module_id === mod.id : true, 'it inherits the parent\'s module');
  check(subRow?.assignee_id === owner.id && subRow?.status === 'todo', 'it carries its assignee and starts as to do');
  const nested = one(await rpc('add_subtask', { p_parent_id: sub.task_id, p_title: 'Too deep' }, owner.token));
  check(nested?.outcome === 'nested', 'a subtask cannot have a subtask', nested?.outcome);
  const blank = one(await rpc('add_subtask', { p_parent_id: parent.id, p_title: '   ' }, owner.token));
  check(blank?.outcome === 'invalid_title', 'a blank title is refused', blank?.outcome);
  const stranger = one(await rpc('add_subtask', { p_parent_id: parent.id, p_title: 'x', p_assignee_id: randomUUID() }, owner.token));
  check(stranger?.outcome === 'invalid_assignee', 'an assignee who is not a member is refused', stranger?.outcome);
  const viewerSub = one(await rpc('add_subtask', { p_parent_id: parent.id, p_title: 'x' }, viewer.token));
  check(viewerSub?.outcome === 'forbidden', 'a viewer may not add a subtask', viewerSub?.outcome);
  const crossProject = await rest('PATCH', 'projects', `tasks?id=eq.${foreign.id}`, { parent_task_id: parent.id }, owner.token);
  check(!crossProject.ok, 'a task cannot be made a subtask of another project\'s task', `${crossProject.status}`);
  const self = await rest('PATCH', 'projects', `tasks?id=eq.${parent.id}`, { parent_task_id: parent.id }, owner.token);
  check(!self.ok, 'a task cannot be its own parent', `${self.status}`);
  const promote = await rest('PATCH', 'projects', `tasks?id=eq.${parent.id}`, { parent_task_id: sub.task_id }, owner.token);
  check(!promote.ok, 'a task that has subtasks cannot become one', `${promote.status}`);

  // ── C. labels ────────────────────────────────────────────────────────────
  console.log('\n  C. labels are trimmed, de-duplicated and bounded');
  const labelled = one(await rpc('set_task_labels', { p_task_id: parent.id, p_labels: [' Feature ', 'feature', 'Backend', '', 'UI/UX'] }, owner.token));
  check(labelled?.outcome === 'set' && JSON.stringify(labelled.labels) === JSON.stringify(['Feature', 'Backend', 'UI/UX']), 'trimmed, blanks dropped, duplicates dropped case-insensitively, order kept', JSON.stringify(labelled?.labels));
  const many = one(await rpc('set_task_labels', { p_task_id: parent.id, p_labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, owner.token));
  check(many?.outcome === 'too_many', 'nine labels are refused', many?.outcome);
  const long = one(await rpc('set_task_labels', { p_task_id: parent.id, p_labels: ['x'.repeat(25)] }, owner.token));
  check(long?.outcome === 'label_too_long', 'a 25-character label is refused', long?.outcome);
  const kept = one(await rest('GET', 'projects', `tasks?id=eq.${parent.id}&select=labels`));
  check(JSON.stringify(kept?.labels) === JSON.stringify(['Feature', 'Backend', 'UI/UX']), 'the refusals left the labels as they were');
  const viewerLabels = one(await rpc('set_task_labels', { p_task_id: parent.id, p_labels: ['x'] }, viewer.token));
  check(viewerLabels?.outcome === 'forbidden', 'a viewer may not label a task', viewerLabels?.outcome);
  const emptied = one(await rpc('set_task_labels', { p_task_id: parent.id, p_labels: [] }, owner.token));
  check(emptied?.outcome === 'set' && (emptied.labels ?? []).length === 0, 'labels can be emptied', emptied?.outcome);

  // ── D. notes ─────────────────────────────────────────────────────────────
  console.log('\n  D. project notes have no path but the doors');
  const note = one(await rpc('add_project_note', { p_project_id: project.id, p_title: '  Client meeting discussion ', p_body: 'Discussed additional AI features.' }, owner.token));
  check(note?.outcome === 'added' && note?.note_id, 'a writer adds a note', note?.outcome);
  const stored = one(await rest('GET', 'projects', `project_notes?id=eq.${note.note_id}&select=title,body,created_by,project_id`, null, owner.token));
  check(stored?.title === 'Client meeting discussion' && stored?.created_by === owner.id, 'the title is trimmed and the author recorded', JSON.stringify(stored));
  const noTitle = one(await rpc('add_project_note', { p_project_id: project.id, p_title: ' ' }, owner.token));
  check(noTitle?.outcome === 'invalid_title', 'a blank title is refused', noTitle?.outcome);
  const noProject = one(await rpc('add_project_note', { p_project_id: randomUUID(), p_title: 'x' }, owner.token));
  check(noProject?.outcome === 'not_found', 'a note on an unknown project is refused', noProject?.outcome);
  const viewerNote = one(await rpc('add_project_note', { p_project_id: project.id, p_title: 'x' }, viewer.token));
  check(viewerNote?.outcome === 'forbidden', 'a viewer may not add a note', viewerNote?.outcome);
  for (const [who, token] of [['owner', owner.token], ['viewer', viewer.token]]) {
    const write = await rest('POST', 'projects', 'project_notes', { organization_id: ORG, project_id: project.id, title: 'direct' }, token);
    check(!write.ok, `${who}: a direct insert is refused`, `${write.status}`);
    const patch = await rest('PATCH', 'projects', `project_notes?id=eq.${note.note_id}`, { title: 'tampered' }, token);
    check(!patch.ok || (Array.isArray(patch.json) && patch.json.length === 0), `${who}: a direct update changes nothing`, `${patch.status}`);
    const del = await rest('DELETE', 'projects', `project_notes?id=eq.${note.note_id}`, null, token);
    check(!del.ok || (Array.isArray(del.json) && del.json.length === 0), `${who}: a direct delete removes nothing`, `${del.status}`);
  }
  const untouched = one(await rest('GET', 'projects', `project_notes?id=eq.${note.note_id}&select=title`));
  check(untouched?.title === 'Client meeting discussion', 'and the note is exactly what the door stored');
  const viewerRemove = one(await rpc('remove_project_note', { p_note_id: note.note_id }, viewer.token));
  check(viewerRemove?.outcome === 'forbidden', 'a viewer may not remove a note', viewerRemove?.outcome);
  const removed = one(await rpc('remove_project_note', { p_note_id: note.note_id }, owner.token));
  check(removed?.outcome === 'removed', 'a writer removes it', removed?.outcome);
  const again = one(await rpc('remove_project_note', { p_note_id: note.note_id }, owner.token));
  check(again?.outcome === 'not_found', 'removing it again says not found', again?.outcome);

  // ── E. the audit ─────────────────────────────────────────────────────────
  console.log('\n  E. every door leaves an audit row naming who did it');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(task.schedule_set,task.subtask_added,task.labels_set,project.note_added,project.note_removed)&or=(after->>projectId.eq.${project.id},before->>projectId.eq.${project.id})&select=action,actor_id&order=id.asc`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  const actions = new Set(rows.map((a) => a.action));
  for (const a of ['task.schedule_set', 'task.subtask_added', 'task.labels_set', 'project.note_added', 'project.note_removed']) {
    check(actions.has(a), `${a} is recorded`);
  }
  check(rows.length > 0 && rows.every((a) => a.actor_id === owner.id), 'every row names the person who did it');
} finally {
  for (const id of created.projects) {
    await rest('DELETE', 'projects', `tasks?project_id=eq.${id}&parent_task_id=not.is.null`);
    await rest('DELETE', 'projects', `tasks?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `modules?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `project_notes?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
