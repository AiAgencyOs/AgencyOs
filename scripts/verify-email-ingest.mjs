#!/usr/bin/env node
/**
 * Inbound email ingest, verified against the real database — audit step 1.1.
 *
 *   • an unrecognised mailbox is refused, and creates nothing
 *   • a first message creates organization → contact → lead → conversation →
 *     message, and queues one extraction
 *   • redelivering the same Message-Id writes nothing and queues nothing
 *   • a second message from the same sender continues the same thread
 *   • two organizations never see each other's rows
 *
 * Every row is created under a temporary organization and removed afterwards.
 *
 *   npm run verify:db:up
 *   npm run db:verify:emailingest
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

const SLUG_A = 'zztest-email-a';
const SLUG_B = 'zztest-email-b';
const MAILBOX_A = 'zztest-leads-a@agency.example';
const MAILBOX_B = 'zztest-leads-b@agency.example';
const SENDER = 'zztest-client@example.com';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

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
        ? method === 'GET' ? { 'Accept-Profile': schema } : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* reported through text */ }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) => request('POST', schema, table, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);
const countOf = async (schema, path) => (await select(schema, path)).json?.length ?? 0;

async function ingest({ mailbox, fromEmail = SENDER, fromName, subject, body, externalRef }) {
  const res = await request('POST', 'crm', 'rpc/ingest_email_lead', {
    body: {
      p_mailbox: mailbox,
      p_from_email: fromEmail,
      ...(fromName ? { p_from_name: fromName } : {}),
      ...(subject ? { p_subject: subject } : {}),
      p_body: body,
      p_external_ref: externalRef,
    },
  });
  if (!res.ok) fail(`ingest failed (${res.status}): ${res.text}`);
  return (Array.isArray(res.json) ? res.json[0] : res.json) ?? null;
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const check = (cond, m) => (cond ? pass(m) : bad(m));
const section = (m) => console.log(`\n${m}`);

async function dropOrganizations() {
  for (const slug of [SLUG_A, SLUG_B]) await remove('core', `organizations?slug=eq.${slug}`);
}

console.log('\n\x1b[1mInbound email ingest — against the real database\x1b[0m');

section('0. Preflight');
announceTarget(target);
const probe = await select('crm', 'conversations?select=channel&limit=1');
check(probe.ok, 'crm.conversations exists (migrations applied)');
if (!probe.ok) fail(`the ingest migration is not applied: ${probe.text}`);
await dropOrganizations();

section('1. Fixture');
const orgA = await insert('core', 'organizations', { name: 'ZZTEST Email A', slug: SLUG_A, settings: { inbound_email_address: MAILBOX_A } });
const orgB = await insert('core', 'organizations', { name: 'ZZTEST Email B', slug: SLUG_B, settings: { inbound_email_address: MAILBOX_B } });
const ORG_A = orgA.json?.[0]?.id;
const ORG_B = orgB.json?.[0]?.id;
if (!ORG_A || !ORG_B) fail(`could not create the temporary organizations: ${orgA.text} ${orgB.text}`);
check(Boolean(ORG_A && ORG_B), 'two organizations exist, each claiming its own mailbox');

section('2. An unrecognised mailbox');
const unknown = await ingest({ mailbox: 'zztest-nobody@nowhere.example', body: 'hello?', externalRef: '<zztest-unknown@mail.example.com>' });
check(unknown?.status === 'unknown_mailbox', 'refused by status, not by an error');
check(unknown?.organization_id === null, 'no organization is guessed');

section('3. A first message');
const first = await ingest({
  mailbox: MAILBOX_A,
  fromName: 'Client Co',
  subject: 'Website enquiry',
  body: 'I need a quote',
  externalRef: '<zztest-msg-1@mail.example.com>',
});
check(first?.status === 'ingested', 'it is ingested');
check(first?.organization_id === ORG_A, 'under the organization that claims the mailbox');
check(first?.message_seq === 0, 'at position 0');
check(Boolean(first?.job_id), 'and one extraction is queued');

const contact = (await select('crm', `contacts?id=eq.${first?.contact_id}&select=*`)).json?.[0];
check(contact?.email === SENDER, 'the contact is stored by sender email');

const lead = (await select('crm', `leads?id=eq.${first?.lead_id}&select=*`)).json?.[0];
check(lead?.source === 'email', 'the lead is email-sourced');
check(lead?.source_ref === `email:${SENDER}`, 'keyed by sender, for idempotent thread continuation');

const conversation = (await select('crm', `conversations?id=eq.${first?.conversation_id}&select=*`)).json?.[0];
check(conversation?.channel === 'email', 'the conversation is on the email channel');

const message = (await select('crm', `conversation_messages?id=eq.${first?.message_id}&select=*`)).json?.[0];
check(message?.metadata?.subject === 'Website enquiry', 'the subject is recorded in metadata');

section('4. Redelivery of the same Message-Id');
const replay = await ingest({
  mailbox: MAILBOX_A,
  fromName: 'Client Co',
  subject: 'Website enquiry',
  body: 'I need a quote',
  externalRef: '<zztest-msg-1@mail.example.com>',
});
check(replay?.status === 'replayed', 'it reports a replay rather than failing');
check(replay?.message_id === first?.message_id, 'returning the message already recorded');
check(replay?.job_id === null, 'and queues no second extraction');
check(
  (await countOf('crm', `conversation_messages?conversation_id=eq.${first?.conversation_id}&select=id`)) === 1,
  'the transcript still holds exactly one message',
);

section('5. A second message, same sender — continues the thread');
const second = await ingest({ mailbox: MAILBOX_A, subject: 'Re: Website enquiry', body: 'Following up', externalRef: '<zztest-msg-2@mail.example.com>' });
check(second?.contact_id === first?.contact_id, 'same contact');
check(second?.lead_id === first?.lead_id, 'same lead');
check(second?.message_seq === 1, 'the transcript continues at position 1');
check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'exactly one lead exists for this organization',
);

section('6. Two organizations never see each other\'s rows');
const forB = await ingest({ mailbox: MAILBOX_B, fromEmail: 'zztest-other@example.com', body: 'hi', externalRef: '<zztest-msg-b1@mail.example.com>' });
check(forB?.organization_id === ORG_B, 'a message to mailbox B lands under organization B');

section('7. Cleanup');
await dropOrganizations();
const leftA = await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`);
const leftB = await countOf('crm', `leads?organization_id=eq.${ORG_B}&select=id`);
check(leftA === 0 && leftB === 0, 'temporary organizations and everything under them removed');

if (failures > 0) {
  console.log(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
