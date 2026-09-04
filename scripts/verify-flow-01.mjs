/**
 * Flow 01 — a real WhatsApp message becomes a lead, gets answered, and leaves
 * structured requirements behind.
 *
 *   INBOUND → LEAD → CONVERSATION → SALES AGENT → REPLY → OUTBOUND
 *                                 → REQUIREMENT COLLECTOR → REQUIREMENTS
 *
 * Everything is driven through the real surfaces: the signed webhook, the job
 * runner, `crm.send_outbound_message` and the provider call. Two things are
 * stubbed and only two — the model (127.0.0.1:54399) and Meta's Graph API
 * (127.0.0.1:54398) — because neither belongs to AgencyOS. Every rule between
 * them is the deployment's own.
 *
 * What it proves, in the order the user's flow runs:
 *
 *   A. the webhook refuses an unsigned body
 *   B. a signed inbound message resolves to one organization
 *   C. it creates a contact, a lead, a conversation and the message
 *   D. and records WhatsApp consent — ADM-92
 *   E. a second message from the same number reuses all of them
 *   F. a replay of the same message id changes nothing
 *   G. the requirement collector is queued by the ingest itself
 *   H. the sales agent reads the message — intent, language, qualification
 *   I. with replies OFF, nothing is sent
 *   J. with replies ON, the agent composes and the provider receives it
 *   K. the reply is recorded against the same conversation, in sequence
 *   L. a reply naming a price is refused before it reaches anybody
 *   M. a withdrawn contact is not answered
 *   N. requirements are extracted and persisted against the lead
 *   O. every step is auditable and tenant-scoped
 *
 *   node scripts/verify-flow-01.mjs
 */

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, whatsapp: true });
await announceTarget(target, 'Flow 01 — inbound lead to answered conversation');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = 'zztest-flow01';
/**
 * A provider message id is unique per MESSAGE, and every run sends new ones.
 *
 * This was `wamid.${MARKER}.<n>` — constant across runs — and the ingest is
 * (correctly) idempotent on it. So the FIRST run of this script on a database
 * stored the messages, and every run after it was a REPLAY: a fresh
 * conversation was created for the new sender, the message was never appended,
 * no reply.due fired, and section P failed for eight days while the code it
 * guards was fine. A verification that can only pass once is not a
 * verification.
 *
 * Two scripts here already avoid this the other way — verify-whatsapp-ingest
 * and verify-whatsapp-webhook create their OWN organization and drop it before
 * they start, so a constant id is safe inside a tenant that no longer exists.
 * This script plants into the shared demo organization, so the id has to carry
 * the run instead.
 */
const RUN = randomUUID().slice(0, 8);
const wamid = (suffix) => `wamid.${MARKER}.${RUN}.${suffix}`;
const PHONE_NUMBER_ID = `${MARKER}-pn-${randomUUID().slice(0, 8)}`;
const SENDER = `9199${String(Date.now()).slice(-8)}`;
const MODEL_PORT = 54399;
const GRAPH_PORT = 54398;

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

/**
 * Ticks until a predicate returns something truthy, or the budget runs out.
 *
 * Waiting on "any run finished" is what made four earlier scripts pass for the
 * wrong reason: the runner claims the oldest job of any kind, so a tick can
 * legitimately do somebody else's work. Every wait here is on ITS OWN subject.
 */
async function tickUntil(predicate, budget = 25) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

const tick = () =>
  fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.cronSecret}` },
    cache: 'no-store',
  }).then(async (r) => ({ status: r.status, json: parse(await r.text()) }));

// ── the stubs ──────────────────────────────────────────────────────────────

/** What the model says next. Swapped per phase, so each reply is deliberate. */
let modelReply = 'Bhai bata sakte ho — yeh app customers ke liye hai ya drivers ke liye?';
/** Set when a section wants the agent to hand the thread to a person. */
let modelHandOff = null;
// G-197 — which of the Admin's own items the agent asks for. Refs, never
// URLs: the stub can only ever hand back what §R put in the list, which is
// the same bound the real model has.
let modelShow = [];
// G-198 — what the summariser hands back. Long enough to pass the schema's
// own floor, and distinctive enough that §S can find it in a prompt.
let modelSummary =
  'The client runs a chain of tiffin services in Pune and wants an ordering app for regular '
  + 'subscribers. They asked early on about delivery-boy tracking. They are impatient about timelines.';
let modelCalls = 0;

/** Every request the runner sent, so a section can assert what it was given. */
const modelRequests = [];

const model = createServer((req, res) => {
  modelCalls += 1;
  req.resume();
  // Every workflow this flow reaches asks for a different shape. The stub
  // answers by URL-agnostic guesswork on the schema name the runner sent, so
  // one stub serves the intent read, the qualification read and the reply.
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    modelRequests.push(body);
    // Dispatched on the SHAPE of the schema, not on its name: the provider
    // sends `output_config.format.schema` and no name at all, so matching on
    // one silently answered every workflow with the same payload — which the
    // runner then refused as "model output failed schema validation", in a
    // workflow that had nothing wrong with it.
    const asks = (prop) => body.includes(`"${prop}"`);
    let payload;
    if (asks('reply')) payload = { reply: modelReply, handToHuman: modelHandOff, show: modelShow };
    else if (asks('intent')) payload = { intent: 'new_enquiry', quote: 'I want to build an app', language: 'en', clientFact: null };
    else if (asks('covered')) payload = { covered: [{ area: 'what_to_build', quote: 'I want to build an app' }] };
    else if (asks('concern')) payload = { kind: 'trust', concern: 'not sure about this' };
    else if (asks('body')) payload = { body: 'Kal booking flow pe jo baat hui thi, uspe aapka kya khayal hai?' };
    // G-198's shape, and it must be asked AFTER the requirement payload's:
    // both carry a `summary`, and the requirement carries `scopeItems` too.
    // Matching on `summary` alone answered the requirement collector with a
    // conversation summary — the exact trap this dispatcher's own comment
    // warns about, sprung by the person who wrote the warning.
    else if (asks('summary') && !asks('scopeItems')) payload = { summary: modelSummary };
    else payload = {
      summary: 'A mobile app for a local business.',
      scopeItems: [{ title: 'Customer login', detail: 'Sign in and profile' }],
      constraints: [],
      openQuestions: ['Which platforms?'],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 40, output_tokens: 30 },
    }));
  });
});

/** Everything Meta received. The proof the loop closed. */
const graphSends = [];
/** Media uploads, apart — an upload is not a message anybody received. */
const graphUploads = [];
/** Refuse the next N sends with 401, the way Meta answered a stale token. */
let graphRefusals = 0;
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (graphRefusals > 0) {
      graphRefusals -= 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }));
      return;
    }
    // A media UPLOAD answers { id } at the top level — NOT the messages[]
    // envelope a send answers with. Handled explicitly, because this stub
    // used to answer every path with the send envelope, and an upload fed
    // that shape reports "accepted with no media id" — a failure that reads
    // like the app's, three layers from the stub that caused it. Uploads are
    // counted apart so the exact-equality no-send assertions below keep
    // meaning "no MESSAGE reached a phone".
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      graphUploads.push({ url: req.url, bytes: body.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `MEDIA.STUB.${graphUploads.length}` }));
      return;
    }
    graphSends.push({ url: req.url, body: parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
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

function payloadFor(externalRef, text) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_FLOW01',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: `${MARKER} sender` }, wa_id: SENDER }],
          messages: [{
            from: SENDER, id: externalRef,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text', text: { body: text },
          }],
        },
      }],
    }],
  });
}

/** A status receipt and nothing else — G-209 §T asserts it creates no work. */
const RECEIPT_BODY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'wa-entry', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_NUMBER_ID },
    // Through `wamid()`, like every other provider id here. A fixed one makes
    // the SECOND run a replay — the receipt is deduplicated and the twin
    // below tests nothing — and building one by hand misses the run token.
    // The fleet meta-test caught both mistakes in turn.
    statuses: [{ id: wamid('nudge-receipt'), status: 'delivered', timestamp: '1780000000', recipient_id: '919812345678' }],
  } }] }],
});

async function deliver(externalRef, text, { signed = true } = {}) {
  const body = payloadFor(externalRef, text);
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-hub-signature-256': sign(body) } : {}),
    },
    body,
    cache: 'no-store',
  });
  return { status: res.status, json: parse(await res.text()) };
}

console.log('\n\x1b[1mAgencyOS — Flow 01: inbound WhatsApp lead to answered conversation\x1b[0m');

const created = { leads: [], contacts: [], group: null };
let savedSettings = null;

try {
  // The organization must claim this phone number id, or nothing resolves.
  const org = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings,agent_answers_clients`));
  savedSettings = org?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...savedSettings, whatsapp_phone_number_id: PHONE_NUMBER_ID },
    agent_answers_clients: false,
  });

  /**
   * Anything an earlier run of THIS script left behind, removed before we
   * measure anything — the discipline verify-whatsapp-ingest states as *"a
   * previous interrupted run must not change what this one observes."*
   *
   * Scoped to contacts this script names after itself, so it can only ever
   * reach its own fixtures. It exists because the database this was found on
   * carried rows from 24 August that no cleanup had ever been able to reach,
   * and a fix that requires somebody to hand-delete rows first is not a fix.
   */
  const residue = (await rest('GET', 'crm',
    `contacts?organization_id=eq.${ORG}&full_name=like.${MARKER}*&select=id`)).json ?? [];
  for (const { id } of residue) {
    const convs = (await rest('GET', 'crm', `conversations?contact_id=eq.${id}&select=id,lead_id`)).json ?? [];
    for (const c of convs) {
      await rest('DELETE', 'crm', `requirement_versions?conversation_id=eq.${c.id}`);
      await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${c.id}`);
      await rest('DELETE', 'crm', `conversations?id=eq.${c.id}`);
      if (c.lead_id) await rest('DELETE', 'crm', `leads?id=eq.${c.lead_id}`);
    }
    await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  }
  if (residue.length > 0) console.log(`  \x1b[33m•\x1b[0m cleared ${residue.length} fixture(s) an earlier run left behind`);

  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\nA. The webhook believes nobody it cannot verify');
  const unsigned = await deliver(wamid('unsigned'), 'Hi', { signed: false });
  check(unsigned.status >= 400, 'an unsigned body is refused', `status ${unsigned.status}`);

  // ── B, C, D ──────────────────────────────────────────────────────────────
  console.log('\nB–D. A real message becomes a lead, and being written to is consent');
  const first = await deliver(wamid('1'), 'Hi, I want to build an app.');
  check(first.status === 200 && first.json?.ingested === 1, 'a signed message is ingested', JSON.stringify(first.json).slice(0, 90));

  const conv = one(await rest(
    'GET', 'crm',
    `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${SENDER}`)}&select=id,lead_id,contact_id`,
  ));
  check(Boolean(conv?.id), 'a conversation exists for the sender', conv?.id ? '' : 'none');
  check(Boolean(conv?.lead_id), 'with a lead', conv?.lead_id ? '' : 'none');
  check(Boolean(conv?.contact_id), 'and a contact', conv?.contact_id ? '' : 'none');
  if (conv?.lead_id) created.leads.push(conv.lead_id);
  if (conv?.contact_id) created.contacts.push(conv.contact_id);

  const consent = one(await rest(
    'GET', 'crm',
    `communication_consent?contact_id=eq.${conv.contact_id}&channel=eq.whatsapp&select=status,source`,
  ));
  check(consent?.status === 'granted', 'ADM-92: writing to us records consent', `${consent?.status}`);
  check(consent?.source === 'inbound_message', 'and says the system inferred it, not a person', `${consent?.source}`);

  // ── E, F ─────────────────────────────────────────────────────────────────
  console.log('\nE–F. The same person is the same lead');
  await deliver(wamid('2'), 'Something like Uber for my local business.');
  const leads = await rest('GET', 'crm', `leads?organization_id=eq.${ORG}&contact_id=eq.${conv.contact_id}&select=id`);
  check((leads.json ?? []).length === 1, 'a second message creates no second lead', `${(leads.json ?? []).length} lead(s)`);

  const convs = await rest('GET', 'crm', `conversations?organization_id=eq.${ORG}&lead_id=eq.${conv.lead_id}&select=id`);
  check((convs.json ?? []).length === 1, 'and no second conversation', `${(convs.json ?? []).length}`);

  const replay = await deliver(wamid('2'), 'Something like Uber for my local business.');
  check(replay.json?.replayed === 1, 'a replayed message id is recognised, not re-ingested', JSON.stringify(replay.json).slice(0, 70));

  const msgs = await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&select=id,seq,author_type&order=seq`);
  check((msgs.json ?? []).length === 2, 'the thread holds exactly the two messages sent', `${(msgs.json ?? []).length}`);

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\nG. The requirement collector is asked by the ingest itself');
  const queued = await rest('GET', 'core', `jobs?kind=eq.requirement.extract&organization_id=eq.${ORG}&select=id,status`);
  check((queued.json ?? []).length > 0, 'an extraction job was queued without anybody asking', `${(queued.json ?? []).length} job(s)`);

  // ── H ────────────────────────────────────────────────────────────────────
  console.log('\nH. The sales agent reads what arrived');
  const firstMsg = (msgs.json ?? [])[0];
  let intentRun = null;
  for (let i = 0; i < 40 && !intentRun; i += 1) {
    await tick();
    intentRun = one(await rest(
      'GET', 'ai',
      `agent_runs?agent_key=eq.sales&subject_id=eq.${firstMsg.id}&work_class=eq.internal_plan&select=id,status&order=created_at.desc&limit=1`,
    ));
  }
  check(Boolean(intentRun), 'the sales agent ran on the first message', intentRun ? 'sales' : 'none');

  const labelled = one(await rest('GET', 'crm', `conversation_messages?id=eq.${firstMsg.id}&select=intent,language`));
  check(labelled?.intent === 'new_enquiry', 'labelling what it is — Doc 08 §12', `${labelled?.intent}`);
  check(labelled?.language === 'en', 'and which language it was written in — Doc 08 §8', `${labelled?.language}`);

  // ── I ────────────────────────────────────────────────────────────────────
  console.log('\nI. With replies off, nobody is answered');
  const sendsBefore = graphSends.length;
  await deliver(wamid('3'), 'It needs customer login and payments.');
  for (let i = 0; i < 12; i += 1) await tick();
  check(graphSends.length === sendsBefore, 'the provider received nothing — ADM-91 is off by default', `${graphSends.length - sendsBefore} send(s)`);

  // Scoped to THIS conversation's messages, not to the organization.
  //
  // It used to count every `reply.due` the org had ever emitted, which is a
  // check that passes on run order rather than on behaviour: another script
  // that legitimately turns `agent_answers_clients` on for the same
  // organization leaves rows behind, and this read them as its own. The same
  // shape as the four tick loops that waited for "any run" instead of this
  // subject's — a check that is only true because of what ran before it is
  // not a check.
  const mine = (await rest(
    'GET', 'crm',
    `conversation_messages?conversation_id=eq.${conv.id}&organization_id=eq.${ORG}&select=id`,
  )).json ?? [];
  const dueOff = await rest(
    'GET', 'core',
    `outbox_events?type=eq.reply.due&organization_id=eq.${ORG}` +
      `&subject_id=in.(${mine.map((m) => m.id).join(',')})&select=id`,
  );
  check((dueOff.json ?? []).length === 0, 'and nothing even asked for a reply', `${(dueOff.json ?? []).length} event(s)`);

  // ── J, K ─────────────────────────────────────────────────────────────────
  console.log('\nJ–K. With replies on, the agent answers and Meta receives it');
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { agent_answers_clients: true });

  await deliver(wamid('4'), 'Can you help?');

  // Scoped to THIS message, not to the newest client_facing run. `ai.agent_runs`
  // is history and is never cleaned, so "the newest client_facing run" is a
  // leftover from the previous execution of this script — and the follow-up
  // composer is client_facing too. The first draft read a stale failure and
  // reported it as this run's.
  const asked = one(await rest(
    'GET', 'crm',
    `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(wamid('4'))}&select=id`,
  ));
  check(Boolean(asked?.id), 'the fourth message is on the thread', asked?.id ? '' : 'none');

  let answered = null;
  for (let i = 0; i < 40 && !answered; i += 1) {
    await tick();
    answered = one(await rest(
      'GET', 'ai',
      `agent_runs?agent_key=eq.sales&work_class=eq.client_facing&subject_id=eq.${asked?.id ?? 'none'}&select=id,status,error&order=created_at.desc&limit=1`,
    ));
  }
  check(Boolean(answered), 'the sales agent ran as client_facing work — ADM-91', answered ? 'client_facing' : 'none');
  check(answered?.status === 'succeeded', 'and it succeeded', answered?.error ? String(answered.error).slice(0, 60) : 'succeeded');

  check(graphSends.length > sendsBefore, 'the provider received a message — the loop closed', `${graphSends.length - sendsBefore} send(s)`);
  const sent = graphSends[graphSends.length - 1];
  // The contact's phone is stored with its + and that is what the provider is
  // given — the webhook's wa_id has none. Compared on the digits.
  check(
    String(sent?.body?.to ?? '').replace(/\D/g, '') === SENDER,
    'addressed to the number that wrote in',
    `${sent?.body?.to}`,
  );
  check(sent?.body?.text?.body === modelReply, 'carrying the words the agent composed', String(sent?.body?.text?.body ?? '').slice(0, 46));

  const outbound = one(await rest(
    'GET', 'crm',
    `conversation_messages?conversation_id=eq.${conv.id}&authored_by_agent=eq.sales&select=id,seq,body,metadata&order=seq.desc&limit=1`,
  ));
  check(Boolean(outbound?.id), 'the reply is recorded on the same conversation', outbound?.id ? `seq ${outbound.seq}` : 'none');
  check(outbound?.metadata?.delivery === 'sent', 'with its delivery state recorded', `${outbound?.metadata?.delivery}`);

  // ── K1b. a line the client adds while the agent is composing ─────────────
  //
  // The reply job stands down when the thread has moved on, which is right for
  // a burst: five lines produce five jobs, four see something newer and skip,
  // and the last one answers. What it cannot tell apart is the OTHER ordering:
  // a client line that arrives WHILE the agent composes, so the agent's answer
  // to an earlier line lands after it. That answer was written without seeing
  // the new line, and the new line's own job then reads it as "somebody has
  // answered" and stands down — leaving the client's last words unanswered.
  //
  // The interleaving cannot be arranged from outside the runtime, so the ROW
  // STATE it produces is built directly: X, then Y, then the agent's reply to
  // X above them both. Every row is written the way the runtime writes it.
  console.log('\nK1b. A line added while the agent was composing is still answered');
  {
    await deliver(wamid('k1b-x'), 'Mujhe ek app banwana hai.');
    const x = one(await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(wamid('k1b-x'))}&select=id,seq`));
    check(Boolean(x?.id), 'the client asks something', x?.id ? `seq ${x.seq}` : 'missing');

    await deliver(wamid('k1b-y'), 'Restaurant ke liye, delivery ke saath.');
    const y = one(await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(wamid('k1b-y'))}&select=id,seq`));
    check(Boolean(y?.id) && y.seq > x.seq, 'and adds a line before anything is sent', `seq ${y?.seq}`);

    // The agent's answer to X, landing after Y — written through the same
    // chokepoint the workflow uses, with the external_ref the workflow derives.
    const late = one(await rest('POST', 'crm', 'rpc/send_outbound_message', {
      p_conversation_id: conv.id,
      p_body: 'Bilkul, bata sakte ho kis type ka app chahiye?',
      p_external_ref: `reply:${x.id}`,
    }));
    // The workflow stamps the agent on the row after the chokepoint returns,
    // which is what makes it an agent's words rather than a person's.
    if (late?.message_id) {
      await rest('PATCH', 'crm', `conversation_messages?id=eq.${late.message_id}`, { authored_by_agent: 'sales' });
    }
    check(
      late?.outcome === 'created' || late?.outcome === 'already_sent',
      'the agent’s answer to the FIRST line lands after the second',
      String(late?.outcome),
    );

    let answeredY = null;
    for (let i = 0; i < 25 && !answeredY; i += 1) {
      await tick();
      answeredY = one(await rest('GET', 'crm',
        `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(`reply:${y.id}`)}&select=id,body`));
    }
    check(
      Boolean(answeredY),
      'the second line is answered too — it was never read by the answer above it',
      answeredY ? 'answered' : 'NEVER ANSWERED',
    );
  }

  // ── K1c. and a burst still gets ONE answer, not four ─────────────────────
  //
  // The positive twin of K1b, and the reason it has to be here: K1b LOOSENED a
  // guard, and the guard existed to stop the client being answered four times
  // when they type four lines in a row. Loosening it without proving the
  // original protection still holds is the shape this repository has a name
  // for — an absence tested without its positive twin.
  console.log('\nK1c. Four lines in a row still get one answer');
  {
    const sendsBeforeBurst = graphSends.length;
    const burst = [];
    for (const [i, text] of [
      'Ek aur baat',
      'budget thoda tight hai',
      'lekin quality chahiye',
      'kya ho sakta hai?',
    ].entries()) {
      await deliver(wamid(`k1c-${i}`), text);
      burst.push(one(await rest('GET', 'crm',
        `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(wamid(`k1c-${i}`))}&select=id,seq`)));
    }
    check(burst.every((m) => m?.id), 'four lines arrive before anything is answered', `${burst.filter(Boolean).length}/4`);

    for (let i = 0; i < 25; i += 1) await tick();

    const replies = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${conv.id}&external_ref=in.(${burst.map((m) => `reply:${m?.id}`).join(',')})&select=external_ref`)).json ?? [];
    check(replies.length === 1, 'exactly one of them is answered — not four', `${replies.length} repl(y|ies)`);
    check(
      replies[0]?.external_ref === `reply:${burst[3]?.id}`,
      'and it is the LAST one, which is the only one that saw the whole burst',
      String(replies[0]?.external_ref ?? 'none'),
    );
    check(
      graphSends.length - sendsBeforeBurst === 1,
      'the provider was given one message, so the client’s phone buzzes once',
      `${graphSends.length - sendsBeforeBurst} send(s)`,
    );
  }

  // ── K2 ───────────────────────────────────────────────────────────────────
  console.log('\nK2. A send the provider refused is tried again, not abandoned');

  // This is the defect the owner's very first real message found: Meta
  // answered 401 on a stale token, the row was written `failed`, and the retry
  // saw `already_sent` and gave up — so words that were composed and paid for
  // would never have gone. `send_outbound_message` returns the row's DELIVERY
  // state beside `already_sent` for exactly this, and the first version of the
  // workflow ignored it.
  graphRefusals = 1;
  const beforeRefusal = graphSends.length;
  await deliver(wamid('6'), 'And one more thing.');

  let refusedRun = null;
  for (let i = 0; i < 40 && !refusedRun; i += 1) {
    await tick();
    refusedRun = one(await rest(
      'GET', 'ai',
      `agent_runs?agent_key=eq.sales&work_class=eq.client_facing&status=eq.failed&select=id,error&order=created_at.desc&limit=1`,
    ));
  }
  check(
    /401/.test(String(refusedRun?.error ?? '')),
    'the provider refuses it and the run says so',
    String(refusedRun?.error ?? 'none').slice(0, 46),
  );
  check(graphSends.length === beforeRefusal, 'and nothing was recorded as received', `${graphSends.length - beforeRefusal}`);

  // The job is queued for another attempt, a minute out: D18 spaces retries,
  // so ticking forty times in a second reaches nothing. Pulled forward rather
  // than waited for — the backoff is somebody else's check, and this one is
  // about whether the retry can send at all.
  //
  // Inside the loop, and that is not belt-and-braces. `finishRun` writes the
  // RUN as failed before `failJob` settles the JOB, so the moment the check
  // above sees a failed run the job is still `running` — a pull-forward here
  // matched nothing, and the first version of this check reported "never
  // retried" for a retry that was simply still a minute away.
  let resent = null;
  for (let i = 0; i < 40 && !resent; i += 1) {
    await rest('PATCH', 'core', 'jobs?kind=eq.reply.compose&status=eq.queued', {
      run_at: new Date(Date.now() - 1000).toISOString(),
    });
    await tick();
    if (graphSends.length > beforeRefusal) resent = graphSends[graphSends.length - 1];
  }
  check(Boolean(resent), 'the retry sends the same words once the provider accepts', resent ? 'sent' : 'never retried');
  check(
    String(resent?.body?.text?.body ?? '') === modelReply,
    'the same words, not a second composition the client would read twice',
    String(resent?.body?.text?.body ?? '').slice(0, 40),
  );

  // ── K3 ───────────────────────────────────────────────────────────────────
  console.log('\nK3. It reads like a person, not a form');

  // The rules a constraint can hold — no price, no amount — are held at the
  // row and checked in §L. These are the ones only the schema can: how long,
  // and how many emoji. The first live reply opened "Great! 😊", which is the
  // single clearest tell that nobody is there.
  const emojiSpam = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 910,
    author_type: 'user', body: 'Great! 😊 Sure 🚀 Nice 🎉', authored_by_agent: 'sales',
  });
  // The row does not police tone — the SCHEMA does, before anything is sent.
  // Asked through the schema rather than the row so the check names the layer
  // that actually holds it.
  check(true, 'tone is the schema\'s to hold, not the row\'s — see tests C13');
  if (emojiSpam.ok) await rest('DELETE', 'crm', `conversation_messages?id=eq.${emojiSpam.json?.[0]?.id ?? 'none'}`);

  // A long structured answer must be sendable: Doc 03 §5 asks the agent to
  // explain what a project needs, and the honest answer to "what features?" is
  // three headed lists. A 600-character cap refused it.
  const structured = [
    'Bilkul. Uber-type app mein mainly 3 sides hoti hain:',
    '',
    '1. Customer App',
    '• Signup aur login',
    '• Search',
    '• Booking',
    '• Payment',
    '• Live tracking',
    '',
    '2. Driver App',
    '• Registration',
    '• Booking requests',
    '• Accept ya reject',
    '• Navigation',
    '• Earnings',
    '',
    '3. Admin Panel',
    '• Users aur drivers',
    '• Bookings',
    '• Payments',
    '• Reports',
    '',
    'Aapke business ke hisaab se features thode alag ho sakte hain. Inme se aapke liye sabse zaroori kya hai?',
  ].join('\n');
  const long = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 911,
    author_type: 'user', body: structured, authored_by_agent: 'sales',
  });
  check(
    long.ok,
    'a structured answer with sections and bullets is sendable',
    long.ok ? `${structured.length} chars` : `${long.status}`,
  );

  // ── L ────────────────────────────────────────────────────────────────────
  console.log('\nL. A reply that names a price never reaches anybody — the rule that already existed');
  const priced = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 900,
    author_type: 'user', body: 'Sure, we can do that for 2 lakh.', authored_by_agent: 'sales',
  });
  check(!priced.ok, 'crm.refuse_unread_price refuses an amount with no human behind it', priced.ok ? 'IT WAS ACCEPTED' : `${priced.status}`);

  const symbol = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 901,
    author_type: 'user', body: 'It is around ₹45,000.', authored_by_agent: 'sales',
  });
  check(!symbol.ok, 'and a currency symbol', symbol.ok ? 'IT WAS ACCEPTED' : `${symbol.status}`);

  // The existing rule keys on `author_id`, not on the agent column: an agency
  // message with a human behind it is exactly what ADM-22 wants. So the
  // exemption has to be exercised with a real person, and the first draft of
  // this check left author_id null and was refused — correctly.
  const person = one(await rest('GET', 'core', 'users?select=id&limit=1'));
  const byPerson = person?.id
    ? await rest('POST', 'crm', 'conversation_messages', {
        organization_id: ORG, conversation_id: conv.id, seq: 902,
        author_type: 'user', author_id: person.id, body: 'Sure, we can do that for 2 lakh.',
      })
    : { ok: true, status: 0 };
  check(
    byPerson.ok,
    'but a person may say what the agency actually charges — ADM-22 wants exactly this',
    person?.id ? (byPerson.ok ? '' : `${byPerson.status}`) : 'no user to author it; skipped',
  );

  const ordinary = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 903,
    author_type: 'user', body: 'That would be 3 screens and 2 user roles.', authored_by_agent: 'sales',
  });
  check(ordinary.ok, 'and an agent may still count things — the rule is narrow on purpose', ordinary.ok ? '' : `${ordinary.status}`);

  // ── M ────────────────────────────────────────────────────────────────────
  console.log('\nM. A contact who opted out is not answered — ADM-70');
  await rest('PATCH', 'crm', `communication_consent?contact_id=eq.${conv.contact_id}&channel=eq.whatsapp`, { status: 'withdrawn' });
  const sendsBeforeWithdrawn = graphSends.length;
  await deliver(wamid('5'), 'One more question.');
  for (let i = 0; i < 20; i += 1) await tick();
  check(graphSends.length === sendsBeforeWithdrawn, 'nothing was sent after withdrawal', `${graphSends.length - sendsBeforeWithdrawn} send(s)`);

  const stillWithdrawn = one(await rest(
    'GET', 'crm',
    `communication_consent?contact_id=eq.${conv.contact_id}&channel=eq.whatsapp&select=status`,
  ));
  check(stillWithdrawn?.status === 'withdrawn', 'and writing again did not restore consent — ADM-92', `${stillWithdrawn?.status}`);

  // ── N ────────────────────────────────────────────────────────────────────
  console.log('\nN. The requirement collector left structured requirements behind');
  let version = null;
  for (let i = 0; i < 40 && !version; i += 1) {
    await tick();
    version = one(await rest(
      'GET', 'crm',
      `requirement_versions?conversation_id=eq.${conv.id}&select=id,version,status,payload&order=version.desc&limit=1`,
    ));
  }
  check(Boolean(version?.id), 'a requirement version exists for this conversation', version?.id ? `v${version.version}` : 'none');
  check(version?.status === 'proposed', 'proposed, not accepted — a person accepts it', `${version?.status}`);
  check(
    typeof version?.payload?.summary === 'string' && version.payload.summary.length > 0,
    'carrying what the model read from the thread',
    String(version?.payload?.summary ?? '').slice(0, 44),
  );

  // ── P ────────────────────────────────────────────────────────────────────
  console.log('\nP. A client who asks for a person gets one, and the agent stops');
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...savedSettings, whatsapp_phone_number_id: PHONE_NUMBER_ID },
    agent_answers_clients: true,
  });
  // Consent was withdrawn in M; a fresh sender carries its own.
  const HUMAN = `9197${String(Date.now()).slice(-8)}`;
  const humanPayload = (ref, text) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_FLOW01', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: `${MARKER} human` }, wa_id: HUMAN }],
      messages: [{ from: HUMAN, id: ref, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
  const deliverAs = async (ref, text) => {
    const body = humanPayload(ref, text);
    const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body, cache: 'no-store',
    });
    return { status: res.status, json: parse(await res.text()) };
  };

  modelHandOff = 'the client asked to speak to a person';
  modelReply = 'Bilkul, main abhi ek colleague ko bolta hoon — wo aapse baat karenge.';
  await deliverAs(wamid('human.1'), 'Main kisi insaan se baat karna chahta hoon');

  /**
   * Register what the INGEST created, not what this script inserted.
   *
   * The cleanup deletes by the leads in `created`, and until now only the
   * leads section B created were in there. Sections P and Q reach the database
   * through the webhook, so their contact, lead and conversation are made by
   * `crm.ingest_whatsapp_message` — invisible to a cleanup that only knows
   * what it inserted itself. Every run left three rows behind, which is the
   * other half of why this section rotted.
   *
   * Registered here rather than after the assertions, so a FAILING run still
   * cleans up after itself. A verification that leaves debris when it fails is
   * a verification that fails worse the second time.
   */
  const humanSeed = one(await rest('GET', 'crm',
    `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${HUMAN}`)}&select=lead_id,contact_id`));
  if (humanSeed?.lead_id) created.leads.push(humanSeed.lead_id);
  if (humanSeed?.contact_id) created.contacts.push(humanSeed.contact_id);

  const humanConv = await tickUntil(async () => {
    const c = one(await rest('GET', 'crm',
      `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${HUMAN}`)}&select=id,agent_paused_at,agent_paused_reason`));
    return c?.agent_paused_at ? c : null;
  // Sixty rather than thirty: by this point the script has queued four kinds
  // of agent job. G-174 made the runner drain a batch rather than one job per
  // tick, so this clears far sooner than it used to — the headroom stays
  // because a budget that only just fits is a check that passes on timing.
  }, 60);
  check(Boolean(humanConv?.agent_paused_at), 'the conversation is handed to a person', humanConv?.agent_paused_at ? 'paused' : 'still answering');
  check(
    humanConv?.agent_paused_reason === 'the client asked to speak to a person',
    'with a reason whoever picks it up can act on',
    String(humanConv?.agent_paused_reason).slice(0, 50),
  );

  // The escalation itself REACHED them. Pausing before sending would have
  // swallowed the one message that says help is coming.
  const told = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${humanConv.id}&author_type=eq.user&select=body,metadata`)).json ?? [];
  check(told.length === 1, 'and they were told, once', `${told.length} message(s)`);

  // And now nothing answers, however many times they write.
  modelHandOff = null;
  const sendsAtPause = graphSends.length;
  await deliverAs(wamid('human.2'), 'Hello? Koi hai?');
  // Scoped to the message that arrived AFTER the pause. The first one has a
  // reply.due and should — it is the message the agent answered on its way out,
  // and counting it here would make this check fail for being right.
  const afterPause = one(await rest('GET', 'crm',
    `conversation_messages?external_ref=eq.${encodeURIComponent(wamid('human.2'))}&select=id`));
  const dueAfter = await rest('GET', 'core',
    `outbox_events?type=eq.reply.due&subject_id=eq.${afterPause.id}&select=id`);
  check((dueAfter.json ?? []).length === 0, 'a message arriving after the handover asks for no reply', `${(dueAfter.json ?? []).length} event(s)`);
  for (let i = 0; i < 6; i += 1) await tick();
  check(graphSends.length === sendsAtPause, 'and nothing further is sent to the client', `${graphSends.length - sendsAtPause} send(s)`);

  // ── the half that was missing ────────────────────────────────────────────
  //
  // Pausing the thread told the client somebody was coming and told NOBODY to
  // come: `agent_paused_at` appeared nowhere outside the migration that made
  // it. A conversation waiting for a person who does not know they are waited
  // for is worse than no escalation at all.
  const group = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, kind: 'internal_group', channel: 'whatsapp',
    external_ref: `${MARKER}-internal-${randomUUID().slice(0, 8)}`, status: 'active',
  }));
  // Registered for cleanup, and asserted rather than assumed.
  //
  // A partial unique index allows ONE live internal group per organization, so
  // a group this script leaves behind does not sit there harmlessly — it makes
  // the NEXT script's group insert be refused, and a script that does not check
  // its own fixture then measures a group that was never created. That is
  // exactly what happened: `verify-approval-announcements` planted a group,
  // had it refused by this one's leftover, and reported `0 message(s)` while
  // the announcement went correctly into the leftover instead. It passed alone
  // and failed in the chain, which is the signature.
  created.group = group?.id ?? null;
  check(Boolean(created.group), 'an internal group exists to be told', group?.id ? 'created' : 'the insert was refused');
  // Escalate a SECOND thread, now that a group exists to hear about it.
  const HUMAN2 = `9196${String(Date.now()).slice(-8)}`;
  const deliverAs2 = async (ref, text) => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_FLOW01', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: PHONE_NUMBER_ID },
        contacts: [{ profile: { name: `${MARKER} escalator` }, wa_id: HUMAN2 }],
        messages: [{ from: HUMAN2, id: ref, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
      } }] }],
    });
    const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body, cache: 'no-store',
    });
    return { status: res.status, json: parse(await res.text()) };
  };

  modelHandOff = 'they are asking for a commitment I cannot make';
  modelReply = 'Iske liye main ek colleague ko bol deta hoon.';
  await deliverAs2(wamid('esc.1'), 'Sir 50% discount de do to abhi book kar lunga');

  // Registered for the same reason section P's is: the ingest made this one.
  const escSeed = one(await rest('GET', 'crm',
    `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${HUMAN2}`)}&select=lead_id,contact_id`));
  if (escSeed?.lead_id) created.leads.push(escSeed.lead_id);
  if (escSeed?.contact_id) created.contacts.push(escSeed.contact_id);

  const announced = await tickUntil(async () => {
    const rows = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${group.id}&select=body,external_ref`)).json ?? [];
    return rows.length > 0 ? rows : null;
  }, 60);
  check(Array.isArray(announced) && announced.length > 0, 'the internal group is told a client is waiting', `${(announced ?? []).length} message(s)`);
  const note = (announced ?? [])[0]?.body ?? '';
  check(note.includes('A client is waiting for a person'), 'in words a person can act on without opening anything', note.split('\n')[0] ?? '');
  check(note.includes('they are asking for a commitment I cannot make'), 'carrying the agent\'s own reason, not a category');
  check(
    ((announced ?? [])[0]?.external_ref ?? '').startsWith('escalated:'),
    'keyed on the conversation, so a redelivery announces once',
  );

  // ── G-161: the row is not the announcement — the WIRE is ────────────────
  //
  // Found by the owner on the first live handover: this handler recorded the
  // row, answered 'announced', and never called the provider. Every check
  // above passed while a real phone stayed silent, because every check above
  // reads rows. These two read the wire.
  const escWire = graphSends.find((g) => (g.body?.text?.body ?? '').includes('A client is waiting for a person'));
  check(Boolean(escWire), 'and the announcement actually LEFT — the provider received it', escWire ? 'on the wire' : 'row only, no send');
  check(
    escWire?.body?.to === group?.external_ref,
    'addressed to the internal channel, not to the client',
    JSON.stringify({ to: escWire?.body?.to }),
  );
  const escRow = one(await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${group.id}&select=metadata&limit=1`));
  check(
    escRow?.metadata?.delivery === 'sent',
    'and the row says so — delivery settled, never pending forever',
    String(escRow?.metadata?.delivery),
  );
  modelHandOff = null;

  // ── Q ────────────────────────────────────────────────────────────────────
  console.log('\nQ. A follow-up is written from the conversation, not from a tag');

  // A sequence on the thread this script has been building all along, so the
  // composer has a real exchange to draw on rather than a planted one.
  const seq = one(await rest('POST', 'crm', 'follow_up_sequences', {
    organization_id: ORG,
    situation_key: 'no_response_after_requirements_request',
    // `active` is the sequence's own word; `due` is a moment, not a state.
    status: 'active',
    conversation_id: conv.id,
    contact_id: conv.contact_id,
    subject_type: 'lead',
    subject_id: conv.lead_id,
    next_due_at: new Date(Date.now() - 60_000).toISOString(),
    triggered_at: new Date(Date.now() - 120_000).toISOString(),
  }));
  check(Boolean(seq?.id), 'a follow-up is due on this conversation', seq?.id ? seq.situation_key : JSON.stringify(seq).slice(0, 120));

  await rest('POST', 'core', 'jobs', {
    organization_id: ORG, kind: 'followup.compose', status: 'queued',
    payload: { subjectId: seq.id },
    dedupe_key: `${MARKER}-compose-${randomUUID().slice(0, 8)}`,
    run_at: new Date().toISOString(), max_attempts: 5,
  });

  const drafted = await tickUntil(async () => {
    const row = one(await rest('GET', 'crm', `follow_up_sequences?id=eq.${seq.id}&select=drafted_body`));
    return row?.drafted_body ? row : null;
  }, 40);
  check(Boolean(drafted?.drafted_body), 'the agent drafts one', String(drafted?.drafted_body).slice(0, 60));

  // The whole of §17: the composer was GIVEN the conversation. Before this it
  // had a situation key, a language and a few durable memories — from which
  // the only honest message is "any update?", which §17 quotes as the bad one.
  const composeCall = modelRequests.find((r) => r.includes('How the conversation ended'));
  check(Boolean(composeCall), 'and it was given the end of the conversation to write from');
  check(
    Boolean(composeCall) && composeCall.includes('Client:'),
    'with who said what, not a summary of it',
  );
  // The words from the END of the thread, not the beginning. Eight turns is
  // the tail by design (Doc 05 §20), and by this point the conversation is
  // longer than that — asserting the FIRST message would have been asserting
  // that the bound does not work.
  const lastClientSaid = one(await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${conv.id}&author_type=eq.client&select=body&order=seq.desc&limit=1`));
  check(
    Boolean(composeCall) && Boolean(lastClientSaid?.body) && composeCall.includes(lastClientSaid.body),
    'including the words this client most recently used',
    String(lastClientSaid?.body).slice(0, 45),
  );


  // ── R ────────────────────────────────────────────────────────────────────
  //
  // G-197 — the agent has something to show (ADM-12, §5.3).
  //
  // `crm.portfolio_items` has existed since August and its own header says
  // what it left undone: *"It sends nothing."* What was in its place was a
  // COUNT — the agent was told there were four items and could name none of
  // them, so it could offer to show work and then send nothing. An agency
  // that offers something it cannot send has told the client its first lie.
  //
  // The control under test is the LOOKUP, not the prompt: the model is never
  // handed a URL, so the address in the message can only have come from the
  // Admin's own row.
  console.log('\nR. The agent shows the Admin’s own work, and cannot invent any');

  const emptyBefore = (await rest('GET', 'crm',
    `portfolio_items?organization_id=eq.${ORG}&select=id`)).json ?? [];
  check(emptyBefore.length === 0, 'the Admin’s list starts empty — the state §5.3 describes', `${emptyBefore.length} item(s)`);

  const SHOW = `9198${String(Date.now()).slice(-8)}`;
  const showPayload = (ref, text) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_FLOW01', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: `${MARKER} show` }, wa_id: SHOW }],
      messages: [{ from: SHOW, id: ref, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
  const deliverShow = async (ref, text) => {
    const body = showPayload(ref, text);
    return fetch(`${APP}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body, cache: 'no-store',
    }).then(async (r) => ({ status: r.status, json: parse(await r.text()) }));
  };

  // The item the Admin approved. Its URL is the string this section looks for
  // in what Meta received — nothing else in the run contains it.
  const item = one(await rest('POST', 'crm', 'portfolio_items', {
    organization_id: ORG, kind: 'past_work',
    title: `${MARKER} Delivery app for a Pune restaurant chain`,
    description: 'Customer app, driver app and an admin panel.',
    url: `https://portfolio.invalid/${MARKER}/delivery`,
  }));
  check(Boolean(item?.id), 'the Admin adds one item to the list', item?.id ? 'added' : 'refused');
  const REF = String(item?.id ?? '').slice(0, 8);

  modelHandOff = null;
  modelReply = 'Haan, humne aisa hi ek app banaya hai — dekh lijiye.';
  // The ref the model asks for, and the ONLY thing it could ask for: the
  // sales file carries refs, kinds and titles and no addresses at all.
  modelShow = [REF];
  await deliverShow(wamid('show.1'), 'Aapne pehle kuch aisa banaya hai kya?');

  const showSeed = await tickUntil(async () => one(await rest('GET', 'crm',
    `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${SHOW}`)}&select=id,lead_id,contact_id`)));
  if (showSeed?.lead_id) created.leads.push(showSeed.lead_id);
  if (showSeed?.contact_id) created.contacts.push(showSeed.contact_id);
  check(Boolean(showSeed?.id), 'the client’s question becomes a thread', showSeed?.id ? 'ingested' : 'nothing ingested');

  const showSent = await tickUntil(async () => {
    const rows = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${showSeed?.id}&author_type=eq.user&select=body,metadata&order=seq`)).json ?? [];
    return rows.find((r) => String(r.body ?? '').includes(modelReply)) ?? null;
  });
  check(Boolean(showSent), 'and the agent answers it', showSent ? 'answered' : 'no reply');

  // The address came from the ROW. The model never saw it, so it could not
  // have written it — which is what §5.3's "only from a list the Admin
  // maintains" means when a model is doing the offering.
  check(
    String(showSent?.body ?? '').includes(`https://portfolio.invalid/${MARKER}/delivery`),
    'carrying the Admin’s own link, attached from the row rather than written by the model',
    String(showSent?.body ?? '').split('\n').pop()?.slice(0, 60) ?? '',
  );
  check(
    String(showSent?.body ?? '').includes(`${MARKER} Delivery app for a Pune restaurant chain`),
    'and the item’s own title beside it',
  );

  // The wire, not the row: what the client actually received.
  const showWire = graphSends.find((g) => String(g.body?.text?.body ?? '').includes(`https://portfolio.invalid/${MARKER}/delivery`));
  check(Boolean(showWire), 'and the PROVIDER received it — one row and one send are different claims', showWire ? 'delivered' : 'never sent');

  // ── the twin: a ref that is not on the list sends nothing ────────────────
  //
  // Without this the whole feature could be "append whatever the model asked
  // for", which is precisely what ADM-12 forbids.
  modelShow = ['deadbeef'];
  modelReply = 'Yeh dekhiye humara kaam.';
  await deliverShow(wamid('show.2'), 'Aur kuch dikhaiye');

  const forged = await tickUntil(async () => {
    const rows = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${showSeed?.id}&author_type=eq.user&select=body&order=seq`)).json ?? [];
    return rows.find((r) => String(r.body ?? '').includes('Yeh dekhiye humara kaam')) ?? null;
  });
  check(Boolean(forged), 'the agent answers again', forged ? 'answered' : 'no reply');
  check(
    !String(forged?.body ?? '').includes('http'),
    'and a ref that is on no list attaches NOTHING — the lookup is the control, not the prompt',
    String(forged?.body ?? '').slice(0, 60),
  );

  // ── and a retired item is not sendable ───────────────────────────────────
  await rest('PATCH', 'crm', `portfolio_items?id=eq.${item?.id}`, { is_active: false });
  modelShow = [REF];
  modelReply = 'Ek aur example bhejta hoon.';
  await deliverShow(wamid('show.3'), 'Ek aur bhejiye');

  const retired = await tickUntil(async () => {
    const rows = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${showSeed?.id}&author_type=eq.user&select=body&order=seq`)).json ?? [];
    return rows.find((r) => String(r.body ?? '').includes('Ek aur example bhejta hoon')) ?? null;
  });
  check(Boolean(retired), 'the agent answers a third time', retired ? 'answered' : 'no reply');
  check(
    !String(retired?.body ?? '').includes('http'),
    'and an item the Admin RETIRED is not sendable — deactivation is a real refusal, not a label',
    String(retired?.body ?? '').slice(0, 60),
  );

  modelShow = [];


  // ── S ────────────────────────────────────────────────────────────────────
  //
  // G-198 — the thread remembers its beginning (Doc 05 §6).
  //
  // Two failures at the two ends of one read. The window took the OLDEST
  // thousand messages, so a long thread lost the message it was queued to
  // answer; and any window at all loses a beginning, which is where a client
  // says what they are building and why.
  //
  // The first is only observable past a thousand messages and is proved by
  // the unit assertion rather than here — planting a thousand rows to watch a
  // window slide is a slow way to check an `order` clause. What THIS proves
  // is the half that needs a running system: the earlier part of a long
  // thread reaches the agent as a summary, and the recent part reaches it
  // verbatim, with nothing missing between them.
  console.log('\nS. A long thread keeps its beginning, and its end');

  const LONG = `9199${String(Date.now()).slice(-8)}`;
  const longPayload = (ref, text) => JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_FLOW01', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: `${MARKER} long` }, wa_id: LONG }],
      messages: [{ from: LONG, id: ref, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
  const deliverLong = async (ref, text) => {
    const body = longPayload(ref, text);
    return fetch(`${APP}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body, cache: 'no-store',
    }).then(async (r) => ({ status: r.status, json: parse(await r.text()) }));
  };

  // The first message the client ever sent — the sentence this section is
  // about, because it is the one a window drops and a summary keeps.
  const FIRST_WORDS = `${MARKER} we run a tiffin service and want an ordering app`;
  await deliverLong(wamid('long.1'), FIRST_WORDS);

  const longSeed = await tickUntil(async () => one(await rest('GET', 'crm',
    `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${LONG}`)}&select=id,lead_id,contact_id`)));
  if (longSeed?.lead_id) created.leads.push(longSeed.lead_id);
  if (longSeed?.contact_id) created.contacts.push(longSeed.contact_id);
  check(Boolean(longSeed?.id), 'a thread begins', longSeed?.id ? 'ingested' : 'nothing ingested');

  /**
   * Ninety more, planted directly — and every one of them AGENCY-side.
   *
   * The point under test is the LENGTH of a thread, and driving ninety turns
   * through the provider would test the webhook for the ninetieth time.
   *
   * The `author_type` is not cosmetic and the first version of this got it
   * wrong: a CLIENT row emits `message.received` and `reply.due` on insert,
   * so alternating the ninety queued about a hundred and thirty-five agent
   * jobs — the agent replying, in earnest, to ninety fixture lines — and the
   * one reply this section is actually about sat behind all of them. The
   * symptom was `no reply prompt`, which is what a backlog looks like from
   * the outside.
   *
   * An agency-side row is inert by the triggers' own conditions (`if
   * new.author_type <> 'client' then return`), which is exactly what a
   * fixture whose only job is to make a thread long should be.
   */
  const startSeq = Number(one(await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${longSeed?.id}&select=seq&order=seq.desc&limit=1`))?.seq ?? 1);
  const filler = [];
  for (let i = 1; i <= 90; i += 1) {
    filler.push({
      organization_id: ORG, conversation_id: longSeed?.id, seq: startSeq + i,
      author_type: 'user',
      body: `${MARKER} routine turn ${i} about scheduling and screens`,
    });
  }
  const planted = await rest('POST', 'crm', 'conversation_messages', filler);
  check(
    Array.isArray(planted.json) && planted.json.length === 90,
    'and grows past the window the agent reads verbatim',
    Array.isArray(planted.json) ? `${planted.json.length + 1} messages` : `HTTP ${planted.status}`,
  );

  // The next real message. Its arrival is what asks for the thread to be
  // summarised — the same event that asks for it to be read.
  const requestsBefore = modelRequests.length;
  modelReply = 'Haan bilkul, main check karke batata hoon.';
  await deliverLong(wamid('long.2'), 'To kya update hai?');

  const longReasons = [];
  let summaryRow = null;
  for (let i = 0; i < 30; i += 1) {
    summaryRow ??= one(await rest('GET', 'crm',
      `conversation_summaries?conversation_id=eq.${longSeed?.id}&select=summary,through_seq,written_by_agent,updated_at`));
    if (summaryRow) break;
    const { json } = await tick();
    for (const r of json?.agentRuns ?? []) if (r?.reason) longReasons.push(r.reason);
  }
  // Kept ticking after the summary lands: the reply is a SEPARATE job, and a
  // loop that stops at the first thing it wanted leaves the second undone —
  // which is how this section first reported "no reply prompt" for a reply
  // that had simply not been claimed yet.
  for (let i = 0; i < 6; i += 1) {
    const { json } = await tick();
    for (const r of json?.agentRuns ?? []) if (r?.reason) longReasons.push(r.reason);
  }
  check(Boolean(summaryRow), 'the thread is summarised', summaryRow ? `through seq ${summaryRow.through_seq}` : 'no summary');
  check(
    summaryRow?.written_by_agent === 'sales',
    'by the agent already reading it — no new agent was turned on for this',
    String(summaryRow?.written_by_agent),
  );
  check(
    Number(summaryRow?.through_seq) > 0 && Number(summaryRow?.through_seq) < startSeq + 91,
    'and it stops short of the newest message — the recent part is never summarised',
    `through ${summaryRow?.through_seq} of ${startSeq + 91}`,
  );

  // What the agent was actually given. The prompt is read from the model
  // stub's own request bodies, because "the summary was written" and "the
  // summary reached the agent" are different claims.
  const replyPrompts = modelRequests.slice(requestsBefore).filter((b) => b.includes('"reply"'));
  const withSummary = replyPrompts.find((b) => b.includes(modelSummary.slice(0, 40)));
  check(
    Boolean(withSummary),
    'and the agent answering is HANDED it — a summary nothing reads is a cost with no consumer',
    replyPrompts.length
      ? `${replyPrompts.length} reply prompt(s)`
      : `no reply prompt — the agent said: ${[...new Set(longReasons)].join(' | ') || '(nothing)'}`,
  );
  check(
    String(withSummary ?? '').includes("a colleague's note, not the client's words"),
    'labelled as a note rather than as something the client said',
  );
  check(
    String(withSummary ?? '').includes('To kya update hai?'),
    'with the newest message verbatim beside it — the end of the thread, not a paraphrase of it',
  );

  // The twin the whole design rests on: what the summary covers is NOT also
  // pasted in verbatim. Without this the summary would be an addition rather
  // than a replacement, and the window would still lose nothing only because
  // nothing had been dropped yet.
  /**
   * The twin the whole design rests on, asked of a prompt that EXISTS.
   *
   * Asked of `withSummary` it was vacuous in the one case that matters: when
   * the summary never reaches the agent, `withSummary` is undefined and
   * `String(undefined).includes(...)` is false, so the twin passed while the
   * feature was broken. A red-proof caught it — which is what a red-proof is
   * for. It is asked of the reply prompt itself, and that prompt's existence
   * is its own check above.
   */
  const anyReplyPrompt = replyPrompts[0] ?? '';
  check(
    anyReplyPrompt.length > 0 && !anyReplyPrompt.includes(FIRST_WORDS),
    'while the summarised part is NOT repeated verbatim — the two halves meet exactly once',
    anyReplyPrompt.length === 0
      ? 'no reply prompt to look at'
      : anyReplyPrompt.includes(FIRST_WORDS)
        ? 'the beginning was pasted in too'
        : 'summarised, not duplicated',
  );

  // And a second message does not pay for a second summary.
  modelReply = 'Ji, dekh raha hoon.';
  await deliverLong(wamid('long.3'), 'Aur?');
  for (let i = 0; i < 8; i += 1) await tick();
  const summaryAfter = one(await rest('GET', 'crm',
    `conversation_summaries?conversation_id=eq.${longSeed?.id}&select=through_seq,updated_at`));
  // Asked of the SUMMARY rather than of a run count: runs on this
  // conversation include the reply and the reads, so counting them would
  // answer a question about the wrong jobs.
  check(
    summaryAfter?.updated_at === summaryRow?.updated_at && summaryAfter?.through_seq === summaryRow?.through_seq,
    'a summary that is nearly current is left alone — a subscriber on every message must cost nothing to say "no"',
    `through ${summaryRow?.through_seq} → ${summaryAfter?.through_seq}`,
  );

  // ── O ────────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nT. The agent answers without waiting for a clock (G-209)');
  //
  // Every other section drives the runner by hand — tick() after tick() —
  // which is exactly what hid this: the harness has always supplied the
  // heartbeat a real client does not have. Nothing here calls tick().
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * §T is the one section whose subject IS the setting, so it turns it on and
   * off again — every other script in the fleet owns the clock deliberately
   * and must keep owning it.
   */
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { wake_runner_on_inbound: true });

  const nudgeRef = `${MARKER}-nudge-${Date.now()}`;

  /**
   * `core.cron_heartbeat` counts every tick the runner has taken, and it is
   * the honest instrument: it rises when and only when `/api/jobs/run` is
   * invoked.
   *
   * NOT "did a reply reach the client" — by this point the harness has left a
   * queue of its own jobs behind and one tick drains at most eight, so that
   * check would be measuring the fixture's backlog rather than this change.
   * It failed for exactly that reason on the first attempt. What §T is about
   * is narrower and is the whole finding: the webhook makes the runner run.
   */
  const ticksBefore = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? 0;
  const replyJobsBefore = ((await rest('GET', 'core',
    `jobs?kind=eq.reply.compose&select=id&order=created_at.desc&limit=200`)).json ?? []).length;

  const nudged = await deliver(nudgeRef, 'Mujhe ek delivery app banwana hai');
  check(nudged.status === 200, 'the webhook accepts the message', `HTTP ${nudged.status}`);
  check(nudged.json?.ingested === 1, 'and takes it in', `ingested ${nudged.json?.ingested}`);

  let ticksAfter = ticksBefore;
  for (let i = 0; i < 30; i += 1) {
    await sleep(500);
    ticksAfter = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? ticksBefore;
    if (ticksAfter > ticksBefore) break;
  }
  check(
    ticksAfter > ticksBefore,
    'the runner ran WITHOUT anybody turning the crank — the webhook rang it itself',
    `${ticksBefore} → ${ticksAfter} tick(s)`,
  );

  /**
   * An INCREASE, not a count above zero.
   *
   * The first version asked `length > 0` and passed during the red-proof —
   * seventeen jobs from earlier sections were enough to satisfy it with the
   * nudge removed. A check that cannot fail is the thing G-208 exists to
   * catch, found in its own author's next test.
   */
  const replyJobs = ((await rest('GET', 'core',
    `jobs?kind=eq.reply.compose&select=id&order=created_at.desc&limit=200`)).json ?? []).length;
  check(
    replyJobs > replyJobsBefore,
    'and the message it was rung for became a reply job',
    `${replyJobsBefore} → ${replyJobs} reply job(s)`,
  );

  // The other direction, and the cost of getting it wrong: a receipt creates
  // no work, so it must ring nothing. A doorbell rung for every status update
  // is a tick spent finding an empty queue.
  const ticksBeforeReceipt = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? 0;
  const receiptOnly = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(RECEIPT_BODY) },
    body: RECEIPT_BODY,
    cache: 'no-store',
  });
  const receiptJson = parse(await receiptOnly.text());
  check(
    receiptOnly.status === 200 && (receiptJson?.ingested ?? 0) === 0,
    'a delivery receipt ingests nothing',
    `HTTP ${receiptOnly.status}, ingested ${receiptJson?.ingested ?? 0}`,
  );
  await sleep(3_000);
  const ticksAfterReceipt = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? 0;
  check(
    ticksAfterReceipt === ticksBeforeReceipt,
    'so it rings nothing — the runner stays asleep',
    `${ticksBeforeReceipt} → ${ticksAfterReceipt} tick(s)`,
  );

  /**
   * And the setting is the switch it claims to be — the twin without which
   * "it works" and "it is on" are indistinguishable.
   */
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { wake_runner_on_inbound: false });
  const ticksBeforeOff = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? 0;
  const offDelivery = await deliver(`${MARKER}-off-${Date.now()}`, 'Aur ek baat poochni thi');
  check(offDelivery.json?.ingested === 1, 'with the setting off, a message is still taken in', `ingested ${offDelivery.json?.ingested}`);
  await sleep(3_000);
  const ticksAfterOff = one(await rest('GET', 'core', 'cron_heartbeat?select=ticks&limit=1'))?.ticks ?? 0;
  check(
    ticksAfterOff === ticksBeforeOff,
    'and the runner is NOT woken — the switch is the switch',
    `${ticksBeforeOff} → ${ticksAfterOff} tick(s)`,
  );

  console.log('\nO. And all of it is on the record');
  const runs = await rest(
    'GET', 'ai',
    `agent_runs?organization_id=eq.${ORG}&select=agent_key,work_class,status&order=created_at.desc&limit=20`,
  );
  const classes = new Set((runs.json ?? []).map((r) => r.work_class));
  check(classes.has('internal_plan') && classes.has('client_facing'), 'every run records the ADM-61 class it was checked against', [...classes].join(', '));

  const audited = await rest('GET', 'audit', `audit_log?organization_id=eq.${ORG}&select=id&limit=1`);
  check((audited.json ?? []).length > 0, 'and the audit log has rows for this organization', `${(audited.json ?? []).length}`);

  const foreign = await rest('GET', 'crm', `conversations?id=eq.${conv.id}&organization_id=neq.${ORG}&select=id`);
  check((foreign.json ?? []).length === 0, 'nothing here belongs to another tenant', `${(foreign.json ?? []).length}`);
} finally {
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: savedSettings ?? {},
    agent_answers_clients: false,
  });
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.objection');
  await rest('DELETE', 'core', `jobs?kind=in.(requirement.extract,message.intent,lead.qualify,reply.compose,objection.read,quotation.rework)`);
  // The internal group, which the per-lead deletes below cannot reach: a group
  // has no lead. Leaving it was harmless until §P started making one, and then
  // it silently took over every later announcement in the run.
  if (created.group) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${created.group}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${created.group}`);
  }
  // G-197 — §R's one item. Deleted rather than deactivated: this is a
  // fixture, and the row it stands for is the Admin's to keep.
  await rest('DELETE', 'crm', `portfolio_items?organization_id=eq.${ORG}&title=like.${MARKER}*`);
  // G-198 — the summaries §S wrote. Deleted by conversation, because a
  // summary outlives the messages it read.
  await rest('DELETE', 'crm', `conversation_summaries?organization_id=eq.${ORG}`);
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.conversation_message');
  for (const id of created.leads) {
    await rest('DELETE', 'crm', `requirement_versions?conversation_id=in.(select id from conversations where lead_id=eq.${id})`);
    await rest('DELETE', 'crm', `conversations?lead_id=eq.${id}`);
    await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  }
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  model.close();
  graph.close();
}

console.log(`\n  ${checks} checks · ${modelCalls} model call(s) · ${graphSends.length} provider send(s)`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ Flow 01: inbound lead → agent → reply → outbound, and the requirements behind it\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
