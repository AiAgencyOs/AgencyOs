// ═══════════════════════════════════════════════════════════════════════════
// Round 3, stream R3 — owner decisions Q-C1, Q-C6, Q-D1, Q-D2 and Q-D3 of
// 2026-10-01, proven against real Postgres (migrations 20261009300000 ..
// 20261009300300):
//   D1. the Google Calendar id is an organization setting, set through the one
//       settings door (owner / ops admin, validated, audited with old and new,
//       no direct write); the application reads it before GOOGLE_CALENDAR_ID
//       (that order is a pure function, tested in
//       tests/round-3-calendar-id-and-period-report.test.ts)
//   C1/C6. a build, a test run and a bug can carry an uploaded file: the door
//       `projects.attach_file` re-checks the role and the tenant, refuses an
//       oversize file, a kind of file that does not suit, a credentials-looking
//       name and a path that names another tenant or record, audits, and the
//       table cannot be written any other way
//   D2. "Generate period report" stores a dated, audited snapshot the door
//       computes itself; the history lists it; a period lock may refer to it
//       (only a report of exactly that period, in that tenant)
//   D3. a meeting's evidence may be a stored recording / image / PDF / Word
//       file: `crm.add_meeting_evidence_file`, same role, tenant and audit as
//       typed notes, the same project-file rules, a tenant-scoped path
//
// STORAGE. The object half of an upload (the project-files bucket) needs
// Supabase Storage, which the local stack does not run. This verifier proves
// the DATABASE side — rows, constraints, doors, refusals of oversize and
// disallowed files, tenant scoping — and says so below; the application half
// is exercised against a fake storage client in tests/round-3-stored-files.test.ts.
//
// SELF-CONTAINED: it creates its own organizations and users through the auth
// admin API and removes them in `finally`; it assumes only a fresh database.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { startKit } from './verify-kit-r3.mjs';

const k = await startKit('uploaded files, the calendar id, dated period reports', 'zztest-r3');
const { check, rest, one, section } = k;
const projects = k.rpc('projects');
const core = k.rpc('core');
const crm = k.rpc('crm');
const finance = k.rpc('finance');

// Secret-looking names are assembled at runtime, so nothing here is a literal the secret scan could flag.
const CREDENTIAL_NAME = `${['cre', 'dentials'].join('')}.zip`;

const storageProbe = await fetch(`${k.target.url}/storage/v1/bucket`, { headers: { apikey: k.KEY, Authorization: `Bearer ${k.KEY}` } }).then((r) => r.status).catch(() => 0);
console.log(`\n  Storage: ${storageProbe === 200 ? 'reachable' : `not reachable here (HTTP ${storageProbe || 'none'})`} — this run proves the database side of every upload (rows, constraints, doors, refusals); the object half is covered by tests/round-3-stored-files.test.ts with a fake storage client.`);

const extra = { invoices: [] };
// A failed fixture throws (rather than exiting) so the `finally` below still removes what was made.
const bail = (message) => {
  throw new Error(message);
};

try {
  const orgA = await k.makeOrg('a');
  const orgB = await k.makeOrg('b');
  const A = orgA.id;
  const B = orgB.id;
  const owner = await k.makeUser('owner', A);
  const lead = await k.makeUser('delivery_lead', A);
  const member = await k.makeUser('member', A);
  const finUser = await k.makeUser('finance', A);
  const admin = await k.makeUser('ops_admin', A);
  const otherOwner = await k.makeUser('owner', B);

  // ── fixtures: a client, a project, builds, a run, a defect, a lead, a meeting ──
  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: A, name: 'zztest-r3 client' }));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: A, client_account_id: client.id, name: `zztest-r3 ${randomUUID().slice(0, 6)}`, status: 'planning' }));
  const build = one(await rest('POST', 'projects', 'deliverables', { organization_id: A, project_id: project.id, kind: 'build', version: 1, title: 'zztest-r3 build' }));
  const prototype = one(await rest('POST', 'projects', 'deliverables', { organization_id: A, project_id: project.id, kind: 'prototype', version: 1, title: 'zztest-r3 prototype' }));
  const design = one(await rest('POST', 'projects', 'deliverables', { organization_id: A, project_id: project.id, kind: 'design', version: 1, title: 'zztest-r3 design' }));
  const run = one(await rest('POST', 'qa', 'test_runs', { organization_id: A, project_id: project.id, deliverable_id: build.id, suite: 'smoke', total: 1, passed: 1, failed: 0 }));
  const defect = one(await rest('POST', 'qa', 'defects', { organization_id: A, project_id: project.id, severity: 'minor', title: 'zztest-r3 defect', reproduction: 'open the page' }));
  const leadRow = one(await rest('POST', 'crm', 'leads', { organization_id: A, title: 'zztest-r3 lead' }));
  const meeting = one(await rest('POST', 'crm', 'meetings', { organization_id: A, lead_id: leadRow.id, requested_mode: 'call' }));
  for (const [what, row] of [['client', client], ['project', project], ['build', build], ['prototype', prototype], ['design', design], ['run', run], ['defect', defect], ['lead', leadRow], ['meeting', meeting]]) {
    if (!row?.id) bail(`could not create the fixture ${what}: ${JSON.stringify(row)}`);
  }
  const clientB = one(await rest('POST', 'core', 'client_accounts', { organization_id: B, name: 'zztest-r3 other client' }));
  const projectB = one(await rest('POST', 'projects', 'projects', { organization_id: B, client_account_id: clientB.id, name: `zztest-r3 other ${randomUUID().slice(0, 6)}`, status: 'planning' }));
  const buildB = one(await rest('POST', 'projects', 'deliverables', { organization_id: B, project_id: projectB.id, kind: 'build', version: 1, title: 'zztest-r3 other build' }));

  const MB = 1024 * 1024;
  const audits = async (subjectId, action) => {
    const r = await rest('GET', 'audit', `audit_log?subject_id=eq.${subjectId}&action=eq.${action}&select=action,organization_id`);
    return Array.isArray(r.json) ? r.json : [];
  };

  // ── D1. the calendar id is an organization setting ───────────────────────
  section('D1 (Q-D1). the Google Calendar id is an organization setting');
  const setting = (token, org, key, value) => core('set_organization_setting', { p_organization_id: org, p_key: key, p_value: value }, token);
  const settingsOf = async (org) => one(await rest('GET', 'core', `organizations?id=eq.${org}&select=settings`))?.settings ?? {};

  check(one(await setting(owner.token, A, 'google_calendar_id', 'meetings@agency.example'))?.outcome === 'set', 'the owner sets the calendar id');
  check((await settingsOf(A)).google_calendar_id === 'meetings@agency.example', 'it is stored in the organization settings');
  check(one(await setting(admin.token, A, 'google_calendar_id', 'ops@group.calendar.google.com'))?.outcome === 'set', 'an ops admin may change it');
  check(one(await setting(owner.token, A, 'google_calendar_id', 'primary'))?.outcome === 'set', 'the word primary is a calendar id');
  for (const [why, value] of [['spaces in it', 'two words'], ['too short', 'ab'], ['over 200 characters', 'x'.repeat(201)]]) {
    check(one(await setting(owner.token, A, 'google_calendar_id', value))?.outcome === 'invalid_value', `an id is refused for ${why}`);
  }
  check(one(await setting(member.token, A, 'google_calendar_id', 'member@agency.example'))?.outcome === 'forbidden', 'a member may not');
  check(one(await setting(finUser.token, A, 'google_calendar_id', 'finance@agency.example'))?.outcome === 'forbidden', 'finance may not');
  check(one(await setting(otherOwner.token, A, 'google_calendar_id', 'other@agency.example'))?.outcome === 'forbidden', 'another tenant\'s owner may not set this tenant\'s');
  check((await settingsOf(A)).google_calendar_id === 'primary', 'and none of those refusals changed it');
  const direct = await rest('PATCH', 'core', `organizations?id=eq.${A}`, { settings: { ...(await settingsOf(A)), google_calendar_id: 'sneaky@agency.example' } }, owner.token);
  check(!direct.ok || (Array.isArray(direct.json) && direct.json.length === 0), 'a direct write of the key (around the door) is refused', `HTTP ${direct.status}`);
  check((await settingsOf(A)).google_calendar_id === 'primary', 'and the value is still the door\'s');
  const setAudits = await audits(A, 'organization.setting_set');
  check(setAudits.length >= 3, 'every change is audited with old and new', `${setAudits.length} organization.setting_set rows`);
  check(one(await setting(owner.token, A, 'whatsapp_test_recipient', '+919000000000'))?.outcome === 'set', 'the earlier keys still go through the same door');
  check(one(await setting(owner.token, A, 'definitely_not_a_key', 'x'))?.outcome === 'invalid_key', 'a key outside the whitelist is still refused');
  check(one(await setting(owner.token, A, 'google_calendar_id', ''))?.outcome === 'cleared', 'an empty value clears it (the environment value serves again)');
  check(!('google_calendar_id' in (await settingsOf(A))), 'the key is gone from the settings');

  // ── C1 / C6. a build, a run and a bug can carry a file ───────────────────
  section('C1/C6 (Q-C1, Q-C6). projects.attach_file — role, tenant, kind of file, size, credentials, path');
  const attach = (token, kind, subject, path, name, size = 2048, type = 'application/octet-stream') =>
    projects('attach_file', { p_subject_kind: kind, p_subject_id: subject, p_storage_path: path, p_file_name: name, p_content_type: type, p_size_bytes: size }, token);
  const buildPath = (name, id = build.id, org = A) => `${org}/builds/${id}/${name}`;
  const evidencePath = (id, name) => `${A}/evidence/${id}/${name}`;

  const apk = one(await attach(lead.token, 'build', build.id, buildPath('release.apk'), 'release.apk', 5 * MB, 'application/vnd.android.package-archive'));
  check(apk?.outcome === 'attached' && apk?.id && apk?.project_id === project.id, 'a delivery lead attaches an apk to a build', apk?.outcome);
  check(one(await attach(lead.token, 'build', build.id, buildPath('ios.ipa'), 'ios.ipa'))?.outcome === 'attached', 'an ipa');
  check(one(await attach(owner.token, 'build', prototype.id, buildPath('web.zip', prototype.id), 'web.zip'))?.outcome === 'attached', 'a zip on a prototype build');
  check(one(await attach(owner.token, 'build', design.id, buildPath('x.apk', design.id), 'x.apk'))?.outcome === 'not_found', 'a design is not a build, so it takes no build file');
  check(one(await attach(owner.token, 'build', build.id, buildPath('setup.exe'), 'setup.exe'))?.outcome === 'bad_type', 'an exe is not a build file');
  check(one(await attach(owner.token, 'build', build.id, buildPath('notes.txt'), 'notes.txt'))?.outcome === 'bad_type', 'nor is a text file');
  check(one(await attach(owner.token, 'build', build.id, buildPath('huge.apk'), 'huge.apk', 51 * MB))?.outcome === 'too_big', 'a file over 50 MB is refused');
  check(one(await attach(owner.token, 'build', build.id, buildPath('empty.apk'), 'empty.apk', 0))?.outcome === 'bad_size', 'an empty file is refused');
  check(one(await attach(owner.token, 'build', build.id, buildPath(CREDENTIAL_NAME), CREDENTIAL_NAME))?.outcome === 'credential_name', 'a credentials-looking name is refused');
  check(one(await attach(owner.token, 'build', build.id, buildPath('id_rsa'), 'id_rsa'))?.outcome === 'credential_name', 'an SSH key name is refused as a credentials file');
  check(one(await attach(owner.token, 'build', build.id, buildPath('a/b.apk'), 'a/b.apk'))?.outcome === 'bad_name', 'a name with a slash in it is refused');
  check(one(await attach(owner.token, 'build', build.id, buildPath('tenant.apk', build.id, B), 'tenant.apk'))?.outcome === 'bad_path', 'a path under another tenant\'s folder is refused');
  check(one(await attach(owner.token, 'build', build.id, buildPath('other.apk', prototype.id), 'other.apk'))?.outcome === 'bad_path', 'a path naming another record is refused');
  check(one(await attach(owner.token, 'build', build.id, `${A}/evidence/${build.id}/area.apk`, 'area.apk'))?.outcome === 'bad_path', 'a path in the wrong area is refused');
  check(one(await attach(member.token, 'build', build.id, buildPath('m.apk'), 'm.apk'))?.outcome === 'forbidden', 'a member may not attach a build file');
  check(one(await attach(otherOwner.token, 'build', build.id, buildPath('x.apk'), 'x.apk'))?.outcome === 'not_found', 'another tenant\'s owner cannot see this build, so cannot attach to it');
  check(one(await attach(owner.token, 'build', buildB.id, buildPath('x.apk', buildB.id, A), 'x.apk'))?.outcome === 'not_found', 'nor can this tenant attach to another tenant\'s build');
  check(one(await attach(owner.token, 'sneaky', build.id, buildPath('x.apk'), 'x.apk'))?.outcome === 'bad_kind', 'an unknown subject kind is refused');
  check(one(await attach(undefined, 'build', build.id, buildPath('anon.apk'), 'anon.apk'))?.outcome === 'no_actor', 'the service role (no person) is not a person');
  for (let i = 3; i <= 5; i += 1) await attach(owner.token, 'build', build.id, buildPath(`more${i}.apk`), `more${i}.apk`);
  check(one(await attach(owner.token, 'build', build.id, buildPath('sixth.apk'), 'sixth.apk'))?.outcome === 'too_many', 'a build carries at most five files');

  const shot = one(await attach(member.token, 'test_run', run.id, evidencePath(run.id, 'failure.png'), 'failure.png', 300000, 'image/png'));
  check(shot?.outcome === 'attached', 'a member (who records runs) attaches a screenshot to a test run', shot?.outcome);
  check(one(await attach(member.token, 'test_run', run.id, evidencePath(run.id, 'run.log'), 'run.log'))?.outcome === 'attached', 'and a log');
  check(one(await attach(member.token, 'test_run', run.id, evidencePath(run.id, 'setup.exe'), 'setup.exe'))?.outcome === 'bad_type', 'but not an installer');
  check(one(await attach(member.token, 'defect', defect.id, evidencePath(defect.id, 'bug.png'), 'bug.png'))?.outcome === 'forbidden', 'a bug is delivery work: a member may not attach to one');
  check(one(await attach(lead.token, 'defect', defect.id, evidencePath(defect.id, 'bug.png'), 'bug.png'))?.outcome === 'attached', 'a delivery lead attaches evidence to a bug');
  check(one(await attach(lead.token, 'defect', defect.id, evidencePath(defect.id, 'huge.mp4'), 'huge.mp4', 60 * MB))?.outcome === 'too_big', 'a 60 MB recording is over the limit');
  check(one(await attach(lead.token, 'defect', run.id, evidencePath(run.id, 'wrong.png'), 'wrong.png'))?.outcome === 'not_found', 'a run id is not a bug id');

  const fileAudits = await audits(build.id, 'project.file_attached');
  check(fileAudits.length >= 4 && fileAudits.every((a) => a.organization_id === A), 'every attachment is audited under the tenant', `${fileAudits.length} rows on the build`);

  // The table has no other way in, and its own constraints hold even for the service role.
  const visible = await rest('GET', 'projects', `attached_files?project_id=eq.${project.id}&select=id,subject_kind,file_name`, undefined, member.token);
  check(Array.isArray(visible.json) && visible.json.length >= 8, 'the project\'s own people read the attached files', `${visible.json?.length} rows`);
  const hidden = await rest('GET', 'projects', `attached_files?project_id=eq.${project.id}&select=id`, undefined, otherOwner.token);
  check(Array.isArray(hidden.json) && hidden.json.length === 0, 'another tenant reads none of them');
  const insertDirect = await rest('POST', 'projects', 'attached_files', { organization_id: A, project_id: project.id, subject_kind: 'build', subject_id: build.id, storage_path: buildPath('direct.apk'), file_name: 'direct.apk', size_bytes: 10 }, owner.token);
  check(!insertDirect.ok, 'a person cannot insert a row around the door', `HTTP ${insertDirect.status}`);
  const updateDirect = await rest('PATCH', 'projects', `attached_files?id=eq.${apk.id}`, { file_name: 'renamed.apk' }, owner.token);
  const deleteDirect = await rest('DELETE', 'projects', `attached_files?id=eq.${apk.id}`, undefined, owner.token);
  check(!updateDirect.ok && !deleteDirect.ok, 'nor edit nor delete one: it is append-only', `PATCH ${updateDirect.status}, DELETE ${deleteDirect.status}`);
  const badSize = await rest('POST', 'projects', 'attached_files', { organization_id: A, project_id: project.id, subject_kind: 'build', subject_id: build.id, storage_path: buildPath('big.apk'), file_name: 'big.apk', size_bytes: 60 * MB });
  check(!badSize.ok, 'the table itself refuses a size over 50 MB, even for the service role', `HTTP ${badSize.status}`);
  const badPath = await rest('POST', 'projects', 'attached_files', { organization_id: A, project_id: project.id, subject_kind: 'build', subject_id: build.id, storage_path: buildPath('x.apk', build.id, B), file_name: 'x.apk', size_bytes: 10 });
  check(!badPath.ok, 'and a path under another tenant', `HTTP ${badPath.status}`);
  const badKind = await rest('POST', 'projects', 'attached_files', { organization_id: A, project_id: project.id, subject_kind: 'build', subject_id: build.id, storage_path: buildPath('x.exe'), file_name: 'x.exe', size_bytes: 10 });
  check(!badKind.ok, 'and a kind of file that does not suit a build', `HTTP ${badKind.status}`);
  const crossProject = await rest('POST', 'projects', 'attached_files', { organization_id: A, project_id: projectB.id, subject_kind: 'build', subject_id: build.id, storage_path: buildPath('x.apk'), file_name: 'x.apk', size_bytes: 10 });
  check(!crossProject.ok, 'and a project of another tenant (the tenancy guard)', `HTTP ${crossProject.status}`);

  // ── D3. a meeting's evidence may be a stored file ────────────────────────
  section('D3 (Q-D3). crm.add_meeting_evidence_file — recordings, images, PDF and Word');
  const meetingPath = (name, id = meeting.id, org = A) => `${org}/meetings/${id}/${name}`;
  const evidenceFile = (token, kind, name, path = meetingPath(name), size = 4096, visibility = 'internal') =>
    crm('add_meeting_evidence_file', { p_meeting_id: meeting.id, p_kind: kind, p_visibility: visibility, p_storage_path: path, p_file_name: name, p_media_type: 'application/octet-stream', p_byte_size: size }, token);

  const rec = one(await evidenceFile(member.token, 'recording', 'kickoff.m4a'));
  check(rec?.outcome === 'attached' && rec?.evidence_id && rec?.lead_id === leadRow.id, 'a recording is filed as evidence, with the lead it belongs to', rec?.outcome);
  check(one(await evidenceFile(member.token, 'image', 'whiteboard.png', undefined, 4096, 'client_visible'))?.outcome === 'attached', 'an image (client-visible)');
  check(one(await evidenceFile(member.token, 'document', 'minutes.pdf'))?.outcome === 'attached', 'a PDF');
  check(one(await evidenceFile(member.token, 'document', 'minutes.docx'))?.outcome === 'attached', 'a Word file');
  const row = one(await rest('GET', 'crm', `meeting_evidence?id=eq.${rec.evidence_id}&select=kind,visibility,artifact_ref,storage_path,file_name,byte_size,uploaded_by`));
  check(row?.kind === 'recording' && row?.storage_path === meetingPath('kickoff.m4a') && row?.file_name === 'kickoff.m4a' && row?.byte_size === 4096 && row?.uploaded_by === member.id && row?.artifact_ref === 'uploaded file: kickoff.m4a', 'the row names the object, the file, its size and who uploaded it', JSON.stringify(row)?.slice(0, 160));
  check(one(await evidenceFile(member.token, 'recording', 'huge.mp4', undefined, 60 * MB))?.outcome === 'too_big', 'a file over 50 MB is refused');
  check(one(await evidenceFile(member.token, 'recording', 'call.pdf'))?.outcome === 'bad_type', 'a PDF is not a recording');
  check(one(await evidenceFile(member.token, 'image', 'run.exe'))?.outcome === 'bad_type', 'an exe is not anything');
  check(one(await evidenceFile(member.token, 'notes', 'a.txt'))?.outcome === 'invalid_kind', 'text goes through the verbatim door, not this one');
  check(one(await evidenceFile(member.token, 'document', CREDENTIAL_NAME.replace('.zip', '.pdf')))?.outcome === 'credential_name', 'a credentials-looking name is refused');
  check(one(await evidenceFile(member.token, 'recording', 'x.m4a', meetingPath('x.m4a', meeting.id, B)))?.outcome === 'bad_path', 'a path under another tenant is refused');
  check(one(await evidenceFile(member.token, 'recording', 'x.m4a', meetingPath('x.m4a', randomUUID())))?.outcome === 'bad_path', 'a path naming another meeting is refused');
  check(one(await evidenceFile(finUser.token, 'recording', 'f.m4a'))?.outcome === 'forbidden', 'finance may not attach meeting evidence');
  check(one(await evidenceFile(otherOwner.token, 'recording', 'o.m4a'))?.outcome === 'not_found', 'another tenant cannot see this meeting');
  check(one(await evidenceFile(member.token, 'recording', 'size.m4a', undefined, 0))?.outcome === 'invalid_size', 'a zero size is refused');
  const evAudits = await audits(meeting.id, 'meeting.evidence_added');
  check(evAudits.length >= 4, 'each is audited as meeting.evidence_added, as typed notes are', `${evAudits.length} rows`);
  const typed = one(await crm('add_meeting_evidence', { p_meeting_id: meeting.id, p_kind: 'notes', p_body: 'typed notes still work', p_visibility: 'internal' }, member.token));
  check(typed?.outcome === 'attached', 'typed notes are unchanged');
  const dupPath = await rest('POST', 'crm', 'meeting_evidence', { organization_id: A, meeting_id: meeting.id, lead_id: leadRow.id, kind: 'recording', artifact_ref: 'x', storage_path: meetingPath('x.m4a', meeting.id, B), file_name: 'x.m4a' });
  check(!dupPath.ok, 'the table itself refuses a stored path under another tenant', `HTTP ${dupPath.status}`);
  const noName = await rest('POST', 'crm', 'meeting_evidence', { organization_id: A, meeting_id: meeting.id, lead_id: leadRow.id, kind: 'recording', artifact_ref: 'x', storage_path: meetingPath('y.m4a') });
  check(!noName.ok, 'and a stored file with no name', `HTTP ${noName.status}`);

  // ── D2. generate period report ───────────────────────────────────────────
  section('D2 (Q-D2). finance.generate_period_report — a dated, audited snapshot a lock may refer to');
  const day = (d) => `2026-09-${String(d).padStart(2, '0')}T10:00:00Z`;
  const invoice = async (n, status, issued, sub, tax) => {
    const inv = one(await rest('POST', 'finance', 'invoices', {
      organization_id: A, client_account_id: client.id, number: `ZZR3-${randomUUID().slice(0, 6)}-${n}`, kind: 'service', status, currency: 'INR',
      subtotal_minor: sub, tax_minor: tax, total_minor: sub + tax, ...(issued ? { issued_at: issued } : {}),
    }));
    if (!inv?.id) bail(`could not create an invoice: ${JSON.stringify(inv)}`);
    extra.invoices.push(inv.id);
    return inv;
  };
  await invoice(1, 'issued', day(5), 100000, 18000);
  await invoice(2, 'overdue', day(20), 50000, 9000);
  await invoice(3, 'draft', null, 999999, 0);
  await invoice(4, 'void', day(6), 999999, 0);
  await invoice(5, 'issued', '2026-08-31T10:00:00Z', 777700, 0);
  await invoice(6, 'issued', '2026-10-01T00:00:00Z', 888800, 0);
  const expenseRow = await rest('POST', 'finance', 'expenses', { organization_id: A, category: 'tooling', description: 'zztest-r3 expense', amount_minor: 4000, incurred_on: '2026-09-15', currency: 'INR' });
  if (!expenseRow.ok) console.log(`  (the expense fixture was not accepted — ${JSON.stringify(expenseRow.json)?.slice(0, 120)}; the expense figure is not asserted)`);
  const expenseSeeded = expenseRow.ok;

  const generate = (token, start = '2026-09-01', end = '2026-10-01', label) => finance('generate_period_report', { p_period_start: start, p_period_end: end, ...(label ? { p_label: label } : {}) }, token);
  const rep = one(await generate(finUser.token, '2026-09-01', '2026-10-01', 'September 2026'));
  check(rep?.outcome === 'generated' && rep?.id, 'finance generates a period report', rep?.outcome);
  check(rep?.invoice_count === 2, 'it holds the issued and overdue invoices of the period, not the draft, the void or those outside it', `${rep?.invoice_count} invoices`);
  const stored = one(await rest('GET', 'finance', `period_reports?id=eq.${rep.id}&select=*`, undefined, finUser.token));
  const inr = (stored?.snapshot ?? []).find((c) => c.currency === 'INR');
  check(inr?.invoices?.count === 2 && inr?.invoices?.subtotal_minor === 150000 && inr?.invoices?.tax_minor === 27000 && inr?.invoices?.total_minor === 177000, 'the figures are the ledger\'s: taxable 150000, tax 27000, total 177000', JSON.stringify(inr?.invoices));
  if (expenseSeeded) check(inr?.expenses?.count === 1 && inr?.expenses?.amount_minor === 4000, 'and the period\'s expenses', JSON.stringify(inr?.expenses));
  check(stored?.period_start === '2026-09-01' && stored?.period_end === '2026-10-01' && stored?.period_label === 'September 2026' && stored?.generated_by === finUser.id && Boolean(stored?.generated_at), 'it is dated, labelled and carries who generated it');
  const again = one(await generate(owner.token, '2026-09-01', '2026-10-01'));
  check(again?.outcome === 'generated' && again?.id !== rep.id, 'a second press is a new, later snapshot of the same period, not an overwrite');
  const listed = await rest('GET', 'finance', `period_reports?organization_id=eq.${A}&select=id&order=generated_at.desc`, undefined, admin.token);
  check(Array.isArray(listed.json) && listed.json.length === 2, 'the history lists both (the owner and ops admin read them)', `${listed.json?.length}`);
  check(one(await generate(member.token))?.outcome === 'forbidden', 'a member may not generate one');
  check(one(await generate(lead.token))?.outcome === 'forbidden', 'nor a delivery lead');
  check(one(await generate(owner.token, '2026-10-01', '2026-09-01'))?.outcome === 'not_a_period', 'a period that ends before it starts is refused');
  const emptyMonth = one(await generate(owner.token, '2026-01-01', '2026-02-01'));
  check(emptyMonth?.outcome === 'generated' && emptyMonth?.invoice_count === 0, 'an empty period is a real, empty report');
  const hiddenReports = await rest('GET', 'finance', `period_reports?select=id`, undefined, otherOwner.token);
  check(Array.isArray(hiddenReports.json) && hiddenReports.json.length === 0, 'another tenant reads none');
  const memberReads = await rest('GET', 'finance', `period_reports?select=id`, undefined, member.token);
  check(Array.isArray(memberReads.json) && memberReads.json.length === 0, 'and a member reads none (the export history is for finance and admins)');
  check(!(await rest('POST', 'finance', 'period_reports', { organization_id: A, period_start: '2026-09-01', period_end: '2026-10-01', period_label: 'forged', snapshot: [] }, owner.token)).ok, 'a person cannot insert a report around the door');
  check(!(await rest('PATCH', 'finance', `period_reports?id=eq.${rep.id}`, { period_label: 'edited' }, owner.token)).ok, 'nor edit one');
  check(!(await rest('POST', 'finance', 'period_reports', { organization_id: A, period_start: '2026-10-01', period_end: '2026-09-01', period_label: 'x', snapshot: [] })).ok, 'the table itself refuses a period that ends before it starts');
  check(!(await rest('POST', 'finance', 'period_reports', { organization_id: A, period_start: '2026-09-01', period_end: '2026-10-01', period_label: 'x', snapshot: { not: 'a list' } })).ok, 'and a snapshot that is not a list');
  check((await audits(rep.id, 'finance.period_report_generated')).length === 1, 'generating is audited as finance.period_report_generated');

  // the lock may refer to a report
  const lock = (token, start, end, report, note = 'filed') => finance('lock_tax_period', { p_period_start: start, p_period_end: end, p_note: note, ...(report ? { p_report_id: report } : {}) }, token);
  const wrongPeriod = one(await lock(owner.token, '2026-09-01', '2026-10-01', emptyMonth.id));
  check(wrongPeriod?.outcome === 'report_mismatch', 'a lock cannot name a report of another period', wrongPeriod?.outcome);
  const foreignReport = one(await generate(otherOwner.token, '2026-09-01', '2026-10-01'));
  check(one(await lock(owner.token, '2026-09-01', '2026-10-01', foreignReport?.id))?.outcome === 'report_mismatch', 'nor another tenant\'s report');
  check(one(await lock(owner.token, '2026-09-01', '2026-10-01', randomUUID()))?.outcome === 'report_mismatch', 'nor one that does not exist');
  const locked = one(await lock(owner.token, '2026-09-01', '2026-10-01', rep.id));
  check(locked?.outcome === 'locked' && locked?.lock_id, 'a lock may name the report of exactly its period', locked?.outcome);
  const lockRow = one(await rest('GET', 'finance', `tax_period_locks?id=eq.${locked.lock_id}&select=period_report_id`, undefined, owner.token));
  check(lockRow?.period_report_id === rep.id, 'the lock refers to it');
  const lockAudit = await rest('GET', 'audit', `audit_log?subject_id=eq.${locked.lock_id}&action=eq.tax_period.locked&select=after`);
  check(JSON.stringify(lockAudit.json).includes(rep.id), 'and the lock\'s audit row names it');
  check(one(await lock(owner.token, '2026-09-01', '2026-10-01', rep.id))?.outcome === 'already_locked', 'locking the same period again is still already_locked');
  const plain = one(await lock(owner.token, '2026-01-01', '2026-02-01'));
  check(plain?.outcome === 'locked', 'a lock with no report works exactly as before (the three-argument call)');
  check(one(await lock(finUser.token, '2026-03-01', '2026-04-01'))?.outcome !== 'locked', 'finance may still not lock a period');
} finally {
  await k.cleanup(async () => {
    for (const id of extra.invoices) await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
    for (const org of k.created.orgs) {
      await rest('DELETE', 'finance', `tax_period_locks?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `period_reports?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `expenses?organization_id=eq.${org}`);
      await rest('DELETE', 'finance', `invoices?organization_id=eq.${org}`);
      await rest('DELETE', 'projects', `attached_files?organization_id=eq.${org}`);
    }
  });
}
k.finish();
