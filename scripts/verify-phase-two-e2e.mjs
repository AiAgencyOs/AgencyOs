#!/usr/bin/env node
/**
 * AgencyOS Phase 2, end to end — the Master Flow, from a WON deal to the
 * official kickoff and Phase 3, through the real doors, the real job runner and
 * a Graph stub that receives every message that leaves.
 *
 *   node scripts/verify-phase-two-e2e.mjs
 *
 *   PHASE 1 WON → PHASE 2 START → PM + CONTEXT → WORKSPACE → WELCOME + GST/NON-GST
 *   → CLIENT ANSWERS → ADMIN CONFIRMS GST → GST DETAILS → M1 30% INVOICE (+GST)
 *   → ISSUED → DELIVERED → GROUP CREATED / MAPPED / VERIFIED → PAYMENT CLAIM
 *   → CHECKED (not the money) → MONEY CONFIRMED → ADVANCE VERIFIED → PLANNING AGENT
 *   → BLUEPRINT → APPROVED + ACTIVATED → READY → KICKOFF → PHASE 2 COMPLETE → PHASE 3
 *
 * Every human gate is a person acting (the owner's token): the GST/Non-GST
 * confirmation, the WhatsApp group, the payment verification, the plan's
 * approval, the kickoff. Every automatic step is the system acting alone. The
 * negatives are checked at the moment they would matter: an early kickoff is
 * refused with the missing gates named; a checked claim is not the money; a
 * client's answer confirms nothing; nobody is messaged twice; nothing reaches
 * another client; nothing died.
 *
 * The model is a stub (the planner's structured answer) - what is proved is the
 * plumbing and the rules around every agent step, not a real model's quality.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'a won deal to an official kickoff');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-p2e2e-${randomUUID().slice(0, 8)}`;
const APP = target.appUrl ?? 'http://localhost:3000';
const GRAPH_PORT = 54398;
const MODEL_PORT = 54399;
const STARTED = new Date().toISOString();

const fx = fixturesFor(target, ORG);
const { rest, one } = fx;

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
const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);

const tick = () =>
  fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' })
    .then(async (r) => ({ status: r.status, json: parse(await r.text()) }));
async function ticks(n = 8) { for (let i = 0; i < n; i += 1) await tick(); }
async function until(predicate, budget = 40) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── stubs ───────────────────────────────────────────────────────────────────
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

const blueprint = (n) => ({
  objective: 'Launch the agreed pharmacy ordering product.',
  deliverables: Array.from({ length: n }, (_, i) => ({
    scopeItem: i + 1, name: `Deliverable ${i + 1}`, applicablePhase: i === 0 ? 'phase_3' : 'phase_5', ownerRole: i === 0 ? 'designer' : 'developer',
    readinessCriteria: `Item ${i + 1} meets the agreed acceptance.`, evidenceRequired: 'A demo the client has seen.', ambiguityNote: null,
  })),
  dependencies: [
    { kind: 'client_asset', description: 'Logo and brand colours', neededByPhase: 'phase_3', ownerRole: 'designer' },
    { kind: 'client_access', description: 'Store account access', neededByPhase: 'phase_6', ownerRole: 'developer' },
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
    const first = JSON.stringify(parsed.messages?.[0]?.content ?? '');
    const n = (first.match(/\\n\d+\. /g) ?? []).length;
    // Accepting the requirement (Phase 1) asks the PM for a delivery plan; everything else here is the planner's blueprint.
    const breakdown = /delivery plan/i.test(JSON.stringify(parsed.system ?? ''));
    const answer = breakdown
      ? { modules: [{ name: 'Ordering', features: [{ name: 'Place an order', tasks: [{ title: 'Order flow' }] }] }] }
      : blueprint(Math.max(n, 1));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 80, output_tokens: 60 },
    }));
  });
});
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(MODEL_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.P2E2E' } });

const phoneKey = (p) => p.replace('+', '');
const to = (phone) => graphSends.filter((g) => g.body?.to === phoneKey(phone) || g.body?.to === phone);
const textsTo = (phone) => to(phone).filter((g) => g.body?.type === 'text').map((g) => g.body?.text?.body ?? '');
const docsTo = (phone) => to(phone).filter((g) => g.body?.type === 'document');

console.log('\n\x1b[1mAgencyOS — Phase 2, end to end\x1b[0m');

let owner = null;
try {
  owner = await fx.bootstrapOwner(MARKER);
  await fx.installProposalPolicy(owner);
  const asOwner = (schema, fn, args) => fx.call(owner.token, 'POST', schema, `rpc/${fn}`, args);

  // ── 0. Phase 1 hands a won deal over ──────────────────────────────────────
  section('0. Phase 1 WON → structured handoff → Phase 2 starts, once');
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  const phone = `+9198${String(Date.now()).slice(-8)}1`;
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: account.id, full_name: `${MARKER} client`, phone }));
  await rest('POST', 'crm', 'communication_consent', { organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted' });
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} lead`, status: 'new' }));
  const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct', channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active' }));
  await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv.id, seq: 0, author_type: 'client', body: 'hello, I want a pharmacy app', external_ref: `${MARKER}:in0`, occurred_at: new Date().toISOString() });
  const opp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead.id, name: `${MARKER} deal`, stage: 'negotiation', owner_id: owner.id, client_account_id: account.id }));
  const quote = await fx.acceptedProposal(opp.id, owner, `${MARKER} quotation`, { contactId: contact.id });
  check(quote.trace?.accept?.outcome === 'recorded', 'the quotation is accepted through the governed path');
  const won = await rest('PATCH', 'sales', `opportunities?id=eq.${opp.id}`, { stage: 'won', closed_at: new Date().toISOString() });
  check(won.ok, 'the deal is won');
  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: account.id, opportunity_id: opp.id, name: `${MARKER} project`, budget_minor: 10_000_000, currency: 'INR', proposal_id: quote.id,
  }));
  // The approved scope the planner will read (items go in while the version is a draft; freezing approves it).
  const scope = one(await rest('POST', 'projects', 'scope_versions', { organization_id: ORG, project_id: project.id, version: 1, status: 'draft' }));
  for (let i = 1; i <= 3; i += 1) {
    await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: scope.id, title: `Scope item ${i}`, detail: `What item ${i} does`, inclusion: 'included', position: i });
  }
  await rest('PATCH', 'projects', `scope_versions?id=eq.${scope.id}`, { status: 'active', frozen_at: new Date().toISOString() });

  // Phase 1's accepted requirement (the kickoff gate reads it, G-026).
  const requirement = one(await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: conv.id, version: 1, source: 'agent', status: 'proposed',
    payload: { summary: 'A pharmacy ordering app.', scopeItems: [{ title: 'Order medicines', detail: 'Search and order' }], constraints: [], openQuestions: [] },
  }));
  await rest('PATCH', 'crm', `requirement_versions?id=eq.${requirement.id}`, { status: 'accepted' });

  const bound = one(await rpc('sales', 'record_won_handoff', { p_opportunity_id: opp.id, p_project_id: project.id }));
  check(bound?.outcome === 'project_bound', 'the handoff packet binds the project', String(bound?.outcome));

  const phase = await until(async () => one(await rest('GET', 'projects', `phase_two?project_id=eq.${project.id}&select=id,state,pm_agent_key`)));
  check(Boolean(phase?.id) && phase?.pm_agent_key === 'project_manager', 'Phase 2 started from the event, with the project manager assigned', String(phase?.state));
  const milestones = (await rest('GET', 'projects', `milestones?project_id=eq.${project.id}&select=position,payment_percent,amount_minor&order=position`)).json ?? [];
  check(milestones.map((m) => Number(m.payment_percent)).join() === '30,20,30,20', 'the locked 30/20/30/20 payment plan is installed', milestones.map((m) => m.payment_percent).join('/'));
  check(milestones.reduce((s, m) => s + Number(m.amount_minor), 0) === 10_000_000 && Number(milestones[0]?.amount_minor) === 3_000_000, 'the four amounts sum exactly to the budget, M1 = 30%', milestones.map((m) => m.amount_minor).join('+'));
  const setup = await until(async () => one(await rest('GET', 'projects', `group_setups?project_id=eq.${project.id}&select=id,state`)));
  check(setup?.state === 'pending', 'the WhatsApp group manual-action task is raised for an Admin', String(setup?.state));

  // ── 1. the PM speaks, the client answers ──────────────────────────────────
  section('1. The PM welcomes the client and asks GST or Non-GST; the client answers; a person confirms');
  const welcomed = await until(async () => textsTo(phone).length >= 2);
  check(Boolean(welcomed) && /project manager/i.test(textsTo(phone)[0] ?? ''), 'the client is welcomed by the project manager');
  check(textsTo(phone).some((t) => /GST invoice or a Non-GST invoice/.test(t)), 'and asked the question in the specification\'s own words');
  const stateOf = async () => one(await rest('GET', 'projects', `phase_two?project_id=eq.${project.id}&select=state`))?.state;
  check(Boolean(await until(async () => (await stateOf()) === 'waiting_client', 12)), 'the phase reads WAITING CLIENT', String(await stateOf()));

  await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv.id, seq: 9, author_type: 'client', body: 'GST invoice chahiye', external_ref: `${MARKER}:in1`, occurred_at: new Date().toISOString() });
  const alerted = await until(async () => ((await rest('GET', 'core', `alerts?fingerprint=eq.billing-answer:${project.id}&select=id`)).json ?? []).length === 1);
  check(Boolean(alerted), 'the client\'s clear answer alerts staff to confirm it');
  check(((await rest('GET', 'finance', `billing_profiles?project_id=eq.${project.id}&select=id`)).json ?? []).length === 0, 'and confirms NOTHING by itself - billing mode is a person\'s act');

  const confirmed = one(await asOwner('finance', 'confirm_billing_mode', { p_project_id: project.id, p_mode: 'gst', p_source: 'client_confirmation' }));
  check(confirmed?.outcome === 'confirmed', 'the owner confirms GST', String(confirmed?.outcome));
  const gstAsked = await until(async () => textsTo(phone).some((t) => /GSTIN/.test(t)));
  check(Boolean(gstAsked), 'the client is asked for the GST details');
  await ticks(4);
  const deadJobs = (await rest('GET', 'core', `jobs?status=eq.dead&created_at=gte.${STARTED}&select=kind,last_error`)).json ?? [];
  check(deadJobs.length === 0, 'and the advance-invoice job WAITS for the details instead of dying', deadJobs.map((j) => j.kind).join());
  check(((await rest('GET', 'finance', `invoices?project_id=eq.${project.id}&select=id`)).json ?? []).length === 0, 'no invoice yet: an invoice with no valid billing details is not issued');

  // ── 2. the advance invoice ────────────────────────────────────────────────
  section('2. GST details complete → the 30% invoice is raised with GST, issued by a person, and delivered');
  const details = one(await asOwner('finance', 'record_billing_details', {
    p_project_id: project.id, p_legal_name: 'Pharma Care Pvt Ltd', p_billing_address: '12 MG Road, Pune', p_billing_state: 'Maharashtra', p_gstin: '27AAPFU0939F1ZV',
  }));
  check(details?.outcome === 'recorded', 'the owner records the client\'s GST details', String(details?.outcome));
  const invoice = await until(async () => one(await rest('GET', 'finance', `invoices?project_id=eq.${project.id}&select=id,number,status,subtotal_minor,tax_minor,total_minor,billing_profile_id`)));
  check(Boolean(invoice?.id), 'the M1 invoice appears with no one opening a page', String(invoice?.status));
  check(Number(invoice?.subtotal_minor) === 3_000_000 && Number(invoice?.tax_minor) === 540_000 && Number(invoice?.total_minor) === 3_540_000,
    'M1 is 30% of the budget with 18% GST, computed by code', `${invoice?.subtotal_minor} + ${invoice?.tax_minor} = ${invoice?.total_minor}`);
  check(Boolean(invoice?.billing_profile_id), 'and it carries the frozen billing profile version it was raised under');
  const sendsBefore = textsTo(phone).length;
  const issued = one(await asOwner('finance', 'issue_invoice', { p_invoice_id: invoice.id }));
  check(issued?.outcome === 'issued', 'a person issues it (the human act)', String(issued?.outcome));
  const delivery = await until(async () => {
    const rows = (await rest('GET', 'finance', `invoice_deliveries?invoice_id=eq.${invoice.id}&select=channel,status,last_error`)).json ?? [];
    return rows.find((r) => r.channel === 'whatsapp')?.status === 'sent' && rows.some((r) => r.channel === 'email') ? rows : null;
  });
  check(Boolean(delivery), 'it is delivered to the client without a button');
  check(textsTo(phone).length === sendsBefore + 1 && docsTo(phone).length === 1, 'one text and one PDF reached the client', `${textsTo(phone).length - sendsBefore} text(s), ${docsTo(phone).length} PDF(s)`);
  check(delivery?.find((r) => r.channel === 'email')?.status === 'skipped', 'email says plainly it was not configured, rather than pretending', String(delivery?.find((r) => r.channel === 'email')?.last_error).slice(0, 50));

  // ── 3. the manual group action ────────────────────────────────────────────
  section('3. The WhatsApp group is a manual action: created, mapped, verified by a person');
  const early = one(await asOwner('projects', 'record_kickoff', { p_project_id: project.id, p_evidence_ref: 'too-early' }));
  check(early?.outcome === 'not_ready', 'an EARLY kickoff is refused', String(early?.outcome));
  check(['whatsapp_group_not_mapped', 'advance_not_verified', 'no_active_plan'].every((g) => (early?.unmet ?? []).includes(g)), 'and it names every missing gate', (early?.unmet ?? []).join());
  check(Boolean(await until(async () => (await stateOf()) === 'waiting_admin', 12)), 'the phase reads WAITING ADMIN (the group)', String(await stateOf()));

  const created = one(await asOwner('projects', 'confirm_group_created', { p_setup_id: setup.id }));
  check(created?.outcome === 'confirmed', 'the Admin confirms the group was created in WhatsApp', String(created?.outcome));
  const linked = one(await rpc('crm', 'link_whatsapp_group', { p_organization_id: ORG, p_kind: 'project_group', p_external_ref: `${MARKER}-grp@g.us`, p_project_id: project.id }));
  const groupConvId = linked?.conversation_id ?? linked?.id;
  const mapped = one(await asOwner('projects', 'map_group', { p_setup_id: setup.id, p_conversation_id: groupConvId }));
  check(mapped?.outcome === 'mapped', 'maps it to AgencyOS', String(mapped?.outcome));
  const verifiedGroup = one(await asOwner('projects', 'verify_group', { p_setup_id: setup.id }));
  check(verifiedGroup?.outcome === 'verified', 'and verifies the mapping', String(verifiedGroup?.outcome));
  check(Boolean(await until(async () => (await stateOf()) === 'waiting_finance', 12)), 'the phase now reads WAITING FINANCE (the advance)', String(await stateOf()));

  // ── 4. payment: a claim is not the money ──────────────────────────────────
  section('4. Payment proof is PENDING_VERIFICATION; only a person confirming the money opens the gate');
  const claim = one(await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 3_540_000, method: 'upi', reference: `${MARKER}-utr`, payer_name: 'Pharma Care', submitted_by_agent: 'sales',
  }));
  check(claim?.status === 'pending_verification', 'the proof is captured as PENDING_VERIFICATION, never verified by arriving', String(claim?.status));
  check(Boolean(await until(async () => (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&author_type=eq.user&select=body`)).json?.some((m) => /received your payment details/.test(m.body)))), 'the client is told it was received, in the project group');
  check(((await rest('GET', 'finance', `invoices?id=eq.${invoice.id}&select=status`)).json?.[0]?.status) === 'issued', 'and the invoice is still unpaid');

  // a client cannot verify: a non-admin token is refused by the database
  const stranger = await fx.bootstrapOwner(`${MARKER}-s`);
  const strangerToken = fx.mint(stranger.id, 'viewer');
  const refused = one(await fx.call(strangerToken, 'POST', 'finance', 'rpc/verify_payment_submission', { p_submission_id: claim.id, p_verified_by: stranger.id, p_evidence: 'I say so', p_approve: true }));
  check(refused?.outcome !== 'verified' && ((await rest('GET', 'finance', `payment_submissions?id=eq.${claim.id}&select=status`)).json?.[0]?.status) === 'pending_verification', 'a person with no admin role cannot verify it', JSON.stringify(refused).slice(0, 60));

  const checkedClaim = one(await asOwner('finance', 'verify_payment_submission', { p_submission_id: claim.id, p_verified_by: owner.id, p_evidence: 'bank statement line 12', p_approve: true }));
  check(checkedClaim?.outcome === 'verified', 'the Admin checks the claim against the bank statement', String(checkedClaim?.outcome));
  await ticks(6);
  check(!(await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&author_type=eq.user&select=body`)).json?.some((m) => /advance payment has been verified/.test(m.body)), 'a CHECKED claim is not announced as the verified advance');
  check(((await rest('GET', 'projects', `project_plans?project_id=eq.${project.id}&select=id`)).json ?? []).length === 0, 'and planning has not started - the gate is still closed');

  const money = one(await asOwner('finance', 'record_manual_payment', { p_invoice_id: invoice.id, p_provider_payment_id: `${MARKER}-money`, p_amount_minor: 3_540_000, p_captured_at: new Date().toISOString(), p_method: 'upi' }));
  const verifiedMoney = one(await asOwner('finance', 'verify_payment', { p_payment_id: money?.payment_id, p_verified_by: owner.id }));
  check(verifiedMoney?.outcome === 'verified', 'the Admin records and CONFIRMS the money', String(verifiedMoney?.outcome));
  check(((await rest('GET', 'finance', `invoices?id=eq.${invoice.id}&select=status`)).json?.[0]?.status) === 'paid', 'M1 is PAID', 'the finance gate is open');
  check(Boolean(await until(async () => (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&author_type=eq.user&select=body`)).json?.some((m) => /advance payment has been verified/.test(m.body)))), 'only now is the client told the advance is verified');

  // ── 5. planning ───────────────────────────────────────────────────────────
  section('5. The Project Planning Agent drafts the blueprint; a person approves and activates it');
  const plan = await until(async () => one(await rest('GET', 'projects', `project_plans?project_id=eq.${project.id}&select=id,status,created_by,approved_at`)));
  check(plan?.status === 'draft' && plan?.created_by === null, 'a DRAFT blueprint appears, drafted by the planner and no person', String(plan?.status));
  const deliverables = (await rest('GET', 'projects', `plan_deliverables?plan_id=eq.${plan.id}&select=scope_item_id`)).json ?? [];
  const gates = (await rest('GET', 'projects', `plan_milestones?plan_id=eq.${plan.id}&kind=eq.finance_gate&select=payment_milestone_id`)).json ?? [];
  check(deliverables.length === 3 && gates.length === 4, 'it covers every approved scope item and maps every payment milestone', `${deliverables.length} deliverables, ${gates.length} gates`);
  check(Boolean(await until(async () => (await stateOf()) === 'waiting_planning', 12)), 'the phase reads WAITING PLANNING', String(await stateOf()));
  const earlyAgain = one(await asOwner('projects', 'record_kickoff', { p_project_id: project.id, p_evidence_ref: 'still-too-early' }));
  check(earlyAgain?.outcome === 'not_ready' && (earlyAgain?.unmet ?? []).join() === 'no_active_plan', 'a kickoff before the plan is active is refused, naming exactly that', (earlyAgain?.unmet ?? []).join());

  const approved = one(await asOwner('projects', 'approve_project_plan', { p_plan_id: plan.id, p_note: 'reviewed' }));
  const activated = one(await asOwner('projects', 'activate_project_plan', { p_plan_id: plan.id }));
  check(approved?.outcome === 'approved' && activated?.outcome === 'activated', 'the owner approves and activates the plan', `${approved?.outcome} / ${activated?.outcome}`);
  check(Boolean(await until(async () => (await stateOf()) === 'kickoff_ready', 12)), 'the phase reads KICKOFF READY', String(await stateOf()));

  // ── 6. kickoff and Phase 3 ────────────────────────────────────────────────
  section('6. The official kickoff completes Phase 2 and hands Phase 3 its work, once');
  const kicked = one(await asOwner('projects', 'record_kickoff', { p_project_id: project.id, p_evidence_ref: `pm:kickoff:${MARKER}` }));
  check(kicked?.outcome === 'kicked_off', 'the kickoff is recorded', String(kicked?.outcome));
  const done = one(await rest('GET', 'projects', `phase_two?project_id=eq.${project.id}&select=state,kickoff_at,completed_at`));
  check(done?.state === 'completed' && Boolean(done?.kickoff_at) && Boolean(done?.completed_at), 'Phase 2 is COMPLETED with the kickoff time on record');
  check(['active'].includes((await rest('GET', 'projects', `projects?id=eq.${project.id}&select=status`)).json?.[0]?.status), 'the project is ACTIVE');
  const events = (await rest('GET', 'core', `outbox_events?subject_id=eq.${project.id}&type=in.(project.phase_two_completed,project.phase_three_ready)&select=type`)).json ?? [];
  check(['project.phase_two_completed', 'project.phase_three_ready'].every((t) => events.some((e) => e.type === t)), 'Phase2Completed and Phase3Ready are both emitted');
  const phaseThree = await until(async () => one(await rest('GET', 'projects', `phase_three?project_id=eq.${project.id}&select=id`)), 20);
  check(Boolean(phaseThree?.id), 'Phase 3 starts from the handoff, ready for its work');
  const again = one(await asOwner('projects', 'record_kickoff', { p_project_id: project.id, p_evidence_ref: 'second' }));
  check(again?.outcome === 'already_done', 'a duplicate kickoff is refused', String(again?.outcome));

  // ── 7. the whole run ──────────────────────────────────────────────────────
  section('7. Across the whole run: nothing twice, nothing lost, nothing crossed, everything on record');
  const clientThread = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&author_type=eq.user&select=external_ref`)).json ?? [];
  const groupThread = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&author_type=eq.user&select=external_ref`)).json ?? [];
  const refs = [...clientThread, ...groupThread].map((m) => m.external_ref).filter(Boolean);
  check(new Set(refs).size === refs.length, 'no message was recorded twice', `${refs.length} messages, ${new Set(refs).size} distinct`);
  const deadAtEnd = (await rest('GET', 'core', `jobs?status=eq.dead&created_at=gte.${STARTED}&select=kind,last_error`)).json ?? [];
  check(deadAtEnd.length === 0, 'no job died', deadAtEnd.map((j) => `${j.kind}: ${String(j.last_error).slice(0, 50)}`).join('; '));
  const audits = (await rest('GET', 'audit', `audit_log?subject_id=eq.${project.id}&select=action`)).json ?? [];
  const have = new Set(audits.map((a) => a.action));
  const want = ['project.billing_mode_confirmed', 'project.billing_details_recorded', 'project.plan_drafted_by_agent', 'project.phase_two_state_changed'];
  check(want.every((a) => have.has(a)), 'the project\'s audit trail names each gate and each agent act', want.filter((a) => !have.has(a)).join());
  check(((await rest('GET', 'audit', `audit_log?subject_id=eq.${invoice.id}&action=in.(invoice.issued,invoice.delivery_sent)&select=action`)).json ?? []).length >= 2, 'and the invoice\'s issue and delivery');
  const intruder = textsTo('+910000000000').concat(graphSends.filter((g) => !JSON.stringify(g.body).includes(phoneKey(phone)) && !JSON.stringify(g.body).includes(`${MARKER}-grp`)).map(() => 'x'));
  check(intruder.length === 0, 'every message went to this client\'s thread or this project\'s group and to nobody else', `${intruder.length}`);
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  graph.close();
  model.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  // The proposal policy and the owners this run created: a later verifier inserts the same policy and would collide.
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
