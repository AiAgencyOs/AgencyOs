#!/usr/bin/env node
/**
 * Outbound messages, verified against a real database.
 *
 * Gap G-014, decision ADM-09. The Graph API is not called here and does not
 * need to be: everything that can go wrong in a way that loses a client's
 * message is in the database half — the seq allocation two repliers race for,
 * and the idempotency key that decides whether a retry is a second message.
 * The provider call itself is stubbed in tests/outbound-messages.test.ts.
 *
 * What it proves:
 *
 *   1. A message is recorded pending, with the number and account read from
 *      the database rather than supplied by the caller.
 *   2. The same idempotency key finds the first message instead of writing a
 *      second — including when two callers race.
 *   3. Two different messages sent at the same moment both survive, with
 *      different seq. This is the C2 race, one table along.
 *   4. A delivery report settles a pending message once, and a late duplicate
 *      cannot turn a delivered message into a failed one.
 *   5. A delivery report cannot touch the body.
 *
 *   node scripts/verify-outbound-messages.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

/**
 * Refuses an environment it cannot run against, with a message rather than a
 * crash. `resolveTarget` takes the caller's own exit function — the first
 * version of this script passed none, so an incomplete .env.verify.local
 * produced "fail is not a function" instead of the sentence explaining what
 * was missing. The error path nobody had executed.
 */
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// This script needs a service key: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-outbound-messages');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g014';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

/** JSON when the body is JSON, null when it is not. */
function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const send = (conversationId, body, ref) =>
  rest('POST', 'crm', 'rpc/send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: body,
    p_external_ref: ref,
  });

const created = {};

console.log('\n\x1b[1mAgencyOS — outbound messages (G-014, ADM-09)\x1b[0m');

try {
  // The organization's own WhatsApp account, which the function reads rather
  // than taking as an argument.
  const org = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`));
  created.settings = org?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...created.settings, whatsapp_phone_number_id: `${MARKER}-5550001` },
  });

  const contact = one(
    await rest('POST', 'crm', 'contacts', {
      organization_id: ORG,
      full_name: `${MARKER} client`,
      phone: '919000000000',
    }),
  );
  created.contact = contact?.id;

  // A conversation belongs to a lead, so the fixture needs one.
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG,
      title: `${MARKER} lead`,
      contact_id: created.contact,
      source: 'whatsapp',
    }),
  );
  created.lead = lead?.id;

  const conversation = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      lead_id: created.lead,
      contact_id: created.contact,
      channel: 'whatsapp',
    }),
  );
  created.conversation = conversation?.id;
  if (!created.conversation) throw new Error('could not create the conversation fixture');

  // ── 1. recorded before anything is sent ─────────────────────────────────
  console.log('\n1. The message is recorded first, pending');
  {
    const first = one(await send(created.conversation, 'Hello from verification', `${MARKER}-a`));
    check(first?.outcome === 'created', 'the first send records a message', `outcome ${first?.outcome}`);
    check(first?.seq === 0, 'and takes the next position in the thread', `seq ${first?.seq}`);
    check(
      first?.to_phone === '919000000000',
      'the number comes from the contact, not from the caller',
      `${first?.to_phone}`,
    );
    check(
      first?.from_phone_number_id === `${MARKER}-5550001`,
      'and the account from the organization it belongs to',
      `${first?.from_phone_number_id}`,
    );

    const row = one(
      await rest('GET', 'crm', `conversation_messages?id=eq.${first.message_id}&select=metadata,author_type`),
    );
    check(
      row?.metadata?.delivery === 'pending',
      'the row exists as pending before the provider is called',
      JSON.stringify(row?.metadata),
    );
    check(row?.author_type === 'user', 'and is attributed to a person, not to the system', `${row?.author_type}`);
  }

  // ── 2. the same message twice ───────────────────────────────────────────
  console.log('\n2. The same message twice is one message');
  {
    const again = one(await send(created.conversation, 'Hello from verification', `${MARKER}-a`));
    check(again?.outcome === 'already_sent', 'a retry finds the first', `outcome ${again?.outcome}`);

    const [a, b] = await Promise.all([
      send(created.conversation, 'Racing retry', `${MARKER}-race`),
      send(created.conversation, 'Racing retry', `${MARKER}-race`),
    ]);
    const outcomes = [one(a)?.outcome, one(b)?.outcome].sort();
    check(
      outcomes[0] === 'already_sent' || outcomes[1] === 'created',
      'two callers with one key produce one message',
      outcomes.join(', '),
    );

    const rows = await rest(
      'GET',
      'crm',
      `conversation_messages?external_ref=eq.${MARKER}-race&select=id`,
    );
    check(rows.json?.length === 1, 'and exactly one row exists for that key', `${rows.json?.length}`);
  }

  // ── 3. two different messages at once ───────────────────────────────────
  console.log('\n3. Two different messages at the same moment both survive');
  {
    const [c, d] = await Promise.all([
      send(created.conversation, 'First reply', `${MARKER}-c`),
      send(created.conversation, 'Second reply', `${MARKER}-d`),
    ]);
    const seqs = [one(c)?.seq, one(d)?.seq];
    check(
      one(c)?.outcome === 'created' && one(d)?.outcome === 'created',
      'both are recorded — neither loses to the unique index',
      `${one(c)?.outcome}, ${one(d)?.outcome}`,
    );
    check(
      seqs[0] !== seqs[1] && seqs.every((s) => s !== null && s !== undefined),
      'with different positions in the thread',
      seqs.join(' and '),
    );
  }

  // ── 4-5. what the provider says ─────────────────────────────────────────
  console.log('\n4. The delivery report settles it once');
  {
    const target = one(await send(created.conversation, 'To be delivered', `${MARKER}-e`));

    const marked = await rest('POST', 'crm', 'rpc/mark_outbound_delivery', {
      p_message_id: target.message_id,
      p_status: 'sent',
      p_provider_ref: 'wamid.VERIFY1',
    });
    check(marked.json === true, 'a pending message is settled', `returned ${marked.json}`);

    const late = await rest('POST', 'crm', 'rpc/mark_outbound_delivery', {
      p_message_id: target.message_id,
      p_status: 'failed',
      p_error: 'a late duplicate report',
    });
    check(
      late.json === false,
      'and a late duplicate report cannot undo a delivery',
      `returned ${late.json}`,
    );

    const row = one(
      await rest('GET', 'crm', `conversation_messages?id=eq.${target.message_id}&select=body,metadata`),
    );
    check(
      row?.metadata?.delivery === 'sent' && row?.metadata?.provider_ref === 'wamid.VERIFY1',
      'the row carries what the provider said',
      JSON.stringify(row?.metadata),
    );
    check(row?.body === 'To be delivered', 'and the body is untouched by the report', `${row?.body}`);

    const nonsense = await rest('POST', 'crm', 'rpc/mark_outbound_delivery', {
      p_message_id: target.message_id,
      p_status: 'maybe',
    });
    check(
      nonsense.status >= 400,
      'a status that is neither sent nor failed is refused',
      `status ${nonsense.status}`,
    );
  }
} finally {
  if (created.conversation) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${created.conversation}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${created.conversation}`);
  }
  if (created.lead) await rest('DELETE', 'crm', `leads?id=eq.${created.lead}`);
  if (created.contact) await rest('DELETE', 'crm', `contacts?id=eq.${created.contact}`);
  if (created.settings) await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: created.settings });
  await rest('DELETE', 'audit', `audit_log?organization_id=eq.${ORG}&action=like.message.outbound.*`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A message is recorded before it is sent, and once\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
