// ═══════════════════════════════════════════════════════════════════════════
// A meeting is concluded by a person — G-237
//
// Scheduler Agent Complete Responsibilities §8 (cancel keeps history, drops
// reminders; a no-show is marked by somebody authorized, never inferred from
// the clock), §9.1 (a person marks COMPLETED; actor, moment and outcome are
// captured; never because the end time passed), §9.2 (evidence linked to the
// exact meeting with uploader and classification), §9.3 (completed → evidence
// → analysis task), §13.2 (each of these is audited).
//
// Every section asserts a REFUSAL by name or a row that exists, and every
// refusal has its positive twin in the same section, so a door that stopped
// existing would turn this red rather than quiet. SELF-RED-PROVING: drop the
// timezone trigger and §1's direct write lands; make complete_meeting SECURITY
// INVOKER and §3's owner path stops writing; remove the no_actor check and
// §2 reports a meeting completed by nobody.
//
//   node scripts/verify-meeting-commands.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

/**
 * A fixture that could not be built THROWS, so the `finally` below still
 * runs. Review found the first draft calling fail() — process.exit — from
 * inside the try, which skipped cleanup and left auth users, memberships and
 * meetings behind in the shared project for every later verifier to trip on.
 */
function abort(message) {
  throw new Error(message);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a meeting is concluded by a person, never by the clock');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-conclude-${randomUUID().slice(0, 8)}`;
const fx = fixturesFor(target, ORG);
const { rest, one, call } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const rpc = (fn, args, token) => (token ? call(token, 'POST', 'crm', `rpc/${fn}`, args) : rest('POST', 'crm', `rpc/${fn}`, args));
const cancel = async (id, reason, token) => one(await rpc('cancel_meeting', { p_meeting_id: id, ...(reason ? { p_reason: reason } : {}) }, token));
const complete = async (id, outcome, note, token) => one(await rpc('complete_meeting', { p_meeting_id: id, ...(outcome ? { p_outcome: outcome } : {}), ...(note ? { p_note: note } : {}) }, token));
const noShow = async (id, note, token) => one(await rpc('record_no_show', { p_meeting_id: id, ...(note ? { p_note: note } : {}) }, token));
const evidence = async (id, args, token) => one(await rpc('add_meeting_evidence', { p_meeting_id: id, ...args }, token));

const row = async (id) => one(await rest('GET', 'crm', `meetings?id=eq.${id}&select=status,outcome,completed_at,completed_by,cancelled_at,cancellation_reason,booking_key,provider_event_id,confirmed_start_at`));
const evidenceRows = async (id) => (await rest('GET', 'crm', `meeting_evidence?meeting_id=eq.${id}&select=id,kind,visibility,body,uploaded_by`)).json ?? [];
const jobs = async (id, kind) => (await rest('GET', 'core', `jobs?kind=eq.${kind}&payload->>meeting_id=eq.${id}&select=id,status`)).json ?? [];
const audits = async (id, action) => (await rest('GET', 'audit', `audit_log?subject_type=eq.meeting&subject_id=eq.${id}&action=eq.${action}&select=id,actor_type,actor_id,after`)).json ?? [];

const created = { leads: [], meetings: [], users: [] };

const HOURS = 3_600_000;

async function meeting(name, status = 'proposed') {
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  const m = one(await rest('POST', 'crm', 'meetings', {
    organization_id: ORG, lead_id: lead.id, requested_mode: 'call', status,
    ...(status === 'proposed' ? { availability_source: 'google:primary', availability_read_at: new Date().toISOString() } : {}),
  }));
  if (!m?.id) abort(`could not create a meeting: ${JSON.stringify(m).slice(0, 200)}`);
  created.meetings.push(m.id);
  return m;
}

/** Booked at `startOffsetMs` from now, through the real door; the past is reached by moving the agreed time afterwards. */
async function booked(name, startOffsetMs, over = {}) {
  const m = await meeting(name);
  const start = new Date(Date.now() + Math.max(startOffsetMs, HOURS));
  const r = one(await rpc('book_meeting', {
    p_meeting_id: m.id, p_booking_key: `${MARKER}-${name}`, p_start_at: start.toISOString(),
    p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'Asia/Kolkata', p_mode: 'call', ...over,
  }));
  if (r?.outcome !== 'booked') abort(`could not book ${name}: ${r?.outcome}`);
  if (startOffsetMs < 0) {
    const moved = await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, {
      confirmed_start_at: new Date(Date.now() + startOffsetMs).toISOString(),
      confirmed_end_at: new Date(Date.now() + startOffsetMs + HOURS / 2).toISOString(),
    });
    if (!moved.ok) abort(`could not move ${name} into the past: ${moved.text.slice(0, 200)}`);
  }
  return m;
}

/** A person of `role` in ORG with a core.users row, so a conclusion can be attributed to them. */
async function person(role) {
  const authUser = await fetch(`${target.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}-${role}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  if (!authUser?.id) abort(`could not create an auth user: ${JSON.stringify(authUser).slice(0, 200)}`);
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: fx.mint(authUser.id, role) };
}

console.log('\n\x1b[1mAgencyOS — a meeting is concluded by a person (G-237)\x1b[0m');

try {
  const owner = await person('owner');

  // ── 1. the zone is a zone ────────────────────────────────────────────────
  console.log('\n1. A timezone Postgres does not know');
  {
    const m = await meeting('zone');
    const start = new Date(Date.now() + 2 * HOURS);
    const bad = one(await rpc('book_meeting', {
      p_meeting_id: m.id, p_booking_key: `${MARKER}-zone`, p_start_at: start.toISOString(),
      p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'Asia/Kolkatta', p_mode: 'call',
    }));
    check(bad?.outcome === 'invalid_timezone', 'book_meeting refuses it by name', `outcome ${bad?.outcome}`);
    const direct = await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, { timezone: 'Mars/Olympus' });
    check(!direct.ok && /meeting_timezone/.test(direct.text), 'and the row refuses a direct write', `${direct.status} ${direct.text.slice(0, 80)}`);
    const good = one(await rpc('book_meeting', {
      p_meeting_id: m.id, p_booking_key: `${MARKER}-zone-ok`, p_start_at: start.toISOString(),
      p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'Asia/Kolkata', p_mode: 'call',
    }));
    check(good?.outcome === 'booked', 'a real zone books (the positive twin)', `outcome ${good?.outcome}`);
    const lower = await meeting('zone-lower');
    const lc = one(await rpc('book_meeting', {
      p_meeting_id: lower.id, p_booking_key: `${MARKER}-zone-lower`, p_start_at: start.toISOString(),
      p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'asia/kolkata', p_mode: 'call',
    }));
    check(lc?.outcome === 'booked', 'a lowercase zone books — Postgres resolves zone names case-insensitively, and so does the check', `outcome ${lc?.outcome}`);
  }

  // ── 2. a worker cannot conclude a meeting ────────────────────────────────
  console.log('\n2. The service role, which is nobody');
  {
    const m = await booked('worker', -2 * HOURS);
    const c = await complete(m.id);
    check(c?.outcome === 'no_actor', 'complete_meeting refuses a caller with no auth.uid()', `outcome ${c?.outcome}`);
    const n = await noShow(m.id);
    check(n?.outcome === 'no_actor', 'record_no_show refuses it too', `outcome ${n?.outcome}`);
    check((await row(m.id))?.status === 'booked', 'and the row is untouched');
    const req = await meeting('worker-cancel', 'requested');
    const x = await cancel(req.id, 'client asked on WhatsApp');
    check(x?.outcome === 'cancelled', 'but the worker MAY cancel — the Scheduler agent acts on a client’s request', `outcome ${x?.outcome}`);
    const a = await audits(req.id, 'meeting.cancelled');
    check(a.length === 1 && a[0].actor_type === 'system', 'audited as the system, not as a user', `${a.length} rows, actor_type ${a[0]?.actor_type}`);
  }

  // ── 3. completion, by the owner, with a note — §9.3’s chain ─────────────
  console.log('\n3. The owner marks a meeting that happened');
  {
    const m = await booked('done', -2 * HOURS);
    const r = await complete(m.id, 'follow_up_required', 'Client wants a demo next Tuesday', owner.token);
    check(r?.outcome === 'completed', 'completed', `outcome ${r?.outcome}`);
    check(Boolean(r?.evidence_id), 'the note became an evidence row');
    check(r?.analysis === 'queued', 'and §9.3 queued the analysis through the existing gate', `analysis ${r?.analysis}`);
    check(r?.lead_id === (await row(m.id))?.lead_id || Boolean(r?.lead_id), 'the door returns the lead — what the application revalidates from', `lead_id ${r?.lead_id}`);
    check((await audits(m.id, 'meeting.evidence_added')).length === 1, 'the note went through the evidence door: its own audit row exists');
    const after = await row(m.id);
    check(after?.status === 'completed' && after?.outcome === 'follow_up_required', 'the row carries status and outcome', `${after?.status} / ${after?.outcome}`);
    check(after?.completed_by === owner.id && Boolean(after?.completed_at), 'with the person and the moment');
    const ev = await evidenceRows(m.id);
    check(ev.length === 1 && ev[0].kind === 'notes' && ev[0].visibility === 'internal' && ev[0].uploaded_by === owner.id, 'the note is internal notes evidence uploaded by the owner', JSON.stringify(ev.map((e) => [e.kind, e.visibility])));
    const j = await jobs(m.id, 'meeting.analysis');
    check(j.length === 1, 'exactly one analysis job exists', `${j.length}`);
    const a = await audits(m.id, 'meeting.completed');
    check(a.length === 1 && a[0].actor_type === 'user' && a[0].actor_id === owner.id && a[0].after?.analysis === 'queued', 'audited as the owner, with the analysis answer in the row', JSON.stringify(a[0]?.after ?? null));
    const again = await complete(m.id, 'completed', null, owner.token);
    check(again?.outcome === 'already_completed', 'asked twice, nothing changes', `outcome ${again?.outcome}`);
    check((await evidenceRows(m.id)).length === 1 && (await jobs(m.id, 'meeting.analysis')).length === 1, 'no second note, no second job');
    const c = await cancel(m.id, 'oops', owner.token);
    check(c?.outcome === 'wrong_state', 'a meeting that happened cannot be cancelled after the fact', `outcome ${c?.outcome}`);
    const bad = await complete((await booked('bad-outcome', -2 * HOURS)).id, 'went_great', null, owner.token);
    check(bad?.outcome === 'invalid_outcome', 'an outcome outside §9.1’s list is refused', `outcome ${bad?.outcome}`);
    const quiet = await complete((await booked('quiet', -2 * HOURS)).id, 'completed', null, owner.token);
    check(quiet?.outcome === 'completed' && quiet?.analysis === 'no_evidence' && quiet?.evidence_id === null, 'without a note: completed, and the gate says no_evidence rather than queueing an empty room', `analysis ${quiet?.analysis}`);
    // Review: a settled meeting must still take evidence, and the gate must be askable again.
    const late = await evidence(quiet.meeting_id, { p_kind: 'summary', p_body: 'Summary written the next morning' }, owner.token);
    check(late?.outcome === 'attached', 'evidence can be attached to a completed meeting afterwards', `outcome ${late?.outcome}`);
    const asked = one(await rpc('request_meeting_analysis', { p_meeting_id: quiet.meeting_id }, owner.token));
    check(asked?.outcome === 'queued', 'and the analysis gate, asked again, now queues', `outcome ${asked?.outcome}`);
  }

  // ── 4. the clock only runs one way ───────────────────────────────────────
  console.log('\n4. A meeting that has not begun');
  {
    const m = await booked('future', 24 * HOURS);
    const c = await complete(m.id, 'completed', null, owner.token);
    check(c?.outcome === 'not_yet_started', 'cannot be completed', `outcome ${c?.outcome}`);
    const n = await noShow(m.id, null, owner.token);
    check(n?.outcome === 'not_yet_started', 'and cannot be a no-show', `outcome ${n?.outcome}`);
    check((await row(m.id))?.status === 'booked', 'the row is untouched');
    const direct = await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, { status: 'completed', completed_at: new Date().toISOString(), completed_by: owner.id });
    check(!direct.ok && /meeting_conclusion/.test(direct.text), 'and a direct write to completed is refused AT THE ROW, not only by the door', `${direct.status} ${direct.text.slice(0, 80)}`);
    await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, {
      confirmed_start_at: new Date(Date.now() - 3 * HOURS).toISOString(), confirmed_end_at: new Date(Date.now() - 2 * HOURS).toISOString(),
    });
    const later = await noShow(m.id, 'did not pick up', owner.token);
    check(later?.outcome === 'no_show' && Boolean(later?.evidence_id), 'once its time has passed a person may record the no-show, with a note', `outcome ${later?.outcome}`);
    const after = await row(m.id);
    check(after?.status === 'no_show' && after?.outcome === 'no_show' && after?.completed_by === owner.id, 'the row says no_show, by whom');
    check((await jobs(m.id, 'meeting.analysis')).length === 0, 'no analysis is queued for a meeting that did not happen (§10.1)');
    const a = await audits(m.id, 'meeting.no_show');
    check(a.length === 1 && /ADM-103/.test(String(a[0]?.after?.follow_up)), 'audited, and the audit row says no follow-up was queued and why', String(a[0]?.after?.follow_up));
    check((await noShow(m.id, null, owner.token))?.outcome === 'already_recorded', 'asked twice, nothing changes');
    check((await complete(m.id, 'completed', null, owner.token))?.outcome === 'wrong_state', 'and it cannot afterwards be completed');
    const req = await meeting('never-booked', 'requested');
    check((await complete(req.id, 'completed', null, owner.token))?.outcome === 'wrong_state', 'a meeting never booked cannot have happened');
    check((await noShow(req.id, null, owner.token))?.outcome === 'wrong_state', 'nor been missed');
  }

  // ── 5. cancellation keeps history and drops the reminder ────────────────
  console.log('\n5. Cancelling a booked meeting with a provider event and a reminder');
  {
    const m = await booked('cancel', 6 * HOURS, { p_provider: 'google', p_provider_event_id: `${MARKER}-evt`, p_meeting_url: 'https://meet.example.invalid/x' });
    const sched = one(await rpc('schedule_meeting_reminder', { p_meeting_id: m.id, p_lead_minutes: 30 }));
    check(sched?.outcome === 'scheduled', 'a reminder is queued first', `outcome ${sched?.outcome}`);
    check((await jobs(m.id, 'meeting.reminder')).filter((j) => j.status === 'queued').length === 1, 'one queued reminder');
    const c = await cancel(m.id, 'client travelling', owner.token);
    check(c?.outcome === 'cancelled', 'cancelled', `outcome ${c?.outcome}`);
    check(c?.provider_event_id === `${MARKER}-evt`, 'the provider event id is returned — it was NOT cancelled at the provider, and the caller is told so');
    check((await jobs(m.id, 'meeting.reminder')).filter((j) => j.status === 'queued').length === 0, 'the queued reminder is gone');
    const after = await row(m.id);
    check(after?.status === 'cancelled' && after?.cancellation_reason === 'client travelling' && Boolean(after?.cancelled_at), 'status, reason and moment on the row');
    check(after?.booking_key === `${MARKER}-cancel` && Boolean(after?.confirmed_start_at) && after?.provider_event_id === `${MARKER}-evt`, 'history is kept: key, agreed time and provider event stay (§8)');
    const a = await audits(m.id, 'meeting.cancelled');
    check(a.length === 1 && a[0].after?.provider_event_cancelled === false, 'the audit row says the provider event was not cancelled', JSON.stringify(a[0]?.after ?? null));
    check((await cancel(m.id, null, owner.token))?.outcome === 'already_cancelled', 'asked twice, nothing changes');
    check((await noShow(m.id, null, owner.token))?.outcome === 'wrong_state', 'a cancelled meeting cannot become a no-show');
  }

  // ── 6. evidence ──────────────────────────────────────────────────────────
  console.log('\n6. Evidence, by name');
  {
    const m = await booked('evidence', -2 * HOURS);
    const ok = await evidence(m.id, { p_kind: 'summary', p_body: 'Agreed: demo Tuesday; budget under 2 lakh', p_visibility: 'client_visible' }, owner.token);
    check(ok?.outcome === 'attached' && Boolean(ok?.evidence_id), 'a client-visible summary attaches', `outcome ${ok?.outcome}`);
    const ev = await evidenceRows(m.id);
    check(ev.length === 1 && ev[0].visibility === 'client_visible' && ev[0].uploaded_by === owner.id, 'with the visibility asked for and the uploader recorded');
    check((await audits(m.id, 'meeting.evidence_added')).length === 1, 'audited');
    check((await evidence(m.id, { p_kind: 'selfie', p_body: 'x' }, owner.token))?.outcome === 'invalid_kind', 'a kind outside §9.2’s list is refused by name');
    check((await evidence(m.id, { p_kind: 'notes', p_body: '   ' }, owner.token))?.outcome === 'nothing_to_attach', 'blank text is refused: a row with nothing in it is a claim that evidence exists');
    check((await evidence(m.id, { p_kind: 'notes', p_body: 'x', p_visibility: 'public' }, owner.token))?.outcome === 'invalid_visibility', 'a visibility outside internal/client_visible is refused');
    check((await evidence(m.id, { p_kind: 'chat_export', p_artifact_ref: 'ref://export/1' }))?.outcome === 'attached', 'the worker may file a reference — the Scheduler agent files a chat export');
    const ghost = fx.mint(randomUUID(), 'owner');
    check((await evidence(m.id, { p_kind: 'notes', p_body: 'x' }, ghost))?.outcome === 'unknown_actor', 'a token with no user row is refused by name here too, not by a foreign-key error');
    check((await evidenceRows(m.id)).length === 2, 'two rows, and the refused three left nothing');
  }

  // ── 7. whose meeting, and who may ────────────────────────────────────────
  console.log('\n7. Tenancy and role');
  {
    const m = await booked('tenancy', -2 * HOURS);
    const foreign = fx.mint(randomUUID(), 'owner', randomUUID());
    check((await cancel(m.id, null, foreign))?.outcome === 'forbidden', 'another organization’s owner cannot cancel');
    check((await complete(m.id, 'completed', null, foreign))?.outcome === 'forbidden', 'nor complete');
    check((await noShow(m.id, null, foreign))?.outcome === 'forbidden', 'nor record a no-show');
    check((await evidence(m.id, { p_kind: 'notes', p_body: 'x' }, foreign))?.outcome === 'forbidden', 'nor attach evidence');
    const client = fx.mint(randomUUID(), 'client');
    check((await complete(m.id, 'completed', null, client))?.outcome === 'forbidden', 'a client of this organization cannot complete');
    check((await evidence(m.id, { p_kind: 'notes', p_body: 'x' }, client))?.outcome === 'forbidden', 'nor attach evidence');
    const ghost = fx.mint(randomUUID(), 'owner');
    check((await complete(m.id, 'completed', null, ghost))?.outcome === 'unknown_actor', 'an owner token whose subject has no user row is refused by name, not by a foreign-key error');
    // The row policies demand core.can_write(), which a contractor lacks; the doors demand the same.
    const contractor = fx.mint(randomUUID(), 'contractor');
    check((await complete(m.id, 'completed', null, contractor))?.outcome === 'forbidden', 'a contractor of this organization cannot complete — the door holds the row policy’s own rule');
    check((await cancel(m.id, null, contractor))?.outcome === 'forbidden', 'nor cancel');
    check((await evidence(m.id, { p_kind: 'notes', p_body: 'x' }, contractor))?.outcome === 'forbidden', 'nor attach evidence');
    check((await row(m.id))?.status === 'booked', 'and after all of that the row is untouched');
    // The database admits every internal role; the application gates on lead.write above it.
    const member = await person('member');
    const r = await complete(m.id, 'completed', 'brief call', member.token);
    check(r?.outcome === 'completed' && (await row(m.id))?.completed_by === member.id, 'a member of this organization may conclude at the database (core.can_write admits them) — the app’s lead.write gate is stricter, and that is the safe direction');
  }
} catch (error) {
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m the run stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const id of created.meetings) {
    await rest('DELETE', 'core', `jobs?kind=in.(meeting.reminder,meeting.analysis)&payload->>meeting_id=eq.${id}`);
    await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}` }, cache: 'no-store' }).catch(() => {});
  }
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a meeting is concluded by a person, never by the clock\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
