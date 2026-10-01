// ═══════════════════════════════════════════════════════════════════════════
// W2 — projects, tasks, plan: what no TypeScript reading can prove.
//
// Migration 20261006200000. Against real Postgres:
//
//   A. a BLOCKED task keeps a type, an owner and a next action, and they are
//      cleared with the reason when the task leaves blocked; the type is a
//      known vocabulary
//   B. agent-generated work carries a gate: an unverified agent task cannot be
//      moved to done by ANY writer (the trigger), only a person who says what
//      they checked verifies it, and only work marked as agent work needs it
//   C. a "Meetings" folder exists as a category, for files and folders
//   D. a template is cloned through a door (name taken, not found, role)
//   E. the organisation's project defaults: only an owner / ops admin sets
//      them, through the door; nobody writes the table directly; new projects
//      start with the standard folders and existing ones do not
//   F. the project activity feed returns the audit rows of the project and its
//      records to an internal reader, with the actor's name and never a
//      before/after snapshot
//   G. a meeting can be attached to a project only when its lead is reachable
//      from the project's client
//
//   node scripts/verify-w2-projects.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'projects, tasks and plan (W2)');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zzbuild-w2-${randomUUID().slice(0, 8)}`;
const fx = fixturesFor(target, ORG);
const { rest, one } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const door = (token, schema, fn, args) => fx.call(token, 'POST', schema, `rpc/${fn}`, args);
const created = { projects: [], tasks: [], templates: [], meetings: [], leads: [], contacts: [] };

console.log('\n\x1b[1mAgencyOS — W2 projects, tasks and plan\x1b[0m');

let savedDefaults = null;
try {
  const owner = await fx.bootstrapOwner(MARKER);
  const member = fx.mint(owner.id, 'member');
  const finance = fx.mint(owner.id, 'finance');
  const account = one(await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=id&limit=1`));
  const mkProject = async (label, extra = {}) => {
    const p = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} ${label}`, budget_minor: 100000, currency: 'INR', ...extra }));
    if (!p?.id) fail(`fixture: project ${label} could not be created`);
    created.projects.push(p.id);
    return p;
  };
  const mkTask = async (projectId, title, extra = {}) => {
    const t = one(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: projectId, title: `${MARKER} ${title}`, ...extra }));
    if (!t?.id) fail(`fixture: task ${title} could not be created`);
    created.tasks.push(t.id);
    return t;
  };
  const project = await mkProject('project');

  // ── A ───────────────────────────────────────────────────────────────────
  console.log('\nA. A blocked task says what kind of block, who acts and what is next');
  const blocked = await mkTask(project.id, 'blocked', { status: 'blocked', blocked_reason: 'waiting on the client logo', blocker_type: 'client_answer', blocker_owner: 'Priya (client PM)', blocker_next_action: 'Chase the logo on Thursday' });
  const readBlocked = one(await rest('GET', 'projects', `tasks?id=eq.${blocked.id}&select=status,blocker_type,blocker_owner,blocker_next_action,blocked_reason,blocked_at`));
  check(readBlocked?.blocker_type === 'client_answer' && readBlocked.blocker_owner === 'Priya (client PM)' && readBlocked.blocker_next_action === 'Chase the logo on Thursday', 'the blocker type, owner and next action are stored');
  check(Boolean(readBlocked?.blocked_at), 'and the task is stamped with when it was blocked');
  const badType = await rest('PATCH', 'projects', `tasks?id=eq.${blocked.id}`, { blocker_type: 'because' });
  check(!badType.ok, 'a blocker type outside the vocabulary is refused', `${badType.status}`);
  const tooLong = await rest('PATCH', 'projects', `tasks?id=eq.${blocked.id}`, { blocker_owner: 'x'.repeat(200) });
  check(!tooLong.ok, 'an owner longer than 120 characters is refused', `${tooLong.status}`);
  await rest('PATCH', 'projects', `tasks?id=eq.${blocked.id}`, { status: 'in_progress' });
  const cleared = one(await rest('GET', 'projects', `tasks?id=eq.${blocked.id}&select=blocker_type,blocker_owner,blocker_next_action,blocked_reason,blocked_at`));
  check(cleared && Object.values(cleared).every((v) => v === null), 'leaving blocked clears the reason, the type, the owner, the next action and the stamp', JSON.stringify(cleared));

  // ── B ───────────────────────────────────────────────────────────────────
  console.log('\nB. Agent-generated work is not done until somebody verified it');
  // Q-B1: Completed is reached only from In review, so the task waits there for the verification gate.
  const human = await mkTask(project.id, 'human work', { status: 'in_review' });
  const marked = one(await door(owner.token, 'projects', 'mark_task_agent_generated', { p_task_id: human.id, p_agent: true }));
  check(marked?.outcome === 'set', 'a writer marks a task as agent-generated', marked?.outcome);
  check(one(await door(owner.token, 'projects', 'mark_task_agent_generated', { p_task_id: human.id, p_agent: true }))?.outcome === 'unchanged', 'marking it again changes nothing');
  check(one(await door(finance, 'projects', 'mark_task_agent_generated', { p_task_id: human.id, p_agent: false }))?.outcome === 'forbidden', 'a role that cannot write may not change a task’s origin');
  check(one(await door(owner.token, 'projects', 'mark_task_agent_generated', { p_task_id: randomUUID(), p_agent: true }))?.outcome === 'not_found', 'a task that does not exist is not found');
  const tryDone = await rest('PATCH', 'projects', `tasks?id=eq.${human.id}`, { status: 'done', completed_at: new Date().toISOString() });
  check(!tryDone.ok && /agent_task_unverified/.test(tryDone.text), 'an unverified agent task cannot be moved to done, even by the service role', tryDone.text.slice(0, 120));
  const tryDoneOwner = await fx.call(owner.token, 'PATCH', 'projects', `tasks?id=eq.${human.id}`, { status: 'done', completed_at: new Date().toISOString() });
  check(!tryDoneOwner.ok && /agent_task_unverified/.test(tryDoneOwner.text), 'nor by the owner, through PostgREST');
  check(one(await door(owner.token, 'projects', 'verify_agent_task', { p_task_id: human.id, p_note: '   ' }))?.outcome === 'note_required', 'verifying needs a note saying what was checked');
  check(one(await door(finance, 'projects', 'verify_agent_task', { p_task_id: human.id, p_note: 'ran the suite' }))?.outcome === 'forbidden', 'a role that cannot write may not verify');
  check(one(await door(owner.token, 'projects', 'verify_agent_task', { p_task_id: (await mkTask(project.id, 'plain human')).id, p_note: 'x' }))?.outcome === 'not_agent_work', 'only agent work needs verifying');
  const verified = one(await door(owner.token, 'projects', 'verify_agent_task', { p_task_id: human.id, p_note: 'ran the suite, read the diff' }));
  check(verified?.outcome === 'verified', 'a person who says what they checked verifies it', verified?.outcome);
  check(one(await door(owner.token, 'projects', 'verify_agent_task', { p_task_id: human.id, p_note: 'again' }))?.outcome === 'already_verified', 'verifying twice is refused');
  const vrow = one(await rest('GET', 'projects', `tasks?id=eq.${human.id}&select=verified_at,verified_by,verification_note`));
  check(Boolean(vrow?.verified_at) && vrow.verified_by === owner.id && vrow.verification_note === 'ran the suite, read the diff', 'the record names who verified, when, and what they checked');
  const doneNow = await rest('PATCH', 'projects', `tasks?id=eq.${human.id}`, { status: 'done', completed_at: new Date().toISOString() });
  check(doneNow.ok, 'once verified, the task can be completed', `${doneNow.status}`);
  const late = await mkTask(project.id, 'done human', { status: 'done', completed_at: new Date().toISOString() });
  check(one(await door(owner.token, 'projects', 'mark_task_agent_generated', { p_task_id: late.id, p_agent: true }))?.outcome === 'already_done', 'finished human work cannot be re-labelled as agent work to hold it up');
  const bornAgent = await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `${MARKER} born done`, origin: 'agent', status: 'done' });
  if (bornAgent.ok) created.tasks.push(one(bornAgent).id);
  check(!bornAgent.ok, 'an agent task cannot be created already done');
  const audit = await rest('GET', 'audit', `audit_log?subject_id=eq.${human.id}&select=action,actor_id&order=id.asc`);
  const actions = (audit.json ?? []).map((r) => r.action);
  check(actions.includes('task.origin_set') && actions.includes('task.verified'), 'marking and verifying are audited', actions.join(' · '));

  // ── C ───────────────────────────────────────────────────────────────────
  console.log('\nC. A Meetings folder');
  const folder = one(await door(owner.token, 'projects', 'create_project_folder', { p_project_id: project.id, p_category: 'meetings', p_path: 'Minutes' }));
  check(folder?.outcome === 'created', 'a folder can be made in the meetings category', folder?.outcome);
  const fileRow = await rest('POST', 'projects', 'project_files', { organization_id: ORG, project_id: project.id, category: 'meetings', title: `${MARKER} minutes`, url: 'https://files.example/minutes.pdf', folder: 'Minutes' });
  check(fileRow.ok, 'a file can be filed under meetings', `${fileRow.status}`);
  check(one(await door(owner.token, 'projects', 'create_project_folder', { p_project_id: project.id, p_category: 'made_up', p_path: 'x' }))?.outcome === 'invalid_category', 'an unknown category is still refused');

  // ── D ───────────────────────────────────────────────────────────────────
  console.log('\nD. A template is cloned through a door');
  const tpl = one(await rest('POST', 'projects', 'project_templates', { organization_id: ORG, name: `${MARKER} template`, description: 'w2', template_items: { modules: [{ name: 'Core', features: [] }], milestones: [{ name: 'M1', percent: 100 }] } }));
  created.templates.push(tpl.id);
  const cloned = one(await door(owner.token, 'projects', 'clone_project_template', { p_template_id: tpl.id, p_name: `${MARKER} copy` }));
  check(cloned?.outcome === 'cloned' && cloned.template_id, 'the owner clones it under a new name', cloned?.outcome);
  if (cloned?.template_id) created.templates.push(cloned.template_id);
  const copy = one(await rest('GET', 'projects', `project_templates?id=eq.${cloned?.template_id}&select=name,description,template_items,created_by`));
  check(copy?.name === `${MARKER} copy` && copy.template_items?.milestones?.[0]?.name === 'M1' && copy.created_by === owner.id, 'the copy carries the whole snapshot and names who cloned it');
  check(one(await door(owner.token, 'projects', 'clone_project_template', { p_template_id: tpl.id, p_name: `${MARKER} COPY` }))?.outcome === 'name_taken', 'a name already taken is refused, whatever its case');
  check(one(await door(owner.token, 'projects', 'clone_project_template', { p_template_id: tpl.id, p_name: '  ' }))?.outcome === 'invalid_name', 'a blank name is refused');
  check(one(await door(owner.token, 'projects', 'clone_project_template', { p_template_id: randomUUID(), p_name: 'x' }))?.outcome === 'not_found', 'a template that does not exist is not found');
  check(one(await door(member, 'projects', 'clone_project_template', { p_template_id: tpl.id, p_name: `${MARKER} by member` }))?.outcome === 'forbidden', 'a member may not clone');
  const cAudit = await rest('GET', 'audit', `audit_log?subject_id=eq.${cloned?.template_id}&action=eq.project_template.cloned&select=after`);
  check(cAudit.json?.[0]?.after?.clonedFrom === tpl.id, 'the clone is audited with its source');

  // ── E ───────────────────────────────────────────────────────────────────
  console.log('\nE. Organisation-level project defaults');
  savedDefaults = one(await rest('GET', 'projects', `project_defaults?organization_id=eq.${ORG}&select=*`)) ?? null;
  check(one(await door(member, 'projects', 'set_project_defaults', { p_watch_phases: ['status'], p_folders: [] }))?.outcome === 'forbidden', 'a member may not set the defaults');
  check(one(await door(owner.token, 'projects', 'set_project_defaults', { p_watch_phases: ['nonsense'], p_folders: [] }))?.outcome === 'invalid_phases', 'an unknown phase is refused');
  check(one(await door(owner.token, 'projects', 'set_project_defaults', { p_watch_phases: ['status'], p_folders: [{ category: 'documents', path: '../up' }] }))?.outcome === 'invalid_folders', 'a folder path that climbs out is refused');
  check(one(await door(owner.token, 'projects', 'set_project_defaults', { p_watch_phases: ['status'], p_folders: [{ category: 'nope', path: 'a' }] }))?.outcome === 'invalid_folders', 'a folder in an unknown category is refused');
  check(one(await door(owner.token, 'projects', 'set_project_defaults', { p_watch_phases: ['status'], p_folders: [{ category: 'documents', path: 'Contracts' }, { category: 'documents', path: 'contracts' }] }))?.outcome === 'invalid_folders', 'the same folder twice (any case) is refused');
  const setD = one(await door(owner.token, 'projects', 'set_project_defaults', { p_watch_phases: ['status', 'phase_three'], p_folders: [{ category: 'documents', path: 'Contracts' }, { category: 'meetings', path: 'Minutes/Weekly' }] }));
  check(setD?.outcome === 'set', 'the owner sets the defaults', setD?.outcome);
  const readD = one(await fx.call(owner.token, 'GET', 'projects', `project_defaults?organization_id=eq.${ORG}&select=default_watch_phases,standard_folders`).then((r) => ({ json: r.json })));
  check(JSON.stringify(readD?.default_watch_phases) === JSON.stringify(['status', 'phase_three']) && readD?.standard_folders?.length === 2, 'and reads them back');
  for (const [who, token] of [['owner', owner.token], ['member', member]]) {
    const ins = await fx.call(token, 'POST', 'projects', 'project_defaults', { organization_id: ORG, default_watch_phases: ['status'], standard_folders: [] });
    check(!ins.ok, `${who}: a direct insert through PostgREST is refused`, `${ins.status}`);
    const upd = await fx.call(token, 'PATCH', 'projects', `project_defaults?organization_id=eq.${ORG}`, { standard_folders: [] });
    check(!upd.ok || (Array.isArray(upd.json) && upd.json.length === 0), `${who}: a direct update changes nothing`, `${upd.status}`);
  }
  const fresh = await mkProject('born after the defaults');
  const freshFolders = (await rest('GET', 'projects', `project_folders?project_id=eq.${fresh.id}&select=category,path&order=path.asc`)).json ?? [];
  const paths = freshFolders.map((f) => `${f.category}/${f.path}`).sort();
  check(JSON.stringify(paths) === JSON.stringify(['documents/Contracts', 'meetings/Minutes', 'meetings/Minutes/Weekly']), 'a NEW project starts with the standard folders (and the ancestors of a nested one)', paths.join(', '));
  const oldFolders = (await rest('GET', 'projects', `project_folders?project_id=eq.${project.id}&select=path`)).json ?? [];
  check(!oldFolders.some((f) => f.path === 'Contracts'), 'an existing project is not touched');
  const dAudit = await rest('GET', 'audit', `audit_log?action=eq.project_defaults.updated&select=before,after&order=id.desc&limit=1`);
  check(dAudit.json?.[0]?.after?.watchPhases?.length === 2, 'the change is audited with its before and after');

  // ── F ───────────────────────────────────────────────────────────────────
  console.log('\nF. The project activity feed, from the audit trail');
  await rest('PATCH', 'projects', `tasks?id=eq.${late.id}`, { title: `${MARKER} done human, renamed` });
  const feed = (await door(owner.token, 'projects', 'project_activity', { p_project_id: project.id, p_limit: 100 })).json ?? [];
  const types = new Set(feed.map((r) => r.subject_type));
  check(feed.length > 0, 'the feed returns rows for the project and its records', `${feed.length} rows`);
  check(types.has('task') && types.has('project_folder'), 'including its tasks and its folders', [...types].join(', '));
  check(feed.every((r) => !('before' in r) && !('after' in r)), 'no row carries a before/after snapshot');
  check(feed.some((r) => r.actor_name), 'rows name the person who acted');
  const memberFeed = (await door(member, 'projects', 'project_activity', { p_project_id: project.id, p_limit: 5 })).json ?? [];
  check(memberFeed.length > 0, 'a member (who cannot read /audit) reads the project feed');
  const clientFeed = (await door(fx.mint(owner.id, 'client_member'), 'projects', 'project_activity', { p_project_id: project.id, p_limit: 5 })).json ?? [];
  check(clientFeed.length === 0, 'a client role reads nothing');
  const otherOrg = (await door(fx.mint(owner.id, 'owner', randomUUID()), 'projects', 'project_activity', { p_project_id: project.id, p_limit: 5 })).json ?? [];
  check(otherOrg.length === 0, 'another organisation reads nothing');

  // ── G ───────────────────────────────────────────────────────────────────
  console.log('\nG. A meeting made from a project belongs to it');
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} contact`, phone: `+9198${String(Date.now()).slice(-8)}`, client_account_id: account.id }));
  created.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} lead`, status: 'new' }));
  created.leads.push(lead.id);
  const meeting = one(await rest('POST', 'crm', 'meetings', { organization_id: ORG, lead_id: lead.id, requested_mode: 'call', status: 'requested' }));
  created.meetings.push(meeting.id);
  check(one(await door(owner.token, 'projects', 'attach_meeting_to_project', { p_meeting_id: meeting.id, p_project_id: project.id }))?.outcome === 'attached', 'a meeting with a lead of the project’s client is attached');
  check(one(await door(owner.token, 'projects', 'attach_meeting_to_project', { p_meeting_id: meeting.id, p_project_id: project.id }))?.outcome === 'unchanged', 'attaching it again changes nothing');
  const stranger = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} stranger`, phone: `+9197${String(Date.now()).slice(-8)}` }));
  created.contacts.push(stranger.id);
  const strangerLead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: stranger.id, source: 'manual', title: `${MARKER} stranger lead`, status: 'new' }));
  created.leads.push(strangerLead.id);
  const strangerMeeting = one(await rest('POST', 'crm', 'meetings', { organization_id: ORG, lead_id: strangerLead.id, requested_mode: 'call', status: 'requested' }));
  created.meetings.push(strangerMeeting.id);
  check(one(await door(owner.token, 'projects', 'attach_meeting_to_project', { p_meeting_id: strangerMeeting.id, p_project_id: project.id }))?.outcome === 'not_this_clients_lead', 'a meeting with a lead who is not reachable from the client is refused');
  check(one(await door(finance, 'projects', 'attach_meeting_to_project', { p_meeting_id: strangerMeeting.id, p_project_id: project.id }))?.outcome === 'forbidden', 'a role that cannot write may not attach');
  check(one(await door(owner.token, 'projects', 'attach_meeting_to_project', { p_meeting_id: randomUUID(), p_project_id: project.id }))?.outcome === 'meeting_not_found', 'a meeting that does not exist is not found');
  check(one(await door(owner.token, 'projects', 'attach_meeting_to_project', { p_meeting_id: meeting.id, p_project_id: randomUUID() }))?.outcome === 'project_not_found', 'a project that does not exist is not found');
  const mRow = one(await rest('GET', 'crm', `meetings?id=eq.${meeting.id}&select=project_id`));
  check(mRow?.project_id === project.id, 'the meeting row carries the project');
} finally {
  // Put the defaults back exactly as they were.
  if (savedDefaults) {
    await rest('PATCH', 'projects', `project_defaults?organization_id=eq.${ORG}`, { default_watch_phases: savedDefaults.default_watch_phases, standard_folders: savedDefaults.standard_folders });
  } else {
    await rest('DELETE', 'projects', `project_defaults?organization_id=eq.${ORG}`);
  }
  for (const id of created.meetings) await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.templates) await rest('DELETE', 'projects', `project_templates?id=eq.${id}`);
  for (const id of created.tasks) await rest('DELETE', 'projects', `tasks?id=eq.${id}`);
  for (const id of created.projects) {
    await rest('DELETE', 'projects', `project_files?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `project_folders?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a blocker is structured, agent work is gated, the defaults are the owner's, the feed is the audit trail\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
