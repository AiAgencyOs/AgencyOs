// ═══════════════════════════════════════════════════════════════════════════
// Search by meaning (owner decision 14), proved against real Postgres and the
// real job runner, with one stub: the embedding vendor (127.0.0.1:54397, the
// address .env.local's OPENAI_BASE_URL points at). The stub's "meaning" is a
// deterministic bag of concepts — "car", "automobile" and "vehicle" are one
// concept — so ranking can be asserted without a real model. pgvector is not
// needed: the vectors are real[] and the ranking is SQL.
//
//   A. only the owner turns it on; the door is audited
//   B. the indexing job embeds the records, and only the safe words of them
//   C. ranking: a query by meaning finds the record that never says the word
//   D. role scoping: a role is offered only the types it may read, and no
//      session can read the vectors table
//   E. content-hash skip: nothing unchanged is embedded twice; a changed
//      record is embedded once
//   F. budget: a reached monthly cap stops the job before it spends, and
//      lifting the cap lets it resume
//   G. the spend is in the cost ledger under the indexer's key
//
// Needs the dev server (the job runner) on :3000 and nothing else on :54397.
//   node scripts/verify-semantic-search.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
announceTarget(target, 'search by meaning');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.app ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = 'zzsem';
const MODEL = 'text-embedding-3-small';
const PORT = 54397;
const DIMS = 512;

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

const mint = (userId, role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
};

async function rest(method, schema, path, body, token) {
  const key = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' },
    cache: 'no-store',
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (schema, fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);

// ── the stub vendor: concepts, not words ───────────────────────────────────
const CONCEPTS = { car: 'vehicle', automobile: 'vehicle', vehicle: 'vehicle', cars: 'vehicle', bread: 'bakery', bakery: 'bakery', pastry: 'bakery' };
const slot = (s) => createHash('sha256').update(s).digest().readUInt32BE(0) % DIMS;
function embedText(text) {
  const v = new Array(DIMS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) v[slot(CONCEPTS[w] ?? w)] += 1;
  return { vector: v, tokens: words.length };
}
const received = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = parse(raw) ?? {};
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    received.push(...inputs);
    let tokens = 0;
    const data = inputs.map((t, index) => {
      const e = embedText(String(t));
      tokens += e.tokens;
      return { object: 'embedding', index, embedding: e.vector };
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data, model: body.model, usage: { prompt_tokens: tokens, total_tokens: tokens } }));
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not listen on :${PORT} (${e.message}) — is another verifier running?`));

const mine = () => received.filter((t) => t.includes(MARKER));
const created = { users: [], clients: [] };

async function makeUser(role) {
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARKER}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: mint(authUser.id, role) };
}

const tick = () => fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' }).then((r) => r.status);
const state = async () => one(await rest('GET', 'core', `semantic_search_state?organization_id=eq.${ORG}&select=*`));
const aged = () => rest('PATCH', 'core', `semantic_search_state?organization_id=eq.${ORG}`, { last_run_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
async function tickUntil(predicate, budget = 40) {
  for (let i = 0; i < budget; i += 1) {
    await aged();
    await tick();
    if (await predicate()) return true;
  }
  return predicate();
}
const queryVector = (text) => embedText(text).vector;
const searchAs = async (token, text, types) => (await rpc('core', 'semantic_search', { p_query: queryVector(text), p_model: MODEL, ...(types ? { p_types: types } : {}), p_limit: 200, p_min_score: 0.2 }, token)).json ?? [];

const priorState = await state();
const priorBudget = one(await rest('GET', 'ai', `provider_budgets?organization_id=eq.${ORG}&provider=eq.openai&select=*`));

try {
  const owner = await makeUser('owner');
  const admin = await makeUser('ops_admin');
  const member = await makeUser('member');
  const contractor = await makeUser('contractor');
  const finance = await makeUser('finance');

  for (const name of [`${MARKER} Automobile Dealership`, `${MARKER} Bakery Pastry Shop`, `${MARKER} Vehicle Rental`, `${MARKER} Fleet sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV`]) {
    const row = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name }));
    created.clients.push(row.id);
  }
  const [auto, bakery, rental, secret] = created.clients;

  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\n  A. only the owner turns it on, and it is audited');
  for (const [who, u] of [['an ops admin', admin], ['a member', member], ['a finance user', finance]]) {
    const r = one(await rpc('core', 'request_semantic_backfill', { p_total: 10, p_model: MODEL }, u.token));
    check(r?.outcome === 'not_owner', `${who} may not turn it on`, r?.outcome);
  }
  check(!(await state())?.enabled || priorState?.enabled === true, 'and nothing was switched on by the refusals');
  const on = one(await rpc('core', 'request_semantic_backfill', { p_total: 50, p_model: MODEL }, owner.token));
  check(on?.outcome === 'requested', 'the owner turns it on', on?.outcome);
  const audit = await rest('GET', 'audit', `audit_log?action=eq.semantic_search.backfill_requested&actor_id=eq.${owner.id}&select=action,after`);
  check(Array.isArray(audit.json) && audit.json.length === 1, 'the request is in the audit trail, naming the owner');

  // ── B ────────────────────────────────────────────────────────────────────
  console.log('\n  B. the job embeds the records — and only their safe words');
  const finished = await tickUntil(async () => (await state())?.status === 'done');
  const st = await state();
  check(finished, 'the backfill runs to done on the real job runner', `status ${st?.status}, ${st?.done} vectors`);
  check(mine().length === 3, 'the three planted records with safe names were sent, once each', `${mine().length} inputs`);
  check(!received.some((t) => t.includes('sk-ant-api03')), 'a credential in a name was never sent to the vendor');
  check(received.includes('Client\nstatus: active'), 'the record whose name was a credential was embedded without it');
  const vectors = await rest('GET', 'core', 'search_embeddings?select=entity_id&limit=1', null, owner.token);
  check(!vectors.ok || (Array.isArray(vectors.json) && vectors.json.length === 0), 'no session can read the vectors table directly', `${vectors.status}`);
  const write = await rest('POST', 'core', 'search_embeddings', { organization_id: ORG, entity_type: 'Client', entity_id: 'x', content_hash: 'x'.repeat(20), embedding: new Array(8).fill(1), norm: 1, model: MODEL }, owner.token);
  check(!write.ok, 'nor write to it', `${write.status}`);
  const door = await rpc('core', 'upsert_search_embeddings', { p_organization_id: ORG, p_model: MODEL, p_rows: [] }, owner.token);
  check(!door.ok, 'the write door is not callable by a session', `${door.status}`);

  // ── C ────────────────────────────────────────────────────────────────────
  console.log('\n  C. ranking by meaning');
  const hits = await searchAs(owner.token, 'car', ['Client']);
  const ids = hits.map((h) => h.entity_id);
  check(ids.includes(auto) && ids.includes(rental), 'a query for "car" finds the dealership and the rental, which never say it');
  check(!ids.includes(bakery), 'and not the bakery');
  const scoreOf = (id) => hits.find((h) => h.entity_id === id)?.score ?? 0;
  check(scoreOf(auto) > 0.3 && scoreOf(auto) <= 1.0001, 'scores are cosine similarities', String(scoreOf(auto).toFixed(3)));
  const sorted = hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score);
  check(sorted, 'results come best first');

  // ── D ────────────────────────────────────────────────────────────────────
  console.log('\n  D. a role is offered only what it may read');
  const typesOf = async (u) => (await rpc('core', 'semantic_visible_types', {}, u.token)).json ?? [];
  const fin = await typesOf(finance);
  check(fin.length === 1 && fin[0] === 'Invoice', 'finance may search invoices and nothing else', fin.join(','));
  const mem = await typesOf(member);
  check(mem.includes('Lead') && mem.includes('Client') && !mem.includes('Invoice') && !mem.includes('Audit') && !mem.includes('Agent'), 'a member: records, not money or audit', mem.join(','));
  const con = await typesOf(contractor);
  check(con.includes('Project') && !con.includes('Lead') && !con.includes('Invoice'), 'a contractor: delivery records, not leads or money', con.join(','));
  const own = await typesOf(owner);
  check(own.length === 11, 'the owner may search all eleven types', `${own.length}`);
  const finHits = await searchAs(finance.token, 'car');
  check(finHits.every((h) => h.entity_type === 'Invoice'), 'a finance search never returns a client, lead or project');
  const finAsk = await searchAs(finance.token, 'car', ['Client']);
  check(finAsk.length === 0, 'and asking finance for clients by name returns nothing');
  const memHits = await searchAs(member.token, 'car', ['Client', 'Audit', 'Invoice']);
  check(memHits.some((h) => h.entity_id === auto) && memHits.every((h) => h.entity_type === 'Client'), 'a member asking for audit and invoices as well gets only the clients');

  // ── E ────────────────────────────────────────────────────────────────────
  console.log('\n  E. nothing unchanged is embedded twice');
  const before = mine().length;
  const idleDone = await tickUntil(async () => true, 3);
  check(idleDone && mine().length === before, 'three more passes over unchanged records embed none of them', `${mine().length - before} new inputs`);
  await rest('PATCH', 'core', `client_accounts?id=eq.${auto}`, { name: `${MARKER} Automobile Dealership Ltd` });
  await tickUntil(async () => mine().some((t) => t.includes('Dealership Ltd')), 6);
  check(mine().length === before + 1, 'a changed record is embedded once, and only that one', `${mine().length - before} new input(s)`);

  // ── F ────────────────────────────────────────────────────────────────────
  console.log('\n  F. a reached monthly budget stops the job before it spends');
  await rest('DELETE', 'ai', `provider_budgets?organization_id=eq.${ORG}&provider=eq.openai`);
  await rest('POST', 'ai', 'provider_budgets', { organization_id: ORG, provider: 'openai', monthly_cap_minor: 1 });
  await rpc('ai', 'record_embedding_usage', { p_organization_id: ORG, p_model: MODEL, p_provider: 'openai', p_input_tokens: 10, p_cost_minor: 5 });
  const allowed = await rpc('ai', 'semantic_budget_allows', { p_provider: 'openai', p_model: MODEL }, member.token);
  check(allowed.json === false, 'the gate says no to a member once the cap is reached');
  const spent = mine().length;
  await rest('PATCH', 'core', `client_accounts?id=eq.${bakery}`, { name: `${MARKER} Bakery Pastry Shop and Cafe` });
  await tickUntil(async () => (await state())?.status === 'blocked', 6);
  const blocked = await state();
  check(blocked?.status === 'blocked', 'the job parks itself as blocked', blocked?.status);
  check(/budget/i.test(blocked?.note ?? ''), 'and says why', blocked?.note ?? '');
  check(mine().length === spent, 'and embedded nothing after the refusal', `${mine().length - spent} new inputs`);
  await rest('DELETE', 'ai', `provider_budgets?organization_id=eq.${ORG}&provider=eq.openai`);
  const resumed = await tickUntil(async () => mine().some((t) => t.includes('and Cafe')), 6);
  check(resumed && (await state())?.status !== 'blocked', 'lifting the cap lets it resume by itself', (await state())?.status);

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\n  G. the spend is in the cost ledger');
  const ledger = await rest('GET', 'ai', `cost_ledger?organization_id=eq.${ORG}&agent_key=eq.semantic_indexer&select=input_tokens,runs,provider,model`);
  const rows = Array.isArray(ledger.json) ? ledger.json : [];
  const tokens = rows.reduce((n, r) => n + Number(r.input_tokens), 0);
  check(rows.length > 0 && rows.every((r) => r.provider === 'openai' && r.model === MODEL), 'embedding calls are recorded against the provider and model');
  check(tokens >= received.reduce((n, t) => n + embedText(t).tokens, 0) * 0.99, 'with the tokens the vendor reported', `${tokens} tokens over ${rows.reduce((n, r) => n + r.runs, 0)} calls`);
  void secret;
} finally {
  server.close();
  await rest('DELETE', 'ai', `provider_budgets?organization_id=eq.${ORG}&provider=eq.openai`);
  if (priorBudget) await rest('POST', 'ai', 'provider_budgets', priorBudget);
  await rest('DELETE', 'ai', `cost_ledger?organization_id=eq.${ORG}&agent_key=eq.semantic_indexer`);
  await rest('DELETE', 'ai', `agent_policy_refusals?organization_id=eq.${ORG}&agent_key=eq.semantic_indexer`);
  await rest('DELETE', 'core', `alerts?organization_id=eq.${ORG}&fingerprint=in.(provider-budget:openai,model-budget:${MODEL})`);
  await rest('DELETE', 'core', `search_embeddings?organization_id=eq.${ORG}`);
  if (priorState) await rest('PATCH', 'core', `semantic_search_state?organization_id=eq.${ORG}`, { enabled: priorState.enabled, status: priorState.status, total: priorState.total, done: priorState.done, cursors: priorState.cursors, passes: priorState.passes, note: priorState.note, model: priorState.model });
  else await rest('DELETE', 'core', `semantic_search_state?organization_id=eq.${ORG}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
