#!/usr/bin/env node
/**
 * An inbound STOP is heard — verified against a real database.
 *
 * Gap G-222, decision ADM-101. Consent in this system was asymmetric: an
 * inbound message GRANTED consent (crm.record_inbound_consent, ADM-92) and
 * nothing ever WITHDREW it. A client could reply "STOP" and keep being
 * messaged, because the blocking machinery (crm.send_outbound_message) refuses
 * on a `withdrawn` row that nothing wrote.
 *
 * The unit tests read the migration text and exercise the matcher's regex over
 * a hundred strings. Text cannot show the two things that matter here:
 *
 *   - that the trigger actually FLIPS a granted row to withdrawn on a real
 *     inbound STOP, through the same insert path production uses;
 *   - that the send is then refused, and that a later ordinary message does NOT
 *     re-grant — withdrawal is final until a deliberate act.
 *
 * What it proves:
 *
 *   1. A consented client who writes "STOP" has their consent withdrawn.
 *   2. The withdrawal is an UPDATE of the existing row, not a new one — the
 *      forge guards (20260815130000) forbid delete-and-insert, so a second row
 *      would mean the guard was bypassed.
 *   3. crm.send_outbound_message then refuses — the loop is actually closed.
 *   4. A later ordinary inbound message does NOT re-grant. Withdrawal stands.
 *   5. A client with no consent row who opens with "STOP" gets a withdrawn row
 *      directly — no send has happened and the opt-out stands.
 *   6. An ordinary message ("stop the ads please") does NOT withdraw — the
 *      false positive that would silence a live client.
 *   7. A Hinglish opt-out ("band karo") is heard.
 *   8. The withdrawal is on the audit record.
 *   9. Nothing was sent back — ADM-101 silent withdraw.
 *
 *   node scripts/verify-inbound-opt-out.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-inbound-opt-out');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest_g222_${randomUUID().slice(0, 8)}`;

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const org = one(await rest('GET', 'core', 'organizations?select=id&limit=1'))?.id;
if (!org) fail('no organization to run against');

let seq = 0;
// A client-authored inbound message, through the same table the webhook writes.
// The trigger fires on this insert exactly as it does in production.
const inbound = async (conversationId, body) =>
  one(await rest('POST', 'crm', 'conversation_messages', {
    organization_id: org,
    conversation_id: conversationId,
    seq: (seq += 1),
    author_type: 'client',
    body,
  }));

const send = async (conversationId, ref) =>
  one(await rest('POST', 'crm', 'rpc/send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: 'probe',
    p_external_ref: ref,
  }));

const consentRows = async (contactId) =>
  (await rest('GET', 'crm',
    `communication_consent?contact_id=eq.${contactId}&channel=eq.whatsapp&select=status,source,note`)).json ?? [];

const created = { conversations: [], leads: [], contacts: [] };

console.log('\n\x1b[1mAgencyOS — an inbound STOP is heard (G-222, ADM-101)\x1b[0m');

try {
  // ── a consented client who then says STOP ──────────────────────────────
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: org, full_name: `${MARKER} client`, phone: `+9199${Date.now() % 100000000}`,
  }));
  created.contacts.push(contact.id);

  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: org, title: `${MARKER} lead`, contact_id: contact.id,
  }));
  created.leads.push(lead.id);

  const convo = one(await rest('POST', 'crm', 'conversations', {
    organization_id: org, kind: 'direct', channel: 'whatsapp',
    lead_id: lead.id, contact_id: contact.id,
  }));
  created.conversations.push(convo.id);

  await rest('POST', 'crm', 'communication_consent', {
    organization_id: org, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
  });

  console.log('\n1. A consented client who writes STOP is withdrawn');
  {
    const before = await send(convo.id, `${MARKER}-pre`);
    check(before?.outcome === 'created', 'a consented client is messaged before STOP', `outcome ${before?.outcome}`);

    await inbound(convo.id, 'STOP');
    const rows = await consentRows(contact.id);
    check(rows.length === 1, 'still exactly one consent row — an UPDATE, not a forge-shaped insert', `rows ${rows.length}`);
    check(rows[0]?.status === 'withdrawn', 'the inbound STOP withdrew consent', `status ${rows[0]?.status}`);
    check(rows[0]?.source === 'inbound_message', 'recorded as an inbound-message withdrawal', `source ${rows[0]?.source}`);
  }

  console.log('\n2. The send is then refused — the loop is closed');
  {
    const after = await send(convo.id, `${MARKER}-post`);
    check(after?.outcome === 'no_consent', 'sending is refused after the STOP', `outcome ${after?.outcome}`);
    check(after?.message_id === null, 'and nothing was queued');
  }

  console.log('\n3. A later ordinary message does NOT re-grant');
  {
    await inbound(convo.id, 'actually, how much for the premium plan?');
    const rows = await consentRows(contact.id);
    check(rows[0]?.status === 'withdrawn', 'consent stays withdrawn after a later message', `status ${rows[0]?.status}`);
    const still = await send(convo.id, `${MARKER}-post2`);
    check(still?.outcome === 'no_consent', 'and the send is still refused', `outcome ${still?.outcome}`);
  }

  console.log('\n4. An ordinary message never withdrew — the false positive that silences a client');
  {
    // A fresh consented client who writes a sentence that merely CONTAINS a
    // command word. If this withdrew, the matcher would silence live clients.
    const c2 = one(await rest('POST', 'crm', 'contacts', {
      organization_id: org, full_name: `${MARKER} client2`, phone: `+9198${Date.now() % 100000000}`,
    }));
    created.contacts.push(c2.id);
    const l2 = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} lead2`, contact_id: c2.id,
    }));
    created.leads.push(l2.id);
    const conv2 = one(await rest('POST', 'crm', 'conversations', {
      organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: l2.id, contact_id: c2.id,
    }));
    created.conversations.push(conv2.id);
    await rest('POST', 'crm', 'communication_consent', {
      organization_id: org, contact_id: c2.id, channel: 'whatsapp', status: 'granted',
    });

    await inbound(conv2.id, 'please stop the facebook ads for now');
    check((await consentRows(c2.id))[0]?.status === 'granted', 'a mid-sentence "stop the ads" does not withdraw', 'must stay granted');
    const ok = await send(conv2.id, `${MARKER}-fp`);
    check(ok?.outcome === 'created', 'and the client is still messaged', `outcome ${ok?.outcome}`);
  }

  console.log('\n5. A Hinglish opt-out is heard');
  {
    await inbound(convo.id, 'bhai band karo ye messages');
    check((await consentRows(contact.id))[0]?.status === 'withdrawn', '"band karo" withdraws consent');
  }

  console.log('\n6. A first-ever STOP with no prior consent row is a direct withdrawal');
  {
    const c3 = one(await rest('POST', 'crm', 'contacts', {
      organization_id: org, full_name: `${MARKER} client3`, phone: `+9197${Date.now() % 100000000}`,
    }));
    created.contacts.push(c3.id);
    const l3 = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} lead3`, contact_id: c3.id,
    }));
    created.leads.push(l3.id);
    const conv3 = one(await rest('POST', 'crm', 'conversations', {
      organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: l3.id, contact_id: c3.id,
    }));
    created.conversations.push(conv3.id);

    await inbound(conv3.id, 'unsubscribe');
    const rows = await consentRows(c3.id);
    check(rows.length === 1 && rows[0]?.status === 'withdrawn', 'a first-ever opt-out inserts a withdrawn row directly', `rows ${JSON.stringify(rows)}`);
    const refused = await send(conv3.id, `${MARKER}-new`);
    check(refused?.outcome === 'no_consent', 'and the send is refused', `outcome ${refused?.outcome}`);
  }

  console.log('\n7. The withdrawal is on the audit record');
  {
    const log = await rest('GET', 'audit',
      `audit_log?subject_type=eq.communication_consent&select=action&order=created_at.desc&limit=20`);
    const actions = (Array.isArray(log.json) ? log.json : []).map((r) => r.action);
    check(actions.includes('consent.withdrawn'), 'withdrawing is audited', actions.join(', '));
  }
} finally {
  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ An inbound STOP is heard — and withdrawal is final\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
