#!/usr/bin/env node
/**
 * Inbound WhatsApp ingest, verified against the real database.
 *
 * `crm.ingest_whatsapp_message` is where the correctness of this slice lives —
 * five inserts across two schemas that must happen exactly once, and a
 * transcript position that must survive concurrent arrivals. None of that can
 * be proved by a unit test: a fake that reimplements ON CONFLICT and row
 * locking proves only that the fake agrees with itself. So this calls the real
 * function against real Postgres.
 *
 *   • an unrecognised phone_number_id is refused, and creates nothing
 *   • a first message creates organization → contact → lead → conversation →
 *     message, and queues one extraction
 *   • redelivering the same provider message id writes nothing and queues
 *     nothing, and reports the ids that already exist
 *   • a second message continues the same contact, lead and conversation
 *   • messages arriving concurrently on one thread take contiguous positions —
 *     the race the migration exists to close
 *   • two organizations claiming different numbers never see each other's rows
 *
 * Every row is created under a temporary organization and removed afterwards;
 * the seeded demo organization is never touched.
 *
 *   npm run verify:db:up        # a local stack, if you do not have one
 *   npm run db:verify:ingest
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

/** Everything this run creates is reachable from these two organizations. */
const SLUG_A = 'zztest-ingest-a';
const SLUG_B = 'zztest-ingest-b';
const PN_A = 'ZZTEST_PN_A';
const PN_B = 'ZZTEST_PN_B';
const SENDER = '919900990011';
const SENDER_E164 = '+919900990011';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// No CRON_SECRET and no app: this exercises the database function directly,
// which is the whole of the slice. The webhook that will call it does not
// exist yet.
const target = resolveTarget(fail, { cron: false, anon: false });
const URL_BASE = target.url;
const SECRET = target.serviceKey;

async function request(method, schema, path, { body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET'
          ? { 'Accept-Profile': schema }
          : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* reported through text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) =>
  request('POST', schema, table, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);

/** One inbound message, through the function the webhook will call. */
async function ingest({ phoneNumberId, from = SENDER, externalRef, body, profileName }) {
  const res = await request('POST', 'crm', 'rpc/ingest_whatsapp_message', {
    body: {
      p_phone_number_id: phoneNumberId,
      p_from: from,
      p_external_ref: externalRef,
      p_body: body,
      ...(profileName ? { p_profile_name: profileName } : {}),
    },
  });
  if (!res.ok) fail(`ingest failed (${res.status}): ${res.text}`);
  return (Array.isArray(res.json) ? res.json[0] : res.json) ?? null;
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : bad(m));
const note = (m) => console.log(`  \x1b[33m•\x1b[0m ${m}`);
const section = (m) => console.log(`\n${m}`);

const countOf = async (schema, path) => {
  const res = await select(schema, path);
  return (res.json ?? []).length;
};

async function dropOrganizations() {
  // Every table in this slice references core.organizations with ON DELETE
  // CASCADE, so removing the organizations removes contacts, leads,
  // conversations, messages and jobs with them.
  for (const slug of [SLUG_A, SLUG_B]) {
    await remove('core', `organizations?slug=eq.${slug}`);
  }
}

console.log('\n\x1b[1mInbound WhatsApp ingest — against the real database\x1b[0m');

// ── 0. Preflight ───────────────────────────────────────────────────────────
section('0. Preflight');
announceTarget(target);

const probe = await select('crm', 'conversation_messages?select=external_ref&limit=1');
check(probe.ok, 'crm.conversation_messages.external_ref exists (migration applied)');
if (!probe.ok) fail(`the ingest migration is not applied: ${probe.text}`);

// A previous interrupted run must not change what this one observes.
await dropOrganizations();

// ── 1. Fixture ─────────────────────────────────────────────────────────────
section('1. Fixture (temporary organizations only)');

const orgA = await insert('core', 'organizations', {
  name: 'ZZTEST Ingest A',
  slug: SLUG_A,
  settings: { whatsapp_phone_number_id: PN_A },
});
const orgB = await insert('core', 'organizations', {
  name: 'ZZTEST Ingest B',
  slug: SLUG_B,
  settings: { whatsapp_phone_number_id: PN_B },
});

const ORG_A = orgA.json?.[0]?.id;
const ORG_B = orgB.json?.[0]?.id;
if (!ORG_A || !ORG_B) fail(`could not create the temporary organizations: ${orgA.text} ${orgB.text}`);
check(Boolean(ORG_A && ORG_B), 'two organizations exist, each claiming its own WhatsApp number');

// ── 2. An unrecognised number ──────────────────────────────────────────────
section('2. An unrecognised phone_number_id');

const unknown = await ingest({
  phoneNumberId: 'ZZTEST_PN_NOBODY',
  externalRef: 'wamid.ZZTEST.unknown',
  body: 'hello?',
});

check(unknown?.status === 'unknown_phone_number_id', 'A. it is refused by status, not by an error');
check(unknown?.organization_id === null, 'A. no organization is guessed');
check(unknown?.message_id === null, 'A. and no message is recorded');
check(
  (await countOf('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.unknown&select=id`)) === 0,
  'A. nothing at all was written for it',
);

// ── 3. The first message ───────────────────────────────────────────────────
section('3. A first inbound message');

const first = await ingest({
  phoneNumberId: PN_A,
  externalRef: 'wamid.ZZTEST.001',
  body: 'I need a storefront rebuild',
  profileName: 'Asha',
});

check(first?.status === 'ingested', 'B. it is ingested');
check(first?.organization_id === ORG_A, 'B. under the organization that claims the number');
check(first?.message_seq === 0, 'B. at position 0 — the start of the transcript');
check(Boolean(first?.job_id), 'B. and one extraction is queued');

const contact = (await select('crm', `contacts?id=eq.${first?.contact_id}&select=*`)).json?.[0];
check(contact?.phone === SENDER_E164, `C. the contact is stored in E.164 (${SENDER_E164})`);
check(contact?.full_name === 'Asha', 'C. named from the sender profile');
check(contact?.organization_id === ORG_A, 'C. and belongs to the right organization');

const lead = (await select('crm', `leads?id=eq.${first?.lead_id}&select=*`)).json?.[0];
check(lead?.source === 'whatsapp', 'D. the lead is whatsapp-sourced');
check(lead?.source_ref === `wa:${SENDER_E164}`, 'D. keyed by the thread, for idempotent ingest');
check(lead?.status === 'new', 'D. and starts as new — nothing has qualified it');
check(lead?.contact_id === first?.contact_id, 'D. the lead is attached to the contact');

const conversation = (
  await select('crm', `conversations?id=eq.${first?.conversation_id}&select=*`)
).json?.[0];
check(conversation?.channel === 'whatsapp', 'E. the conversation is on the whatsapp channel');
check(conversation?.lead_id === first?.lead_id, 'E. and attached to the lead');
// G-102. The tenant was always resolved from this number and the number was
// always thrown away, which is what made G-090 unanswerable: no row could say
// which of the agency's numbers a message came in on.
check(
  conversation?.inbound_number_id === PN_A,
  'E. and records the number it arrived on, not just the sender (G-102)',
);

const message = (
  await select('crm', `conversation_messages?id=eq.${first?.message_id}&select=*`)
).json?.[0];
check(message?.author_type === 'client', 'F. the message is authored by the client');
check(message?.external_ref === 'wamid.ZZTEST.001', 'F. and carries the provider id');
check(
  message?.metadata?.phone_number_id === PN_A,
  'F. with the receiving number recorded in metadata',
);

const job = (await select('core', `jobs?id=eq.${first?.job_id}&select=*`)).json?.[0];
check(job?.kind === 'requirement.extract', 'G. the queued job is the kind the runner claims');
check(job?.status === 'queued', 'G. and is queued, waiting for a tick');
check(
  job?.payload?.conversationId === first?.conversation_id,
  'G. pointing at the conversation just created',
);

// ── 4. Replay ──────────────────────────────────────────────────────────────
section('4. Redelivery of the same provider message id');

const replay = await ingest({
  phoneNumberId: PN_A,
  externalRef: 'wamid.ZZTEST.001',
  body: 'I need a storefront rebuild',
  profileName: 'Asha',
});

check(replay?.status === 'replayed', 'H. it reports a replay rather than failing');
check(replay?.message_id === first?.message_id, 'H. returning the message already recorded');
check(replay?.job_id === null, 'H. and queues no second extraction');
check(
  (await countOf('crm', `conversation_messages?conversation_id=eq.${first?.conversation_id}&select=id`)) === 1,
  'H. the transcript still holds exactly one message',
);
check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'H. and no duplicate lead was created',
);
check(
  (await countOf('core', `jobs?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'H. exactly one extraction job exists for this organization',
);

// ── 5. A second message on the same thread ─────────────────────────────────
section('5. A second message from the same sender');

const second = await ingest({
  phoneNumberId: PN_A,
  externalRef: 'wamid.ZZTEST.002',
  body: 'Budget is around five lakh',
  profileName: 'Asha',
});

check(second?.status === 'ingested', 'I. it is ingested');
check(second?.message_seq === 1, 'I. at position 1 — the transcript continues');
check(second?.conversation_id === first?.conversation_id, 'I. on the same conversation');
check(second?.lead_id === first?.lead_id, 'I. under the same lead');
check(second?.contact_id === first?.contact_id, 'I. and the same contact — nothing was duplicated');
check(Boolean(second?.job_id), 'I. a fresh extraction is queued for the longer transcript');
check(
  (await countOf('crm', `conversation_messages?conversation_id=eq.${first?.conversation_id}&select=id`)) === 2,
  'I. the transcript now holds two messages',
);

// ── 6. Concurrent arrivals ─────────────────────────────────────────────────
section('6. Eight messages arriving at once on one thread');

const CONCURRENT = 8;
const results = await Promise.all(
  Array.from({ length: CONCURRENT }, (_, i) =>
    ingest({
      phoneNumberId: PN_A,
      externalRef: `wamid.ZZTEST.race.${i}`,
      body: `concurrent message ${i}`,
      profileName: 'Asha',
    }),
  ),
);

check(
  results.every((r) => r?.status === 'ingested'),
  'J. every one of them was ingested — none lost to a race',
);

const seqs = results.map((r) => r?.message_seq).sort((a, b) => a - b);
const expected = Array.from({ length: CONCURRENT }, (_, i) => i + 2); // 0 and 1 are taken
check(
  JSON.stringify(seqs) === JSON.stringify(expected),
  `J. they took contiguous positions ${expected[0]}..${expected[expected.length - 1]} (got ${seqs.join(',')})`,
);
check(new Set(seqs).size === CONCURRENT, 'J. with no position used twice');

// ── 7. Organization isolation ──────────────────────────────────────────────
section('7. The same sender, a different business number');

const other = await ingest({
  phoneNumberId: PN_B,
  externalRef: 'wamid.ZZTEST.B.001',
  body: 'Different business, same customer',
  profileName: 'Asha',
});

check(other?.status === 'ingested', 'K. it is ingested');
check(other?.organization_id === ORG_B, 'K. under the second organization');
check(other?.contact_id !== first?.contact_id, 'K. as a separate contact — tenants do not share');
check(other?.lead_id !== first?.lead_id, 'K. and a separate lead');
check(other?.message_seq === 0, 'K. starting its own transcript at 0');
check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'K. the first organization still has exactly one lead',
);

// ── 7b. C6 — a settled lead stops commissioning extractions ────────────────
//
// The lead is resolved by thread key and the extraction was queued without
// ever reading the lead's status, so a converted or disqualified lead kept
// ordering a model run per message against a deal already decided.
//
// One lead per number is unchanged: nothing here reopens a lead, creates a
// second one, or invents a thread key. The message is still stored — dropping
// it is the failure C5 fixed — and only the follow-on stops.
section('7b. C6 — a converted or disqualified lead queues no extraction');

const C6_SENDER = '919900990022';
const C6_THREAD = `wa:+${C6_SENDER}`;

const setLeadStatus = (id, body) =>
  request('PATCH', 'crm', `leads?id=eq.${id}`, { body });

// The extraction jobs for one conversation, which is the unit the guard acts
// on. Counting per organization would drift with the sections above.
const jobsFor = (conversationId) =>
  countOf('core', `jobs?select=id&payload->>conversationId=eq.${conversationId}`);

const messagesIn = (conversationId) =>
  countOf('crm', `conversation_messages?conversation_id=eq.${conversationId}&select=id`);

// ── an active lead behaves exactly as before ──
const c6First = await ingest({
  phoneNumberId: PN_A,
  from: C6_SENDER,
  externalRef: 'wamid.ZZTEST.C6.001',
  body: 'I need an online store',
  profileName: 'Ravi',
});

const c6Lead = c6First?.lead_id;
const c6Conv = c6First?.conversation_id;

check(c6First?.status === 'ingested', 'L. a first message from a new number is ingested');
check(Boolean(c6First?.job_id), 'L. a new lead queues an extraction — unchanged behaviour');
check(
  (await select('crm', `leads?id=eq.${c6Lead}&select=status`)).json?.[0]?.status === 'new',
  'L. and the lead starts as new',
);

// ── converted: the message lands, the extraction does not ──
await setLeadStatus(c6Lead, { status: 'converted', converted_at: new Date().toISOString() });

const jobsBeforeConverted = await jobsFor(c6Conv);
const c6Converted = await ingest({
  phoneNumberId: PN_A,
  from: C6_SENDER,
  externalRef: 'wamid.ZZTEST.C6.002',
  body: 'while you are at it, I want a second site',
  profileName: 'Ravi',
});

check(c6Converted?.status === 'ingested', 'M. a message to a converted lead is still ingested');
check(c6Converted?.job_id === null, 'M. but queues NO extraction');
check(
  (await jobsFor(c6Conv)) === jobsBeforeConverted,
  `M. the job count is unchanged (${jobsBeforeConverted})`,
);
check((await messagesIn(c6Conv)) === 2, 'M. and the message IS stored — nothing was discarded');
check(
  (await select('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.C6.002&select=body`))
    .json?.[0]?.body === 'while you are at it, I want a second site',
  'M. stored whole, exactly as the client wrote it',
);
check(c6Converted?.lead_id === c6Lead, 'M. under the same lead — no second lead was opened');
check(
  (await select('crm', `leads?id=eq.${c6Lead}&select=status`)).json?.[0]?.status === 'converted',
  'M. and the lead was NOT reopened',
);

// ── disqualified: the same, but on its OWN lead. `converted` is terminal and
//    `converted → disqualified` is not a legal move (crm.leads_guard, which
//    holds the status machine the service layer already enforced), so the
//    disqualified case gets a fresh lead — disqualified straight from `new` —
//    rather than walking the converted one backward, which is exactly what the
//    guard now forbids. The C6 extraction guard reads only the lead's status,
//    so a fresh disqualified lead exercises it identically. ──
const C6_SENDER_D = '919900990033';

const c6DFirst = await ingest({
  phoneNumberId: PN_A,
  from: C6_SENDER_D,
  externalRef: 'wamid.ZZTEST.C6D.001',
  body: 'do you build online shops?',
  profileName: 'Meena',
});
const c6LeadD = c6DFirst?.lead_id;
const c6ConvD = c6DFirst?.conversation_id;
await setLeadStatus(c6LeadD, { status: 'disqualified', disqualified_reason: 'not a fit' });

const jobsBeforeDisq = await jobsFor(c6ConvD);
const c6Disqualified = await ingest({
  phoneNumberId: PN_A,
  from: C6_SENDER_D,
  externalRef: 'wamid.ZZTEST.C6D.002',
  body: 'have you reconsidered?',
  profileName: 'Meena',
});

check(c6Disqualified?.status === 'ingested', 'N. a message to a disqualified lead is ingested');
check(c6Disqualified?.job_id === null, 'N. but queues NO extraction');
check((await jobsFor(c6ConvD)) === jobsBeforeDisq, 'N. the job count is unchanged');
check((await messagesIn(c6ConvD)) === 2, 'N. and the message IS stored');
check(c6Disqualified?.lead_id === c6LeadD, 'N. still the same lead');
check(
  (await select('crm', `leads?id=eq.${c6LeadD}&select=status`)).json?.[0]?.status === 'disqualified',
  'N. and still disqualified — a message is not a sales action',
);

// ── repetition does not erode the invariant, on the converted lead (terminal) ──
const jobsBeforeRepeat = await jobsFor(c6Conv);
for (const i of [4, 5]) {
  await ingest({
    phoneNumberId: PN_A,
    from: C6_SENDER,
    externalRef: `wamid.ZZTEST.C6.00${i}`,
    body: `still here, message ${i}`,
    profileName: 'Ravi',
  });
}

check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&source_ref=eq.${encodeURIComponent(C6_THREAD)}&select=id`)) === 1,
  'O. repeated messages to a terminal lead create exactly one lead, never a second',
);
check((await jobsFor(c6Conv)) === jobsBeforeRepeat, 'O. and never another extraction');
check((await messagesIn(c6Conv)) === 4, 'O. while every message is still recorded');
check(
  (await countOf('crm', `conversations?organization_id=eq.${ORG_A}&external_ref=eq.${encodeURIComponent(C6_THREAD)}&select=id`)) === 1,
  'O. on exactly one conversation — no second thread was invented',
);

// ── the guard is per lead, not global ──
//
// The same customer writing to the OTHER business must still be extracted:
// a terminal lead in one organization cannot mute another's pipeline.
const c6Other = await ingest({
  phoneNumberId: PN_B,
  from: C6_SENDER,
  externalRef: 'wamid.ZZTEST.C6.B.001',
  body: 'different agency, fresh enquiry',
  profileName: 'Ravi',
});

check(c6Other?.status === 'ingested', 'P. the same sender reaching the other organization is ingested');
check(c6Other?.organization_id === ORG_B, 'P. under that organization');
check(c6Other?.lead_id !== c6Lead, 'P. as its own lead — tenants do not share');
check(Boolean(c6Other?.job_id), 'P. and it DOES queue an extraction — the guard is per lead');

// ── an unrelated active lead in the same organization is unaffected ──
const c6Active = await ingest({
  phoneNumberId: PN_A,
  externalRef: 'wamid.ZZTEST.C6.ACTIVE',
  body: 'and one more thing about the storefront',
  profileName: 'Asha',
});

check(c6Active?.lead_id === first?.lead_id, 'P. the original active lead is untouched');
check(Boolean(c6Active?.job_id), 'P. and still queues extraction normally');

// ── 8. Cleanup ─────────────────────────────────────────────────────────────
section('8. Cleanup');

await dropOrganizations();
const leftA = await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`);
const leftB = await countOf('crm', `leads?organization_id=eq.${ORG_B}&select=id`);
check(leftA === 0 && leftB === 0, 'temporary organizations and everything under them removed');

const orphanJobs = await countOf('core', `jobs?organization_id=eq.${ORG_A}&select=id`);
check(orphanJobs === 0, 'queued extraction jobs went with them — nothing is left for the runner');
note('the seeded demo organization was never touched');

// ── Result ─────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.log(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
