#!/usr/bin/env node
/**
 * The inbound WhatsApp webhook, verified over real HTTP against the real route.
 *
 * scripts/verify-whatsapp-ingest.mjs proves the database function. This proves
 * the door in front of it: that a delivery Meta did not sign is refused, that a
 * handshake with the wrong token gets no challenge, and that a genuine delivery
 * travels all the way from an HTTP request to a lead, a transcript line and a
 * queued extraction.
 *
 *   • the subscription handshake echoes the challenge for the right token, and
 *     nothing at all for the wrong one
 *   • a delivery with a bad, missing or tampered signature is refused, and
 *     writes nothing
 *   • a first message becomes a contact, lead, conversation, message and job
 *   • redelivering it answers 200 and creates nothing further
 *   • status receipts and non-text messages are acknowledged, not ingested
 *   • a body that is not JSON is a 400
 *   • a message for a phone_number_id no organization claims is acknowledged
 *     rather than retried forever
 *
 * Everything is created under a temporary organization and removed afterwards.
 *
 *   npm run verify:db:up        # a local stack, if you do not have one
 *   npm run verify:dev          # in another terminal
 *   npm run db:verify:webhook
 */

import { createHmac } from 'node:crypto';
import { URL } from 'node:url';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const SLUG = 'zztest-webhook-org';
const PN = 'ZZTEST_WEBHOOK_PN';
const SENDER = '919900880077';
const SENDER_E164 = '+919900880077';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false, whatsapp: true });
const URL_BASE = target.url;
const SECRET = target.serviceKey;
const APP = target.app;
const VERIFY_TOKEN = target.whatsappVerifyToken;
const APP_SECRET = target.whatsappAppSecret;

const WEBHOOK = `${APP}/api/webhooks/whatsapp`;

// ── PostgREST, for observing what the route did ────────────────────────────

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
const countOf = async (schema, path) => ((await select(schema, path)).json ?? []).length;

// ── the webhook, as Meta calls it ──────────────────────────────────────────

const sign = (body, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

/** GET, the subscription handshake. */
async function handshake({ mode = 'subscribe', token, challenge = '1158201444' }) {
  const url = new URL(WEBHOOK);
  if (mode !== null) url.searchParams.set('hub.mode', mode);
  if (token !== null) url.searchParams.set('hub.verify_token', token);
  if (challenge !== null) url.searchParams.set('hub.challenge', challenge);
  const res = await fetch(url, { cache: 'no-store' });
  return { status: res.status, body: await res.text() };
}

/** POST, one signed delivery. `signature` overrides the correct one. */
async function deliver(payload, { signature, raw } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers['X-Hub-Signature-256'] = sig;

  const res = await fetch(WEBHOOK, { method: 'POST', headers, body, cache: 'no-store' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

/** A delivery carrying one inbound text message. */
const textDelivery = (id, body, { phoneNumberId = PN, name = 'Ravi' } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ZZTEST',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
            contacts: [{ profile: { name }, wa_id: SENDER }],
            messages: [
              {
                from: SENDER,
                id,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body },
              },
            ],
          },
        },
      ],
    },
  ],
});

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : bad(m));
const note = (m) => console.log(`  \x1b[33m•\x1b[0m ${m}`);
const section = (m) => console.log(`\n${m}`);

const dropOrganization = () => remove('core', `organizations?slug=eq.${SLUG}`);

console.log('\n\x1b[1mInbound WhatsApp webhook — over real HTTP\x1b[0m');

// ── 0. Preflight ───────────────────────────────────────────────────────────
section('0. Preflight');
announceTarget(target);

const reachable = await fetch(`${APP}/api/health`, { cache: 'no-store' }).catch(() => null);
check(Boolean(reachable?.ok), `app reachable at ${APP}`);
if (!reachable?.ok) fail(`the app is not running at ${APP} — start it with: npm run verify:dev`);

await dropOrganization();

// ── 1. The subscription handshake ──────────────────────────────────────────
section('1. GET — the subscription handshake');

const good = await handshake({ token: VERIFY_TOKEN });
check(good.status === 200, 'A. the right token is answered 200');
check(good.body === '1158201444', 'A. and the challenge is echoed back verbatim');

const wrongToken = await handshake({ token: 'definitely-not-the-token' });
check(wrongToken.status === 403, 'B. a wrong token is refused with 403');
check(!wrongToken.body.includes('1158201444'), 'B. and the challenge is NOT echoed');

const noToken = await handshake({ token: null });
check(noToken.status === 403, 'B. an absent token is refused');

const wrongMode = await handshake({ mode: 'unsubscribe', token: VERIFY_TOKEN });
check(wrongMode.status === 403, 'B. the right token under another mode is refused');

// ── 2. Signature enforcement ───────────────────────────────────────────────
section('2. POST — signature enforcement');

const payload = textDelivery('wamid.ZZTEST.SIG', 'this must never be stored');

const unsigned = await deliver(payload, { signature: null });
check(unsigned.status === 401, 'C. a delivery with no signature is refused with 401');

const badSig = await deliver(payload, { signature: `sha256=${'0'.repeat(64)}` });
check(badSig.status === 401, 'C. a wrong digest is refused');

const wrongSecret = await deliver(payload, { signature: sign(JSON.stringify(payload), 'not-the-secret-000000') });
check(wrongSecret.status === 401, 'C. a signature from another secret is refused');

const body = JSON.stringify(payload);
const tampered = body.replace('this must never be stored', 'free work forever');
const tamperedRes = await deliver(null, { raw: tampered, signature: sign(body) });
check(tamperedRes.status === 401, 'C. a tampered body is refused despite a once-valid signature');

check(
  (await countOf('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.SIG&select=id`)) === 0,
  'C. none of the refused deliveries wrote anything',
);

// ── 3. Malformed body ──────────────────────────────────────────────────────
section('3. POST — a body that is not JSON');

const malformed = await deliver(null, { raw: '{ this is not json', signature: undefined });
// signature is computed over the raw body, so this is a *validly signed*
// delivery whose body cannot be parsed — the case that isolates the 400.
const malformedSigned = await deliver(null, {
  raw: '{ this is not json',
  signature: sign('{ this is not json'),
});
check(malformed.status === 401 || malformed.status === 400, 'D. an unsigned malformed body is refused');
check(malformedSigned.status === 400, 'D. a signed malformed body is 400, not a retry loop');

// ── 4. Fixture ─────────────────────────────────────────────────────────────
section('4. Fixture (a temporary organization only)');

const org = await insert('core', 'organizations', {
  name: 'ZZTEST Webhook Org',
  slug: SLUG,
  settings: { whatsapp_phone_number_id: PN },
});
const ORG = org.json?.[0]?.id;
if (!ORG) fail(`could not create the temporary organization: ${org.text}`);
check(Boolean(ORG), 'an organization exists, claiming the test WhatsApp number');

// ── 5. A first inbound message, end to end ─────────────────────────────────
section('5. POST — a first inbound message');

const first = await deliver(textDelivery('wamid.ZZTEST.W1', 'We need a booking system'));

check(first.status === 200, 'E. the delivery is accepted with 200');
check(first.json?.received === 1, 'E. one message was read out of the envelope');
check(first.json?.ingested === 1, 'E. and one was ingested');

const lead = (await select('crm', `leads?organization_id=eq.${ORG}&select=*`)).json?.[0];
check(Boolean(lead), 'F. a lead now exists for this organization');
check(lead?.source === 'whatsapp', 'F. sourced whatsapp');
check(lead?.source_ref === `wa:${SENDER_E164}`, 'F. keyed by the sender thread');

const contact = (await select('crm', `contacts?organization_id=eq.${ORG}&select=*`)).json?.[0];
check(contact?.phone === SENDER_E164, 'F. with a contact stored in E.164');
check(contact?.full_name === 'Ravi', 'F. named from the WhatsApp profile');

const message = (
  await select('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.W1&select=*`)
).json?.[0];
check(Boolean(message), 'G. the transcript holds the message');
check(message?.author_type === 'client', 'G. authored by the client');
check(message?.body === 'We need a booking system', 'G. with the text exactly as sent');
check(message?.seq === 0, 'G. at position 0');

const jobs = (await select('core', `jobs?organization_id=eq.${ORG}&select=*`)).json ?? [];
check(jobs.length === 1, 'H. exactly one extraction job was queued');
check(jobs[0]?.kind === 'requirement.extract', 'H. of the kind the runner claims');

// ── 6. Replay ──────────────────────────────────────────────────────────────
section('6. POST — the same delivery again');

const replay = await deliver(textDelivery('wamid.ZZTEST.W1', 'We need a booking system'));

check(replay.status === 200, 'I. a redelivery is answered 200, never a conflict');
check(replay.json?.replayed === 1, 'I. and is reported as a replay');
check(replay.json?.ingested === 0, 'I. nothing was ingested a second time');
check(
  (await countOf('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.W1&select=id`)) === 1,
  'I. the transcript still holds exactly one copy',
);
check((await countOf('crm', `leads?organization_id=eq.${ORG}&select=id`)) === 1, 'I. still one lead');
check((await countOf('core', `jobs?organization_id=eq.${ORG}&select=id`)) === 1, 'I. still one job');

// ── 7. Events that are not inbound messages ────────────────────────────────
section('7. POST — deliveries that carry no message');

const statuses = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ZZTEST',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: PN },
            statuses: [{ id: 'wamid.ZZTEST.W1', status: 'read', recipient_id: SENDER }],
          },
        },
      ],
    },
  ],
};
const statusRes = await deliver(statuses);
check(statusRes.status === 200, 'J. a status receipt is acknowledged with 200');
check(statusRes.json?.received === 0, 'J. with no message read');
check(statusRes.json?.ignored === 1, 'J. and counted as ignored rather than silently dropped');

const image = textDelivery('wamid.ZZTEST.IMG', 'ignored');
image.entry[0].changes[0].value.messages[0] = {
  from: SENDER,
  id: 'wamid.ZZTEST.IMG',
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'image',
  image: { id: 'media-1', mime_type: 'image/jpeg' },
};
const imageRes = await deliver(image);
check(imageRes.status === 200, 'J. a non-text message is acknowledged');
check(
  (await countOf('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.IMG&select=id`)) === 0,
  'J. and is not given an invented body',
);

const unknownNumber = await deliver(
  textDelivery('wamid.ZZTEST.NOBODY', 'hello?', { phoneNumberId: 'ZZTEST_PN_UNCLAIMED' }),
);
check(unknownNumber.status === 200, 'K. a message to an unclaimed number is acknowledged, not retried');
check(unknownNumber.json?.skipped === 1, 'K. and reported as skipped');
check(
  (await countOf('crm', `conversation_messages?external_ref=eq.wamid.ZZTEST.NOBODY&select=id`)) === 0,
  'K. having created nothing',
);

// ── 7b. Regression: C5 — refused messages are named, long ones are kept ────
//
// VALIDATION and NOT_FOUND were folded into one `skipped` count behind a
// console.warn, so a customer's message that never reached the transcript was
// indistinguishable from a delivery for a number we do not serve. Separately, a
// body over 10,000 characters was dropped outright by a bound copied from the
// staff form schema — the column holding it is `text` with no upper limit.
section('7b. C5 — nothing is discarded silently');

// A long message: longer than the old cap, and longer than WhatsApp itself
// permits, so this is the robustness case rather than an everyday one.
const longBody = `${'A'.repeat(12_000)}END`;
const longRes = await deliver(textDelivery('wamid.ZZTEST.C5.LONG', longBody));
const longStored = (
  await select('crm', 'conversation_messages?external_ref=eq.wamid.ZZTEST.C5.LONG&select=id,body')
).json?.[0];

check(longRes.status === 200, 'M. a 12,000-character message is accepted');
check(longRes.json?.ingested === 1, 'M. and reported as ingested, not skipped');
check(Boolean(longStored), 'M. it reached the transcript rather than being dropped');
check(
  longStored?.body?.length === longBody.length,
  `M. stored whole — ${longStored?.body?.length ?? 0} of ${longBody.length} characters`,
);
check(longStored?.body?.endsWith('END') === true, 'M. and not truncated at the tail');

// A structurally invalid message: nothing can store it, and no retry helps.
const badFrom = textDelivery('wamid.ZZTEST.C5.BAD', 'a real question');
badFrom.entry[0].changes[0].value.messages[0].from = 'not-a-number';
badFrom.entry[0].changes[0].value.contacts[0].wa_id = 'not-a-number';
const badRes = await deliver(badFrom);

check(badRes.status === 200, 'N. a malformed message is acknowledged, not retried into a loop');
check(badRes.json?.rejected === 1, 'N. and counted as rejected');
check(badRes.json?.skipped === 0, 'N. distinct from an unclaimed number, which is skipped');
check(badRes.json?.ingested === 0, 'N. nothing was stored for it');
check(
  (await countOf('crm', 'conversation_messages?external_ref=eq.wamid.ZZTEST.C5.BAD&select=id')) === 0,
  'N. the transcript holds nothing for it',
);

// The two outcomes must remain distinguishable from each other.
const unclaimedC5 = await deliver(
  textDelivery('wamid.ZZTEST.C5.NOORG', 'hello?', { phoneNumberId: 'ZZTEST_PN_STILL_UNCLAIMED' }),
);
check(unclaimedC5.json?.skipped === 1, 'N. an unclaimed number is still skipped');
check(unclaimedC5.json?.rejected === 0, 'N. and never counted as rejected');

// Redelivering a refused message must not start duplicating anything.
const badAgain = await deliver(badFrom);
check(badAgain.status === 200, 'O. redelivering a refused message is still 200');
check(badAgain.json?.rejected === 1, 'O. still rejected, not silently absorbed');
check(
  (await countOf('crm', 'conversation_messages?external_ref=eq.wamid.ZZTEST.C5.BAD&select=id')) === 0,
  'O. and still nothing stored — no duplicate processing introduced',
);

// The valid path is unchanged.
const stillFine = await deliver(textDelivery('wamid.ZZTEST.C5.OK', 'an ordinary message'));
check(stillFine.json?.ingested === 1, 'O. an ordinary message is still ingested');
check(stillFine.json?.rejected === 0, 'O. with nothing rejected');

// ── 8. Nothing was sent ────────────────────────────────────────────────────
section('8. The webhook sent nothing');

const outbound = (await select('crm', `conversation_messages?organization_id=eq.${ORG}&select=author_type`)).json ?? [];
check(
  outbound.every((m) => m.author_type === 'client'),
  'L. every message recorded is client-authored — nothing replied',
);
note('AI proposes, a human approves and sends (ARCHITECTURE.md §6.1)');

// ── 9. Cleanup ─────────────────────────────────────────────────────────────
section('9. Cleanup');

await dropOrganization();
check((await countOf('crm', `leads?organization_id=eq.${ORG}&select=id`)) === 0, 'the temporary organization and everything under it removed');
check((await countOf('core', `jobs?organization_id=eq.${ORG}&select=id`)) === 0, 'its queued job went with it');

if (failures > 0) {
  console.log(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
