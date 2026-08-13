#!/usr/bin/env node
/**
 * A client who comes back, verified against a real database.
 *
 * Gap G-016, decision ADM-05 — *"One lead per person, forever. A returning
 * client gets a new deal on their existing lead."*
 *
 * Two thirds of that already worked and are asserted here rather than assumed,
 * because they are what makes the third meaningful:
 *
 *   1. The same phone resolves to the same lead, before and after conversion.
 *   2. A second deal opens on that lead — a won deal does not block it.
 *   3. **The return is marked.** Until this, the message landed in the
 *      transcript of a lead nobody was working: no activity, no event, no
 *      change anywhere a person looks. Repeat revenue, filed silently.
 *
 * And what it must NOT do, which is the half most likely to be "fixed" wrongly
 * later: it does not move the lead's status, because `converted` is terminal
 * and ADM-05 gives the returning client a new deal rather than a reopened lead.
 *
 *   node scripts/verify-returning-client.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-returning-client');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-return';
const ORG = '00000000-0000-4000-8000-000000000001';
const PHONE = '919111100011';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

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
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const say = (ref, body) =>
  rest('POST', 'crm', 'rpc/ingest_whatsapp_message', {
    p_phone_number_id: `${MARKER}-pn`,
    p_from: PHONE,
    p_external_ref: ref,
    p_body: body,
  });

const marksFor = async (leadId) =>
  ((await rest('GET', 'crm', `lead_activities?lead_id=eq.${leadId}&metadata->>returning=eq.true&select=id,body`)).json ?? []);

const created = { opportunities: [] };
let previousSettings = null;

console.log('\n\x1b[1mAgencyOS — a client who comes back (G-016)\x1b[0m');

try {
  previousSettings = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`))?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...previousSettings, whatsapp_phone_number_id: `${MARKER}-pn` },
  });

  console.log('\n1. One lead per person, before and after the deal closes');
  const first = one(await say(`${MARKER}-1`, 'I need an app'));
  check(first?.status === 'ingested', 'the first message opens a lead', `status ${first?.status}`);
  created.lead = first?.lead_id;
  created.contact = first?.contact_id;
  created.conversation = first?.conversation_id;

  const second = one(await say(`${MARKER}-2`, 'with payments too'));
  check(second?.lead_id === created.lead, 'a second message continues the same lead');

  check(
    (await marksFor(created.lead)).length === 0,
    'and while the lead is live, nothing is marked as a return',
  );

  // The deal is won and the lead converted.
  const deal = one(
    await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG, lead_id: created.lead, name: `${MARKER} first deal`,
      stage: 'won', value_minor: 100000, currency: 'INR', closed_at: new Date().toISOString(),
    }),
  );
  created.opportunities.push(deal.id);
  await rest('PATCH', 'crm', `leads?id=eq.${created.lead}`, {
    status: 'converted', qualified_at: new Date().toISOString(), converted_at: new Date().toISOString(),
  });

  console.log('\n2. The client comes back, and it is no longer silent');
  {
    const back = one(await say(`${MARKER}-3`, 'hi, I want a second app'));
    check(back?.lead_id === created.lead, 'the returning client lands on the same lead (ADM-05)');
    check(back?.job_id === null, 'no extraction is queued against a settled deal, as C6 decided');

    const marks = await marksFor(created.lead);
    check(marks.length === 1, 'the return is recorded on the lead', `${marks.length} marks`);
    check(
      typeof marks[0]?.body === 'string' && marks[0].body.includes('already won'),
      'saying what actually happened',
      `${marks[0]?.body}`,
    );

    const events = (await rest('GET', 'core', `outbox_events?type=eq.lead.returned&subject_id=eq.${created.lead}&select=id`)).json ?? [];
    check(events.length === 1, 'and announced once, for the retention work to read', `${events.length}`);
  }

  console.log('\n3. What it must not do');
  {
    const lead = one(await rest('GET', 'crm', `leads?id=eq.${created.lead}&select=status,next_follow_up_at`));
    check(
      lead?.status === 'converted',
      'the lead status is NOT rewritten — converted is terminal, and ADM-05 gives a new deal, not a reopened lead',
      `${lead?.status}`,
    );
    check(
      lead?.next_follow_up_at === null,
      'and no follow-up date is invented — when to chase is a rule nobody has written',
    );

    const deals = (await rest('GET', 'sales', `opportunities?lead_id=eq.${created.lead}&select=id`)).json ?? [];
    check(deals.length === 1, 'and no deal is opened unasked', `${deals.length} deals`);
  }

  console.log('\n4. A second deal is possible, which is what ADM-05 asks for');
  {
    const next = one(
      await rest('POST', 'sales', 'opportunities', {
        organization_id: ORG, lead_id: created.lead, name: `${MARKER} second deal`,
        stage: 'discovery', value_minor: 0, currency: 'INR',
      }),
    );
    created.opportunities.push(next?.id);
    check(!!next?.id, 'a won deal does not block the next one on the same lead');

    const deals = (await rest('GET', 'sales', `opportunities?lead_id=eq.${created.lead}&select=id`)).json ?? [];
    check(deals.length === 2, 'so the whole history stays in one place', `${deals.length} deals`);
  }

  console.log('\n5. Who has come back');
  {
    const rows = (await rest('POST', 'crm', 'rpc/returning_clients', {})).json ?? [];
    const mine = rows.find((r) => r.lead_id === created.lead);
    check(!!mine, 'the lead appears in the returning-client read');
    check(mine?.messages === 1, 'with the number of times they got back in touch', `${mine?.messages}`);

    // An outbound reply must not read as the client returning again.
    await rest('POST', 'crm', 'rpc/send_outbound_message', {
      p_conversation_id: created.conversation,
      p_body: 'Good to hear from you',
      p_external_ref: `${MARKER}-out-1`,
    });
    const after = await marksFor(created.lead);
    check(after.length === 1, 'and the agency replying does not count as a return', `${after.length}`);
  }
} finally {
  for (const id of created.opportunities) if (id) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  if (created.lead) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${created.lead}`);
    await rest('DELETE', 'crm', `lead_activities?lead_id=eq.${created.lead}`);
  }
  if (created.conversation) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${created.conversation}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${created.conversation}`);
  }
  await rest('DELETE', 'core', `jobs?organization_id=eq.${ORG}`);
  if (created.lead) await rest('DELETE', 'crm', `leads?id=eq.${created.lead}`);
  if (created.contact) await rest('DELETE', 'crm', `contacts?id=eq.${created.contact}`);
  if (previousSettings !== null) {
    await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: previousSettings });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A client who comes back is one lead, a new deal, and no longer silent\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
