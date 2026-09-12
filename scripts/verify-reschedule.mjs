// ═══════════════════════════════════════════════════════════════════════════
// A reschedule is a new row — G-244
//
// Scheduler §8: "Reschedule request → identify current booking → … →
// rebook → update reminders. Critical control: preserve old booking
// history." Driven against the real database through the door: the booked
// row is cancelled with a reason that says rescheduled and every other
// column as it was, its queued reminder is dropped by the existing trigger,
// a new requested row carries supersedes_id and what identifies the
// meeting, and the new row goes through the offer and the booking like any
// other. Every refusal by name, with its positive twin.
//
//   node scripts/verify-reschedule.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) { console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`); process.exit(1); }
function abort(message) { throw new Error(message); }

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a reschedule is a new row, and the old one is history');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-resched-${randomUUID().slice(0, 8)}`;
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
const created = { contacts: [], leads: [], conversations: [], meetings: [], users: [] };

async function person(role) {
  const authUser = await fetch(`${target.url}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}-${role}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  if (!authUser?.id) abort(`could not create an auth user: ${JSON.stringify(authUser).slice(0, 200)}`);
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: fx.mint(authUser.id, role) };
}

/** A booked meeting with a contact, a thread, a purpose, a provider event and a queued reminder. */
async function bookedMeeting(name) {
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} ${name}`, phone: `+9197${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-8)}` }));
  created.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, channel: 'whatsapp', external_ref: `${MARKER}:${name}`, status: 'active' }));
  created.conversations.push(conv.id);
  const m = one(await rest('POST', 'crm', 'meetings', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id, conversation_id: conv.id, requested_mode: 'call', purpose: 'Discovery', status: 'proposed',
    availability_source: 'google:meetings@agency.example', availability_read_at: new Date().toISOString(),
  }));
  if (!m?.id) abort(`could not create a meeting: ${JSON.stringify(m).slice(0, 200)}`);
  created.meetings.push(m.id);
  const start = new Date(Date.now() + 2 * 24 * HOURS); start.setUTCMinutes(0, 0, 0);
  const booked = one(await rpc('book_meeting', { p_meeting_id: m.id, p_booking_key: `${MARKER}-${name}`, p_start_at: start.toISOString(), p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'Europe/London', p_mode: 'video_meeting', p_provider: 'google', p_provider_event_id: `${MARKER}-${name}-evt`, p_meeting_url: 'https://meet.google.com/zzz-stub' }));
  if (booked?.outcome !== 'booked') abort(`could not book ${name}: ${booked?.outcome}`);
  const reminder = one(await rpc('schedule_meeting_reminder', { p_meeting_id: m.id, p_lead_minutes: 30 }));
  if (reminder?.outcome !== 'scheduled') abort(`could not schedule a reminder for ${name}: ${reminder?.outcome}`);
  return { meeting: m, lead, contact, conversationId: conv.id, start };
}
const row = async (id) => one(await rest('GET', 'crm', `meetings?id=eq.${id}&select=*`));
const reminders = async (id) => ((await rest('GET', 'core', `jobs?kind=eq.meeting.reminder&payload->>meeting_id=eq.${id}&status=eq.queued&select=id`)).json ?? []).length;
const audits = async (id, action) => (await rest('GET', 'audit', `audit_log?subject_type=eq.meeting&subject_id=eq.${id}&action=eq.${action}&select=id,actor_type,after`)).json ?? [];

console.log('\n\x1b[1mAgencyOS — a reschedule is a new row (G-244)\x1b[0m');

try {
  const owner = await person('owner');

  console.log('\n1. The booking becomes history; a new request carries what identifies the meeting');
  {
    const { meeting, lead, contact, conversationId, start } = await bookedMeeting('move');
    check((await reminders(meeting.id)) === 1, 'a reminder is queued for the booking');
    const r = one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id, p_reason: 'client is travelling that day', p_requested_mode: 'call' }, owner.token));
    check(r?.outcome === 'rescheduled' && Boolean(r?.new_meeting_id), 'rescheduled, with the new row named', `outcome ${r?.outcome}`);
    check(r?.provider_event_id === `${MARKER}-move-evt`, 'the provider event is returned for the adapter to take back');
    created.meetings.push(r.new_meeting_id);
    const old = await row(meeting.id);
    check(old?.status === 'cancelled' && old?.cancellation_reason === 'rescheduled: client is travelling that day', 'the old row is cancelled with a reason that says rescheduled', old?.cancellation_reason);
    // Timestamps compared as instants: PostgREST renders `+00:00` and drops zero fractions, so a string equality against toISOString() can never be true (CI's first run, and the review, both said so).
    check(Date.parse(old?.confirmed_start_at ?? '') === start.getTime() && old?.booking_key === `${MARKER}-move` && old?.provider_event_id === `${MARKER}-move-evt` && old?.meeting_url === 'https://meet.google.com/zzz-stub', 'and every other column exactly as it was (§8: preserve history)');
    check((await reminders(meeting.id)) === 0, 'its queued reminder is dropped by the existing trigger');
    const fresh = await row(r.new_meeting_id);
    check(fresh?.status === 'requested' && fresh?.supersedes_id === meeting.id, 'the new row is requested and carries supersedes_id');
    check(fresh?.lead_id === lead.id && fresh?.contact_id === contact.id && fresh?.conversation_id === conversationId, 'with the lead, the contact and the thread');
    check(fresh?.requested_mode === 'call' && fresh?.timezone === 'Europe/London' && fresh?.duration_minutes === 30 && fresh?.purpose === 'Discovery', 'the mode the client now asks for, the zone, the duration and the purpose');
    check(fresh?.created_by === owner.id && fresh?.confirmed_start_at === null && fresh?.booking_key === null && fresh?.provider_event_id === null, 'created by the person, and nothing booked yet');
    const a = await audits(meeting.id, 'meeting.rescheduled');
    check(a.length === 1 && a[0].actor_type === 'user' && a[0].after?.new_meeting_id === r.new_meeting_id && a[0].after?.provider_event_cancelled === false, 'audited on the old row, naming the new one and that the provider event was not cancelled here');
    check((await audits(meeting.id, 'meeting.cancelled')).length === 0, 'not audited as a plain cancellation');

    // The new row goes through the offer and the booking like any other.
    const s = new Date(Date.now() + 3 * 24 * HOURS); s.setUTCMinutes(0, 0, 0);
    const offered = one(await rpc('propose_meeting_slots', { p_meeting_id: r.new_meeting_id, p_slots: [{ startAt: s.toISOString(), endAt: new Date(s.getTime() + HOURS / 2).toISOString() }], p_availability_source: 'google:meetings@agency.example', p_availability_read_at: new Date().toISOString(), p_duration_minutes: 30 }, owner.token));
    check(offered?.outcome === 'proposed', 'the new row is offered a time through G-243’s door', `outcome ${offered?.outcome}`);
    const rebooked = one(await rpc('book_meeting', { p_meeting_id: r.new_meeting_id, p_booking_key: `meeting:${r.new_meeting_id}:${s.toISOString()}`, p_start_at: s.toISOString(), p_end_at: new Date(s.getTime() + HOURS / 2).toISOString(), p_timezone: 'Europe/London', p_mode: 'call', p_provider: 'google', p_provider_event_id: `${MARKER}-move-evt-2` }));
    check(rebooked?.outcome === 'booked', 'and booked (§8 rebook)', `outcome ${rebooked?.outcome}`);
    check((await rpc('reschedule_meeting', { p_meeting_id: meeting.id }, owner.token)).json?.[0]?.outcome === 'wrong_state', 'the old row, now history, cannot be rescheduled again');
  }

  console.log('\n2. What is refused, by name');
  {
    const { meeting } = await bookedMeeting('refuse');
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id, p_requested_mode: 'telepathy' }, owner.token)))?.outcome === 'invalid_request', 'a mode nobody knows');
    const t = new Date(Date.now() + 24 * HOURS).toISOString();
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id, p_requested_start_at: t, p_requested_window_end: new Date(Date.now() + 20 * HOURS).toISOString() }, owner.token)))?.outcome === 'invalid_request', 'a window that ends before it starts');
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id, p_requested_window_end: t }, owner.token)))?.outcome === 'invalid_request', 'a window end without a start');
    const foreign = fx.mint(randomUUID(), 'owner', randomUUID());
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id }, foreign)))?.outcome === 'forbidden', 'another organization’s owner');
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id }, fx.mint(randomUUID(), 'contractor'))))?.outcome === 'forbidden', 'a contractor');
    check((one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id }, fx.mint(randomUUID(), 'owner'))))?.outcome === 'unknown_actor', 'an owner token whose subject has no user row, by name');
    check((await row(meeting.id))?.status === 'booked' && (await reminders(meeting.id)) === 1, 'and after all of that the booking and its reminder stand');
    const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} req`, status: 'new' }));
    created.leads.push(lead.id);
    const req = one(await rest('POST', 'crm', 'meetings', { organization_id: ORG, lead_id: lead.id, requested_mode: 'call', status: 'requested' }));
    created.meetings.push(req.id);
    check((one(await rpc('reschedule_meeting', { p_meeting_id: req.id }, owner.token)))?.outcome === 'wrong_state', 'a request is re-offered, not rescheduled');
    // The service role — the Scheduler agent on a client's request — may, with the time the client named.
    const r = one(await rpc('reschedule_meeting', { p_meeting_id: meeting.id, p_reason: 'client asked on WhatsApp', p_requested_start_at: t }));
    check(r?.outcome === 'rescheduled', 'the service role may reschedule (the positive twin)', `outcome ${r?.outcome}`);
    created.meetings.push(r.new_meeting_id);
    const fresh = await row(r.new_meeting_id);
    check(Date.parse(fresh?.requested_start_at ?? '') === Date.parse(t) && fresh?.created_by === null && fresh?.requested_mode === 'video_meeting', 'the new row carries the time the client named, no person, and the mode that was booked');
    check((await audits(meeting.id, 'meeting.rescheduled'))[0]?.actor_type === 'system', 'audited as the system');
  }
} catch (error) {
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m the run stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const id of [...created.meetings].reverse()) {
    await rest('DELETE', 'core', `jobs?kind=in.(meeting.reminder,meeting.analysis)&payload->>meeting_id=eq.${id}`);
    await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  }
  for (const id of created.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}` }, cache: 'no-store' }).catch(() => {});
  }
  await fx.cleanup();
}

console.log(failures === 0 ? `\n\x1b[32m✔ ${checks} checks passed — a reschedule is a new row, and the old one is history\x1b[0m\n` : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
