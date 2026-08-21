// ═══════════════════════════════════════════════════════════════════════════
// A message nobody read may not name a price.
//
// ADM-11 grants automatic sending with nobody reading it first — and names the
// risk in its own words, "including messages that may carry a price, discount
// or delivery promise". ADM-22 forbids an agent stating a price at any level.
// The faithful implementation of both is that the automatic path stays
// automatic and what travels down it may not quote money.
//
// Asserted against real Postgres because the rule is a trigger over a regex,
// and both halves are the kind of thing that reads correct and behaves
// otherwise. The first draft used `\b` for a word boundary, which in Postgres
// is a BACKSPACE character, so three of five patterns matched nothing at all.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'an automated message may not state a price');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-price';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;

function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const created = { leads: [], conversations: [] };

/** Write a message straight at the table — around every application path. */
const write = (conversationId, seq, body, authorId) =>
  rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG,
    conversation_id: conversationId,
    seq,
    author_type: 'user',
    ...(authorId ? { author_id: authorId } : {}),
    body,
    external_ref: `${MARKER}:${randomUUID().slice(0, 8)}`,
  });

try {
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG,
      source: 'manual',
      title: `${MARKER} ${randomUUID().slice(0, 8)}`,
      status: 'new',
    }),
  );
  created.leads.push(lead.id);

  const conversation = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      lead_id: lead.id,
      channel: 'whatsapp',
      kind: 'direct',
      status: 'active',
    }),
  );
  created.conversations.push(conversation.id);

  // `author_id` carries no foreign key, so the rule keys on its PRESENCE
  // rather than on the id resolving to a person — see the migration's stated
  // limit. A synthetic id is therefore the honest fixture here: it exercises
  // exactly what the trigger tests. core.users is empty on the verification
  // database anyway, because users arrive through Supabase auth.
  const someone = randomUUID();

  console.log('\n  A. the unread path may not quote money');
  let seq = 0;
  for (const body of [
    'Your quote is ₹45,000 for the app.',
    'Total: Rs. 20000',
    'It comes to 2 lakh including GST',
    'We can offer 20% off this week',
    'USD 1200 for the admin panel',
  ]) {
    const r = await write(conversation.id, seq++, body, null);
    check(
      !r.ok && JSON.stringify(r.json ?? '').includes('may not state a price'),
      `refused: ${JSON.stringify(body).slice(0, 40)}`,
      r.ok ? 'IT WAS ACCEPTED' : `${r.status}`,
    );
  }

  console.log('\n  B. honest text still goes, or the guard teaches people around it');
  for (const body of [
    'Following up on our last message.',
    'The project is 50% complete.',
    'Milestone 3 of 4 is approved.',
    'Version 2024.1 is ready for your review.',
  ]) {
    const r = await write(conversation.id, seq++, body, null);
    check(r.ok, `sent: ${JSON.stringify(body).slice(0, 40)}`, r.ok ? '' : JSON.stringify(r.json).slice(0, 90));
  }

  console.log('\n  C. a human quoting a price is the thing ADM-22 asks for');
  const authored = await write(conversation.id, seq++, 'Your quote is ₹45,000 for the app.', someone);
  check(
    authored.ok,
    'a human-authored price is allowed',
    authored.ok ? '' : JSON.stringify(authored.json).slice(0, 90),
  );

  console.log('\n  D. and it cannot be edited in afterwards');
  const plain = one(await write(conversation.id, seq++, 'Following up on our last message.', null));
  const edited = await rest('PATCH', 'crm', `conversation_messages?id=eq.${plain.id}`, {
    body: 'Actually, it is ₹45,000.',
  });
  check(
    !edited.ok && JSON.stringify(edited.json ?? '').includes('may not state a price'),
    'an UPDATE that adds a price is refused too',
    edited.ok ? 'IT WAS ACCEPTED' : `${edited.status}`,
  );

  console.log('\n  E. an inbound client message is not the agency speaking');
  const inbound = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG,
    conversation_id: conversation.id,
    seq: seq++,
    author_type: 'client',
    body: 'My budget is ₹45,000 — can you do it?',
    external_ref: `${MARKER}:in:${randomUUID().slice(0, 8)}`,
  });
  check(inbound.ok, "a client may name their own budget", inbound.ok ? '' : JSON.stringify(inbound.json).slice(0, 90));
} finally {
  for (const id of created.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
