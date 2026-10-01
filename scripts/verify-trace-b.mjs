// ═══════════════════════════════════════════════════════════════════════════
// TRACE B — what no TypeScript reading can prove, for PDF pages 28-45.
//
// Migration 20261008120000. Against real Postgres:
//
//   A. a task enters Review only through the hand-off: from in progress and
//      with evidence, by ANY writer; every other way in is refused by the
//      trigger, and every other move is untouched
//   B. a milestone's due date change is written to the audit trail (old and new
//      date, the actor), and a write that changes no date writes nothing
//   C. `projects.schedule_changes` returns the dates that really moved with the
//      old and the new date; `p_mine` returns only what concerns the caller and
//      was done by somebody else; a role outside the agency gets nothing
//
//   node scripts/verify-trace-b.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'review hand-off, date history and schedule notices (trace B)');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zzbuild-traceb-${randomUUID().slice(0, 8)}`;
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
const created = { projects: [], tasks: [], milestones: [] };

console.log('\n\x1b[1mAgencyOS — trace B: review hand-off, date history, schedule notices\x1b[0m');

try {
  const owner = await fx.bootstrapOwner(`${MARKER}-a`);
  const colleague = await fx.bootstrapOwner(`${MARKER}-b`);
  const colleagueToken = fx.mint(colleague.id, 'member');
  const finance = fx.mint(owner.id, 'finance');
  const account = one(await rest('GET', 'core', `client_accounts?organization_id=eq.${ORG}&select=id&limit=1`));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} project`, budget_minor: 100000, currency: 'INR', ends_on: '2026-12-15' }));
  if (!project?.id) fail('fixture: the project could not be created');
  created.projects.push(project.id);
  const mkTask = async (title, extra = {}) => {
    const t = one(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: project.id, title: `${MARKER} ${title}`, ...extra }));
    if (!t?.id) fail(`fixture: task ${title} could not be created`);
    created.tasks.push(t.id);
    return t;
  };
  const setStatus = (token, id, status) => fx.call(token, 'PATCH', 'projects', `tasks?id=eq.${id}`, { status });
  const statusOf = async (id) => one(await rest('GET', 'projects', `tasks?id=eq.${id}&select=status`))?.status;

  // ── A ───────────────────────────────────────────────────────────────────
  console.log('\nA. A task enters review only through the hand-off');
  const fromTodo = await mkTask('from todo');
  const r1 = await setStatus(owner.token, fromTodo.id, 'in_review');
  check(!r1.ok && /task_review_requires_hand_off/.test(r1.text), 'To do straight to review is refused', r1.text.slice(0, 110));
  const r1s = await rest('PATCH', 'projects', `tasks?id=eq.${fromTodo.id}`, { status: 'in_review' });
  check(!r1s.ok && /task_review_requires_hand_off/.test(r1s.text), 'and by the service role as well, whichever path writes the row');
  check((await statusOf(fromTodo.id)) === 'todo', 'and the task stayed where it was');

  const blocked = await mkTask('blocked', { status: 'blocked', blocked_reason: 'waiting', blocker_type: 'client_answer', blocker_owner: 'Priya', blocker_next_action: 'Chase' });
  const r2 = await setStatus(owner.token, blocked.id, 'in_review');
  check(!r2.ok && /task_review_requires_hand_off/.test(r2.text), 'a blocked task cannot be sent to review');

  const noEvidence = await mkTask('in progress, no evidence', { status: 'in_progress' });
  const r3 = await setStatus(owner.token, noEvidence.id, 'in_review');
  check(!r3.ok && /evidence/.test(r3.text), 'in progress without evidence is refused too', r3.text.slice(0, 110));
  const handOffNoEvidence = one(await door(owner.token, 'projects', 'mark_task_ready_for_qa', { p_task_id: noEvidence.id }));
  check(handOffNoEvidence?.outcome === 'no_evidence', 'the hand-off door says the same', handOffNoEvidence?.outcome);

  const evidenced = await mkTask('in progress with evidence', { status: 'in_progress' });
  const added = one(await door(owner.token, 'projects', 'submit_task_evidence', { p_task_id: evidenced.id, p_kind: 'test', p_title: `${MARKER} test run`, p_url: 'https://example.invalid/run/1', p_note: 'green' }));
  check(Boolean(added), 'evidence is attached to the task', JSON.stringify(added)?.slice(0, 80));
  const handOff = one(await door(owner.token, 'projects', 'mark_task_ready_for_qa', { p_task_id: evidenced.id }));
  check(handOff?.outcome === 'ready' && (await statusOf(evidenced.id)) === 'in_review', 'the hand-off door moves it to review', handOff?.outcome);

  const direct = await mkTask('direct with evidence', { status: 'in_progress' });
  await door(owner.token, 'projects', 'submit_task_evidence', { p_task_id: direct.id, p_kind: 'review', p_title: `${MARKER} note`, p_url: null, p_note: 'read the diff' });
  const r4 = await setStatus(owner.token, direct.id, 'in_review');
  check(r4.ok && (await statusOf(direct.id)) === 'in_review', 'the rule is the state and the evidence, not the door: in progress with evidence may be set directly');

  const back = await setStatus(owner.token, evidenced.id, 'in_progress');
  check(back.ok && (await statusOf(evidenced.id)) === 'in_progress', 'review back to in progress (changes requested) is untouched');
  await setStatus(owner.token, evidenced.id, 'in_review');
  const done = await setStatus(owner.token, evidenced.id, 'done');
  check(done.ok && (await statusOf(evidenced.id)) === 'done', 'review to done is untouched');
  const sameState = await setStatus(owner.token, direct.id, 'in_review');
  check(sameState.ok, 'a task already in review stays in review without a refusal');
  const plain = await mkTask('plain move');
  check((await setStatus(owner.token, plain.id, 'in_progress')).ok, 'ordinary moves (to do to in progress) are untouched');

  // ── B ───────────────────────────────────────────────────────────────────
  console.log('\nB. A milestone date change is written down');
  const ms = one(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: `${MARKER} M1`, position: 0, status: 'pending', due_on: '2026-10-13' }));
  if (!ms?.id) fail('fixture: milestone could not be created');
  created.milestones.push(ms.id);
  const auditOf = async (action) => (await rest('GET', 'audit', `audit_log?subject_id=eq.${ms.id}&action=eq.${action}&select=before,after,actor_id,created_at&order=id.asc`)).json ?? [];
  check((await auditOf('milestone.due_changed')).length === 0, 'creating a milestone is not a date change');
  const moved = await fx.call(owner.token, 'PATCH', 'projects', `milestones?id=eq.${ms.id}`, { due_on: '2026-10-20' });
  check(moved.ok, 'the owner moves the due date', `${moved.status}`);
  const rows = await auditOf('milestone.due_changed');
  check(rows.length === 1, 'one audit row is written');
  check(rows[0]?.before?.dueOn === '2026-10-13' && rows[0]?.after?.dueOn === '2026-10-20', 'it carries the old and the new date', JSON.stringify([rows[0]?.before, rows[0]?.after]));
  check(rows[0]?.after?.projectId === project.id && rows[0]?.actor_id === owner.id, 'and the project and the actor', rows[0]?.actor_id);
  await fx.call(owner.token, 'PATCH', 'projects', `milestones?id=eq.${ms.id}`, { due_on: '2026-10-20' });
  check((await auditOf('milestone.due_changed')).length === 1, 'a write that changes no date writes nothing');
  await fx.call(owner.token, 'PATCH', 'projects', `milestones?id=eq.${ms.id}`, { description: 'renamed text' });
  check((await auditOf('milestone.due_changed')).length === 1, 'nor does a change to something else');
  await fx.call(owner.token, 'PATCH', 'projects', `milestones?id=eq.${ms.id}`, { due_on: null });
  const cleared = await auditOf('milestone.due_changed');
  check(cleared.length === 2 && cleared[1]?.after?.dueOn === null, 'clearing the date is a change too');
  await fx.call(owner.token, 'PATCH', 'projects', `milestones?id=eq.${ms.id}`, { due_on: '2026-10-27' });

  // ── C ───────────────────────────────────────────────────────────────────
  console.log('\nC. The people a moved date concerns are told');
  const theirs = await mkTask('assigned to the colleague', { assignee_id: colleague.id, due_on: '2026-10-10', milestone_id: ms.id });
  const unrelated = await mkTask('assigned to nobody', { due_on: '2026-10-11' });
  const sched = (token, id, start, due) => door(token, 'projects', 'set_task_schedule', { p_task_id: id, p_start_on: start, p_due_on: due });
  check(one(await sched(owner.token, theirs.id, null, '2026-10-17'))?.outcome === 'set', 'the owner moves the colleague\'s task date');
  check(one(await sched(owner.token, unrelated.id, null, '2026-10-11'))?.outcome === 'set', 'and saves another task with the same date (nothing moved)');

  const all = (await door(owner.token, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: false, p_limit: 50 })).json ?? [];
  const kinds = all.map((r) => `${r.kind}:${r.was_on ?? 'null'}>${r.now_on ?? 'null'}`);
  check(all.some((r) => r.kind === 'task' && r.subject_id === theirs.id && r.was_on === '2026-10-10' && r.now_on === '2026-10-17'), 'the project\'s history lists the task date with old and new', kinds.join(' | '));
  check(!all.some((r) => r.subject_id === unrelated.id), 'a save that moved no date is not a change');
  check(all.some((r) => r.kind === 'milestone' && r.subject_id === ms.id && r.was_on === '2026-10-13' && r.now_on === '2026-10-20'), 'the milestone move is in the history');
  check(all.every((r) => r.actor_name && r.project_name), 'each row names the actor and the project');
  check(all.every((r) => !('before' in r) && !('after' in r)), 'and never returns the audit snapshots');

  const mineOwner = (await door(owner.token, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: true, p_limit: 50 })).json ?? [];
  check(mineOwner.length === 0, 'the person who moved the dates is not notified of their own change', `${mineOwner.length}`);
  const mineColleague = (await door(colleagueToken, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: true, p_limit: 50 })).json ?? [];
  check(mineColleague.some((r) => r.kind === 'task' && r.subject_id === theirs.id), 'the assignee of the task is told its date moved');
  check(mineColleague.some((r) => r.kind === 'milestone' && r.subject_id === ms.id), 'and the milestone its task is filed under');
  check(!mineColleague.some((r) => r.subject_id === unrelated.id), 'but not about a task that is not theirs');

  await rest('PATCH', 'projects', `projects?id=eq.${project.id}`, { delivery_lead_id: colleague.id });
  const lead = (await door(colleagueToken, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: true, p_limit: 50 })).json ?? [];
  check(lead.length >= mineColleague.length && lead.some((r) => r.subject_id === ms.id), 'the delivery lead is told about the project\'s dates');
  const projMove = await fx.call(owner.token, 'PATCH', 'projects', `projects?id=eq.${project.id}`, { ends_on: '2027-01-15' });
  check(projMove.ok, 'the owner moves the project due date');
  const afterProject = (await door(colleagueToken, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: true, p_limit: 50 })).json ?? [];
  check(afterProject.some((r) => r.kind === 'project' && r.was_on === '2026-12-15' && r.now_on === '2027-01-15'), 'a project due date move reaches its delivery lead, old date to new');

  const asFinance = (await door(finance, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: false, p_limit: 50 })).json ?? [];
  check(Array.isArray(asFinance) && asFinance.length === 0, 'a role outside the agency (finance) gets nothing');
  const since = (await door(owner.token, 'projects', 'schedule_changes', { p_project_id: project.id, p_mine: false, p_since: new Date(Date.now() + 3600_000).toISOString(), p_limit: 50 })).json ?? [];
  check(since.length === 0, 'a window that starts later returns nothing');
} finally {
  for (const id of created.tasks) {
    await rest('DELETE', 'projects', `task_evidence?task_id=eq.${id}`);
    await rest('DELETE', 'projects', `tasks?id=eq.${id}`);
  }
  for (const id of created.milestones) await rest('DELETE', 'projects', `milestones?id=eq.${id}`);
  for (const id of created.projects) {
    await rest('DELETE', 'projects', `project_files?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `project_folders?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — review needs a hand-off, a moved date is remembered, and the people it concerns are told\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
