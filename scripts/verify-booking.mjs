// ═══════════════════════════════════════════════════════════════════════════
// A retry that books twice — G-227
//
// P0. §6.3 "Use idempotency to prevent duplicate bookings"; §14 "Provider
// timeout → verify actual provider state before retry → avoid double-booking";
// Master Development Plan V3 §19, where "worker crash during booking → second
// booking created" is a HARD FAIL.
//
// Idempotency cannot be proved by reading a migration. An index that refuses a
// duplicate and an index that was never created look identical in source until
// two callers arrive at once — so §3 below fires eight simultaneous bookings
// with one key and counts the survivors, which is the assertion that would
// have caught a missing index.
//
// SELF-RED-PROVING throughout: every section asserts a REFUSAL or a count of
// exactly one. Drop `meetings_booking_key` and §3 reports eight bookings
// instead of one; drop the staleness check and §4 flips to 'booked'.
//
//   node scripts/verify-booking.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'a retry is the same booking, not another one');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-book-${randomUUID().slice(0, 8)}`;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const book = (args) => rest('POST', 'crm', 'rpc/book_meeting', args);

const created = { leads: [], meetings: [] };

/** A meeting that has read availability and is ready to be booked. */
async function newMeeting(name, { readAt = new Date().toISOString(), source = 'google:primary', status = 'proposed' } = {}) {
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new',
  }));
  created.leads.push(lead.id);

  const meeting = one(await rest('POST', 'crm', 'meetings', {
    organization_id: ORG,
    lead_id: lead.id,
    requested_mode: 'video_meeting',
    status,
    availability_source: source,
    availability_read_at: readAt,
  }));
  if (meeting?.id) created.meetings.push(meeting.id);
  return meeting;
}

const START = new Date(Date.now() + 86_400_000).toISOString();
const END = new Date(Date.now() + 86_400_000 + 1_800_000).toISOString();

const bookArgs = (meetingId, key, over = {}) => ({
  p_meeting_id: meetingId,
  p_booking_key: key,
  p_start_at: START,
  p_end_at: END,
  p_timezone: 'Asia/Kolkata',
  p_mode: 'video_meeting',
  ...over,
});

const bookedCount = async (meetingId) => {
  const r = await rest('GET', 'crm', `meetings?id=eq.${meetingId}&select=status,booking_key,booked_at,confirmed_start_at`);
  return Array.isArray(r.json) ? r.json : [];
};

console.log('\n\x1b[1mAgencyOS — a retry that books twice (G-227)\x1b[0m');

try {
  // ── 1. the door works at all ─────────────────────────────────────────────
  console.log('\n1. A meeting with read availability books');
  {
    const meeting = await newMeeting('happy');
    const result = one(await book(bookArgs(meeting.id, `${MARKER}-happy`)));

    check(result?.outcome === 'booked', 'the booking lands', `outcome ${result?.outcome}`);

    const [row] = await bookedCount(meeting.id);
    check(row?.status === 'booked', 'and the row says so', `status ${row?.status}`);
    check(Boolean(row?.booked_at), 'with the moment it became a booking recorded');
    // Boolean(), not `!== null`: an undefined row passes `!== null`, so the
    // first draft of this line was green when no row was read at all.
    check(Boolean(row?.confirmed_start_at), 'and the time that was agreed');
  }

  // ── 2. the retry ─────────────────────────────────────────────────────────
  console.log('\n2. The same attempt, asked twice');
  {
    const meeting = await newMeeting('retry');
    const key = `${MARKER}-retry`;

    const first = one(await book(bookArgs(meeting.id, key)));
    const second = one(await book(bookArgs(meeting.id, key)));

    check(first?.outcome === 'booked', 'the first attempt books', `outcome ${first?.outcome}`);
    check(
      second?.outcome === 'already_booked',
      'the second gets the SAME booking rather than an error',
      `outcome ${second?.outcome}`,
    );
    check(second?.meeting_id === meeting.id, 'and the same meeting id');
  }

  // ── 3. eight at once — the assertion a source read cannot make ───────────
  console.log('\n3. Eight simultaneous retries of one attempt');
  {
    const meeting = await newMeeting('race');
    const key = `${MARKER}-race`;

    const results = (await Promise.all(
      Array.from({ length: 8 }, () => book(bookArgs(meeting.id, key))),
    )).map((r) => one(r)?.outcome);

    const booked = results.filter((o) => o === 'booked').length;
    const already = results.filter((o) => o === 'already_booked').length;

    check(booked === 1, 'exactly one call booked', `booked ${booked} of 8 — ${results.join(', ')}`);
    check(
      booked + already === 8,
      'and every other call got the existing booking rather than a failure',
      `already ${already}`,
    );

    const rows = await bookedCount(meeting.id);
    check(rows.length === 1 && rows[0]?.status === 'booked', 'one meeting, booked once');
  }

  // ── 4. the re-check ──────────────────────────────────────────────────────
  console.log('\n4. Availability that has gone stale, and availability never read');
  {
    // Ten minutes old: past a 300-second bound, inside a 900-second one. The
    // first draft used an hour, which no bound the function permits could
    // admit — so the "same row books under a wider bound" check could never
    // pass, and the refusal was never proved to be the clock. Found by review.
    const stale = await newMeeting('stale', {
      readAt: new Date(Date.now() - 600_000).toISOString(),
    });
    const staleResult = one(await book(bookArgs(stale.id, `${MARKER}-stale`, { p_max_staleness_seconds: 300 })));
    check(
      staleResult?.outcome === 'stale_availability',
      'a ten-minute-old answer is refused, not trusted',
      `outcome ${staleResult?.outcome}`,
    );

    // The same meeting books when the caller asks for a bound that admits it —
    // which proves the refusal was the CLOCK and not something else.
    const admitted = one(await book(bookArgs(stale.id, `${MARKER}-stale-ok`, { p_max_staleness_seconds: 900 })));
    check(
      admitted?.outcome === 'booked',
      'and the same row books under a bound that admits it — so the refusal was the clock',
      `outcome ${admitted?.outcome}`,
    );

    const unchecked = one(await rest('POST', 'crm', 'meetings', {
      organization_id: ORG, lead_id: created.leads[0],
      requested_mode: 'call', status: 'requested',
    }));
    if (unchecked?.id) created.meetings.push(unchecked.id);
    const neverResult = one(await book(bookArgs(unchecked.id, `${MARKER}-never`)));
    check(
      neverResult?.outcome === 'never_checked',
      'a meeting that never read a calendar cannot be booked',
      `outcome ${neverResult?.outcome}`,
    );
  }

  // ── 5. the provider receipt ──────────────────────────────────────────────
  console.log('\n5. A provider named without the event it created');
  {
    const meeting = await newMeeting('unverified');
    const result = one(await book(bookArgs(meeting.id, `${MARKER}-unverified`, {
      p_provider: 'google',
      p_provider_event_id: null,
    })));
    check(
      result?.outcome === 'unverified_provider',
      '"we think we created it" is refused',
      `outcome ${result?.outcome}`,
    );

    const [row] = await bookedCount(meeting.id);
    check(row?.status !== 'booked', 'and nothing was written', `status ${row?.status}`);
  }

  // ── 6. one external event, one meeting ──────────────────────────────────
  console.log('\n6. One provider event cannot become two meetings');
  {
    const eventId = `evt-${randomUUID().slice(0, 8)}`;
    const first = await newMeeting('event-a');
    const second = await newMeeting('event-b');

    const a = one(await book(bookArgs(first.id, `${MARKER}-ev-a`, {
      p_provider: 'google', p_provider_event_id: eventId,
    })));
    check(a?.outcome === 'booked', 'the first meeting takes the event', `outcome ${a?.outcome}`);

    const b = one(await book(bookArgs(second.id, `${MARKER}-ev-b`, {
      p_provider: 'google', p_provider_event_id: eventId,
    })));
    check(
      b?.outcome === 'event_taken',
      'and the second cannot claim the same one',
      `outcome ${b?.outcome}`,
    );
  }

  // ── 7. states and tenants ───────────────────────────────────────────────
  console.log('\n7. What is not this attempt’s to overwrite');
  {
    const meeting = await newMeeting('settled');
    await book(bookArgs(meeting.id, `${MARKER}-settled`));

    // A different attempt against an already-booked meeting.
    const other = one(await book(bookArgs(meeting.id, `${MARKER}-settled-other`)));
    check(
      other?.outcome === 'wrong_state',
      'a different attempt cannot re-book a booked meeting',
      `outcome ${other?.outcome}`,
    );

    const incomplete = one(await book(bookArgs((await newMeeting('incomplete')).id, `${MARKER}-inc`, {
      p_timezone: null,
    })));
    check(
      incomplete?.outcome === 'incomplete',
      'a booking with no timezone is not a booking',
      `outcome ${incomplete?.outcome}`,
    );
  }
} finally {
  for (const id of created.meetings) await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — one attempt is one booking, whatever the network did\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
