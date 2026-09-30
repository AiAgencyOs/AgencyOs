// ═══════════════════════════════════════════════════════════════════════════
// Theme W5 — QA, release, communication (SCR-044 to 049, 057 to 060).
//
// Against real Postgres, the rules that reading TypeScript cannot prove:
//
//   A. a run names its tester and environment; evidence is appended to an open
//      OR a closed run and never rewrites it; nobody writes the tables directly
//   B. a case can be edited (not on an approved plan); a requirement with no
//      case can carry a written reason instead
//   C. an unsupported device/configuration must say why
//   D. a release records its rollback plan, smoke checklist, dependencies and
//      a dated verification with NO handover
//   E. an announcement names its project (which fixes its client); a met
//      milestone drafts one from the active template; a retry needs a reason;
//      an email is recorded with the provider's answer
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'theme W5: QA, release, communication');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzbuild-w5';
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
const rpc = (schema, fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);
const out = async (schema, fn, args, token) => one(await rpc(schema, fn, args, token))?.outcome;

const created = { users: [], projects: [], accounts: [], scopeVersions: [], devices: [], templates: [], announcements: [], emails: [] };

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
  const admin = await makeUser('ops_admin');
  const lead = await makeUser('delivery_lead');
  const member = await makeUser('member');
  const finance = await makeUser('finance');

  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.accounts.push(account.id);
  const other = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} other client` }));
  created.accounts.push(other.id);
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: account.id, name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'planning' }));
  created.projects.push(project.id);
  const build = one(await rpc('projects', 'add_deliverable', { p_project_id: project.id, p_kind: 'build', p_title: `${MARKER} build`, p_artifact_url: 'https://builds.example/w5.apk' }));

  // ── A. a run names its tester and environment; evidence is appended ──────
  console.log('\n  A. a run names its tester and environment; evidence is appended, never rewrites');
  const opened = one(await rpc('qa', 'open_test_run', { p_deliverable_id: build.deliverable_id, p_suite: 'functional', p_environment: 'staging', p_tester_id: lead.id }, member.token));
  check(opened?.outcome === 'opened', 'a member opens a run naming a staging environment and another tester', opened?.outcome);
  const row = one(await rest('GET', 'qa', `test_runs?id=eq.${opened.id}&select=environment,tester_id,executed_by`));
  check(row?.environment === 'staging' && row?.tester_id === lead.id && row?.executed_by === member.id, 'the run keeps the environment, the tester, and who recorded it');
  check((await out('qa', 'open_test_run', { p_deliverable_id: build.deliverable_id, p_suite: 'ui', p_environment: 'the moon' }, member.token)) === 'bad_environment', 'an environment outside the vocabulary is refused');
  check((await out('qa', 'open_test_run', { p_deliverable_id: build.deliverable_id, p_suite: 'ui', p_tester_id: randomUUID() }, member.token)) === 'tester_not_found', 'a tester who is not on the team is refused');
  const noTester = one(await rpc('qa', 'open_test_run', { p_deliverable_id: build.deliverable_id, p_suite: 'api' }, member.token));
  const defaulted = one(await rest('GET', 'qa', `test_runs?id=eq.${noTester.id}&select=tester_id`));
  check(defaulted?.tester_id === member.id, 'with no tester named, the person who opened it is the tester');

  const recorded = one(await rpc('qa', 'record_test_run', { p_deliverable_id: build.deliverable_id, p_suite: 'smoke', p_total: 4, p_passed: 3, p_failed: 1, p_environment: 'production' }, member.token));
  check(recorded?.outcome === 'recorded', 'a whole run is recorded with its environment', recorded?.outcome);

  const closed = one(await rpc('qa', 'close_test_run', { p_run_id: opened.id, p_passed: 2, p_failed: 1, p_skipped: 0, p_blocked: 0 }, member.token));
  check(closed?.outcome === 'closed', 'the open run is closed with its counts', closed?.outcome);

  const ev1 = one(await rpc('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'screenshot', p_value: 'https://files.example/fail.png', p_label: 'login error' }, member.token));
  const ev2 = one(await rpc('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'log', p_value: 'https://files.example/run.log' }, lead.token));
  const ev3 = one(await rpc('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'note', p_value: 'Fails only on the second attempt.' }, member.token));
  check([ev1, ev2, ev3].every((e) => e?.outcome === 'added'), 'three pieces of evidence are appended to a CLOSED run', [ev1, ev2, ev3].map((e) => e?.outcome).join(','));
  const counts = one(await rest('GET', 'qa', `test_runs?id=eq.${opened.id}&select=passed,failed,status`));
  check(counts?.passed === 2 && counts?.failed === 1 && counts?.status === 'closed', 'and the run itself is exactly as it was closed');
  check((await out('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'screenshot', p_value: 'not a link' }, member.token)) === 'bad_value', 'a screenshot that is not a link is refused');
  check((await out('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'video-of-cat', p_value: 'https://x.example/a' }, member.token)) === 'bad_kind', 'a kind outside the vocabulary is refused');
  check((await out('qa', 'add_run_evidence', { p_run_id: opened.id, p_kind: 'note', p_value: 'x' }, finance.token)) === 'not_authorized', 'finance may not add run evidence');
  const listed = await rest('GET', 'qa', `test_run_evidence?run_id=eq.${opened.id}&select=kind,label&order=added_at.asc`, null, member.token);
  check(Array.isArray(listed.json) && listed.json.length === 3 && listed.json[0].label === 'login error', 'the evidence reads back in order, with its label');
  const direct = await rest('POST', 'qa', 'test_run_evidence', { organization_id: ORG, run_id: opened.id, kind: 'note', value: 'sneaked in' }, owner.token);
  check(!direct.ok, 'nobody, not even the owner, writes the table directly', `${direct.status}`);
  const finRead = await rest('GET', 'qa', `test_run_evidence?run_id=eq.${opened.id}&select=id`, null, finance.token);
  check(Array.isArray(finRead.json) && finRead.json.length === 0, 'finance reads none of it');
  const rerun = one(await rpc('qa', 'rerun_test_run', { p_run_id: opened.id }, member.token));
  const rr = one(await rest('GET', 'qa', `test_runs?id=eq.${rerun.id}&select=environment,rerun_of`));
  check(rerun?.outcome === 'opened' && rr?.environment === 'staging' && rr?.rerun_of === opened.id, 'a rerun inherits the environment and points back at the run it repeats');

  // ── B. a case is edited; a requirement without one says why ──────────────
  console.log('\n  B. a case is edited; a requirement with no case can carry a reason');
  const sv = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft' }));
  if (!sv?.id) console.log('  scope version:', JSON.stringify(sv));
  created.scopeVersions.push(sv.id);
  const itemA = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, title: `${MARKER} login` }));
  if (!itemA?.id) console.log('  scope item:', JSON.stringify(itemA));
  const itemB = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: sv.id, title: `${MARKER} legal page` }));
  await rest('PATCH', 'projects', `scope_versions?id=eq.${sv.id}`, { status: 'active', frozen_at: new Date().toISOString() });
  const plan = one(await rpc('qa', 'draft_test_plan', { p_scope_version_id: sv.id }, lead.token));
  const added = one(await rpc('qa', 'add_test_plan_item', { p_plan_id: plan.id, p_scope_item_id: itemA.id, p_category: 'functional', p_reason: 'money moves here' }, lead.token));
  check(added?.outcome === 'added', 'a delivery lead adds a case', JSON.stringify(added));
  const upd = await out('qa', 'update_test_plan_item', { p_item_id: added.id, p_reason: 'money moves here; retried twice', p_critical_path: true, p_preconditions: 'A client exists', p_steps: '1. open\n2. pay', p_expected_result: 'receipt shown' }, lead.token);
  const edited = one(await rest('GET', 'qa', `test_plan_items?id=eq.${added.id}&select=reason,critical_path,steps,expected_result`));
  check(upd === 'updated' && edited?.critical_path === true && edited?.steps === '1. open\n2. pay' && edited?.expected_result === 'receipt shown', 'the case is edited: reason, critical path, steps, expected result', upd);
  check((await out('qa', 'update_test_plan_item', { p_item_id: added.id, p_reason: '  ', p_critical_path: false }, lead.token)) === 'bad_reason', 'a blank reason is refused');
  check((await out('qa', 'update_test_plan_item', { p_item_id: added.id, p_reason: 'x', p_critical_path: false }, member.token)) === 'not_authorized', 'a member may not edit a case');
  const auditEdit = await rest('GET', 'audit', `audit_log?action=eq.test_case.updated&subject_id=eq.${added.id}&select=before,after`);
  check(Array.isArray(auditEdit.json) && auditEdit.json.length === 1 && auditEdit.json[0].before?.reason === 'money moves here', 'the edit is audited with before and after');

  check((await out('qa', 'waive_test_coverage', { p_plan_id: plan.id, p_scope_item_id: itemB.id, p_reason: 'static legal copy, reviewed by counsel' }, lead.token)) === 'waived', 'a requirement with no case carries a written reason instead');
  check((await out('qa', 'waive_test_coverage', { p_plan_id: plan.id, p_scope_item_id: itemA.id, p_reason: 'no' }, lead.token)) === 'already_covered', 'one that HAS a case cannot be waived');
  check((await out('qa', 'waive_test_coverage', { p_plan_id: plan.id, p_scope_item_id: itemB.id, p_reason: '' }, lead.token)) === 'bad_reason', 'a waiver with no reason is refused');
  check((await out('qa', 'waive_test_coverage', { p_plan_id: plan.id, p_scope_item_id: itemB.id, p_reason: 'x' }, member.token)) === 'not_authorized', 'a member may not waive coverage');
  const waivers = await rest('GET', 'qa', `test_coverage_waivers?plan_id=eq.${plan.id}&select=scope_item_id,reason`, null, member.token);
  check(Array.isArray(waivers.json) && waivers.json.length === 1 && waivers.json[0].scope_item_id === itemB.id, 'the waiver reads back');
  check((await out('qa', 'restore_test_coverage', { p_plan_id: plan.id, p_scope_item_id: itemB.id }, lead.token)) === 'restored', 'and can be withdrawn, so the requirement is uncovered again');
  const approved = one(await rpc('qa', 'approve_test_plan', { p_plan_id: plan.id }, owner.token));
  check(approved?.outcome === 'approved', 'the owner approves the plan', approved?.outcome);
  check((await out('qa', 'update_test_plan_item', { p_item_id: added.id, p_reason: 'late change', p_critical_path: false }, lead.token)) === 'plan_approved', 'an approved plan loses no words: its cases are no longer edited');

  // ── C. an unsupported device must say why ────────────────────────────────
  console.log('\n  C. an unsupported device or configuration is explicitly recorded, with a reason');
  const dev = `${MARKER} Galaxy Fold ${randomUUID().slice(0, 4)}`;
  check((await out('qa', 'add_device_configuration', { p_name: dev, p_platform: 'android', p_status: 'unsupported' }, lead.token)) === 'reason_required', 'unsupported without a reason is refused');
  const addedDevice = one(await rpc('qa', 'add_device_configuration', { p_name: dev, p_platform: 'android', p_os: 'Android 9', p_browser: 'Opera Mini', p_status: 'unsupported', p_reason: 'The client contract excludes Android 9 and below.' }, lead.token));
  check(addedDevice?.outcome === 'added', 'an unsupported configuration is recorded with its reason', addedDevice?.outcome);
  if (addedDevice?.id) created.devices.push(addedDevice.id);
  check((await out('qa', 'add_device_configuration', { p_name: dev.toUpperCase(), p_platform: 'android', p_os: 'android 9', p_browser: 'opera mini' }, lead.token)) === 'already_recorded', 'the same configuration is not recorded twice, whatever its case');
  check((await out('qa', 'add_device_configuration', { p_name: `${dev} b`, p_platform: 'toaster' }, lead.token)) === 'bad_platform', 'a platform outside the vocabulary is refused');
  check((await out('qa', 'add_device_configuration', { p_name: `${dev} c`, p_platform: 'web' }, member.token)) === 'not_authorized', 'a member may not add a device');
  check((await out('qa', 'set_device_support', { p_device_id: addedDevice.id, p_status: 'supported' }, lead.token)) === 'set', 'it is marked supported again');
  const back = one(await rest('GET', 'qa', `device_configurations?id=eq.${addedDevice.id}&select=status,reason`));
  check(back?.status === 'supported' && back?.reason === null, 'and the old reason is cleared with it');
  check((await out('qa', 'set_device_support', { p_device_id: addedDevice.id, p_status: 'unsupported', p_reason: '' }, lead.token)) === 'reason_required', 'unsupported again needs a reason again');
  const directDev = await rest('POST', 'qa', 'device_configurations', { organization_id: ORG, name: 'x', platform: 'web', status: 'unsupported' }, owner.token);
  check(!directDev.ok, 'no role writes the table directly', `${directDev.status}`);

  // ── D. a release is recorded with no handover ────────────────────────────
  console.log('\n  D. a release records its rollback plan, smoke checklist, dependencies and verification with no handover');
  const handovers = await rest('GET', 'projects', `handovers?project_id=eq.${project.id}&select=id`);
  check(Array.isArray(handovers.json) && handovers.json.length === 0, 'this project has no handover');
  check((await out('projects', 'set_release_rollback_plan', { p_project_id: project.id, p_rollback_plan: 'Redeploy v1.0.3; run migration 0042 down.' }, lead.token)) === 'set', 'the rollback plan is written');
  check((await out('projects', 'set_release_smoke_item', { p_project_id: project.id, p_label: 'Home loads over HTTPS', p_done: false }, lead.token)) === 'set', 'a smoke check is listed');
  check((await out('projects', 'set_release_smoke_item', { p_project_id: project.id, p_label: 'Home loads over HTTPS', p_done: true }, lead.token)) === 'set', 'and ticked');
  check((await out('projects', 'set_release_dependency', { p_project_id: project.id, p_label: 'DNS cutover', p_status: 'pending' }, lead.token)) === 'set', 'a dependency is listed');
  check((await out('projects', 'set_release_dependency', { p_project_id: project.id, p_label: 'DNS cutover', p_status: 'ready' }, lead.token)) === 'set', 'and marked ready');
  check((await out('projects', 'set_release_dependency', { p_project_id: project.id, p_label: 'x', p_status: 'maybe' }, lead.token)) === 'bad_status', 'a dependency status outside pending/ready is refused');
  const rec = one(await rest('GET', 'projects', `release_records?project_id=eq.${project.id}&select=rollback_plan,smoke_checklist,deployment_dependencies`, null, member.token));
  check(rec?.rollback_plan?.startsWith('Redeploy') && rec.smoke_checklist?.length === 1 && rec.smoke_checklist[0].done_at && rec.deployment_dependencies?.length === 1 && rec.deployment_dependencies[0].status === 'ready', 'all three read back from one row');
  check((await out('projects', 'set_release_rollback_plan', { p_project_id: project.id, p_rollback_plan: 'x' }, member.token)) === 'not_authorized', 'a member may not write the plan');
  check((await out('projects', 'set_release_smoke_item', { p_project_id: project.id, p_label: 'x', p_done: true }, finance.token)) === 'not_authorized', 'finance may not tick a check');
  const v1 = one(await rpc('projects', 'record_release_verification', { p_project_id: project.id, p_environment: 'production', p_outcome: 'passed', p_deliverable_id: build.deliverable_id, p_evidence_url: 'https://status.example/ok' }, lead.token));
  check(v1?.outcome === 'recorded', 'a dated post-deploy verification is recorded against the build', v1?.outcome);
  check((await out('projects', 'record_release_verification', { p_project_id: project.id, p_environment: 'production', p_outcome: 'failed' }, lead.token)) === 'notes_required', 'a failed verification with no words is refused');
  check((await out('projects', 'record_release_verification', { p_project_id: project.id, p_environment: 'mars', p_outcome: 'passed' }, lead.token)) === 'bad_environment', 'an environment outside the vocabulary is refused');
  check((await out('projects', 'record_release_verification', { p_project_id: project.id, p_environment: 'staging', p_outcome: 'passed', p_deliverable_id: randomUUID() }, lead.token)) === 'build_not_on_project', 'a build from nowhere is refused');
  check((await out('projects', 'record_release_verification', { p_project_id: project.id, p_environment: 'staging', p_outcome: 'passed' }, member.token)) === 'not_authorized', 'a member may not record a verification');
  const dirRel = await rest('POST', 'projects', 'release_records', { organization_id: ORG, project_id: randomUUID() }, owner.token);
  check(!dirRel.ok, 'the release tables are not directly writable', `${dirRel.status}`);

  // ── E. announcements, templates, retries, email ──────────────────────────
  console.log('\n  E. announcements belong to a project; a met milestone drafts one; a retry says why; email is recorded');
  const tplName = `${MARKER} milestone ${randomUUID().slice(0, 4)}`;
  check((await out('crm', 'save_announcement_template', { p_template_id: null, p_name: tplName, p_kind: 'milestone', p_audience: 'clients', p_title_template: '{{milestone}} is done', p_body_template: 'For {{client}}: {{milestone}} on {{project}} is complete.' }, admin.token)) === 'forbidden', 'only the owner writes a template');
  const tpl = one(await rpc('crm', 'save_announcement_template', { p_template_id: null, p_name: tplName, p_kind: 'milestone', p_audience: 'clients', p_title_template: '{{milestone}} is done', p_body_template: 'For {{client}}: {{milestone}} on {{project}} is complete.' }, owner.token));
  check(tpl?.outcome === 'created', 'the owner saves a milestone template', tpl?.outcome);
  if (tpl?.id) created.templates.push(tpl.id);
  check((await out('crm', 'save_announcement_template', { p_template_id: null, p_name: tplName.toUpperCase(), p_kind: 'general', p_audience: 'internal', p_title_template: 't', p_body_template: 'b' }, owner.token)) === 'name_taken', 'two templates do not share a name');

  const ann = one(await rpc('crm', 'create_announcement', { p_title: 'Launch window', p_body: 'We go live Friday.', p_audience: 'clients', p_project_id: project.id }, owner.token));
  check(ann?.outcome === 'drafted', 'the owner drafts an announcement about a project', ann?.outcome);
  if (ann?.id) created.announcements.push(ann.id);
  const annRow = one(await rest('GET', 'crm', `announcements?id=eq.${ann.id}&select=project_id,client_account_id`));
  check(annRow?.project_id === project.id && annRow?.client_account_id === account.id, 'the project fixes the client it is recorded against');
  check((await out('crm', 'create_announcement', { p_title: 't', p_body: 'b', p_audience: 'clients', p_project_id: project.id, p_client_account_id: other.id }, owner.token)) === 'client_not_on_project', 'a different client beside the project is a contradiction and is refused');
  check((await out('crm', 'create_announcement', { p_title: 't', p_body: 'b', p_audience: 'clients', p_project_id: randomUUID() }, owner.token)) === 'project_not_found', 'a project from nowhere is refused');
  check((await out('crm', 'create_announcement', { p_title: 't', p_body: 'b', p_audience: 'clients' }, admin.token)) === 'forbidden', 'only the owner drafts');
  const clientOnly = one(await rpc('crm', 'create_announcement', { p_title: 'Hello', p_body: 'World', p_audience: 'clients', p_client_account_id: account.id }, owner.token));
  if (clientOnly?.id) created.announcements.push(clientOnly.id);
  check(clientOnly?.outcome === 'drafted', 'an announcement can be addressed to one client alone');

  const ms = one(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: `${MARKER} Design approved`, status: 'in_progress', visibility: 'client' }));
  await rest('PATCH', 'projects', `milestones?id=eq.${ms.id}`, { status: 'met', met_at: new Date().toISOString() });
  const drafted = await rest('GET', 'crm', `announcements?milestone_id=eq.${ms.id}&select=id,title,body,status,source,project_id,client_account_id,template_id`);
  const d = Array.isArray(drafted.json) ? drafted.json[0] : null;
  if (d?.id) created.announcements.push(d.id);
  check(d && d.status === 'draft' && d.source === 'milestone' && d.title.includes('Design approved') && d.body.includes(`${MARKER} client`) && d.project_id === project.id && d.template_id === tpl.id, 'a met milestone drafts an announcement from the template — a DRAFT, naming the client, project and milestone', d ? d.title : 'none drafted');
  const again = await out('crm', 'draft_milestone_announcement', { p_milestone_id: ms.id }, owner.token);
  check(again === 'already_drafted', 'a milestone is announced once', again);
  const hidden = one(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: `${MARKER} internal step`, status: 'in_progress', visibility: 'internal' }));
  await rest('PATCH', 'projects', `milestones?id=eq.${hidden.id}`, { status: 'met', met_at: new Date().toISOString() });
  const none = await rest('GET', 'crm', `announcements?milestone_id=eq.${hidden.id}&select=id`);
  check(Array.isArray(none.json) && none.json.length === 0, 'an internal milestone drafts nothing for clients');
  await rest('PATCH', 'crm', `announcement_templates?id=eq.${tpl.id}`, { active: false });
  const ms2 = one(await rest('POST', 'projects', 'milestones', { organization_id: ORG, project_id: project.id, name: `${MARKER} Beta`, status: 'in_progress', visibility: 'client' }));
  await rest('PATCH', 'projects', `milestones?id=eq.${ms2.id}`, { status: 'met', met_at: new Date().toISOString() });
  const after = await rest('GET', 'crm', `announcements?milestone_id=eq.${ms2.id}&select=id`);
  check(Array.isArray(after.json) && after.json.length === 0, 'with no active milestone template nothing is drafted — and meeting the milestone still worked');
  check((await out('crm', 'draft_milestone_announcement', { p_milestone_id: ms2.id }, owner.token)) === 'no_template', 'the button says there is no template to draft from');
  const directAnn = await rest('POST', 'crm', 'announcement_templates', { organization_id: ORG, name: 'x', audience: 'internal', title_template: 't', body_template: 'b' }, owner.token);
  check(!directAnn.ok, 'the template table is not directly writable', `${directAnn.status}`);

  // the retry reason
  check((await out('crm', 'requeue_failed_delivery', { p_original_id: randomUUID(), p_retry_id: randomUUID(), p_reason: 'no' }, admin.token)) === 'no_reason', 'a retry with fewer than five characters of reason is refused');
  check((await out('crm', 'requeue_failed_delivery', { p_original_id: randomUUID(), p_retry_id: randomUUID(), p_reason: 'The window has reopened.' }, member.token)) === 'forbidden', 'a member may not requeue a delivery');
  check((await out('crm', 'requeue_failed_delivery', { p_original_id: randomUUID(), p_retry_id: randomUUID(), p_reason: 'The window has reopened.' }, admin.token)) === 'not_found', 'a message that is not there is not found');

  // the email lane
  const sent = one(await rpc('crm', 'record_outbound_email', { p_kind: 'client_update', p_to: 'client@example.com', p_subject: 'Weekly update', p_body: 'Design is approved.', p_status: 'sent', p_project_id: project.id, p_transport: 'smtp', p_message_ref: 'queued-1' }, admin.token));
  check(sent?.outcome === 'recorded', 'a sent client update is recorded against its project', sent?.outcome);
  if (sent?.id) created.emails.push(sent.id);
  const erow = one(await rest('GET', 'crm', `outbound_emails?id=eq.${sent.id}&select=client_account_id,status`, null, member.token));
  check(erow?.client_account_id === account.id && erow?.status === 'sent', 'and its client is the project\'s');
  check((await out('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'failed' }, admin.token)) === 'error_required', 'a failed send must carry the provider\'s reason');
  const failedMail = one(await rpc('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'failed', p_error: 'No email transport is configured.' }, admin.token));
  if (failedMail?.id) created.emails.push(failedMail.id);
  check(failedMail?.outcome === 'recorded', 'a failed send is recorded with its reason', failedMail?.outcome);
  check((await out('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'sent', p_retry_of: failedMail.id }, admin.token)) === 'no_reason', 'a resend must say why');
  const resent = one(await rpc('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'sent', p_retry_of: failedMail.id, p_retry_reason: 'SMTP is configured now.' }, admin.token));
  if (resent?.id) created.emails.push(resent.id);
  check(resent?.outcome === 'recorded', 'a resend with a reason is recorded and points back', resent?.outcome);
  check((await out('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'sent', p_retry_of: sent.id, p_retry_reason: 'Again, please.' }, admin.token)) === 'not_failed', 'only a failed send can be resent');
  check((await out('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'not-an-address', p_subject: 's', p_body: 'b', p_status: 'sent' }, admin.token)) === 'invalid', 'an address that is not an address is refused');
  check((await out('crm', 'record_outbound_email', { p_kind: 'email', p_to: 'a@b.example', p_subject: 's', p_body: 'b', p_status: 'sent' }, member.token)) === 'forbidden', 'a member may not record an email send');
  const directMail = await rest('POST', 'crm', 'outbound_emails', { organization_id: ORG, to_address: 'a@b.example', subject: 's', body: 'b', status: 'sent' }, owner.token);
  check(!directMail.ok, 'the email table is not directly writable', `${directMail.status}`);
} finally {
  // Children first; nothing here may outlive the run.
  for (const id of created.emails) await rest('DELETE', 'crm', `outbound_emails?id=eq.${id}&retry_of=not.is.null`);
  for (const id of created.emails) await rest('DELETE', 'crm', `outbound_emails?id=eq.${id}`);
  for (const id of created.announcements) await rest('DELETE', 'crm', `announcements?id=eq.${id}`);
  for (const id of created.projects) await rest('DELETE', 'crm', `announcements?project_id=eq.${id}`);
  for (const id of created.templates) await rest('DELETE', 'crm', `announcement_templates?id=eq.${id}`);
  for (const id of created.devices) await rest('DELETE', 'qa', `device_configurations?id=eq.${id}`);
  for (const id of created.projects) {
    await rest('DELETE', 'core', `outbox_events?payload->>project_id=eq.${id}`);
    const runs = await rest('GET', 'qa', `test_runs?project_id=eq.${id}&select=id`);
    for (const r of Array.isArray(runs.json) ? runs.json : []) await rest('DELETE', 'core', `outbox_events?subject_type=eq.test_run&subject_id=eq.${r.id}`);
    await rest('DELETE', 'qa', `test_runs?project_id=eq.${id}&rerun_of=not.is.null`);
    await rest('DELETE', 'qa', `test_runs?project_id=eq.${id}`);
  }
  for (const id of created.scopeVersions) await rest('DELETE', 'projects', `scope_versions?id=eq.${id}`);
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
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
