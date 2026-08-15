#!/usr/bin/env node
/**
 * No consent, no send — verified against a real database.
 *
 * Gap G-012, decisions ADM-70 and ADM-81. ADM-70 required that suppression be
 * enforced by the communication system rather than the UI, so the only honest
 * test is one that calls the communication system.
 *
 * The unit tests read the migration text. Text cannot show that the guard
 * actually refuses, and it cannot show the thing ADM-70 warned about hardest:
 * that the approval announcement to the internal group still gets through.
 *
 * What it proves:
 *
 *   1. A client with no consent row is refused.
 *   2. A client whose consent is `granted` is sent to.
 *   3. A client whose consent is `withdrawn` is refused again.
 *   4. Consent is channel-specific — a row for another channel is no consent.
 *   5. A refused send is not made permissible by retrying it.
 *   6. The internal group is sent to with no consent anywhere — G-110 survives.
 *   7. A client conversation with no identifiable contact is refused.
 *   8. Every consent change is audited.
 *
 *   node scripts/verify-consent.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-consent');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest_g012_${randomUUID().slice(0, 8)}`;

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

const send = async (conversationId, ref) =>
  one(await rest('POST', 'crm', 'rpc/send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: 'probe',
    p_external_ref: ref,
  }));

const created = { conversations: [], leads: [], contacts: [] };

console.log('\n\x1b[1mAgencyOS — no consent, no send (G-012, ADM-70, ADM-81)\x1b[0m');

try {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: org, full_name: `${MARKER} client`, phone: `+9199${Date.now() % 100000000}`,
  }));
  created.contacts.push(contact.id);

  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: org, title: `${MARKER} lead`, contact_id: contact.id,
  }));
  created.leads.push(lead.id);

  const direct = one(await rest('POST', 'crm', 'conversations', {
    organization_id: org, kind: 'direct', channel: 'whatsapp',
    lead_id: lead.id, contact_id: contact.id,
  }));
  created.conversations.push(direct.id);

  console.log('\n1. A client with no recorded consent is not messaged');
  {
    const r = await send(direct.id, `${MARKER}-1`);
    check(r?.outcome === 'no_consent', 'absent consent refuses the send', `outcome ${r?.outcome}`);
    check(r?.message_id === null, 'and nothing was queued', `${r?.message_id}`);
  }

  console.log('\n2. Consent is channel-specific');
  {
    // The channel CHECK admits only whatsapp today, so the honest form of this
    // is that a granted row must name the channel being sent on. Writing one
    // for a channel that does not exist is refused by the constraint itself,
    // which is the same guarantee arrived at one layer down.
    const bogus = await rest('POST', 'crm', 'communication_consent', {
      organization_id: org, contact_id: contact.id, channel: 'email', status: 'granted',
    });
    check(bogus.status >= 400, 'consent cannot be recorded for a channel with no sender', `status ${bogus.status}`);
  }

  console.log('\n3. Granted consent lets it through, withdrawn stops it');
  {
    await rest('POST', 'crm', 'communication_consent', {
      organization_id: org, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
    });
    const ok = await send(direct.id, `${MARKER}-2`);
    check(ok?.outcome === 'created', 'a client who consented is messaged', `outcome ${ok?.outcome}`);
    check(ok?.to_phone === contact.phone, 'and addressed by their own number');

    await rest('PATCH', 'crm',
      `communication_consent?contact_id=eq.${contact.id}&channel=eq.whatsapp`,
      { status: 'withdrawn' });
    const stopped = await send(direct.id, `${MARKER}-3`);
    check(stopped?.outcome === 'no_consent', 'withdrawing stops future sends', `outcome ${stopped?.outcome}`);
  }

  console.log('\n4. A refusal is not undone by retrying it');
  {
    // The guard runs before the idempotency lookup, so a send refused for want
    // of consent cannot become permitted by being repeated under the same ref.
    const again = await send(direct.id, `${MARKER}-3`);
    check(again?.outcome === 'no_consent', 'the same ref is refused again, not already_sent', `outcome ${again?.outcome}`);
  }

  console.log('\n5. The internal group is not a client — G-110 survives');
  {
    // The trap ADM-70 named before anybody built it. There is no consent row
    // for anybody here, and there is no client on the other end.
    const internal = one(await rest('POST', 'crm', 'conversations', {
      organization_id: org, kind: 'internal_group', channel: 'whatsapp',
    }));
    created.conversations.push(internal.id);

    const r = await send(internal.id, `${MARKER}-4`);
    check(
      r?.outcome === 'created',
      'the approval announcement is sent with no consent anywhere',
      `outcome ${r?.outcome}`,
    );
    check(r?.recipient_type === 'group', 'and still addressed as a group');
  }

  console.log('\n6. Nobody to have consented is a refusal, not a pass');
  {
    // A client-facing conversation carrying no contact. Built as a `direct`
    // thread with a lead and no contact rather than a project group, because
    // that exercises the same branch and needs no project fixture — the first
    // draft looked for an existing project and SKIPPED when it found none,
    // which is a check reporting green for work it did not do.
    const orphanLead = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} no-contact lead`,
    }));
    created.leads.push(orphanLead.id);

    const orphan = one(await rest('POST', 'crm', 'conversations', {
      organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: orphanLead.id,
    }));
    created.conversations.push(orphan.id);

    const r = await send(orphan.id, `${MARKER}-5`);
    check(
      r?.outcome === 'no_consent',
      'a client conversation with no identifiable contact is refused',
      `outcome ${r?.outcome}`,
    );
  }

  console.log('\n7. Every consent change is on the record');
  {
    const log = await rest('GET', 'audit',
      `audit_log?subject_type=eq.communication_consent&select=action&order=created_at.desc&limit=10`);
    const actions = (Array.isArray(log.json) ? log.json : []).map((r) => r.action);
    check(actions.includes('consent.granted'), 'granting is audited', actions.join(', '));
    check(actions.includes('consent.withdrawn'), 'and so is withdrawing', actions.join(', '));
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
  console.log('\n\x1b[32m✔ No consent, no send — and the internal group still gets through\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
