// ═══════════════════════════════════════════════════════════════════════════
// Trace D (SCR-055 and SCR-065), against real Postgres:
//   A. recording and correcting an expense is audited, with before and after,
//      by the person who did it; a write that changes nothing is silent
//   B. ai.spend_by_project keeps the runs that belong to no project, is
//      visible to the owner and not to a member, and adds up to the settled runs
//   C. the Phase 5 traceability chain (PDF section 8) is stored link by link
//   D. an uploaded meeting note (SCR-060) is kept word for word with its file name, type and size
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'expense audit and spend by project');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-traced';
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
const rows = (r) => (Array.isArray(r.json) ? r.json : []);

const created = { users: [], expenses: [], meetings: [] };
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
const auditFor = (expenseId) =>
  rest('GET', 'audit', `audit_log?subject_type=eq.expense&subject_id=eq.${expenseId}&select=action,actor_id,before,after&order=id.asc`).then(rows);

try {
  const owner = await makeUser('owner');
  const member = await makeUser('member');

  console.log('\n  A. an expense is audited when it is recorded or changed');
  const expenseId = randomUUID();
  created.expenses.push(expenseId);
  const insert = await rest('POST', 'finance', 'expenses', { id: expenseId, organization_id: ORG, category: 'tooling', description: `${MARKER} licence`, amount_minor: 125000, incurred_on: '2026-10-01', recorded_by: owner.id, receipt_url: 'https://example.invalid/receipt' }, owner.token);
  check(insert.ok, 'the owner records an expense', String(insert.status));
  let trail = await auditFor(expenseId);
  check(trail.length === 1 && trail[0].action === 'finance.expense_recorded' && trail[0].actor_id === owner.id, 'recording writes one audit row, by the owner', trail.map((t) => t.action).join(','));
  check(Number(trail[0]?.after?.amount_minor) === 125000 && trail[0]?.after?.has_receipt === true && trail[0]?.before === null, 'it carries the amount and that a receipt is attached, and no before');
  check(!JSON.stringify(trail[0]).includes('example.invalid'), 'the receipt link itself is not copied into the log');

  const update = await rest('PATCH', 'finance', `expenses?id=eq.${expenseId}`, { amount_minor: 150000, category: 'vendor' }, owner.token);
  check(update.ok, 'the owner corrects it', String(update.status));
  trail = await auditFor(expenseId);
  check(trail.length === 2 && trail[1].action === 'finance.expense_updated' && Number(trail[1].before?.amount_minor) === 125000 && Number(trail[1].after?.amount_minor) === 150000 && trail[1].before?.category === 'tooling' && trail[1].after?.category === 'vendor', 'correcting writes before and after', trail.map((t) => t.action).join(','));

  await rest('PATCH', 'finance', `expenses?id=eq.${expenseId}`, { amount_minor: 150000 }, owner.token);
  trail = await auditFor(expenseId);
  check(trail.length === 2, 'a write that changes nothing is not recorded again');

  const memberWrite = await rest('POST', 'finance', 'expenses', { id: randomUUID(), organization_id: ORG, category: 'tooling', description: `${MARKER} nope`, amount_minor: 1, incurred_on: '2026-10-01' }, member.token);
  check(!memberWrite.ok, 'a member cannot record an expense, so there is nothing for them to audit', String(memberWrite.status));

  console.log('\n  B. spend by project hides no spend');
  const settled = rows(await rest('GET', 'ai', `agent_runs?select=id,project_id,status&organization_id=eq.${ORG}&status=not.in.(queued,running,awaiting_approval)&limit=10000`));
  const view = rows(await rest('GET', 'ai', 'spend_by_project?select=project_id,runs', undefined, owner.token));
  const viewRuns = view.reduce((n, r) => n + Number(r.runs), 0);
  check(viewRuns === settled.length, 'the lines add up to every settled run', `${viewRuns} of ${settled.length}`);
  const noProject = settled.filter((r) => r.project_id === null).length;
  const noProjectLine = view.find((r) => r.project_id === null);
  check(noProject === 0 ? !noProjectLine : Number(noProjectLine?.runs) === noProject, 'the runs with no project are one line of their own', `${noProject} runs`);
  const asMember = rows(await rest('GET', 'ai', 'spend_by_project?select=project_id,runs', undefined, member.token));
  check(asMember.length === 0, 'a member sees none of it (cost is owner and ops admin only)');

  console.log('\n  C. the Phase 5 chain is stored link by link (plan -> task -> evidence -> test -> QA -> Admin -> client)');
  // PDF section 8: "plan -> task -> evidence -> developer test -> QA -> Admin -> client approval". Each hop is a stored
  // reference, so a trace can be walked from either end. A column that is missing answers 400 from PostgREST.
  const hops = [
    ['projects', 'task_evidence', 'task_id', 'evidence belongs to a task'],
    ['projects', 'plan_layers', 'plan_deliverable_id', 'a plan layer names its deliverable'],
    ['qa', 'test_plan_items', 'task_id', 'a developer test names the task it proves'],
    ['qa', 'test_runs', 'deliverable_id', 'a QA run names the deliverable'],
    ['qa', 'defects', 'task_id', 'a defect names the task'],
    ['qa', 'defects', 'build_id', 'a defect names the build'],
    ['qa', 'defects', 'run_id', 'a defect names the test run'],
    ['projects', 'deliverables', 'approval_request_id', 'a deliverable names the Admin approval'],
    ['projects', 'handovers', 'approval_request_id', 'a handover names the Admin approval'],
    ['projects', 'release_verifications', 'evidence_url', 'a post-deploy verification keeps its evidence'],
  ];
  for (const [schema, table, column, what] of hops) {
    const r = await rest('GET', schema, `${table}?select=${column}&limit=1`);
    check(r.ok, what, `${schema}.${table}.${column}`);
  }

  console.log('\n  D. an uploaded meeting note is kept word for word, with its file name, type and size');
  // SCR-060. The application reads a text file and files it through the SAME door as typed evidence
  // (crm.add_meeting_evidence) with the file's name as the reference. This proves the door keeps all of it.
  const lead = rows(await rest('GET', 'crm', `leads?organization_id=eq.${ORG}&select=id&limit=1`))[0];
  const meeting = lead && rows(await rest('POST', 'crm', 'meetings', { organization_id: ORG, lead_id: lead.id, requested_mode: 'call', purpose: `${MARKER} meeting` }))[0];
  check(Boolean(meeting?.id), 'a meeting row to attach to', lead ? '' : 'no lead in this database');
  if (meeting?.id) {
    created.meetings.push(meeting.id);
    const note = 'Client wants the dashboard first.\nBudget agreed: 4 lakh.\n';
    const attach = await rest('POST', 'crm', 'rpc/add_meeting_evidence', { p_meeting_id: meeting.id, p_kind: 'notes', p_body: note, p_visibility: 'internal', p_artifact_ref: 'uploaded file: call-notes.txt', p_media_type: 'text/plain', p_byte_size: String(Buffer.byteLength(note)) }, owner.token);
    const first = Array.isArray(attach.json) ? attach.json[0] : attach.json;
    check(first?.outcome === 'attached', 'the owner attaches the uploaded text through the door', JSON.stringify(first));
    const kept = rows(await rest('GET', 'crm', `meeting_evidence?meeting_id=eq.${meeting.id}&select=body,artifact_ref,media_type,byte_size,uploaded_by,kind`))[0];
    check(kept?.body?.trim() === note.trim() && kept?.artifact_ref === 'uploaded file: call-notes.txt' && kept?.media_type === 'text/plain' && Number(kept?.byte_size) === Buffer.byteLength(note) && kept?.uploaded_by === owner.id, 'the text, file name, type, size and uploader are all kept', JSON.stringify(kept));
    const memberAttach = await rest('POST', 'crm', 'rpc/add_meeting_evidence', { p_meeting_id: meeting.id, p_kind: 'notes', p_body: 'nope', p_visibility: 'internal', p_artifact_ref: 'uploaded file: x.txt', p_media_type: 'text/plain', p_byte_size: '4' }, (await makeUser('contractor')).token);
    const mFirst = Array.isArray(memberAttach.json) ? memberAttach.json[0] : memberAttach.json;
    check(mFirst?.outcome === 'forbidden' || !memberAttach.ok, 'a contractor cannot attach evidence', mFirst?.outcome ?? String(memberAttach.status));
    const trail = rows(await rest('GET', 'audit', `audit_log?subject_type=eq.meeting&subject_id=eq.${meeting.id}&action=eq.meeting.evidence_added&select=actor_id,after`));
    check(trail.length === 1 && trail[0].actor_id === owner.id && trail[0].after?.has_reference === true, 'the attachment is audited by the owner, recording that it carries a reference');
  }
} finally {
  for (const id of created.meetings) await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  for (const id of created.expenses) await rest('DELETE', 'finance', `expenses?id=eq.${id}`);
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
