// ═══════════════════════════════════════════════════════════════════════════
// A reminder for a meeting that moved — G-228
//
// Review found this path had no live coverage of any kind — and that its first
// draft could not be called by anyone: SECURITY INVOKER writing core.jobs,
// whose RLS admits no such write, with a tenancy check that refused the
// service role too. Nothing could ever reach 'scheduled'.
//
// This drives the real jobs table. Every section asserts something the queue
// itself holds — a row exists, a row was reused, a row was left alone, a row
// is gone — rather than an outcome string alone.
//
//   node scripts/verify-reminders.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'a reminder is decided twice, and the second time wins');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-remind-${randomUUID().slice(0, 8)}`;
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

const rpc = (schema, fn, args, token) => (token ? call(token, 'POST', schema, `rpc/${fn}`, args) : rest('POST', schema, `rpc/${fn}`, args));
const schedule = async (meetingId, lead, token) =>
  one(await rpc('crm', 'schedule_meeting_reminder', { p_meeting_id: meetingId, ...(lead ? { p_lead_minutes: lead } : {}) }, token));

const jobsFor = async (meetingId) =>
  (await rest('GET', 'core', `jobs?kind=eq.meeting.reminder&payload->>meeting_id=eq.${meetingId}&select=id,status,run_at,attempts,payload`)).json ?? [];

const created = { leads: [], meetings: [] };

const START = new Date(Date.now() + 2 * 86_400_000);
START.setUTCSeconds(0, 0);
const END = new Date(START.getTime() + 1_800_000);

async function bookedMeeting(name) {
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  const meeting = one(await rest('POST', 'crm', 'meetings', {
    organization_id: ORG, lead_id: lead.id, requested_mode: 'video_meeting', status: 'proposed',
    availability_source: 'google:primary', availability_read_at: new Date().toISOString(),
  }));
  created.meetings.push(meeting.id);
  const booked = one(await rpc('crm', 'book_meeting', {
    p_meeting_id: meeting.id, p_booking_key: `${MARKER}-${name}`,
    p_start_at: START.toISOString(), p_end_at: END.toISOString(), p_timezone: 'Asia/Kolkata', p_mode: 'video_meeting',
  }));
  if (booked?.outcome !== 'booked') fail(`fixture could not book: ${booked?.outcome}`);
  return meeting.id;
}

const minutesBefore = (runAt) => Math.round((START.getTime() - Date.parse(runAt)) / 60_000);

console.log('\n\x1b[1mAgencyOS — a reminder for a meeting that moved (G-228)\x1b[0m');

try {
  const owner = await fx.bootstrapOwner(MARKER);

  // ── 1. an authenticated owner can schedule at all ────────────────────────
  console.log('\n1. An owner schedules a reminder, and a job exists');
  const m1 = await bookedMeeting('one');
  {
    const r = await schedule(m1, 30, owner.token);
    check(r?.outcome === 'scheduled', 'as an authenticated owner — the path the first draft could never take', `outcome ${r?.outcome}`);
    const jobs = await jobsFor(m1);
    check(jobs.length === 1 && jobs[0]?.status === 'queued', 'one queued job', `${jobs.length} job(s)`);
    check(minutesBefore(jobs[0]?.run_at) === 30, 'due thirty minutes before the meeting', `${minutesBefore(jobs[0]?.run_at)} min`);
    check(jobs[0]?.payload?.scheduled_for_start_at !== undefined, 'carrying the start it was computed against');
  }

  // ── 2. asking again replaces, never accumulates ─────────────────────────
  console.log('\n2. The same reminder asked again is one job, not two');
  {
    const r = await schedule(m1, 30);
    check(r?.outcome === 'replaced', 'the second ask is a replacement', `outcome ${r?.outcome}`);
    check((await jobsFor(m1)).length === 1, 'still one job');
  }

  // ── 3. a job that already ran is reused, not collided with ──────────────
  console.log('\n3. A reminder whose job already ran can be scheduled again');
  {
    // Found by review: the first draft probed for status='queued' only, while
    // the dedupe index is unique over EVERY status — so this raised a raw
    // unique_violation.
    const [job] = await jobsFor(m1);
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, { status: 'succeeded', attempts: 3 });
    const r = await schedule(m1, 30);
    check(r?.outcome === 'replaced', 'a finished job is reused rather than collided with', `outcome ${r?.outcome}`);
    const [after] = await jobsFor(m1);
    check(after?.status === 'queued' && after?.attempts === 0, 'back to queued, attempts reset', `${after?.status}, attempts ${after?.attempts}`);
  }

  // ── 4. a running job is left alone ──────────────────────────────────────
  console.log('\n4. A running job is somebody else’s in-flight work');
  {
    const [job] = await jobsFor(m1);
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, { status: 'running' });
    const r = await schedule(m1, 30);
    check(r?.outcome === 'in_flight', 'and is not touched', `outcome ${r?.outcome}`);
    const [after] = await jobsFor(m1);
    check(after?.status === 'running', 'the row is unchanged');
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, { status: 'queued' });
  }

  // ── 5. two lead times are two reminders ─────────────────────────────────
  console.log('\n5. Two lead times are two reminders, not one overwriting the other');
  {
    const r = await schedule(m1, 60);
    check(r?.outcome === 'scheduled', 'a second lead time schedules its own job', `outcome ${r?.outcome}`);
    check((await jobsFor(m1)).length === 2, 'two jobs now');
  }

  // ── 6. a moved meeting drops its queued reminders ───────────────────────
  console.log('\n6. Moving the meeting drops the queued reminders');
  {
    const moved = new Date(START.getTime() + 3_600_000).toISOString();
    const movedEnd = new Date(START.getTime() + 5_400_000).toISOString();
    const r = await rest('PATCH', 'crm', `meetings?id=eq.${m1}`, { confirmed_start_at: moved, confirmed_end_at: movedEnd });
    check(r.ok, 'the meeting moves an hour later', `status ${r.status}`);
    check((await jobsFor(m1)).length === 0, 'and both queued reminders are gone — §7.2, replace rather than ignore');
    const again = await schedule(m1, 30);
    check(again?.outcome === 'scheduled', 'a fresh reminder is scheduled for the new time', `outcome ${again?.outcome}`);
    const [job] = await jobsFor(m1);
    check(Math.round((Date.parse(moved) - Date.parse(job?.run_at)) / 60_000) === 30, 'thirty minutes before the NEW start');
  }

  // ── 7. a cancelled meeting drops its reminder ───────────────────────────
  console.log('\n7. Cancelling the meeting drops the reminder');
  {
    await rest('PATCH', 'crm', `meetings?id=eq.${m1}`, { status: 'cancelled', cancelled_at: new Date().toISOString() });
    check((await jobsFor(m1)).length === 0, 'no reminder survives a cancellation');
    const r = await schedule(m1, 30);
    check(r?.outcome === 'not_booked', 'and none can be scheduled on it now', `outcome ${r?.outcome}`);
  }

  // ── 8. the configured lead time ─────────────────────────────────────────
  console.log('\n8. The lead time comes from the organization’s setting');
  const m2 = await bookedMeeting('two');
  {
    const set = one(await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'meeting_reminder_minutes', p_value: '45' }, owner.token));
    check(set?.outcome === 'set', 'the owner sets 45 minutes', `outcome ${set?.outcome}`);
    const r = await schedule(m2);
    check(r?.outcome === 'scheduled', 'a reminder with no explicit lead time schedules', `outcome ${r?.outcome}`);
    const [job] = await jobsFor(m2);
    check(minutesBefore(job?.run_at) === 45, 'forty-five minutes before', `${minutesBefore(job?.run_at)} min`);
    await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'meeting_reminder_minutes', p_value: null }, owner.token);
    const bad = one(await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'meeting_reminder_minutes', p_value: '0' }, owner.token));
    check(bad?.outcome === 'invalid_value', 'zero is refused — that is a reminder that has already failed');
  }

  // ── 9. the past, and the wrong tenant ───────────────────────────────────
  console.log('\n9. What cannot be scheduled');
  {
    const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, source: 'manual', title: `${MARKER} past`, status: 'new' }));
    created.leads.push(lead.id);
    const past = one(await rest('POST', 'crm', 'meetings', {
      organization_id: ORG, lead_id: lead.id, requested_mode: 'call', status: 'proposed',
      availability_source: 'google:primary', availability_read_at: new Date().toISOString(),
    }));
    created.meetings.push(past.id);
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    await rpc('crm', 'book_meeting', {
      p_meeting_id: past.id, p_booking_key: `${MARKER}-past`, p_start_at: soon,
      p_end_at: new Date(Date.now() + 35 * 60_000).toISOString(), p_timezone: 'Asia/Kolkata', p_mode: 'call',
    });
    const r = await schedule(past.id, 30);
    check(r?.outcome === 'in_the_past', 'a reminder whose moment has passed is not queued to fire immediately', `outcome ${r?.outcome}`);

    // Another organization's owner — the org claim is what the guard reads.
    const foreign = fx.mint(randomUUID(), 'owner', randomUUID());
    const stranger = await schedule(m2, 30, foreign);
    check(stranger?.outcome === 'forbidden', 'an owner of another organization is refused', `outcome ${stranger?.outcome}`);
  }
} finally {
  for (const id of created.meetings) await rest('DELETE', 'core', `jobs?kind=eq.meeting.reminder&payload->>meeting_id=eq.${id}`);
  for (const id of created.meetings) await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  await rest('POST', 'core', 'rpc/set_organization_setting', { p_organization_id: ORG, p_key: 'meeting_reminder_minutes', p_value: null });
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — a reminder is decided at the moment it fires, and the queue agrees\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
