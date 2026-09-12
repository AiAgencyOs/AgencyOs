// ═══════════════════════════════════════════════════════════════════════════
// A slot is offered, and taken — G-243
//
// Scheduler §5 (what is offered was READ), §6.1 (up to three, with duration),
// §6.2 (a proposal is a state before a confirmation; revalidate), §6.3 (the
// row's own door, with the provider event). The two doors this drives are
// the offer and the re-check; the booking door is G-227's, driven here with
// the freshness the re-check gives it. The Google half is the stand-in's in
// the unit suite; nothing in CI holds a credential.
//
// Every section asserts a refusal by name with its positive twin.
//
//   node scripts/verify-slot-offer.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}
function abort(message) { throw new Error(message); }

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a slot is offered from what was read, and taken after a re-check');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-offer-${randomUUID().slice(0, 8)}`;
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
const HOURS = 3_600_000;
const created = { leads: [], meetings: [] };

async function meeting(name, status = 'requested') {
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  const m = one(await rest('POST', 'crm', 'meetings', { organization_id: ORG, lead_id: lead.id, requested_mode: 'call', status }));
  if (!m?.id) abort(`could not create a meeting: ${JSON.stringify(m).slice(0, 200)}`);
  created.meetings.push(m.id);
  return m;
}
const row = async (id) => one(await rest('GET', 'crm', `meetings?id=eq.${id}&select=status,proposed_slots,availability_source,availability_read_at,duration_minutes,provider,provider_event_id,meeting_url,booking_key`));
const audits = async (id, action) => (await rest('GET', 'audit', `audit_log?subject_type=eq.meeting&subject_id=eq.${id}&action=eq.${action}&select=id,after`)).json ?? [];
const slot = (h, minutes = 30) => { const s = new Date(Date.now() + h * HOURS); s.setUTCMinutes(0, 0, 0); return { startAt: s.toISOString(), endAt: new Date(s.getTime() + minutes * 60_000).toISOString() }; };
const READ = { p_availability_source: 'google:meetings@agency.example', p_availability_read_at: new Date().toISOString() };

console.log('\n\x1b[1mAgencyOS — a slot is offered, and taken (G-243)\x1b[0m');

try {
  // ── 1. the offer ─────────────────────────────────────────────────────────
  console.log('\n1. The offer: up to three slots that were read');
  {
    const m = await meeting('offer');
    const three = [slot(24), slot(26), slot(48)];
    const r = one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: three, ...READ, p_duration_minutes: 30 }));
    check(r?.outcome === 'proposed', 'three slots with a source and a moment are proposed', `outcome ${r?.outcome}`);
    const after = await row(m.id);
    check(after?.status === 'proposed' && Array.isArray(after?.proposed_slots) && after.proposed_slots.length === 3, 'the row is proposed and carries the offer');
    check(after?.availability_source === 'google:meetings@agency.example' && Boolean(after?.availability_read_at) && after?.duration_minutes === 30, 'with the source, the moment and the duration');
    check((await audits(m.id, 'meeting.proposed')).length === 1, 'audited as meeting.proposed');
    // §5.3: a re-offer after "none of those work" is the same door.
    const again = one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(72)], ...READ, p_duration_minutes: 30 }));
    check(again?.outcome === 'proposed' && (await row(m.id))?.proposed_slots?.length === 1, 'a re-offer replaces the offer (§5.3)');
  }

  // ── 2. what cannot be offered ─────────────────────────────────────────────
  console.log('\n2. What cannot be offered, by name');
  {
    const m = await meeting('refusals');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [], ...READ, p_duration_minutes: 30 })))?.outcome === 'nothing_to_offer', 'an empty offer is nothing_to_offer, not a proposal');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24)], p_availability_source: null, p_availability_read_at: null, p_duration_minutes: 30 })))?.outcome === 'never_checked', 'an offer with no read behind it is refused (§5: never invent)');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24), slot(26), slot(28), slot(30)], ...READ, p_duration_minutes: 30 })))?.outcome === 'invalid_slots', 'four is more than §6.1 offers');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [{ startAt: 'tuesday', endAt: 'later' }], ...READ, p_duration_minutes: 30 })))?.outcome === 'invalid_slots', 'a slot that is not an instant pair');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24, 20)], ...READ, p_duration_minutes: 30 })))?.outcome === 'invalid_slots', 'a slot shorter than the meeting');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24)], ...READ, p_duration_minutes: 3 })))?.outcome === 'invalid_duration', 'a three-minute meeting');
    check((await row(m.id))?.status === 'requested', 'and after all of that the row is untouched');
    const direct = await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, { proposed_slots: [slot(1), slot(2), slot(3), slot(4)] });
    check(!direct.ok && /proposed_slots_are_a_list/.test(direct.text), 'the row itself refuses more than three, whoever writes', `${direct.status}`);
  }

  // ── 3. the re-check, then the booking through G-227's door ───────────────
  console.log('\n3. The re-check gives the booking its freshness');
  {
    const m = await meeting('book');
    const s = slot(24);
    one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [s], p_availability_source: 'google:meetings@agency.example', p_availability_read_at: new Date(Date.now() - 2 * HOURS).toISOString(), p_duration_minutes: 30 }));
    const stale = one(await rpc('book_meeting', { p_meeting_id: m.id, p_booking_key: `${MARKER}-stale`, p_start_at: s.startAt, p_end_at: s.endAt, p_timezone: 'Asia/Kolkata', p_mode: 'call' }));
    check(stale?.outcome === 'stale_availability', 'a booking on a two-hour-old read is refused by G-227', `outcome ${stale?.outcome}`);
    const future = one(await rpc('note_availability_read', { p_meeting_id: m.id, p_availability_source: 'google:meetings@agency.example', p_availability_read_at: new Date(Date.now() + HOURS).toISOString() }));
    check(future?.outcome === 'never_checked', 'a re-check claimed from the future is not a read');
    const noted = one(await rpc('note_availability_read', { p_meeting_id: m.id, p_availability_source: 'google:meetings@agency.example', p_availability_read_at: new Date().toISOString() }));
    check(noted?.outcome === 'noted', 'the re-check is noted', `outcome ${noted?.outcome}`);
    const booked = one(await rpc('book_meeting', { p_meeting_id: m.id, p_booking_key: `meeting:${m.id}:${s.startAt}`, p_start_at: s.startAt, p_end_at: s.endAt, p_timezone: 'Asia/Kolkata', p_mode: 'video_meeting', p_provider: 'google', p_provider_event_id: `${MARKER}-evt`, p_meeting_url: 'https://meet.google.com/zzz-test-stub' }));
    check(booked?.outcome === 'booked', 'and the booking lands, with the provider event and the link', `outcome ${booked?.outcome}`);
    const after = await row(m.id);
    check(after?.status === 'booked' && after?.provider === 'google' && after?.provider_event_id === `${MARKER}-evt` && after?.meeting_url === 'https://meet.google.com/zzz-test-stub', 'the row carries provider, event id and link (§6.3)');
    check((one(await rpc('note_availability_read', { p_meeting_id: m.id, p_availability_source: 'google:x', p_availability_read_at: new Date().toISOString() })))?.outcome === 'wrong_state', 'a booked meeting is not re-checked');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(48)], ...READ, p_duration_minutes: 30 })))?.outcome === 'wrong_state', 'nor offered times');
  }

  // ── 4. whose meeting ─────────────────────────────────────────────────────
  console.log('\n4. Tenancy and role');
  {
    const m = await meeting('tenancy');
    const foreign = fx.mint(randomUUID(), 'owner', randomUUID());
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24)], ...READ, p_duration_minutes: 30 }, foreign)))?.outcome === 'forbidden', 'another organization’s owner cannot offer');
    check((one(await rpc('note_availability_read', { p_meeting_id: m.id, ...READ }, foreign)))?.outcome === 'forbidden', 'nor re-check');
    const contractor = fx.mint(randomUUID(), 'contractor');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24)], ...READ, p_duration_minutes: 30 }, contractor)))?.outcome === 'forbidden', 'a contractor cannot offer — the row policy’s own rule');
    check((one(await rpc('propose_meeting_slots', { p_meeting_id: m.id, p_slots: [slot(24)], ...READ, p_duration_minutes: 30 })))?.outcome === 'proposed', 'the service role may (the positive twin)');
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
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a slot is offered from what was read, and taken after a re-check\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
