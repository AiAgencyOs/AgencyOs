#!/usr/bin/env node
/**
 * The Project Planning Agent drafts the operational blueprint — Phase 2
 * Planning §2-§9, §18. Against the real database and the running app, with a
 * stub model that answers the agent's structured call (no provider is needed).
 *
 *   node scripts/verify-planning-agent.mjs
 *
 * Proves, each in both directions:
 *   • the advance (milestone 1) VERIFIED opens planning with no further call,
 *     and a draft plan appears: a deliverable per scope item, the client's
 *     asks owned by the project manager, a finance gate per payment milestone
 *   • a LATER milestone's payment does not, and a replay never makes a second
 *     plan
 *   • a draft that misses a scope item or contains engineering is sent back
 *     once, and the corrected one is what is written
 *   • a model that cannot get it right writes NOTHING and tells staff
 *   • the plan is a DRAFT: nothing is active, approved or sent to a client
 *   • staff can ask for planning by hand, through an audited door
 *   • a plan that already exists (a person's) is never replaced
 *
 * The model is a stub; what is proved is the agent's plumbing and the rules
 * around its answer, not the quality of a real model's blueprint.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'the planner drafts, a person approves');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-plan-${randomUUID().slice(0, 8)}`;
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
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text) };
}
const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);
const emit = (type, subjectType, subjectId) => rpc('core', 'emit_event', { p_organization_id: ORG, p_type: type, p_subject_type: subjectType, p_subject_id: subjectId, p_payload: {} });

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

const tick = () =>
  fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' })
    .then(async (r) => ({ status: r.status, json: parse(await r.text()) }));
async function tickUntil(predicate, budget = 40) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── the model stub: a blueprint per project, behaving as the marker says ────
const modes = new Map(); // project name -> 'good' | 'bad_then_good' | 'always_bad'
const callsFor = new Map();
const corrections = [];
const goodFor = (n) => ({
  objective: 'Launch the agreed product for the client.',
  deliverables: Array.from({ length: n }, (_, i) => ({
    scopeItem: i + 1, name: `Deliverable ${i + 1}`, applicablePhase: i === 0 ? 'phase_3' : 'phase_5', ownerRole: i === 0 ? 'designer' : 'developer',
    readinessCriteria: `Item ${i + 1} meets the agreed acceptance.`, evidenceRequired: 'A demo the client has seen.', ambiguityNote: null,
  })),
  dependencies: [
    { kind: 'client_asset', description: 'Logo and brand colours', neededByPhase: 'phase_3', ownerRole: 'designer' },
    { kind: 'client_access', description: 'Store account access', neededByPhase: 'phase_6', ownerRole: 'developer' },
    { kind: 'external_service', description: 'Payment gateway merchant account', neededByPhase: 'phase_5', ownerRole: 'developer' },
  ],
  milestones: [{ name: 'Design approved', kind: 'client_approval', phase: 'phase_4', gateCriteria: 'The client approves the design in writing.' }],
  notes: [{ kind: 'risk', statement: 'Client content may arrive late.', ownerRole: 'project_manager' }],
  clarifications: [],
});
const model = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = parse(body) ?? {};
    const messages = parsed.messages ?? [];
    const first = typeof messages[0]?.content === 'string' ? messages[0].content : JSON.stringify(messages[0]?.content ?? '');
    const key = [...modes.keys()].find((k) => first.includes(k));
    const n = (first.match(/^\d+\. /gm) ?? []).length;
    const count = (callsFor.get(key) ?? 0) + 1;
    callsFor.set(key, count);
    const last = messages[messages.length - 1];
    const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    if (/cannot be used/.test(lastText)) corrections.push(lastText);

    const mode = modes.get(key) ?? 'good';
    let out;
    if (mode === 'always_bad' || (mode === 'bad_then_good' && count === 1)) {
      out = goodFor(n);
      out.deliverables = out.deliverables.slice(0, 1); // misses the rest
      out.objective = 'Design the database schema and create a table for orders.'; // and designs the product
    } else if (mode === 'asks') {
      out = goodFor(n);
      out.clarifications = [
        { scopeItem: 1, question: 'Which stores should the first release cover?', impact: 'Decides how many store accounts are set up.' },
        { scopeItem: 2, question: 'Do you already have a delivery partner for medicines?', impact: 'Decides whether delivery is in scope for planning.' },
      ];
    } else if (mode === 'unsafe_question') {
      out = goodFor(n);
      out.clarifications = [{ scopeItem: 1, question: 'Can you pay 50,000 rupees more to add this?', impact: 'Changes what is planned.' }];
    } else {
      out = goodFor(n);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 80, output_tokens: 60 },
    }));
  });
});
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(MODEL_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

// ── the Graph stub, for the questions the PM puts to the client ─────────────
const graphSends = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && req.url.endsWith('/media')) return res.end(JSON.stringify({ id: `MEDIA.STUB.${Date.now()}` }));
    graphSends.push({ url: req.url, body: parse(body) });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
await new Promise((resolve, reject) => { graph.once('error', reject); graph.listen(GRAPH_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));
const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.PLANNER' } });
const textsTo = (phone) => graphSends.filter((g) => g.body?.type === 'text' && (g.body?.to === phone.replace('+', '') || g.body?.to === phone)).map((g) => g.body?.text?.body ?? '');

// ── fixtures ────────────────────────────────────────────────────────────────
let adminId = null;
async function ensureAdmin() {
  if (adminId) return adminId;
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ email: `zzplan-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json()).catch(() => ({}));
  adminId = authUser?.id;
  if (!adminId) fail('could not create the admin');
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: adminId, role: 'owner', status: 'active' });
  return adminId;
}

async function plant(label, { items = 3, plan = false, thread = false } = {}) {
  const name = `${MARKER}-${label}`;
  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${name} client` }));
  let conv = null; let phone = null;
  let opp = null;
  if (thread) {
    phone = `+9198${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`;
    const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: client.id, full_name: `${name} contact`, phone }));
    await rest('POST', 'crm', 'communication_consent', { organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted' });
    const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, title: name, source: 'whatsapp', source_ref: `${name}:src`, status: 'new' }));
    conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct', channel: 'whatsapp', external_ref: `${name}:conv`, status: 'active' }));
    await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv.id, seq: 0, author_type: 'client', body: 'hello', external_ref: `${name}:in0`, occurred_at: new Date().toISOString() });
    opp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead.id, name: `${name} deal`, stage: 'discovery', client_account_id: client.id }));
  }
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: client.id, name, status: 'planning', ...(opp ? { opportunity_id: opp.id } : {}) }));
  const handoff = one(await rest('POST', 'ai', 'handoffs', { organization_id: ORG, correlation_id: randomUUID(), from_agent: 'sales', to_agent: 'project_manager', objective: `${name} handoff` }));
  await rest('POST', 'projects', 'phase_two', { organization_id: ORG, project_id: project.id, handoff_id: handoff.id });
  const scope = one(await rest('POST', 'projects', 'scope_versions', {
    organization_id: ORG, project_id: project.id, version: 1, status: 'draft',
  }));
  for (let i = 1; i <= items; i += 1) {
    await rest('POST', 'projects', 'scope_items', {
      organization_id: ORG, scope_version_id: scope.id, title: `Scope item ${i}`, detail: `What item ${i} does`, inclusion: 'included', position: i,
    });
  }
  await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: scope.id, title: 'Marketing campaign', inclusion: 'excluded', position: 99 });
  // Items go in while the version is a draft; freezing it is what makes it the approved scope.
  await rest('PATCH', 'projects', `scope_versions?id=eq.${scope.id}`, { status: 'active', frozen_at: new Date().toISOString() });
  const milestones = (await rest('POST', 'projects', 'milestones', [30, 20, 30, 20].map((p, i) => ({
    organization_id: ORG, project_id: project.id, name: `${name} M${i + 1}`, position: i, payment_percent: p,
  })))).json ?? [];
  if (plan) {
    await rpc('projects', 'draft_project_plan', { p_project_id: project.id, p_objective: 'A person drafted this.' });
  }
  return { name, client, project, scope, milestones, conv, phone };
}

/** An invoice for a milestone, issued, with a payment a person verifies - which emits invoice.paid. */
async function advanceVerified(fx, position) {
  const milestone = fx.milestones.find((m) => m.position === position);
  const invoice = one(await rest('POST', 'finance', 'invoices', {
    organization_id: ORG, client_account_id: fx.client.id, project_id: fx.project.id, milestone_id: milestone.id,
    number: `${fx.name}-I${position}`.toUpperCase().slice(0, 40), status: 'draft', currency: 'INR', subtotal_minor: 1000000, tax_minor: 0, total_minor: 1000000,
  }));
  await rest('POST', 'finance', 'invoice_items', {
    organization_id: ORG, invoice_id: invoice.id, position: 0, description: `${fx.name} line`, quantity: 1, unit_price_minor: 1000000, amount_minor: 1000000, tax_rate_bp: 0,
  });
  await rpc('finance', 'issue_invoice', { p_invoice_id: invoice.id });
  // The money path the Admin's button takes: the payment is recorded, then a
  // PERSON confirms it - which is what publishes invoice.paid.
  const payment = one(await rpc('finance', 'record_manual_payment', {
    p_invoice_id: invoice.id, p_provider_payment_id: `${fx.name}-utr-${position}`, p_amount_minor: 1000000,
    p_captured_at: new Date().toISOString(), p_method: 'bank_transfer',
  }));
  const verified = one(await rpc('finance', 'verify_payment', { p_payment_id: payment?.payment_id, p_verified_by: await ensureAdmin() }));
  return { invoice, verified };
}

const plans = async (projectId) => (await rest('GET', 'projects', `project_plans?project_id=eq.${projectId}&select=id,version,status,objective,created_by,approved_at,activated_at`)).json ?? [];
const children = async (planId, table) => (await rest('GET', 'projects', `${table}?plan_id=eq.${planId}&select=*`)).json ?? [];

console.log('\n\x1b[1mAgencyOS — the Project Planning Agent drafts the blueprint (Phase 2 Planning)\x1b[0m');

try {
  // ── 1. the advance verified opens planning ────────────────────────────────
  section('1. The advance verified opens planning, with no further call');
  const a = await plant('a');
  modes.set(a.name, 'good');
  const { verified } = await advanceVerified(a, 0);
  check(verified?.outcome === 'verified', 'an admin verifies the advance (the human act)', String(verified?.outcome));
  const draftA = await tickUntil(async () => (await plans(a.project.id))[0] ?? null);
  check(Boolean(draftA), 'a plan appears for the project');
  check(draftA?.status === 'draft' && draftA?.created_by === null, 'it is a DRAFT, drafted by no person', `${draftA?.status}`);
  check(draftA?.approved_at === null && draftA?.activated_at === null, 'and nothing is approved or active - a person does that');

  const deliverables = await children(draftA.id, 'plan_deliverables');
  const scopeItems = (await rest('GET', 'projects', `scope_items?scope_version_id=eq.${a.scope.id}&inclusion=eq.included&select=id`)).json ?? [];
  check(deliverables.length === 3 && scopeItems.every((s) => deliverables.some((d) => d.scope_item_id === s.id)),
    'every included scope item has a deliverable, tied to the approved item', `${deliverables.length}`);
  const deps = await children(draftA.id, 'plan_dependencies');
  check(deps.filter((d) => d.kind.startsWith('client_')).length === 2 && deps.filter((d) => d.kind.startsWith('client_')).every((d) => d.owner_role === 'project_manager'),
    'what the client owes (an asset, access) is owned by the project manager, though the model said otherwise');
  const miles = await children(draftA.id, 'plan_milestones');
  const gates = miles.filter((m) => m.kind === 'finance_gate');
  check(gates.length === 4 && a.milestones.every((m) => gates.some((g) => g.payment_milestone_id === m.id)),
    'a finance gate maps every payment milestone - from the payment plan, not the model', `${gates.length}`);
  check(['phase_3', 'phase_5'].every((p) => miles.some((m) => m.phase === p && m.kind !== 'finance_gate')),
    'every phase that carries work has a place in the sequence');
  const validation = one(await rpc('projects', 'validate_project_plan', { p_plan_id: draftA.id }));
  check(validation?.valid === true, 'the plan passes the validator as drafted', JSON.stringify(validation?.findings));

  const alerts = (await rest('GET', 'core', `alerts?fingerprint=eq.planning-drafted:${a.project.id}&select=id,summary`)).json ?? [];
  check(alerts.length === 1, 'staff are told there is a draft to review and approve', alerts[0]?.summary?.slice(0, 70));
  const runs = (await rest('GET', 'ai', `agent_runs?agent_key=eq.project_planning&subject_id=eq.${a.project.id}&select=status,work_class`)).json ?? [];
  check(runs.some((r) => r.status === 'succeeded' && r.work_class === 'internal_plan'), 'the run is recorded under the planning agent, as internal planning');

  // ── 2. replay, and the wrong milestone ────────────────────────────────────
  section('2. A replay makes no second plan, and a later milestone does not open planning');
  await rpc('core', 'emit_event', { p_organization_id: ORG, p_type: 'invoice.paid', p_subject_type: 'invoice', p_subject_id: (await rest('GET', 'finance', `invoices?project_id=eq.${a.project.id}&select=id`)).json[0].id, p_payload: {} });
  for (let i = 0; i < 8; i += 1) await tick();
  check((await plans(a.project.id)).length === 1, 'still exactly one plan after the event replays');

  const b = await plant('b');
  modes.set(b.name, 'good');
  await advanceVerified(b, 1);
  for (let i = 0; i < 10; i += 1) await tick();
  check((await plans(b.project.id)).length === 0, 'the second milestone\'s payment does not open planning');

  // ── 3. corrected once ─────────────────────────────────────────────────────
  section('3. A draft that misses scope or designs the product is sent back once');
  const c = await plant('c');
  modes.set(c.name, 'bad_then_good');
  await advanceVerified(c, 0);
  const draftC = await tickUntil(async () => (await plans(c.project.id))[0] ?? null);
  check(Boolean(draftC), 'the corrected draft is what gets written');
  check(corrections.some((t) => /no deliverable/.test(t) && /database design|not how the product is built/.test(t)),
    'the model was told exactly what was wrong: the missed items and the engineering');
  check((await children(draftC?.id, 'plan_deliverables')).length === 3, 'and the written plan covers every item');
  check(!/schema|table/i.test(draftC?.objective ?? ''), 'and no engineering reached the plan', String(draftC?.objective).slice(0, 60));

  // ── 4. cannot get it right ────────────────────────────────────────────────
  section('4. A model that cannot get it right writes nothing and tells staff');
  const d = await plant('d');
  modes.set(d.name, 'always_bad');
  await advanceVerified(d, 0);
  const told = await tickUntil(async () => (await rest('GET', 'core', `alerts?fingerprint=eq.planning-refused:${d.project.id}&select=id`)).json?.length === 1);
  check(Boolean(told), 'staff are told the planner could not produce a valid blueprint');
  check((await plans(d.project.id)).length === 0, 'and NO plan was written');

  // ── 5. a person's plan is not replaced; asking by hand ────────────────────
  section('5. A person\'s plan is never replaced, and staff can ask by hand');
  const e = await plant('e', { plan: true });
  modes.set(e.name, 'good');
  await advanceVerified(e, 0);
  for (let i = 0; i < 10; i += 1) await tick();
  const ePlans = await plans(e.project.id);
  check(ePlans.length === 1 && ePlans[0].objective === 'A person drafted this.', 'the person\'s plan stands untouched');

  const f = await plant('f');
  modes.set(f.name, 'good');
  const owner = mint(await ensureAdmin(), 'owner');
  const asService = await rpc('projects', 'request_project_planning', { p_project_id: f.project.id });
  check(asService.json === 'needs_person', 'an unattended caller cannot ask: it is a person\'s request', JSON.stringify(asService.json));
  const asOwner = await call(owner, 'POST', 'projects', 'rpc/request_project_planning', { p_project_id: f.project.id });
  check(asOwner.json === 'requested', 'an admin asks for planning', JSON.stringify(asOwner.json));
  const draftF = await tickUntil(async () => (await plans(f.project.id))[0] ?? null);
  check(Boolean(draftF), 'and the planner drafts it');
  const again = await call(owner, 'POST', 'projects', 'rpc/request_project_planning', { p_project_id: f.project.id });
  check(again.json === 'plan_exists', 'asking again once a plan exists is refused', JSON.stringify(again.json));
  const audit = (await rest('GET', 'audit', `audit_log?subject_id=eq.${f.project.id}&action=eq.project.planning_requested&select=id`)).json ?? [];
  check(audit.length === 1, 'and the request is audited');

  const door = await call(owner, 'POST', 'projects', 'rpc/agent_draft_blueprint', { p_project_id: f.project.id, p_blueprint: {} });
  check(!door.ok, 'a signed-in person cannot call the agent\'s own door', `status ${door.status}`);

  // ── 6. the planner's question reaches the client, one at a time ───────────
  section('6. The planner\'s question goes to the client through the PM, one at a time, and the answer is kept');
  const g = await plant('g', { thread: true });
  modes.set(g.name, 'asks');
  await advanceVerified(g, 0);
  const draftG = await tickUntil(async () => (await plans(g.project.id))[0] ?? null);
  check(Boolean(draftG), 'the planner drafts a plan with two open questions');
  const asked1 = await tickUntil(async () => textsTo(g.phone).some((t) => /Which stores/.test(t)));
  check(Boolean(asked1), 'the PM puts the FIRST question to the client');
  check(!textsTo(g.phone).some((t) => /delivery partner/.test(t)), 'and only that one - the second waits');
  const clarsG = async () => (await rest('GET', 'projects', `plan_clarifications?plan_id=eq.${draftG.id}&select=id,question,status,answer,asked_at,answered_via&order=created_at`)).json ?? [];
  check((await clarsG())[0]?.status === 'asked' && (await clarsG())[1]?.status === 'open', 'the register says asked / open');

  const reply = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: g.conv.id, seq: 5, author_type: 'client', body: 'Sirf Pune ke do stores, abhi',
    external_ref: `${g.name}:in1`, occurred_at: new Date().toISOString(),
  });
  check(reply.ok, 'the client answers');
  const answered = await tickUntil(async () => (await clarsG())[0]?.status === 'answered');
  check(Boolean(answered), 'the answer is kept against the question');
  const c1 = (await clarsG())[0];
  check(c1?.answer === 'Sirf Pune ke do stores, abhi' && c1?.answered_via === 'client_whatsapp', 'in the client\'s own words, with where it came from', String(c1?.answer));
  check((await rest('GET', 'core', `alerts?fingerprint=eq.planning-answer:${c1.id}&select=id`)).json?.length === 1, 'and staff are told to review it');
  check(!textsTo(g.phone).some((t) => /delivery partner/.test(t)), 'nothing more is asked until a person settles the first');

  const ownerTok = mint(await ensureAdmin(), 'owner');
  const resolved = await call(ownerTok, 'POST', 'projects', 'rpc/resolve_clarification', { p_clarification_id: c1.id });
  check(resolved.ok, 'a person resolves it', JSON.stringify(resolved.json).slice(0, 60));
  const asked2 = await tickUntil(async () => textsTo(g.phone).some((t) => /delivery partner/.test(t)));
  check(Boolean(asked2), 'and then the SECOND question goes');

  const beforeReplay = graphSends.length;
  await emit('project.clarification_required', 'project', g.project.id);
  for (let i = 0; i < 8; i += 1) await tick();
  check(graphSends.length === beforeReplay, 'a replayed event asks nothing twice', `${graphSends.length - beforeReplay} send(s)`);

  const h = await plant('h', { thread: true });
  modes.set(h.name, 'unsafe_question');
  await advanceVerified(h, 0);
  const draftH = await tickUntil(async () => (await plans(h.project.id))[0] ?? null);
  check(Boolean(draftH), 'a plan with a question that mentions money is drafted');
  const held = await tickUntil(async () => (await rest('GET', 'core', `alerts?summary=ilike.*held back*&select=id,summary`)).json?.some((a) => a.summary.includes(h.name)));
  check(Boolean(held), 'but the question is HELD for a person, not sent');
  check(textsTo(h.phone).length === 0, 'and the client received nothing');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  model.close();
  graph.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
