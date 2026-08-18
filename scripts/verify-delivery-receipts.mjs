#!/usr/bin/env node
/**
 * Delivery receipts, verified against a real database — C10.
 *
 * An outbound message carries two axes. `metadata.delivery` is the accept-state
 * (pending → sent | failed) crm.mark_outbound_delivery settles the moment the
 * provider returns a ref. `metadata.wire_status` is what Meta reports AFTER —
 * delivered, read, or a downstream failure — arriving asynchronously in the
 * webhook's `statuses[]` and recorded by crm.record_delivery_receipt. This
 * proves that second axis: monotonic, idempotent, tenant-scoped, and unable to
 * touch anything but the outbound message it names.
 *
 * What it proves:
 *   1. A receipt advances the wire status and stamps its timestamp.
 *   2. The axis is MONOTONIC — a duplicate or out-of-order receipt is a no-op,
 *      and `read`/`failed` are terminal.
 *   3. A `failed` receipt is recorded AND audited; delivered/read are not.
 *   4. TENANT ISOLATION — a receipt routed to org B's number cannot touch org
 *      A's message even when A holds that provider_ref (the graft), and a
 *      number no org claims is acknowledged, not matched.
 *   5. A receipt cannot stamp an INBOUND message (a client's own words).
 *   6. The message body is never touched.
 *   7. An unknown status string is refused defensively at the database, not
 *      just at the app schema.
 *
 * Hermetic: two throwaway organizations, deleted at the end.
 *
 *   node scripts/verify-delivery-receipts.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-delivery-receipts');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARK = `zzrcpt-${randomUUID().slice(0, 8)}`;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

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

/** rpc/record_delivery_receipt returns a bare text outcome. */
async function receipt(phoneNumberId, providerRef, status, occurredAt) {
  const r = await rest('POST', 'crm', 'rpc/record_delivery_receipt', {
    p_phone_number_id: phoneNumberId,
    p_provider_ref: providerRef,
    p_status: status,
    ...(occurredAt ? { p_occurred_at: occurredAt } : {}),
  });
  return one(r);
}

const wireOf = async (messageId) => {
  const row = one(
    await rest('GET', 'crm', `conversation_messages?id=eq.${messageId}&select=metadata,body`),
  );
  return row ?? {};
};

const orgs = [];
async function makeOrg(label, phoneNumberId) {
  const o = one(
    await rest('POST', 'core', 'organizations', {
      name: `${MARK} ${label}`,
      slug: `${MARK}-${label}`,
      settings: { whatsapp_phone_number_id: phoneNumberId },
    }),
  );
  if (!o?.id) throw new Error(`could not create org ${label}: ${JSON.stringify(o)}`);
  orgs.push(o.id);
  return o.id;
}

/** A fully-set-up outbound message in org A with a recorded provider_ref. */
async function sentMessage(org, conversationId, body, ref, wamid) {
  const sent = one(
    await rest('POST', 'crm', 'rpc/send_outbound_message', {
      p_conversation_id: conversationId,
      p_body: body,
      p_external_ref: ref,
    }),
  );
  if (!sent?.message_id) throw new Error(`send failed: ${JSON.stringify(sent)}`);
  await rest('POST', 'crm', 'rpc/mark_outbound_delivery', {
    p_message_id: sent.message_id,
    p_status: 'sent',
    p_provider_ref: wamid,
  });
  return sent.message_id;
}

console.log('\n\x1b[1mAgencyOS — a message reports what the wire did (C10)\x1b[0m');

try {
  const PA = `${MARK}-A-5550001`;
  const PB = `${MARK}-B-5550002`;
  const A = await makeOrg('a', PA);
  // Org B is created (and cleaned up) so PB resolves to a REAL other tenant —
  // its id is never needed directly; the graft is driven by its number.
  await makeOrg('b', PB);

  // Fixture in A: a contact, a consented lead, a conversation to send on.
  const contact = one(
    await rest('POST', 'crm', 'contacts', {
      organization_id: A,
      full_name: `${MARK} client`,
      phone: `9190${(Date.now() % 100000000).toString().padStart(8, '0')}`,
    }),
  );
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: A,
      title: `${MARK} lead`,
      contact_id: contact?.id,
      source: 'whatsapp',
    }),
  );
  await rest('POST', 'crm', 'communication_consent', {
    organization_id: A,
    contact_id: contact?.id,
    channel: 'whatsapp',
    status: 'granted',
    source: `${MARK} fixture`,
  });
  const conversation = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: A,
      lead_id: lead?.id,
      contact_id: contact?.id,
      channel: 'whatsapp',
    }),
  );
  if (!conversation?.id) throw new Error('could not create the conversation fixture');

  const R1 = `wamid.${MARK}.R1`;
  const msg1 = await sentMessage(A, conversation.id, 'To be delivered and read', `${MARK}-m1`, R1);

  // ── 1. a receipt advances the wire status ───────────────────────────────
  console.log('\n1. A receipt advances the wire status and stamps its time');
  {
    const before = await wireOf(msg1);
    check(before.metadata?.wire_status === undefined, 'a fresh send has no wire_status yet', JSON.stringify(before.metadata));

    const out = await receipt(PA, R1, 'delivered', '2026-08-18T10:00:00Z');
    check(out === 'recorded', 'a delivered receipt is recorded', `outcome ${out}`);
    const m = await wireOf(msg1);
    check(m.metadata?.wire_status === 'delivered', 'wire_status becomes delivered', JSON.stringify(m.metadata));
    check(typeof m.metadata?.delivered_at === 'string', 'and delivered_at is stamped', JSON.stringify(m.metadata));
    check(m.metadata?.delivery === 'sent', 'the accept-state (delivery) is left untouched', JSON.stringify(m.metadata));
  }

  // ── 2. monotonic, then terminal ─────────────────────────────────────────
  console.log('\n2. The axis only moves forward, then locks');
  {
    // msg1 is at 'delivered' (non-terminal) from section 1 — the state where a
    // non-advancing receipt is refused as not-forward rather than terminal.
    const dupDelivered = await receipt(PA, R1, 'delivered', '2026-08-18T10:04:00Z');
    check(dupDelivered === 'ignored_not_forward', 'a duplicate delivered is a no-op', `outcome ${dupDelivered}`);
    const lower = await receipt(PA, R1, 'sent', '2026-08-18T10:04:30Z');
    check(lower === 'ignored_not_forward', 'a lower status (sent) after delivered is a no-op', `outcome ${lower}`);
    check((await wireOf(msg1)).metadata?.wire_status === 'delivered', 'wire_status stays delivered');

    const read = await receipt(PA, R1, 'read', '2026-08-18T10:05:00Z');
    check(read === 'recorded', 'read advances past delivered', `outcome ${read}`);
    check((await wireOf(msg1)).metadata?.wire_status === 'read', 'wire_status is read');

    // `read` is terminal: anything after it is ignored AS terminal, a stronger
    // statement than not-forward — the message is done.
    const back = await receipt(PA, R1, 'delivered', '2026-08-18T10:06:00Z');
    check(back === 'ignored_terminal', 'a delivered after read is terminal-ignored', `outcome ${back}`);
    const dupRead = await receipt(PA, R1, 'read', '2026-08-18T10:07:00Z');
    check(dupRead === 'ignored_terminal', 'a duplicate read is terminal-ignored', `outcome ${dupRead}`);
    const afterFail = await receipt(PA, R1, 'failed', '2026-08-18T10:08:00Z');
    check(afterFail === 'ignored_terminal', 'a failed cannot follow a read', `outcome ${afterFail}`);
    check((await wireOf(msg1)).metadata?.wire_status === 'read', 'and wire_status stays read');
  }

  // ── 3. a failure is recorded and audited ────────────────────────────────
  console.log('\n3. A wire failure is recorded, and audited');
  {
    const R2 = `wamid.${MARK}.R2`;
    const msg2 = await sentMessage(A, conversation.id, 'This one bounces', `${MARK}-m2`, R2);

    const failed = await receipt(PA, R2, 'failed', '2026-08-18T11:00:00Z');
    check(failed === 'recorded', 'a failed receipt is recorded', `outcome ${failed}`);
    const m = await wireOf(msg2);
    check(m.metadata?.wire_status === 'failed', 'wire_status becomes failed', JSON.stringify(m.metadata));
    check(typeof m.metadata?.failed_at === 'string', 'and failed_at is stamped');

    const audit = await rest(
      'GET',
      'audit',
      `audit_log?subject_id=eq.${msg2}&action=eq.message.outbound.wire_failed&select=id,action,subject_type`,
    );
    check((audit.json?.length ?? 0) === 1, 'exactly one wire_failed audit row exists', JSON.stringify(audit.json ?? audit.text));
    check(one(audit)?.subject_type === 'conversation_message', 'audited against the message', JSON.stringify(one(audit)));

    const afterFail = await receipt(PA, R2, 'delivered', '2026-08-18T11:01:00Z');
    check(afterFail === 'ignored_terminal', 'a delivered cannot follow a failed (failed is terminal)', `outcome ${afterFail}`);
  }

  // ── 4. tenant isolation, including the graft ────────────────────────────
  console.log('\n4. A receipt cannot cross a tenant');
  {
    // Org B is real and claims PB, but holds no message with R1. A receipt
    // routed to B by its number must not reach A's message R1 even though A
    // holds it — the graft the org-scoped lookup exists to refuse.
    const graft = await receipt(PB, R1, 'delivered', '2026-08-18T12:00:00Z');
    check(graft === 'unmatched', "org B's number cannot match org A's message", `outcome ${graft}`);
    check((await wireOf(msg1)).metadata?.wire_status === 'read', "and A's message is unchanged (still read)");

    const nobody = await receipt(`${MARK}-CLAIMED-BY-NOBODY`, R1, 'read', '2026-08-18T12:01:00Z');
    check(nobody === 'unknown_phone_number_id', 'a number no org claims is acknowledged, not matched', `outcome ${nobody}`);
    check((await wireOf(msg1)).metadata?.wire_status === 'read', "and A's message is still unchanged");
  }

  // ── 5. an inbound message cannot be stamped ─────────────────────────────
  console.log('\n5. A receipt cannot touch an inbound message');
  {
    const IW = `wamid.${MARK}.INBOUND`;
    await rest('POST', 'crm', 'rpc/ingest_whatsapp_message', {
      p_phone_number_id: PA,
      p_from: '919111111111',
      p_external_ref: IW,
      p_body: 'a client speaking',
      p_occurred_at: '2026-08-18T09:00:00Z',
    });
    const out = await receipt(PA, IW, 'read', '2026-08-18T13:00:00Z');
    check(out === 'unmatched', 'a wamid that exists only as an inbound external_ref is unmatched', `outcome ${out}`);
    const inbound = one(
      await rest('GET', 'crm', `conversation_messages?organization_id=eq.${A}&external_ref=eq.${IW}&select=metadata,body`),
    );
    check(inbound?.metadata?.wire_status === undefined, 'the inbound row is never given a wire_status', JSON.stringify(inbound?.metadata));
    // Inbound metadata carries no `direction: outbound` — that is exactly why
    // the function's outbound filter excludes it; assert the row is intact.
    check(inbound?.metadata?.direction !== 'outbound', 'and is never marked outbound', JSON.stringify(inbound?.metadata));
    check(inbound?.body === 'a client speaking', "and its body is untouched", `${inbound?.body}`);
  }

  // ── 6. the body is never touched ────────────────────────────────────────
  console.log('\n6. A delivery report cannot rewrite the message');
  {
    const m = await wireOf(msg1);
    check(m.body === 'To be delivered and read', 'the body is exactly what was sent', `${m.body}`);
  }

  // ── 7. an unknown status is refused at the database ─────────────────────
  console.log('\n7. An unknown status is refused defensively');
  {
    const R3 = `wamid.${MARK}.R3`;
    const msg3 = await sentMessage(A, conversation.id, 'Third', `${MARK}-m3`, R3);
    const bogus = await receipt(PA, R3, 'teleported', '2026-08-18T14:00:00Z');
    check(bogus === 'ignored_unknown_status', 'a status the function does not model is ignored, not stored', `outcome ${bogus}`);
    check((await wireOf(msg3)).metadata?.wire_status === undefined, 'and the message keeps no wire_status');

    // A 'sent' wire receipt is a legitimate forward move from nothing, and a
    // later 'read' skipping 'delivered' still advances.
    const sent = await receipt(PA, R3, 'sent', '2026-08-18T14:01:00Z');
    check(sent === 'recorded', 'a sent wire receipt records from nothing', `outcome ${sent}`);
    const readSkip = await receipt(PA, R3, 'read', '2026-08-18T14:02:00Z');
    check(readSkip === 'recorded', 'read advances even skipping delivered', `outcome ${readSkip}`);
    check((await wireOf(msg3)).metadata?.wire_status === 'read', 'wire_status is read');
  }
} finally {
  for (const id of orgs) {
    const gone = await rest('DELETE', 'core', `organizations?id=eq.${id}`);
    if (gone.status >= 400) console.error(`  (cleanup) organization ${id.slice(0, 8)} left behind — HTTP ${gone.status}`);
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed.\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
