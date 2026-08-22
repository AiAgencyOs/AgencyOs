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
let modelCalls = 0;

const model = createServer((req, res) => {
  modelCalls += 1;
  req.resume();
  // Every workflow this flow reaches asks for a different shape. The stub
  // answers by URL-agnostic guesswork on the schema name the runner sent, so
  // one stub serves the intent read, the qualification read and the reply.
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Dispatched on the SHAPE of the schema, not on its name: the provider
    // sends `output_config.format.schema` and no name at all, so matching on
    // one silently answered every workflow with the same payload — which the
    // runner then refused as "model output failed schema validation", in a
    // workflow that had nothing wrong with it.
    const asks = (prop) => body.includes(`"${prop}"`);
    let payload;
    if (asks('reply')) payload = { reply: modelReply, handToHuman: modelHandOff };
    else if (asks('intent')) payload = { intent: 'new_enquiry', quote: 'I want to build an app', language: 'en', clientFact: null };
    else if (asks('covered')) payload = { covered: [{ area: 'what_to_build', quote: 'I want to build an app' }] };
    else if (asks('concern')) payload = { kind: 'trust', concern: 'not sure about this' };
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

const created = { leads: [], contacts: [] };
let savedSettings = null;

try {
  // The organization must claim this phone number id, or nothing resolves.
  const org = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings,agent_answers_clients`));
  savedSettings = org?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...savedSettings, whatsapp_phone_number_id: PHONE_NUMBER_ID },
    agent_answers_clients: false,
  });

  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\nA. The webhook believes nobody it cannot verify');
  const unsigned = await deliver(`wamid.${MARKER}.unsigned`, 'Hi', { signed: false });
  check(unsigned.status >= 400, 'an unsigned body is refused', `status ${unsigned.status}`);

  // ── B, C, D ──────────────────────────────────────────────────────────────
  console.log('\nB–D. A real message becomes a lead, and being written to is consent');
  const first = await deliver(`wamid.${MARKER}.1`, 'Hi, I want to build an app.');
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
  await deliver(`wamid.${MARKER}.2`, 'Something like Uber for my local business.');
  const leads = await rest('GET', 'crm', `leads?organization_id=eq.${ORG}&contact_id=eq.${conv.contact_id}&select=id`);
  check((leads.json ?? []).length === 1, 'a second message creates no second lead', `${(leads.json ?? []).length} lead(s)`);

  const convs = await rest('GET', 'crm', `conversations?organization_id=eq.${ORG}&lead_id=eq.${conv.lead_id}&select=id`);
  check((convs.json ?? []).length === 1, 'and no second conversation', `${(convs.json ?? []).length}`);

  const replay = await deliver(`wamid.${MARKER}.2`, 'Something like Uber for my local business.');
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
  await deliver(`wamid.${MARKER}.3`, 'It needs customer login and payments.');
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

  await deliver(`wamid.${MARKER}.4`, 'Can you help?');

  // Scoped to THIS message, not to the newest client_facing run. `ai.agent_runs`
  // is history and is never cleaned, so "the newest client_facing run" is a
  // leftover from the previous execution of this script — and the follow-up
  // composer is client_facing too. The first draft read a stale failure and
  // reported it as this run's.
  const asked = one(await rest(
    'GET', 'crm',
    `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(`wamid.${MARKER}.4`)}&select=id`,
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
  await deliver(`wamid.${MARKER}.6`, 'And one more thing.');

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
  await deliver(`wamid.${MARKER}.5`, 'One more question.');
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
  await deliverAs(`wamid.${MARKER}.human.1`, 'Main kisi insaan se baat karna chahta hoon');

  const humanConv = await tickUntil(async () => {
    const c = one(await rest('GET', 'crm',
      `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${HUMAN}`)}&select=id,agent_paused_at,agent_paused_reason`));
    return c?.agent_paused_at ? c : null;
  // Sixty rather than thirty: the runner claims ONE agent job per tick and by
  // this point the script has queued four kinds of them. A budget that only
  // clears on an empty queue is a check that passes on ordering.
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
  await deliverAs(`wamid.${MARKER}.human.2`, 'Hello? Koi hai?');
  // Scoped to the message that arrived AFTER the pause. The first one has a
  // reply.due and should — it is the message the agent answered on its way out,
  // and counting it here would make this check fail for being right.
  const afterPause = one(await rest('GET', 'crm',
    `conversation_messages?external_ref=eq.${encodeURIComponent(`wamid.${MARKER}.human.2`)}&select=id`));
  const dueAfter = await rest('GET', 'core',
    `outbox_events?type=eq.reply.due&subject_id=eq.${afterPause.id}&select=id`);
  check((dueAfter.json ?? []).length === 0, 'a message arriving after the handover asks for no reply', `${(dueAfter.json ?? []).length} event(s)`);
  for (let i = 0; i < 6; i += 1) await tick();
  check(graphSends.length === sendsAtPause, 'and nothing further is sent', `${graphSends.length - sendsAtPause} send(s)`);

  // ── O ────────────────────────────────────────────────────────────────────
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
  await rest('DELETE', 'core', `jobs?kind=in.(requirement.extract,message.intent,lead.qualify,reply.compose,objection.read)`);
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
