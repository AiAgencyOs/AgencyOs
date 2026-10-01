// ═══════════════════════════════════════════════════════════════════════════
// Round-3 owner decisions, stream R1 (real Postgres):
//
//   Q-BAND      budget bands are the owner's: `crm.set_budget_bands` (owner /
//               ops admin, validated, audited, cleared by an empty list); nobody
//               writes the table directly; another tenant cannot read it.
//   Q-OVERRIDE  a person's Hot / Warm / Cold label with a reason:
//               `crm.override_lead_heat` keeps the computed label, audits both
//               set and clear, refuses a bad label / no reason / a role that may
//               not write / another tenant's lead, and the columns cannot be
//               written around the door.
//   Q-PH56      `projects.complete_phase`: Phase 5 completes from the development
//               tasks, Phase 6 from QA runs and defects; each emits the event that
//               raises M3 / M4 and the PM message, once; the role is re-checked;
//               the tenancy guards hold on the new table.
//   (Q-CHIPS is a pure derivation, covered by tests/a-client-wears-one-lifecycle-chip.test.ts.)
//
// CI's fresh database carries only the seeded owner and organization, so every
// user, the second organization and every row is created here and removed in
// `finally`. No UUID is written down: the organization is read, ids are returned.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'round-3 decisions, stream R1 (bands, heat override, phases 5 and 6)');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zzr1-${randomUUID().slice(0, 8)}`;

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

function mint(userId, orgId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: orgId, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

async function rest(method, schema, path, body, token) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token ?? KEY}`,
      'Content-Type': 'application/json',
      ...(method === 'GET' ? { 'Accept-Profile': schema } : { 'Content-Profile': schema }),
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: parse(text), text };
}
const rpc = (schema, fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);
const row = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const fixture = { users: [], orgs: [], leads: [], projects: [], accounts: [], deliverables: [], invoices: [] };
let ORG = null;

async function mkUser(role, orgId) {
  const email = `${MARKER}-${role}-${randomUUID().slice(0, 6)}@example.invalid`;
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  if (!authUser?.id) fail(`could not create a ${role} fixture user: ${JSON.stringify(authUser).slice(0, 200)}`);
  fixture.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: orgId, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: mint(authUser.id, orgId, role) };
}

async function cleanup() {
  for (const id of fixture.projects) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of fixture.invoices) await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
  for (const id of fixture.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of fixture.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  if (ORG) await rest('DELETE', 'crm', `budget_bands?organization_id=eq.${ORG}`);
  for (const id of fixture.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
  for (const id of fixture.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
}

try {
  // the seeded organization, read rather than written down
  const orgRow = row(await rest('GET', 'core', 'organizations?select=id&order=created_at&limit=1'));
  if (!orgRow?.id) fail('the database has no organization to run against');
  ORG = orgRow.id;

  const owner = await mkUser('owner', ORG);
  const lead = await mkUser('delivery_lead', ORG);
  const member = await mkUser('member', ORG);
  const contractor = await mkUser('contractor', ORG);

  const other = row(await rest('POST', 'core', 'organizations', { name: `${MARKER} other org`, slug: `${MARKER}-other` }));
  if (!other?.id) fail('could not create the second organization');
  fixture.orgs.push(other.id);
  const stranger = await mkUser('owner', other.id);

  // ═══ Q-BAND ═══════════════════════════════════════════════════════════════
  console.log('\n1. Q-BAND — the budget bands are the owner’s');
  const bandsOf = async (token) => row(await rest('GET', 'crm', `budget_bands?organization_id=eq.${ORG}&select=bands,updated_by`, undefined, token));
  await rest('DELETE', 'crm', `budget_bands?organization_id=eq.${ORG}`);

  const asMember = row(await rpc('crm', 'set_budget_bands', { p_bands: [{ label: 'All', minMinor: 0 }] }, member.token));
  check(asMember?.outcome === 'forbidden', 'a member cannot set the bands');
  check(row(await rpc('crm', 'set_budget_bands', { p_bands: [{ label: 'All', minMinor: 0 }] }, lead.token))?.outcome === 'forbidden', 'nor can a delivery lead');

  for (const [why, bands] of [
    ['the first band must start at 0', [{ label: 'A', minMinor: 100 }]],
    ['bands must rise', [{ label: 'A', minMinor: 0 }, { label: 'B', minMinor: 500 }, { label: 'C', minMinor: 500 }]],
    ['a name is used once, whatever its case', [{ label: 'A', minMinor: 0 }, { label: 'a', minMinor: 500 }]],
    ['a name is required', [{ label: '  ', minMinor: 0 }]],
    ['a figure is a whole number of paise', [{ label: 'A', minMinor: 0 }, { label: 'B', minMinor: -5 }]],
  ]) {
    check(row(await rpc('crm', 'set_budget_bands', { p_bands: bands }, owner.token))?.outcome === 'invalid_bands', `refused: ${why}`);
  }
  check((await bandsOf(owner.token)) === undefined || (await bandsOf(owner.token)) === null, 'and nothing was saved by the refusals');

  const good = [{ label: 'Starter', minMinor: 0 }, { label: 'Growth', minMinor: 5_000_000 }, { label: 'Scale', minMinor: 50_000_000 }];
  check(row(await rpc('crm', 'set_budget_bands', { p_bands: good }, owner.token))?.outcome === 'set', 'the owner sets valid bands');
  const saved = await bandsOf(owner.token);
  check(Array.isArray(saved?.bands) && saved.bands.length === 3 && saved.bands[1].label === 'Growth', 'the owner reads them back', JSON.stringify(saved?.bands));
  check(saved?.updated_by === owner.id, 'and the row names who set them');
  const readByMember = await bandsOf(member.token);
  check(readByMember?.bands?.length === 3, 'an internal reader sees the same bands');

  const replaced = [{ label: 'Everything', minMinor: 0 }];
  check(row(await rpc('crm', 'set_budget_bands', { p_bands: replaced }, owner.token))?.outcome === 'set', 'setting again replaces them');
  check((await bandsOf(owner.token))?.bands?.length === 1, 'one band remains');

  check(!(await rest('POST', 'crm', 'budget_bands', { organization_id: ORG, bands: good }, owner.token)).ok, 'nobody inserts the table directly, the owner included');
  check(!(await rest('PATCH', 'crm', `budget_bands?organization_id=eq.${ORG}`, { bands: good }, owner.token)).ok || (await bandsOf(owner.token))?.bands?.length === 1, 'nor updates it directly');
  const strangerRead = await rest('GET', 'crm', `budget_bands?organization_id=eq.${ORG}&select=bands`, undefined, stranger.token);
  check(strangerRead.ok && strangerRead.json.length === 0, 'another tenant cannot read this organization’s bands');
  const movedOrg = await rest('PATCH', 'crm', `budget_bands?organization_id=eq.${ORG}`, { organization_id: other.id });
  check(!movedOrg.ok, 'the row cannot be moved to another organization (frozen)', `${movedOrg.status}`);

  check(row(await rpc('crm', 'set_budget_bands', { p_bands: [] }, owner.token))?.outcome === 'cleared', 'an empty list clears the setting');
  const bandsAudit = (await rest('GET', 'audit', `audit_log?organization_id=eq.${ORG}&subject_id=eq.${ORG}&action=in.(lead_budget_bands.updated,lead_budget_bands.cleared)&select=action&order=created_at.desc&limit=20`)).json ?? [];
  check(bandsAudit.some((a) => a.action === 'lead_budget_bands.updated') && bandsAudit.some((a) => a.action === 'lead_budget_bands.cleared'), 'setting and clearing were both audited');

  // ═══ Q-OVERRIDE ═══════════════════════════════════════════════════════════
  console.log('\n2. Q-OVERRIDE — a person’s label, beside the computed one');
  const leadRow = row(await rest('POST', 'crm', 'leads', { organization_id: ORG, title: `${MARKER} lead` }));
  if (!leadRow?.id) fail(`could not create the fixture lead: ${JSON.stringify(leadRow).slice(0, 200)}`);
  fixture.leads.push(leadRow.id);
  const L = leadRow.id;
  const heat = (token, label, reason, computed = 'Cold') => rpc('crm', 'override_lead_heat', { p_lead_id: L, p_label: label, p_reason: reason, p_computed: computed }, token);
  const leadNow = async () => row(await rest('GET', 'crm', `leads?id=eq.${L}&select=heat_override,heat_override_reason,heat_override_by,heat_override_at,heat_override_computed`));

  check(row(await heat(contractor.token, 'Hot', 'why'))?.outcome === 'forbidden', 'a contractor, who may not write leads, cannot override');
  check(row(await heat(member.token, 'Hot', '   '))?.outcome === 'no_reason', 'a reason is required');
  check(row(await heat(member.token, 'Lukewarm', 'why'))?.outcome === 'bad_label', 'the label is Hot, Warm or Cold');
  check(row(await heat(member.token, 'Hot', 'why', 'Tepid'))?.outcome === 'bad_label', 'and so is the computed label it is kept beside');
  check(row(await heat(stranger.token, 'Hot', 'why'))?.outcome === 'not_found', 'another tenant’s person cannot reach this lead');
  check((await leadNow())?.heat_override === null, 'none of the refusals wrote anything');

  check(row(await heat(member.token, 'Hot', 'The founder confirmed budget on a call', 'Cold'))?.outcome === 'overridden', 'a person who may write leads sets the label');
  const after = await leadNow();
  check(after?.heat_override === 'Hot' && after?.heat_override_computed === 'Cold', 'the row keeps the label and the computed label it overruled');
  check(after?.heat_override_by === member.id && !!after?.heat_override_at && /founder/.test(after?.heat_override_reason ?? ''), 'with who, when and why');
  const writeAround = await rest('PATCH', 'crm', `leads?id=eq.${L}`, { heat_override: 'Warm' }, member.token);
  check(!writeAround.ok || (Array.isArray(writeAround.json) && writeAround.json.length === 0), 'the columns cannot be written around the door (member)', `${writeAround.status}`);
  const writeAroundService = await rest('PATCH', 'crm', `leads?id=eq.${L}`, { heat_override: 'Warm' });
  check(!writeAroundService.ok, 'nor by the service role', `${writeAroundService.status}`);
  check((await leadNow())?.heat_override === 'Hot', 'the label still stands');
  const halfWritten = await rest('PATCH', 'crm', `leads?id=eq.${L}`, { heat_override_reason: 'only a reason' });
  check(!halfWritten.ok, 'a reason cannot be written without its label');

  check(row(await heat(lead.token, 'Warm', 'Silent for a month', 'Warm'))?.outcome === 'overridden', 'a second person may change it');
  check((await leadNow())?.heat_override === 'Warm', 'and the label follows');
  check(row(await heat(member.token, null, 'The override was a mistake'))?.outcome === 'cleared', 'a null label clears it, with a reason');
  const cleared = await leadNow();
  check(cleared?.heat_override === null && cleared?.heat_override_reason === null && cleared?.heat_override_computed === null, 'every column is empty again');
  check(row(await heat(member.token, null, ''))?.outcome === 'no_reason', 'clearing needs a reason too');

  const heatAudit = (await rest('GET', 'audit', `audit_log?organization_id=eq.${ORG}&subject_id=eq.${L}&action=in.(lead.heat_overridden,lead.heat_override_cleared)&select=action,after&order=created_at`)).json ?? [];
  check(heatAudit.filter((a) => a.action === 'lead.heat_overridden').length === 2 && heatAudit.some((a) => a.action === 'lead.heat_override_cleared'), 'two overrides and the clear are audited');
  check(heatAudit.some((a) => a.after?.computed === 'Cold' && /founder/.test(a.after?.reason ?? '')), 'the audit row carries the computed label and the reason');

  // ═══ Q-PH56 ═══════════════════════════════════════════════════════════════
  console.log('\n3. Q-PH56 — Phase 5 and Phase 6 complete from Development and QA data');
  const account = row(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  if (!account?.id) fail(`could not create the fixture client: ${JSON.stringify(account).slice(0, 200)}`);
  fixture.accounts.push(account.id);
  const project = row(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} project`, budget_minor: 100000, currency: 'INR' }));
  if (!project?.id) fail(`could not create the fixture project: ${JSON.stringify(project).slice(0, 200)}`);
  fixture.projects.push(project.id);
  const P = project.id;

  const complete = (token, phase) => rpc('projects', 'complete_phase', { p_project_id: P, p_phase: phase }, token);
  const readiness = async (phase) => row(await rpc('projects', 'phase_readiness', { p_project_id: P, p_phase: phase }, owner.token));
  const eventsOf = async (type) => (await rest('GET', 'core', `outbox_events?subject_id=eq.${P}&type=eq.${type}&select=type,subject_type,payload`)).json ?? [];

  check(row(await complete(member.token, 5))?.outcome === 'forbidden', 'a member cannot complete a phase (project.write)');
  check(row(await complete(contractor.token, 5))?.outcome === 'forbidden', 'nor can a contractor');
  check(row(await complete(stranger.token, 5))?.outcome === 'forbidden', 'nor a person from another organization');
  check(row(await complete(owner.token, 4))?.outcome === 'invalid_phase', 'only Phase 5 and Phase 6 complete this way');
  const noProject = await rpc('projects', 'complete_phase', { p_project_id: randomUUID(), p_phase: 5 }, owner.token);
  check(row(noProject)?.outcome === 'not_found', 'an unknown project is not found');

  // Phase 5: development tasks
  const early = row(await complete(owner.token, 5));
  check(early?.outcome === 'not_ready' && /No development task/.test((early.missing ?? []).join(' ')), 'Phase 5 with no development task is not ready, and says why', JSON.stringify(early));
  const mod = row(await rest('POST', 'projects', 'modules', { organization_id: ORG, project_id: P, name: `${MARKER} module` }));
  const t1 = row(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: P, module_id: mod?.id, title: `${MARKER} build one` }));
  const t2 = row(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: P, module_id: mod?.id, title: `${MARKER} build two` }));
  const loose = row(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: P, title: `${MARKER} not a development task` }));
  check(!!mod?.id && !!t1?.id && !!t2?.id && !!loose?.id, 'the fixture module and tasks exist');
  const open2 = row(await complete(owner.token, 5));
  check(open2?.outcome === 'not_ready' && /2 of 2 development tasks/.test((open2.missing ?? []).join(' ')), 'two open development tasks stop it', JSON.stringify(open2));
  // Finished work is planted born done (the service role has no person to accept it): the
  // review / acceptance gates on the way to done are other decisions and are not under test here.
  await rest('DELETE', 'projects', `tasks?id=eq.${t1.id}`);
  const t1done = row(await rest('POST', 'projects', 'tasks', { organization_id: ORG, project_id: P, module_id: mod?.id, title: `${MARKER} build one, finished`, status: 'done', completed_at: new Date().toISOString() }));
  check(!!t1done?.id && /1 of 2 development tasks/.test(((await readiness(5))?.missing ?? []).join(' ')), 'one done, one open: still not ready');
  await rest('DELETE', 'projects', `tasks?id=eq.${t2.id}`);
  // R1-3 (round 3b): every task done is not enough - the M2 invoice must be verified paid.
  const noM2 = await readiness(5);
  check(noM2?.outcome === 'not_ready' && (noM2.missing ?? []).join('|') === 'M2 not verified paid', 'every development task done but no M2 on the project: still not ready, and M2 is the only thing missing', JSON.stringify(noM2));
  const m2 = row(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: P, name: `${MARKER} M2`, position: 2, amount_minor: 100000, currency: 'INR' }));
  if (!m2?.id) fail(`could not create the fixture M2 milestone: ${JSON.stringify(m2).slice(0, 200)}`);
  const m2inv = row(await rest('POST', 'finance', 'invoices', { organization_id: ORG, client_account_id: account.id, project_id: P, milestone_id: m2.id, number: `${MARKER}-M2`, status: 'issued', currency: 'INR', subtotal_minor: 100000, total_minor: 100000, issued_at: new Date().toISOString() }));
  if (!m2inv?.id) fail(`could not create the fixture M2 invoice: ${JSON.stringify(m2inv).slice(0, 200)}`);
  fixture.invoices.push(m2inv.id);
  check((await readiness(5))?.missing?.includes('M2 not verified paid'), 'an issued M2 invoice is not verified paid');
  const refusedUnpaid = row(await complete(owner.token, 5));
  check(refusedUnpaid?.outcome === 'not_ready' && (refusedUnpaid.missing ?? []).includes('M2 not verified paid'), 'complete_phase refuses while M2 is unpaid, and says why', JSON.stringify(refusedUnpaid));
  check((await eventsOf('project.phase_five_completed')).length === 0, 'and nothing was emitted');
  // Recorded but not verified (paid_minor without verified_minor) is still not enough.
  await rest('PATCH', 'finance', `invoices?id=eq.${m2inv.id}`, { paid_minor: 100000 });
  check((await readiness(5))?.missing?.includes('M2 not verified paid'), 'money recorded on M2 but not verified does not count');
  // Verified in full: the basis the status follows.
  const verifiedPaid = await rest('PATCH', 'finance', `invoices?id=eq.${m2inv.id}`, { verified_minor: 100000, status: 'paid', paid_at: new Date().toISOString() });
  check(verifiedPaid.ok, 'the fixture M2 invoice is marked verified paid', verifiedPaid.text.slice(0, 160));
  check((await readiness(5))?.outcome === 'ready', 'M2 verified paid and every development task done: ready (a task outside any module does not count)');
  check((await eventsOf('project.phase_five_completed')).length === 0, 'and nothing was emitted by merely being ready');

  const phase6Early = row(await complete(owner.token, 6));
  check(phase6Early?.outcome === 'not_ready' && /Phase 5 is not complete/.test((phase6Early.missing ?? []).join(' ')), 'Phase 6 cannot complete before Phase 5');

  const done5 = row(await complete(lead.token, 5));
  check(done5?.outcome === 'completed', 'a delivery lead completes Phase 5', JSON.stringify(done5));
  const ev5 = await eventsOf('project.phase_five_completed');
  check(ev5.length === 1 && ev5[0].subject_type === 'project' && ev5[0].payload?.projectId === P && ev5[0].payload?.phase === 5, 'exactly one project.phase_five_completed event, with the project as its subject (what the M3 and Task 3 handlers read)');
  const rec5 = row(await rest('GET', 'projects', `phase_completions?project_id=eq.${P}&phase=eq.5&select=completed_by,basis`));
  check(rec5?.completed_by === lead.id && rec5?.basis?.developmentTasks === 1, 'the fact records who and the evidence it stood on', JSON.stringify(rec5));
  check(row(await complete(owner.token, 5))?.outcome === 'already_completed', 'completing again answers already_completed');
  check((await eventsOf('project.phase_five_completed')).length === 1, 'and emits nothing a second time');
  const audit5 = (await rest('GET', 'audit', `audit_log?organization_id=eq.${ORG}&subject_id=eq.${P}&action=eq.project.phase_five_completed&select=id`)).json ?? [];
  check(audit5.length === 1, 'Phase 5 completion is audited once');

  // Phase 6: test runs and defects
  const noRun = row(await complete(owner.token, 6));
  check(noRun?.outcome === 'not_ready' && /No test run/.test((noRun.missing ?? []).join(' ')), 'Phase 6 with no test run is not ready');
  const deliv = row(await rest('POST', 'projects', 'deliverables', { organization_id: ORG, project_id: P, kind: 'build', version: 1, title: `${MARKER} build` }));
  if (!deliv?.id) fail(`could not create the fixture deliverable: ${JSON.stringify(deliv).slice(0, 200)}`);
  const run = (over) => rest('POST', 'qa', 'test_runs', { organization_id: ORG, project_id: P, deliverable_id: deliv.id, suite: 'functional', total: 10, passed: 10, failed: 0, skipped: 0, evidence_url: 'https://ci.example/run/1', ...over });
  const failing = await run({ passed: 8, failed: 2, executed_at: '2026-09-01T10:00:00Z' });
  check(failing.ok, 'a failing run is recorded', failing.text.slice(0, 120));
  check(/has failures/.test(((await readiness(6))?.missing ?? []).join(' ')), 'a suite whose latest run fails stops Phase 6');
  const clean = await run({ executed_at: '2026-09-02T10:00:00Z' });
  check(clean.ok && (await readiness(6))?.outcome === 'ready', 'a later clean run of that suite makes it ready (the latest run is what counts)');
  const bug = row(await rest('POST', 'qa', 'defects', { organization_id: ORG, project_id: P, severity: 'blocker', title: `${MARKER} blocker`, reproduction: 'open the app' }));
  check(!!bug?.id, 'a blocker defect is recorded');
  const blocked = await readiness(6);
  check(blocked?.outcome === 'not_ready' && /blocker or major defect/.test((blocked.missing ?? []).join(' ')), 'an open blocker stops Phase 6', JSON.stringify(blocked));
  await rest('PATCH', 'qa', `defects?id=eq.${bug.id}`, { status: 'wontfix', resolution: 'accepted by the client' });
  const minor = await rest('POST', 'qa', 'defects', { organization_id: ORG, project_id: P, severity: 'minor', title: `${MARKER} minor`, reproduction: 'scroll' });
  check(minor.ok && (await readiness(6))?.outcome === 'ready', 'a settled blocker and an open minor defect do not stop it');

  check(row(await complete(owner.token, 6))?.outcome === 'completed', 'the owner completes Phase 6');
  const ev6 = await eventsOf('project.phase_six_completed');
  check(ev6.length === 1 && ev6[0].payload?.phase === 6, 'exactly one project.phase_six_completed event');
  check(row(await complete(owner.token, 6))?.outcome === 'already_completed' && (await eventsOf('project.phase_six_completed')).length === 1, 'a replay emits nothing');

  // tenancy guards on the new table
  const rows = (await rest('GET', 'projects', `phase_completions?project_id=eq.${P}&select=id,organization_id`)).json ?? [];
  const wrongTenant = await rest('POST', 'projects', 'phase_completions', { organization_id: other.id, project_id: P, phase: 5 });
  check(!wrongTenant.ok, 'a completion cannot be filed under another organization than its project’s', `${wrongTenant.status}`);
  const retenant = await rest('PATCH', 'projects', `phase_completions?id=eq.${rows[0]?.id}`, { organization_id: other.id });
  check(!retenant.ok, 'and a completion cannot change tenant', `${retenant.status}`);
  const strangerSees = await rest('GET', 'projects', `phase_completions?project_id=eq.${P}&select=id`, undefined, stranger.token);
  check(strangerSees.ok && strangerSees.json.length === 0, 'another tenant sees none');
  check(!(await rest('POST', 'projects', 'phase_completions', { organization_id: ORG, project_id: P, phase: 5 }, owner.token)).ok, 'nobody writes the table directly, the owner included');

  // the events are real event types, so the dispatcher can publish them
  for (const type of ['project.phase_five_completed', 'project.phase_six_completed']) {
    const t = await rest('GET', 'core', `event_types?type=eq.${type}&select=type`);
    check(t.ok && t.json?.length === 1, `${type} is a registered event type`);
  }
} catch (error) {
  failures += 1;
  console.error(`\n  ✗ the verifier stopped: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await cleanup().catch((e) => console.error(`  cleanup problem: ${e instanceof Error ? e.message : e}`));
}

console.log(failures === 0 ? '\n  all round-3 R1 checks passed\n' : `\n  ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
