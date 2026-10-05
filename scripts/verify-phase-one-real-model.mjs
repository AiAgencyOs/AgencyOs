#!/usr/bin/env node
/**
 * Phase 1 on a REAL model: an inbound WhatsApp lead is read, answered and turned into requirements by the
 * agents themselves. The sibling of verify-flow-01.mjs, which scripts the model; here nothing is scripted -
 * the model is whatever the Provider Manager routes to (set it up under /agents/providers first), so what is
 * checked is what must hold for ANY model's words: the structure, the guards and the record, never a sentence.
 *
 *   VERIFY_JWT_SKEW_SECONDS=14400 node scripts/verify-phase-one-real-model.mjs
 *
 * Only Meta's Graph API is stubbed (127.0.0.1:54398); it belongs to Meta, not AgencyOS. It costs model credits.
 * The reply the agent wrote and the requirements it extracted are PRINTED for a person to read - a script can
 * prove they exist and obey the rules, not that they are good.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, whatsapp: true });
await announceTarget(target, 'Phase 1 on a real model - inbound lead to requirements');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = 'zztest-p1real';
const RUN = randomUUID().slice(0, 8);
const wamid = (suffix) => `wamid.${MARKER}.${RUN}.${suffix}`;
const PHONE_NUMBER_ID = `${MARKER}-pn-${RUN}`;
const SENDER = `9199${String(Date.now()).slice(-8)}`;
const GRAPH_PORT = 54398;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` - ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` - ${detail}` : ''}`);
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
  fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' })
    .then(async (r) => ({ status: r.status, json: parse(await r.text()) }));

/** Ticks until the predicate is truthy or the budget runs out. A real model is slow: the budget is generous. */
async function tickUntil(predicate, budget = 60) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

const graphSends = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ id: 'MEDIA.STUB' }));
    }
    graphSends.push({ url: req.url, body: parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
await new Promise((resolve, reject) => { graph.once('error', reject); graph.listen(GRAPH_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));

const sign = (body) => `sha256=${createHmac('sha256', target.whatsappAppSecret).update(body, 'utf8').digest('hex')}`;
async function deliver(externalRef, text) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_P1REAL', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_NUMBER_ID },
      contacts: [{ profile: { name: `${MARKER} sender` }, wa_id: SENDER }],
      messages: [{ from: SENDER, id: externalRef, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
    } }] }],
  });
  const res = await fetch(`${APP}/api/webhooks/whatsapp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body, cache: 'no-store',
  });
  return { status: res.status, json: parse(await res.text()) };
}

console.log('\n\x1b[1mAgencyOS - Phase 1 on a real model\x1b[0m');

const created = { leads: [], contacts: [] };
let savedSettings = null;
const startedAt = new Date(Date.now() - 5_000).toISOString();

try {
  const org = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`));
  savedSettings = org?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...savedSettings, whatsapp_phone_number_id: PHONE_NUMBER_ID },
    agent_answers_clients: false,
  });
  // Anything an earlier run left, so it cannot change what this one observes.
  for (const { id } of (await rest('GET', 'crm', `contacts?organization_id=eq.${ORG}&full_name=like.${MARKER}*&select=id`)).json ?? []) {
    for (const c of (await rest('GET', 'crm', `conversations?contact_id=eq.${id}&select=id,lead_id`)).json ?? []) {
      await rest('DELETE', 'crm', `requirement_versions?conversation_id=eq.${c.id}`);
      await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${c.id}`);
      await rest('DELETE', 'crm', `conversations?id=eq.${c.id}`);
      if (c.lead_id) await rest('DELETE', 'crm', `leads?id=eq.${c.lead_id}`);
    }
    await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  }
  await rest('DELETE', 'core', 'jobs?status=in.(queued,running)');

  // ── A. a real enquiry becomes a lead and is READ by the sales agent ──────
  console.log('\nA. A real enquiry becomes a lead and is read');
  const first = await deliver(wamid('1'), 'Hello, mujhe apni pharmacy chain ke liye ek mobile app banwana hai. Customers medicines order kar sakein aur home delivery ya store pickup choose kar sakein.');
  check(first.status === 200 && first.json?.ingested === 1, 'a signed message is ingested', JSON.stringify(first.json).slice(0, 80));
  const conv = one(await rest('GET', 'crm', `conversations?organization_id=eq.${ORG}&external_ref=eq.${encodeURIComponent(`wa:+${SENDER}`)}&select=id,lead_id,contact_id`));
  check(Boolean(conv?.id && conv?.lead_id && conv?.contact_id), 'a conversation, a lead and a contact exist');
  if (conv?.lead_id) created.leads.push(conv.lead_id);
  if (conv?.contact_id) created.contacts.push(conv.contact_id);
  const firstMsg = one(await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&select=id&order=seq&limit=1`));

  const intentRun = await tickUntil(async () => one(await rest('GET', 'ai',
    `agent_runs?agent_key=eq.sales&subject_id=eq.${firstMsg.id}&work_class=eq.internal_plan&status=in.(succeeded,failed)&select=id,status,error,model,provider_id&order=created_at.desc&limit=1`)));
  check(intentRun?.status === 'succeeded', 'the sales agent read the message on the real model', `${intentRun?.model} via ${intentRun?.provider_id}${intentRun?.error ? ` - ${String(intentRun.error).slice(0, 120)}` : ''}`);
  const labelled = one(await rest('GET', 'crm', `conversation_messages?id=eq.${firstMsg.id}&select=intent,language`));
  check(Boolean(labelled?.intent), 'it labelled what the message is', `${labelled?.intent}`);
  check(Boolean(labelled?.language), 'and the language it was written in', `${labelled?.language}`);

  // ── B. with replies off nobody is answered ───────────────────────────────
  console.log('\nB. With replies off, nobody is answered');
  for (let i = 0; i < 6; i += 1) await tick();
  check(graphSends.length === 0, 'the provider received nothing', `${graphSends.length} send(s)`);

  // ── C. with replies on, the agent answers - and never quotes a price ─────
  console.log('\nC. With replies on, the agent answers, and a price question is not answered with a price');
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { agent_answers_clients: true });
  await deliver(wamid('2'), 'App mein prescription upload, UPI payment aur order tracking bhi chahiye. Total kitna kharcha aayega aur kitne din lagenge?');
  const asked = one(await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&external_ref=eq.${encodeURIComponent(wamid('2'))}&select=id`));
  const answered = await tickUntil(async () => one(await rest('GET', 'ai',
    `agent_runs?agent_key=eq.sales&work_class=eq.client_direct&subject_id=eq.${asked?.id ?? 'none'}&status=in.(succeeded,failed)&select=id,status,error&order=created_at.desc&limit=1`)));
  check(answered?.status === 'succeeded', 'the sales agent composed a client-direct reply', answered?.error ? String(answered.error).slice(0, 140) : 'succeeded');
  const sentToClient = await tickUntil(async () => graphSends.at(-1));
  check(Boolean(sentToClient), 'the provider received a message - the loop closed');
  const replyText = String(sentToClient?.body?.text?.body ?? '');
  check(String(sentToClient?.body?.to ?? '').replace(/\D/g, '') === SENDER, 'addressed to the number that wrote in');
  check(replyText.trim().length > 0, 'with words in it', replyText.slice(0, 70).replace(/\n/g, ' '));
  check(!/(?:₹|rs\.?|inr|rupees?)\s*\d|\d[\d,]{3,}\s*(?:₹|rs\b|inr|rupees?)/i.test(replyText), 'and no price is named - the guard held on the real model\'s words');
  const outbound = one(await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&authored_by_agent=eq.sales&select=id,metadata&order=seq.desc&limit=1`));
  check(outbound?.metadata?.delivery === 'sent', 'the reply is recorded on the thread as sent', `${outbound?.metadata?.delivery}`);
  console.log(`\n  \x1b[2mWhat the agent said (read it): ${replyText.replace(/\n/g, ' ')}\x1b[0m`);

  // ── D. the requirement collector turns the thread into scope ─────────────
  console.log('\nD. The requirement collector turns the thread into scope');
  const req = await tickUntil(async () => one(await rest('GET', 'crm', `requirement_versions?conversation_id=eq.${conv.id}&select=id,version,status,payload&order=version.desc&limit=1`)));
  check(Boolean(req?.id), 'a requirement version exists for the conversation', req ? `v${req.version} ${req.status}` : 'none');
  const payload = req?.payload ?? {};
  const items = Array.isArray(payload.scopeItems) ? payload.scopeItems : [];
  check(typeof payload.summary === 'string' && payload.summary.length > 10, 'with a summary', String(payload.summary ?? '').slice(0, 70));
  check(items.length >= 2, 'and at least two scope items from what the client said', `${items.length}`);
  check(items.every((i) => i && typeof i.title === 'string' && i.title.trim() !== ''), 'each with a title');
  check(req?.status === 'proposed', 'proposed only - a person accepts it, the agent does not', `${req?.status}`);
  console.log(`\n  \x1b[2mScope the agent extracted (read it):\x1b[0m`);
  for (const i of items) console.log(`  \x1b[2m  - ${i.title}${i.detail ? `: ${String(i.detail).slice(0, 90)}` : ''}\x1b[0m`);
  if (Array.isArray(payload.openQuestions) && payload.openQuestions.length) console.log(`  \x1b[2m  open questions: ${payload.openQuestions.slice(0, 4).join(' | ')}\x1b[0m`);

  // ── E. nothing died, nothing was spent twice, everything is on the record ─
  console.log('\nE. Nothing died and every run is on the record');
  const runs = (await rest('GET', 'ai', `agent_runs?organization_id=eq.${ORG}&created_at=gte.${startedAt}&select=agent_key,work_class,status,error,model,provider_id,cost_minor`)).json ?? [];
  // Phase 1's agents only: a leftover job from another phase's run draining on the shared queue is not this flow's.
  const PHASE_ONE = new Set(['sales', 'requirement_collector', 'lead_qualifier', 'proposal_drafter']);
  const failed = runs.filter((r) => r.status === 'failed' && PHASE_ONE.has(r.agent_key));
  const strays = runs.filter((r) => r.status === 'failed' && !PHASE_ONE.has(r.agent_key));
  if (strays.length) console.log(`  \x1b[33m•\x1b[0m ${strays.length} failed run(s) from other phases' agents on the shared queue (not counted): ${strays.map((r) => r.agent_key).join(', ')}`);
  check(failed.length === 0, 'no agent run failed', failed.map((r) => `${r.agent_key}: ${String(r.error).slice(0, 90)}`).join(' | '));
  check(runs.length > 0 && runs.every((r) => r.work_class && r.provider_id), 'every run records its ADM-61 class and the provider that served it', `${runs.length} run(s)`);
  const dead = (await rest('GET', 'core', `jobs?status=eq.dead&created_at=gte.${startedAt}&select=kind,last_error`)).json ?? [];
  check(dead.length === 0, 'no job died', dead.map((j) => `${j.kind}: ${String(j.last_error).slice(0, 80)}`).join(' | '));
  const sendsToThisClient = graphSends.filter((g) => String(g.body?.to ?? '').replace(/\D/g, '') === SENDER).length;
  check(sendsToThisClient === 1, 'the client was messaged exactly once for the one question', `${sendsToThisClient}`);
} finally {
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings ?? {}, agent_answers_clients: false });
  await rest('DELETE', 'core', 'jobs?kind=in.(requirement.extract,message.intent,lead.qualify,reply.compose,objection.read,quotation.rework)');
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.conversation_message');
  await rest('DELETE', 'crm', `conversation_summaries?organization_id=eq.${ORG}`);
  for (const id of created.leads) {
    await rest('DELETE', 'crm', `requirement_versions?conversation_id=in.(select id from conversations where lead_id=eq.${id})`);
    await rest('DELETE', 'crm', `conversations?lead_id=eq.${id}`);
    await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  }
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  graph.close();
}

console.log(`\n  ${checks} checks · ${graphSends.length} provider send(s)`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ Phase 1 on a real model: lead -> agent -> reply -> requirements, every rule held\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
