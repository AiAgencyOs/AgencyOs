/**
 * An image a client sent is read before anybody answers it.
 *
 * Brief 2026-08-22 §28 and §29. The whole feature is one ordering rule and one
 * honesty rule, and both are proved here against real Postgres, the real
 * webhook, the real job runner and the real fetch path:
 *
 *   the ordering  a fetchable image holds back the intent read and the reply
 *                 until somebody has looked at it — and releases them the
 *                 instant somebody has, INCLUDING when the looking failed.
 *   the honesty   the transcript says "read by the agent: …" only where a
 *                 description exists, and "not transcribed" only where one
 *                 does not. Neither is a rule that could drift from the other,
 *                 because both are the same fact.
 *
 * Two stubs and only two — the model (127.0.0.1:54399) and Meta's Graph API
 * (127.0.0.1:54398), which here serves the media lookup and the bytes as well
 * as the send. Neither belongs to AgencyOS.
 *
 *   A. an image arrives with its handle and its caption, and no body
 *   B. it asks to be looked at, and holds back everything that would answer it
 *   C. the runner fetches it, reads it, and writes what it saw
 *   D. the transcript stops saying "not transcribed" — and only then
 *   E. everything the image held back is released, and the client is answered
 *   F. the two paths agree: a read image emits what a text message emits
 *   G. an image with no handle holds nothing back — a conversation never stops
 *   H. an image that cannot be fetched is released, unread and unpretended
 *   I. a reading is written once
 *   J. an account number in a screenshot is not written down
 *   K. a description queues the extraction the ingest declined
 *   L. the fetch will not follow a URL to a host Meta does not serve from
 *
 *   node scripts/verify-image-reading.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, whatsapp: true });
await announceTarget(target, 'An image is read before it is answered');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = 'zztest-image';
const PHONE_NUMBER_ID = `${MARKER}-pn-${randomUUID().slice(0, 8)}`;
const SENDER = `9198${String(Date.now()).slice(-8)}`;
const MODEL_PORT = 54399;
const GRAPH_PORT = 54398;

/** A 1×1 PNG. The smallest thing that is genuinely an image. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

const tick = () =>
  fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.cronSecret}` },
    cache: 'no-store',
  }).then(async (r) => ({ status: r.status, json: parse(await r.text()) }));

/**
 * Ticks until one message has been looked at, or the budget runs out.
 *
 * Waiting on "any run finished" is what made four earlier scripts pass for the
 * wrong reason: the runner claims the oldest job of any kind, so a tick can
 * legitimately do somebody else's work. This waits on THIS message.
 */
async function tickUntilRead(messageId, budget = 25) {
  for (let i = 0; i < budget; i += 1) {
    const row = one(await rest('GET', 'crm', `conversation_messages?id=eq.${messageId}&select=media_read_at,media_description`));
    if (row?.media_read_at) return row;
    await tick();
  }
  return one(await rest('GET', 'crm', `conversation_messages?id=eq.${messageId}&select=media_read_at,media_description`));
}

async function tickUntil(predicate, budget = 25) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── the stubs ──────────────────────────────────────────────────────────────

let modelDescription = 'A food delivery app home screen: a search bar, four category tiles and a cart button.';
let modelTextLanguage = 'en';
let modelCalls = 0;
/**
 * Every request the runner sent, verbatim.
 *
 * The transcript is asserted from THIS rather than from the function that
 * builds it. What matters is not that `transcriptContent` returns the right
 * string — the unit tests cover that — but that the string reached the model,
 * which is the only claim a reader of this script cares about.
 */
const modelRequests = [];

const model = createServer((req, res) => {
  modelCalls += 1;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    modelRequests.push(body);
    const asks = (prop) => body.includes(`"${prop}"`);
    let payload;
    if (asks('description') && asks('textLanguage')) payload = { description: modelDescription, textLanguage: modelTextLanguage };
    else if (asks('reply')) payload = { reply: 'Achha, samajh gaya. Aapko iske jaisa hi flow chahiye ya kuch alag?' };
    else if (asks('intent')) payload = { intent: 'requirement_sharing', quote: 'sent a screenshot', language: 'en', clientFact: null };
    else if (asks('covered')) payload = { covered: [] };
    else if (asks('concern')) payload = { kind: 'trust', concern: 'none' };
    else payload = { summary: 'A delivery app.', scopeItems: [{ title: 'Home screen', detail: 'Search and categories' }], constraints: [], openQuestions: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 40, output_tokens: 30 },
    }));
  });
});

/** How the Graph stub answers a media lookup. Swapped per section. */
let mediaMode = 'ok';
const graphSends = [];
const mediaLookups = [];

const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // The bytes.
    if (req.url.startsWith('/media-bytes/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PIXEL_PNG);
      return;
    }
    // The send.
    if (req.method === 'POST' && req.url.endsWith('/messages')) {
      graphSends.push({ url: req.url, body: parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
      return;
    }
    // Everything else on a GET is a media lookup.
    mediaLookups.push(req.url);
    if (mediaMode === 'gone') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported get request', code: 100 } }));
      return;
    }
    const url = mediaMode === 'foreign'
      ? 'https://lookaside.fbsbx.com.evil.example/steal'
      : `http://127.0.0.1:${GRAPH_PORT}/media-bytes/${randomUUID()}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url, mime_type: 'image/png', file_size: PIXEL_PNG.length }));
  });
});

await new Promise((resolve, reject) => {
  model.once('error', reject);
  model.listen(MODEL_PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

await new Promise((resolve, reject) => {
  graph.once('error', reject);
  graph.listen(GRAPH_PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));

// ── the real webhook ───────────────────────────────────────────────────────

const sign = (body) =>
  `sha256=${createHmac('sha256', target.whatsappAppSecret).update(body, 'utf8').digest('hex')}`;

function envelope(message) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_IMAGE',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: `${MARKER} sender` }, wa_id: SENDER }],
          messages: [{ from: SENDER, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
        },
      }],
    }],
  });
}

async function deliver(message) {
  const body = envelope(message);
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    body,
    cache: 'no-store',
  });
  return { status: res.status, json: parse(await res.text()) };
}

const messageBy = async (ref) =>
  one(await rest('GET', 'crm',
    `conversation_messages?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(ref)}` +
    '&select=id,seq,body,metadata,intent,media_description,media_read_at,media_read_by_agent'));

const eventsFor = async (messageId) =>
  (await rest('GET', 'core',
    `outbox_events?subject_id=eq.${messageId}&select=type&order=id`)).json ?? [];

console.log('\n\x1b[1mAgencyOS — an image is read before it is answered\x1b[0m');

let savedSettings = null;
let savedAnswers = null;

try {
  const org = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings,agent_answers_clients`));
  savedSettings = org?.settings ?? {};
  savedAnswers = org?.agent_answers_clients ?? false;
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...savedSettings, whatsapp_phone_number_id: PHONE_NUMBER_ID },
    agent_answers_clients: true,
  });

  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\nA. An image arrives with its handle and its caption');
  const REF_A = `wamid.${MARKER}.a.${randomUUID().slice(0, 8)}`;
  const sent = await deliver({
    id: REF_A, type: 'image',
    image: { id: 'MEDIA-A', mime_type: 'image/png', caption: 'isme jo home screen hai wo chahiye' },
  });
  check(sent.status === 200 && sent.json?.ingested === 1, 'the webhook ingests an image message', JSON.stringify(sent.json).slice(0, 80));

  const a = await messageBy(REF_A);
  check(Boolean(a?.id), 'the message is recorded');
  check(a?.metadata?.media_type === 'image', 'its kind is recorded', a?.metadata?.media_type);
  check(a?.metadata?.media_id === 'MEDIA-A', 'its handle is recorded — without it nothing could ever look', a?.metadata?.media_id);
  check(a?.metadata?.caption === 'isme jo home screen hai wo chahiye', 'the caption is kept — the client did type words');
  check((a?.body ?? '') === '', 'and the body is still empty: naming the envelope is not writing the letter');

  // ── B ────────────────────────────────────────────────────────────────────
  console.log('\nB. It asks to be looked at, and holds back everything that would answer it');
  const emitted = await eventsFor(a.id);
  const types = emitted.map((e) => e.type);
  check(types.includes('image.received'), 'image.received is emitted', types.join(', '));
  check(!types.includes('message.received'), 'message.received is NOT — the intent read would run on an empty body');
  check(!types.includes('reply.due'), 'reply.due is NOT — the agent would be answering a photograph it has not seen');
  check(a?.media_read_at === null, 'and nothing claims to have read it yet');

  // ── C ────────────────────────────────────────────────────────────────────
  console.log('\nC. The runner fetches it, reads it, and writes what it saw');
  const beforeLookups = mediaLookups.length;
  const readA = await tickUntilRead(a.id);
  check(Boolean(readA?.media_read_at), 'the message is marked read');
  check(mediaLookups.length > beforeLookups, 'the Graph API was asked what the handle points at', `${mediaLookups.length - beforeLookups} lookup(s)`);
  check(readA?.media_description === modelDescription, 'and the description is what the model returned', String(readA?.media_description).slice(0, 60));
  const provenance = one(await rest('GET', 'crm', `conversation_messages?id=eq.${a.id}&select=media_read_by_agent`));
  check(provenance?.media_read_by_agent === 'sales', 'attributed to the agent that read it', provenance?.media_read_by_agent);

  // ── D ────────────────────────────────────────────────────────────────────
  console.log('\nD. What the image was sent as, and what the transcript then said');
  const imageCall = modelRequests.find((r) => r.includes('"image"') && r.includes('"base64"'));
  check(Boolean(imageCall), 'the bytes went to the model as an image block, not as a URL');
  check(
    Boolean(imageCall) && imageCall.includes('"media_type":"image/png"'),
    'with the media type Meta reported',
  );
  check(
    Boolean(imageCall) && imageCall.includes('isme jo home screen hai wo chahiye'),
    'and the caption beside it, so the model reads the picture and the question together',
  );

  // ── E ────────────────────────────────────────────────────────────────────
  console.log('\nE. Everything the image held back is released, and the client is answered');
  const released = await eventsFor(a.id);
  const releasedTypes = released.map((e) => e.type);
  check(releasedTypes.includes('message.received'), 'message.received is emitted now', releasedTypes.join(', '));
  check(releasedTypes.includes('reply.due'), 'and reply.due with it');

  const sendsBefore = graphSends.length;
  await tickUntil(async () => graphSends.length > sendsBefore, 30);
  check(graphSends.length > sendsBefore, 'the provider received an answer', `${graphSends.length - sendsBefore} send(s)`);

  const labelled = one(await rest('GET', 'crm', `conversation_messages?id=eq.${a.id}&select=intent`));
  check(labelled?.intent !== null, 'and the message was labelled from the reading, not from an empty body', String(labelled?.intent));

  // The honesty rule, proved on what the model was actually handed.
  const sawTranscript = modelRequests.filter((r) => r.includes('read by the agent:'));
  check(sawTranscript.length > 0, 'the transcript the model read carries the reading, attributed', `${sawTranscript.length} call(s)`);
  check(
    sawTranscript.some((r) => r.includes('isme jo home screen hai wo chahiye')),
    'with the caption still quoted as the client\'s own words',
  );
  check(
    !sawTranscript.some((r) => r.includes(`captioned \\u201cisme jo home screen hai wo chahiye\\u201d — not transcribed`)),
    'and never both — a message cannot be read and not transcribed at once',
  );

  // ── F ────────────────────────────────────────────────────────────────────
  console.log('\nF. The two paths agree — a read image emits what a text message emits');
  const REF_T = `wamid.${MARKER}.t.${randomUUID().slice(0, 8)}`;
  await deliver({ id: REF_T, type: 'text', text: { body: 'aur ek cheez puchni thi' } });
  const t = await messageBy(REF_T);
  const textTypes = new Set((await eventsFor(t.id)).map((e) => e.type));
  const imageTypes = new Set(releasedTypes.filter((x) => x !== 'image.received'));
  check(
    [...textTypes].every((x) => imageTypes.has(x)) && [...imageTypes].every((x) => textTypes.has(x)),
    'the same set, by equivalence rather than by reading two functions',
    `text: ${[...textTypes].join(',')} | image: ${[...imageTypes].join(',')}`,
  );

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\nG. An image with no handle holds nothing back — a conversation never stops');
  const REF_G = `wamid.${MARKER}.g.${randomUUID().slice(0, 8)}`;
  await deliver({ id: REF_G, type: 'image', image: { mime_type: 'image/png' } });
  const g = await messageBy(REF_G);
  const gTypes = (await eventsFor(g.id)).map((e) => e.type);
  check(!gTypes.includes('image.received'), 'nothing is asked to look at an image nobody could fetch', gTypes.join(', '));
  check(gTypes.includes('reply.due'), 'and the client is answered immediately, as before this change');

  // ── H ────────────────────────────────────────────────────────────────────
  console.log('\nH. An image that cannot be fetched is released, unread and unpretended');
  mediaMode = 'gone';
  const REF_H = `wamid.${MARKER}.h.${randomUUID().slice(0, 8)}`;
  await deliver({ id: REF_H, type: 'image', image: { id: 'MEDIA-GONE', mime_type: 'image/png' } });
  const h = await messageBy(REF_H);
  check(!(await eventsFor(h.id)).some((e) => e.type === 'reply.due'), 'it is held while there is still a chance of reading it');
  const readH = await tickUntilRead(h.id);
  check(Boolean(readH?.media_read_at), 'it is marked read — somebody looked, and could not');
  check(readH?.media_description === null, 'with NO description: §28 says do not pretend', String(readH?.media_description));
  check(
    (await eventsFor(h.id)).some((e) => e.type === 'reply.due'),
    'and the client is answered anyway — an unreadable photo must never be the reason nobody replied',
  );
  const beforeH = modelRequests.length;
  await tickUntil(async () => modelRequests.slice(beforeH).some((r) => r.includes('not transcribed')), 30);
  check(
    modelRequests.slice(beforeH).some((r) => r.includes('not transcribed')),
    'and the transcript it is answered from says plainly that nobody read it',
  );
  mediaMode = 'ok';

  // ── I ────────────────────────────────────────────────────────────────────
  console.log('\nI. A reading is written once');
  const rewrite = await rest('PATCH', 'crm', `conversation_messages?id=eq.${a.id}`, {
    media_description: 'something else entirely',
  });
  check(rewrite.status >= 400, 'the description cannot be rewritten after the fact', `status ${rewrite.status}`);
  const still = one(await rest('GET', 'crm', `conversation_messages?id=eq.${a.id}&select=media_description`));
  check(still?.media_description === modelDescription, 'and it still says what was seen');

  // ── J ────────────────────────────────────────────────────────────────────
  console.log('\nJ. An account number in a screenshot is not written down');
  modelDescription = 'A bank transfer screen showing account 4111 1111 1111 1111 and a confirm button.';
  const REF_J = `wamid.${MARKER}.j.${randomUUID().slice(0, 8)}`;
  await deliver({ id: REF_J, type: 'image', image: { id: 'MEDIA-J', mime_type: 'image/png' } });
  const j = await messageBy(REF_J);
  const readJ = await tickUntilRead(j.id);
  check(Boolean(readJ?.media_description), 'the reading is still written — redaction never costs the description');
  check(!/4111/.test(readJ?.media_description ?? ''), 'but the account number is gone', String(readJ?.media_description).slice(0, 80));
  check((readJ?.media_description ?? '').includes('[number removed]'), 'and its absence is visible rather than silent');
  modelDescription = 'A food delivery app home screen: a search bar, four category tiles and a cart button.';

  // ── K ────────────────────────────────────────────────────────────────────
  console.log('\nK. A description queues the extraction the ingest declined');
  const extraction = (await rest('GET', 'core',
    `jobs?kind=eq.requirement.extract&dedupe_key=like.*${encodeURIComponent(a.conversation_id ?? '')}*&select=id`)).json ?? [];
  const conv = one(await rest('GET', 'crm', `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${SENDER}`)}&select=id`));
  const queued = (await rest('GET', 'core',
    `jobs?kind=eq.requirement.extract&dedupe_key=like.*${conv.id}*&select=id,dedupe_key`)).json ?? [];
  check(queued.length > 0, 'the requirement collector has work on this conversation', `${queued.length} job(s)`);
  void extraction;

  // ── L ────────────────────────────────────────────────────────────────────
  console.log('\nL. The fetch will not follow a URL to a host Meta does not serve from');
  mediaMode = 'foreign';
  const REF_L = `wamid.${MARKER}.l.${randomUUID().slice(0, 8)}`;
  await deliver({ id: REF_L, type: 'image', image: { id: 'MEDIA-L', mime_type: 'image/png' } });
  const l = await messageBy(REF_L);
  const readL = await tickUntilRead(l.id);
  check(Boolean(readL?.media_read_at), 'the message is released rather than stuck');
  check(readL?.media_description === null, 'and nothing was read from a host the token may not go to');
  mediaMode = 'ok';

  check(modelCalls > 0, 'the model was genuinely called', `${modelCalls} call(s)`);
} finally {
  if (savedSettings !== null) {
    await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
      settings: savedSettings,
      agent_answers_clients: savedAnswers,
    });
  }
  await new Promise((resolve) => model.close(resolve));
  await new Promise((resolve) => graph.close(resolve));
}

console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
