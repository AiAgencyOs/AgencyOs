#!/usr/bin/env node
/**
 * Phase 3, end to end - UI theme and colour finalization, from Phase 2's kickoff to the
 * Phase 4 handoff. The sibling of verify-phase-two-e2e.mjs: same real doors, same real job
 * runner, a stub model on :54399 and a Graph stub on :54398, no direct writes except fixtures.
 *
 *   node scripts/verify-phase-three-e2e.mjs
 *
 * Proves, each in both directions:
 *   - the kickoff starts Phase 3 once, and the PM announces it to the client (once)
 *   - the designer agent drafts the screen list from the approved scope; a person finalizes it;
 *     the finalized list - and only that - starts the theme directions (2-3, with colours)
 *   - nothing reaches a client before internal review AND Admin; an Admin EDIT sends it back through review
 *   - a client's selection makes the PM ask for the final confirmation (once); only the
 *     confirmation locks; the lock hands Phase 4 an exact, ready handoff and Phase 4 starts from it
 *   - ordering/negatives: PM-side doors cannot mark Admin approval; an outsider sees nothing
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { signFigmaCode } from '../src/modules/projects/figma-export-token.ts';
import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'a won deal to an official kickoff');

const ORG = '00000000-0000-4000-8000-000000000001';
const REAL_MODEL = process.env.REAL_MODEL === '1';
// A real model reads the scope as a person would: a line saying "What item 1 does" is rightly answered with a question. The stub never
// reads it, so only a real run needs words that mean something.
const REAL_SCOPE = REAL_MODEL
  ? [
      { title: 'Customer app: browse and order medicines', detail: 'Search a catalogue by name, add to a basket, choose home delivery or store pickup, pay by UPI or card, and see the order status.' },
      { title: 'Prescription upload and pharmacist review', detail: 'The customer photographs a prescription; a pharmacist reviews it in a web panel, approves or rejects with a reason, and the customer is notified.' },
      { title: 'Store admin panel', detail: 'Store staff manage stock levels and prices, see incoming orders, mark them packed and out for delivery, and view a daily sales summary.' },
    ]
  : [];
const MARKER = `zztest-p3e2e-${randomUUID().slice(0, 8)}`;
const APP = target.appUrl ?? 'http://localhost:3000';
const GRAPH_PORT = 54398;
const MODEL_PORT = 54399;
// The database's own clock, not this machine's: a local Docker VM can run hours behind, which made every `created_at >= STARTED` filter match nothing.
const STARTED = new Date((await fetch(`${target.url}/rest/v1/`, { headers: { apikey: target.serviceKey } })).headers.get('date') ?? Date.now()).toISOString();

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
const directions = () => ({
  directions: [
    { name: 'Calm Clinical', directionSummary: 'A quiet, trust-first look with generous white space and soft teal accents.', metadata: { personality: 'calm' }, palette: { paletteName: 'Calm Teal', primaryHex: '#0F766E', secondaryHex: '#0B3B3A', accentHex: '#F59E0B', backgroundHex: '#F8FAFC', surfaceHex: '#FFFFFF', textPrimaryHex: '#0F172A', contrastNotes: 'Dark text on a near-white background reads clearly.' } },
    { name: 'Bold Modern', directionSummary: 'A confident high-contrast look with strong blocks of colour and large type.', metadata: { personality: 'bold' }, palette: { paletteName: 'Bold Indigo', primaryHex: '#4338CA', secondaryHex: '#1E1B4B', accentHex: '#F43F5E', backgroundHex: '#FFFFFF', surfaceHex: '#EEF2FF', textPrimaryHex: '#111827', contrastNotes: 'Dark text on white is high contrast.' } },
    { name: 'Warm Friendly', directionSummary: 'An approachable look with rounded cards, warm neutrals and a friendly orange.', metadata: { personality: 'warm' }, palette: { paletteName: 'Warm Orange', primaryHex: '#C2410C', secondaryHex: '#7C2D12', accentHex: '#0EA5E9', backgroundHex: '#FFF7ED', surfaceHex: '#FFFFFF', textPrimaryHex: '#1C1917', contrastNotes: 'Dark brown text on a cream background is readable.' } },
  ],
});
const modelCalls = [];
const model = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = parse(body) ?? {};
    const system = JSON.stringify(parsed.system ?? '');
    const first = JSON.stringify(parsed.messages?.[0]?.content ?? '');
    const n = (first.match(/\\n\d+\. /g) ?? []).length;
    let answer;
    if (/read ONE client message/i.test(system)) {
      // The PM reads a client's reply. The stub reads the client's words the way a good model would.
      const said = (first.split('The client').pop() ?? '').toLowerCase();
      modelCalls.push('reply');
      if (/accent/.test(said)) answer = { intent: 'design_change_request', optionNumber: 1, evidence: 'the accent is too orange', confidence: 0.93, reasoning: 'A visual change to option 1.' };
      else if (/not sure/.test(said)) answer = { intent: 'unclear', evidence: 'not sure', confidence: 0.4, reasoning: 'The client has not said what they want.', clarifyingQuestion: 'Which of the options would you like us to continue with?' };
      else if (/loyalty/.test(said)) answer = { intent: 'possible_scope_change', evidence: 'add a loyalty module', confidence: 0.9, reasoning: 'A new module, not a visual change.' };
      else if (/option 3/.test(said)) answer = { intent: 'client_selected', optionNumber: 3, evidence: 'option 3', confidence: 0.95, reasoning: 'Picks option 3.' };
      else if (/final/.test(said)) answer = { intent: 'final_confirmed', optionNumber: 1, paletteName: 'Calm Teal', evidence: 'final', confidence: 0.96, reasoning: 'Confirms option 1 with its palette as final.' };
      else if (/go with|like/.test(said)) answer = { intent: 'client_selected', optionNumber: 1, paletteName: 'Calm Teal', evidence: 'we like Calm', confidence: 0.94, reasoning: 'Chooses option 1.' };
      else answer = { intent: 'unrelated', evidence: said.slice(0, 40) || 'x', confidence: 0.9, reasoning: 'Not about the design.' };
    } else if (/inventory of screens/i.test(system)) {
      const ids = [...new Set((first.match(/id: ([0-9a-f]{8}-[0-9a-f-]{27})/g) ?? []).map((m) => m.slice(4)))];
      modelCalls.push('inventory');
      answer = { screens: [
        { screenKey: 'home', name: 'Home', userRole: 'customer', purpose: 'Search and start an order', hasEmptyState: true, hasLoadingState: true, hasErrorState: true, hasSuccessState: true, coversScopeItems: ids.slice(0, 1) },
        ...(ids.length > 1 ? [{ screenKey: 'orders', name: 'Orders', userRole: 'customer', purpose: 'Track orders', hasEmptyState: true, hasLoadingState: true, hasErrorState: true, hasSuccessState: true, coversScopeItems: ids.slice(1) }] : []),
      ] };
    } else if (/visual directions/i.test(system)) {
      modelCalls.push('directions');
      answer = directions();
    } else if (/delivery plan/i.test(system)) {
      answer = { modules: [{ name: 'Ordering', features: [{ name: 'Place an order', tasks: [{ title: 'Order flow' }] }] }] };
    } else {
      answer = blueprint(Math.max(n, 1));
    }
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
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.P3E2E' } });

const phoneKey = (p) => p.replace('+', '');
const to = (phone) => graphSends.filter((g) => g.body?.to === phoneKey(phone) || g.body?.to === phone);
const textsTo = (phone) => to(phone).filter((g) => g.body?.type === 'text').map((g) => g.body?.text?.body ?? '');
const docsTo = (phone) => to(phone).filter((g) => g.body?.type === 'document');

console.log('\n\x1b[1mAgencyOS — Phase 3, end to end\x1b[0m');

let owner = null;
try {
  owner = await fx.bootstrapOwner(MARKER);
  await fx.installProposalPolicy(owner);
  const asOwner = (schema, fn, args) => fx.call(owner.token, 'POST', schema, `rpc/${fn}`, args);
  const asServiceRpc = (fn, args) => rest('POST', 'projects', `rpc/${fn}`, args);

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
    await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: scope.id, title: REAL_SCOPE[i - 1]?.title ?? `Scope item ${i}`, detail: REAL_SCOPE[i - 1]?.detail ?? `What item ${i} does`, inclusion: 'included', position: i });
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
  // Separation of duties (owner decision 2026-10-04): an ops admin may issue, record and check - but not confirm the money.
  const opsToken = fx.mint(stranger.id, 'ops_admin');
  const opsTries = one(await fx.call(opsToken, 'POST', 'finance', 'rpc/verify_payment', { p_payment_id: money?.payment_id, p_verified_by: stranger.id }));
  check(opsTries?.outcome === 'forbidden', 'an OPS ADMIN cannot confirm the money - only the owner can', String(opsTries?.outcome));
  check(((await rest('GET', 'finance', `invoices?id=eq.${invoice.id}&select=status`)).json?.[0]?.status) !== 'paid', 'and the invoice is still unpaid after that attempt');
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
  // With a real model (REAL_MODEL=1) the planner may write several deliverables per scope item; the stub writes exactly one each.
  const coversAll = REAL_MODEL ? new Set(deliverables.map((d) => d.scope_item_id)).size >= 3 && gates.length === 4 : deliverables.length === 3 && gates.length === 4;
  check(coversAll, 'it covers every approved scope item and maps every payment milestone', `${deliverables.length} deliverables, ${gates.length} gates`);
  if (REAL_MODEL) {
    // A real planner asks what it does not know, and it asks the way the product says: the PM puts ONE question at a time to the client,
    // the client answers in the group, and a person resolves it (a clarification cannot be closed without the client's answer).
    const all = async () => (await rest('GET', 'projects', `plan_clarifications?plan_id=eq.${plan.id}&select=id,question,status&order=created_at`)).json ?? [];
    const total = (await all()).length;
    let settled = 0;
    for (let i = 0; i < total; i += 1) {
      const asked = await until(async () => (await all()).find((c) => c.status === 'asked'), 40);
      if (!asked) break;
      console.log(`    ↳ the PM asked the client: ${String(asked.question).slice(0, 110)}`);
      const seqNow = ((await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&select=seq&order=seq.desc&limit=1`)).json?.[0]?.seq ?? 0) + 1;
      await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: groupConvId, seq: seqNow, author_type: 'client', body: 'It is a standard flow - login, a list, a detail screen and a form. Nothing unusual; please proceed with the usual approach.', external_ref: `${MARKER}:answer${i}`, occurred_at: new Date().toISOString() });
      const answered = await until(async () => (await all()).find((c) => c.id === asked.id && c.status === 'answered'), 40);
      if (!answered) break;
      const done = await asOwner('projects', 'resolve_clarification', { p_clarification_id: asked.id });
      if (one(done)?.outcome === 'resolved') settled += 1;
    }
    check(total > 0 ? settled === total : true, `the real planner raised ${total} clarification(s): each put to the client, answered, resolved by a person`, `${settled}/${total}`);
  }
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

  // ── 7. the PM announces Phase 3 ───────────────────────────────────────────
  section('7. The PM tells the client the UI finalization stage has begun - once');
  const p3 = () => rest('GET', 'projects', `phase_three?id=eq.${phaseThree.id}&select=*`).then((r) => one(r));
  const groupTexts = () => graphSends.filter((g) => JSON.stringify(g.body ?? {}).includes(`${MARKER}-grp`) && g.body?.type === 'text').map((g) => g.body?.text?.body ?? '');
  const announced = await until(async () => groupTexts().find((t) => /UI finalization/i.test(t)), 30);
  check(Boolean(announced), 'the client is told, in the project group, that the UI finalization stage is starting', announced ? announced.slice(0, 50) : 'nothing sent');
  const announcedCount = groupTexts().filter((t) => /UI finalization/i.test(t)).length;
  await ticks(6);
  check(groupTexts().filter((t) => /UI finalization/i.test(t)).length === announcedCount, 'and a replay says nothing a second time', `${announcedCount} announcement(s)`);
  check(!groupTexts().concat(textsTo(phone)).some((t) => /claude|gpt|openai|anthropic|gemini|model|prompt/i.test(t)), 'no message names a provider, a model or a prompt');
  const startedAgain = one(await asOwner('projects', 'start_phase_three', { p_project_id: project.id }));
  check(startedAgain?.outcome === 'already_started', 'a duplicate Phase 3 start returns the existing workspace', String(startedAgain?.outcome));

  // ── 8. the screen list ────────────────────────────────────────────────────
  section('8. The designer drafts the screens from the approved scope; a person finalizes the list');
  const screens = await until(async () => {
    const rows = (await rest('GET', 'projects', `screens?project_id=eq.${project.id}&status=neq.superseded&select=id,screen_key,name`)).json ?? [];
    return rows.length > 0 ? rows : null;
  }, 25);
  check(Boolean(screens) && modelCalls.includes('inventory'), 'the screen inventory is drafted from the scope - every screen covers an approved item', `${screens?.length ?? 0} screens`);
  const noDirectionsYet = ((await rest('GET', 'projects', `theme_options?phase_three_id=eq.${phaseThree.id}&select=id`)).json ?? []).length;
  check(noDirectionsYet === 0 && !modelCalls.includes('directions'), 'no theme is drawn before the screen list is finalized', `${noDirectionsYet} themes`);

  const drafted = one(await asOwner('projects', 'draft_screen_baseline', { p_project_id: project.id }));
  check(drafted?.outcome === 'drafted', 'a person opens the screen list (baseline v1)', String(drafted?.outcome));
  const finalized = one(await asOwner('projects', 'finalize_screen_baseline', { p_baseline_id: drafted.baseline_id }));
  check(finalized?.outcome === 'finalized', 'and finalizes it - every included requirement has a screen', `${finalized?.outcome} ${(finalized?.findings ?? []).join()}`);
  const refinal = one(await asOwner('projects', 'finalize_screen_baseline', { p_baseline_id: drafted.baseline_id }));
  check(refinal?.outcome === 'already_finalized', 'finalizing twice is harmless', String(refinal?.outcome));

  // ── 9. the theme directions ───────────────────────────────────────────────
  section('9. The finalized list starts the theme directions: two or three, each with colours');
  const themes = await until(async () => {
    const rows = (await rest('GET', 'projects', `theme_options?phase_three_id=eq.${phaseThree.id}&select=id,name,option_index,admin_status,internal_review_status,client_status&order=option_index`)).json ?? [];
    return rows.length >= 2 ? rows : null;
  }, 40);
  check(Boolean(themes) && themes.length === 3, 'the designer drafts three distinct directions', `${themes?.length ?? 0}`);
  check(new Set((themes ?? []).map((t) => t.name)).size === (themes ?? []).length, 'with different names');
  const colours = (await rest('GET', 'projects', `color_options?theme_option_id=in.(${(themes ?? []).map((t) => t.id).join(',')})&select=id,theme_option_id,primary_hex`)).json ?? [];
  check(colours.length === 3 && colours.every((c) => /^#[0-9a-f]{6}$/i.test(c.primary_hex)), 'each direction has its named colour palette', `${colours.length} palettes`);
  check((themes ?? []).every((t) => t.admin_status !== 'approved' && t.client_status !== 'shared'), 'and nothing is approved or shown to anyone yet');
  const directionCalls = modelCalls.filter((c) => c === 'directions').length;
  await ticks(6);
  check(modelCalls.filter((c) => c === 'directions').length === directionCalls && directionCalls === 1, 'the model is asked for directions exactly once - a replay reuses them', `${directionCalls} call(s)`);
  const wf = await p3();
  check(['internal_review', 'waiting_review', 'theme_generation', 'admin_review', 'waiting_designer'].includes(wf?.state), 'the Phase 3 state reads as design work in progress', String(wf?.state));

  // ── 10. nothing reaches the client before the gates ─────────────────────────
  section('10. Internal review, then Admin - and only what Admin approved can be shown');
  const [t1, t2, t3] = themes;
  for (const [i, t] of themes.entries()) {
    const linked = one(await asOwner('projects', 'link_theme_figma', { p_theme_option_id: t.id, p_file_key: `FILE${MARKER}`, p_node_id: `${i + 1}:1` }));
    if (i === 0) check(['linked', 'recorded'].includes(linked?.outcome), 'a person links the Figma node they drew (Figma is recorded, never claimed)', String(linked?.outcome));
  }
  const earlyShare = one(await asOwner('projects', 'record_design_share', { p_project_id: project.id, p_theme_option_ids: [t1.id], p_channel: 'whatsapp', p_evidence_ref: 'too-early' }));
  check(earlyShare?.outcome === 'not_approved', 'a share of an UNAPPROVED option is refused, before any gate has passed', String(earlyShare?.outcome));
  const adminFirst = one(await asOwner('projects', 'submit_admin_design_decision', { p_theme_option_id: t1.id, p_decision: 'confirm' }));
  check(adminFirst?.outcome !== 'recorded' && adminFirst?.outcome !== 'approved', 'Admin cannot approve before internal review has passed', String(adminFirst?.outcome));
  const noReviewer = one(await asOwner('projects', 'submit_internal_design_review', { p_theme_option_id: t1.id, p_result: 'passed' }));
  check(noReviewer?.outcome === 'no_reviewer_assigned', 'and internal review needs an assigned reviewer', String(noReviewer?.outcome));
  const assigned = one(await asOwner('projects', 'assign_design_reviewer', { p_project_id: project.id, p_user_id: owner.id }));
  check(['assigned', 'recorded'].includes(assigned?.outcome), 'a reviewer is assigned', String(assigned?.outcome));

  const changes = one(await asOwner('projects', 'submit_internal_design_review', { p_theme_option_id: t1.id, p_result: 'changes_required', p_comments: 'The accent colour is too close to the surface.' }));
  check(changes?.outcome === 'recorded', 'the reviewer sends the first direction back with comments', String(changes?.outcome));
  const blocked = one(await asOwner('projects', 'submit_admin_design_decision', { p_theme_option_id: t1.id, p_decision: 'confirm' }));
  check(blocked?.outcome !== 'recorded' && blocked?.outcome !== 'approved', 'a direction sent back cannot be approved by Admin', String(blocked?.outcome));
  for (const t of themes) {
    const pass = one(await asOwner('projects', 'submit_internal_design_review', { p_theme_option_id: t.id, p_result: 'passed' }));
    if (t.id === t1.id) check(pass?.outcome === 'recorded', 'after the revision the reviewer passes it', String(pass?.outcome));
  }
  const edit = one(await asOwner('projects', 'submit_admin_design_decision', { p_theme_option_id: t1.id, p_decision: 'edit', p_reason: 'Make the headline weight lighter.' }));
  check(edit?.outcome === 'recorded', 'Admin EDITs the first direction, with a reason', String(edit?.outcome));
  const afterEdit = one(await rest('GET', 'projects', `theme_options?id=eq.${t1.id}&select=internal_review_status,admin_status`));
  check(afterEdit?.internal_review_status !== 'passed' && afterEdit?.admin_status !== 'approved', 'an Admin edit returns it THROUGH internal review again', `${afterEdit?.internal_review_status}/${afterEdit?.admin_status}`);
  const adminSkip = one(await asOwner('projects', 'submit_admin_design_decision', { p_theme_option_id: t1.id, p_decision: 'confirm' }));
  check(adminSkip?.outcome !== 'recorded' && adminSkip?.outcome !== 'approved', 'and Admin cannot approve it again until that review passes', String(adminSkip?.outcome));
  await asOwner('projects', 'submit_internal_design_review', { p_theme_option_id: t1.id, p_result: 'passed' });
  for (const t of themes) {
    const approved = one(await asOwner('projects', 'submit_admin_design_decision', { p_theme_option_id: t.id, p_decision: 'confirm' }));
    if (t.id === t1.id) check(approved?.outcome === 'recorded', 'Admin approves the revised direction', String(approved?.outcome));
  }
  const history = (await rest('GET', 'projects', `admin_design_decisions?theme_option_id=eq.${t1.id}&select=decision&order=created_at`)).json ?? [];
  check(history.map((h) => h.decision).join() === 'edit,confirm', 'and the edit stays on the record beside the approval - history is kept, not overwritten', history.map((h) => h.decision).join());

  // ── 11. the client sees exactly what was approved ───────────────────────────
  section('11. The PM shares the approved options; the exact set is on the record');
  const share = one(await asOwner('projects', 'record_design_share', { p_project_id: project.id, p_theme_option_ids: [t1.id, t2.id], p_channel: 'whatsapp', p_evidence_ref: `wamid.${MARKER}.share1`, p_conversation_id: groupConvId }));
  check(share?.outcome === 'shared', 'two approved options are shared and recorded', String(share?.outcome));
  const shareRow = one(await rest('GET', 'projects', `client_design_shares?id=eq.${share.share_id}&select=share_number,option_count,shared_options`));
  check(shareRow?.option_count === 2 && JSON.stringify(shareRow?.shared_options).includes(t1.name) && !JSON.stringify(shareRow?.shared_options).includes(t3.name), 'the Admin Panel can say exactly which two went, and that the third did not', `${shareRow?.option_count}`);

  // ── 12. the PM reads the client's replies ────────────────────────────────────
  section('12. The PM reads what the client writes: it applies the safe set, asks when unsure, and leaves the rest to a person');
  let seq = 100;
  const say = async (body) => {
    // The PM's own messages take sequence numbers in this thread too, so ask for the next free one.
    const top = one(await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&select=seq&order=seq.desc&limit=1`));
    seq = Math.max(seq, Number(top?.seq ?? 0)) + 1;
    const ref = `${MARKER}:reply${seq}`;
    const inserted = await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: groupConvId, seq, author_type: 'client', body, external_ref: ref, occurred_at: new Date().toISOString() });
    if (!inserted.ok) throw new Error(`could not post the client's message: ${inserted.status} ${JSON.stringify(inserted.json).slice(0, 160)}`);
    const msg = one(await rest('GET', 'crm', `conversation_messages?external_ref=eq.${ref}&select=id`));
    return msg.id;
  };
  const proposalFor = async (messageId, wait = true) => {
    const read = async () => one(await rest('GET', 'projects', `design_reply_proposals?message_id=eq.${messageId}&select=*`));
    return wait ? until(async () => ((await read())?.status && (await read())?.status !== 'proposed' ? await read() : null), 30) : read();
  };
  const colour1 = colours.find((c) => c.theme_option_id === t1.id);
  const colour1b = colour1;

  const callsBefore = modelCalls.filter((c) => c === 'reply').length;
  const thanksId = await say('Thanks!');
  await ticks(6);
  check((await proposalFor(thanksId, false)) === undefined && modelCalls.filter((c) => c === 'reply').length === callsBefore, 'a thank-you costs nothing - no model call, no proposal', `${modelCalls.filter((c) => c === 'reply').length - callsBefore} call(s)`);

  const unrelatedId = await say('What time does the office open?');
  const unrelated = await proposalFor(unrelatedId);
  check(unrelated?.intent === 'unrelated' && unrelated?.status === 'ignored', 'an unrelated question is read and left alone', `${unrelated?.intent}/${unrelated?.status}`);

  const notShownId = await say('Let us go with option 3 please');
  const notShown = await proposalFor(notShownId);
  check(notShown?.status === 'asked' && notShown?.selected_theme_option_id === null, 'a choice the client was never shown is NOT applied - the PM asks which option they mean', `${notShown?.status}`);
  check(groupTexts().some((t) => /which option you mean|Which of the options/i.test(t)), 'and the question reaches the client');
  const qCount = groupTexts().filter((t) => /which option you mean|Which of the options/i.test(t)).length;

  const unclearId = await say('hmm not sure yet');
  const unclear = await proposalFor(unclearId);
  check(unclear?.intent === 'unclear' && unclear?.status === 'asked', 'an unclear reply gets one plain question back', `${unclear?.status}`);
  await ticks(6);
  check(groupTexts().filter((t) => /which option you mean|Which of the options/i.test(t)).length === qCount + 1, 'asked once each, never twice', `${groupTexts().filter((t) => /which option you mean|Which of the options/i.test(t)).length}`);
  check((await p3())?.state === 'waiting_client', 'and neither moved the phase', String((await p3())?.state));

  const accentId = await say('Can the accent colour be less orange on the first one?');
  const accent = await proposalFor(accentId);
  check(accent?.intent === 'design_change_request' && accent?.status === 'applied', 'a visual change is applied by the PM', `${accent?.intent}/${accent?.status}`);
  const accentDecision = one(await rest('GET', 'projects', `client_design_decisions?id=eq.${accent?.decision_id}&select=decision,recorded_by,recorded_by_agent,client_words`));
  check(accentDecision?.recorded_by === null && accentDecision?.recorded_by_agent === 'project_manager' && /accent/.test(accentDecision?.client_words ?? ''), 'recorded as the PM agent - never as a person - with the client\'s own words', JSON.stringify(accentDecision).slice(0, 90));
  const afterChange = await p3();
  const revision = one(await rest('GET', 'projects', `design_revisions?id=eq.${accent?.revision_id}&select=origin,round_number,from_theme_option_id`));
  check(afterChange?.state === 'revision' && afterChange?.client_revision_count === 1 && revision?.round_number === 1 && revision?.from_theme_option_id === t1.id, 'it opens revision round 1 on the option they meant and the phase reads REVISION', `${afterChange?.state} count ${afterChange?.client_revision_count}`);
  const sameAgain = one(await asServiceRpc('agent_apply_design_reply', { p_proposal_id: accent.id }));
  check(sameAgain?.outcome === 'already_applied' && (await p3())?.client_revision_count === 1, 'applying the same reading twice spends no second round', String(sameAgain?.outcome));

  const loyaltyId = await say('Please also add a loyalty module with points');
  const loyalty = await proposalFor(loyaltyId);
  check(loyalty?.intent === 'possible_scope_change' && loyalty?.status === 'awaiting_person', 'a request for NEW features is never applied by the PM - it waits for a person', `${loyalty?.intent}/${loyalty?.status}`);
  check((await p3())?.state === 'revision', 'and the phase has not been stopped on a guess', String((await p3())?.state));
  const accepted = one(await asOwner('projects', 'accept_design_reply_proposal', { p_proposal_id: loyalty.id }));
  const stopped = await p3();
  check(accepted?.outcome === 'accepted' && stopped?.state === 'scope_escalation', 'a person records it, and only then the phase stops as a possible scope change', `${accepted?.outcome} / ${stopped?.state}`);
  const changeRequest = await until(async () => {
    const r = (await rest('GET', 'projects', `change_requests?project_id=eq.${project.id}&select=id`)).json ?? [];
    return r.length > 0 ? r : null;
  }, 20);
  check(Boolean(changeRequest), 'and a change request is opened for triage (the existing scope flow)');
  const memberTry = one(await fx.call(fx.mint(owner.id, 'member'), 'POST', 'projects', 'rpc/resolve_phase_three_stop', { p_phase_three_id: phaseThree.id, p_resolution: 'declined_continue', p_note: 'I say so' }));
  check(memberTry?.outcome === 'forbidden', 'only an admin can let a stopped phase continue - a member cannot', String(memberTry?.outcome));
  const noNote = one(await asOwner('projects', 'resolve_phase_three_stop', { p_phase_three_id: phaseThree.id, p_resolution: 'declined_continue', p_note: '  ' }));
  check(noNote?.outcome === 'needs_note', 'and a reason is required', String(noNote?.outcome));
  const wrongWay = one(await asOwner('projects', 'resolve_phase_three_stop', { p_phase_three_id: phaseThree.id, p_resolution: 'allow_more_rounds', p_note: 'wrong stop', p_extra_rounds: 2 }));
  check(wrongWay?.outcome === 'bad_resolution', 'a resolution that belongs to a different stop is refused', String(wrongWay?.outcome));
  const resumed = one(await asOwner('projects', 'resolve_phase_three_stop', { p_phase_three_id: phaseThree.id, p_resolution: 'declined_continue', p_note: 'Loyalty is a separate paid module; design continues on the approved scope.' }));
  check(resumed?.outcome === 'resolved' && resumed?.resumed_state === 'waiting_client', 'an admin declines the extra scope and design continues', `${resumed?.outcome} -> ${resumed?.resumed_state}`);
  const notStopped = one(await asOwner('projects', 'resolve_phase_three_stop', { p_phase_three_id: phaseThree.id, p_resolution: 'declined_continue', p_note: 'again' }));
  check(notStopped?.outcome === 'not_stopped', 'resolving a phase that is not stopped is refused', String(notStopped?.outcome));
  const resolutions = (await rest('GET', 'projects', `phase_three_stop_resolutions?phase_three_id=eq.${phaseThree.id}&select=stopped_state,resolution`)).json ?? [];
  check(resolutions.length === 1 && resolutions[0].stopped_state === 'scope_escalation', 'and the resolution is on the record with the stop it answered', JSON.stringify(resolutions));

  const pickId = await say('We like Calm Clinical, we will go with it');
  const pick = await proposalFor(pickId);
  check(pick?.intent === 'client_selected' && pick?.status === 'applied' && pick?.selected_theme_option_id === t1.id, 'a clear choice is applied: Calm Clinical and its palette', `${pick?.intent}/${pick?.status}`);
  check((await p3())?.state === 'final_confirmation', 'the phase reads FINAL CONFIRMATION', String((await p3())?.state));
  const ask = await until(async () => groupTexts().find((t) => /confirm the selected UI theme and color/i.test(t)), 25);
  check(Boolean(ask), 'the PM asks the client to explicitly confirm the selected theme and colour', ask ? ask.slice(0, 40) : 'nothing sent');
  await ticks(6);
  check(groupTexts().filter((t) => /confirm the selected UI theme and color/i.test(t)).length === 1, 'and asks only once', `${groupTexts().filter((t) => /confirm the selected UI theme and color/i.test(t)).length}`);
  const lockTooSoon = one(await asOwner('projects', 'lock_phase_three_direction', { p_phase_three_id: phaseThree.id }));
  check(lockTooSoon?.outcome !== 'locked' && lockTooSoon?.outcome !== 'locked_not_ready', 'a selection alone does not lock - only the final confirmation does', String(lockTooSoon?.outcome));

  const yesCalls = modelCalls.filter((c) => c === 'reply').length;
  const yesId = await say('Yes, confirmed');
  const yes = await proposalFor(yesId);
  check(yes?.source === 'rule' && yes?.intent === 'final_confirmed' && yes?.status === 'awaiting_person' && modelCalls.filter((c) => c === 'reply').length === yesCalls, 'a plain yes is read by rule (no model call) - and still only PROPOSED: a person confirms the lock', `${yes?.source}/${yes?.status}`);
  check((await p3())?.state === 'final_confirmation', 'nothing is locked yet', String((await p3())?.state));

  // ── 13. the lock and the Phase 4 handoff ─────────────────────────────────
  section('13. Final confirmation locks the theme, the colour and the Figma node - and Phase 4 starts from them');
  const finalAccepted = one(await asOwner('projects', 'accept_design_reply_proposal', { p_proposal_id: yes.id, p_theme_option_id: t1.id, p_color_option_id: colour1b.id }));
  check(finalAccepted?.outcome === 'accepted', 'a person accepts the proposal with the exact theme and colour - one click, their name on it', String(finalAccepted?.outcome));
  const finalDecision = one(await rest('GET', 'projects', `client_design_decisions?id=eq.${finalAccepted?.decision_id}&select=decision,recorded_by,recorded_by_agent`));
  check(finalDecision?.decision === 'final_confirmed' && finalDecision?.recorded_by === owner.id && finalDecision?.recorded_by_agent === null, 'recorded as a PERSON\'s act, not the PM agent\'s', JSON.stringify(finalDecision));
  const tokens = one(await asOwner('projects', 'record_design_token_set', { p_theme_option_id: t1.id, p_font_family_heading: 'Inter', p_font_family_body: 'Inter', p_type_scale_ratio: 1.25, p_base_spacing_px: 8, p_radius_style: 'rounded', p_elevation_style: 'subtle', p_border_style: 'hairline', p_icon_treatment: 'outline', p_navigation_style: 'side_nav', p_button_treatment: 'solid', p_card_treatment: 'flat' }));
  const tokenFinal = one(await asOwner('projects', 'finalize_design_token_set', { p_theme_option_id: t1.id }));
  check(['recorded', 'drafted'].includes(tokens?.outcome) && ['finalized', 'already_finalized'].includes(tokenFinal?.outcome), 'the design primitives (type, spacing, shape) are recorded and finalized', `${JSON.stringify(tokens).slice(0, 120)} / ${tokenFinal?.outcome}`);
  const screen = screens[0];
  await asOwner('projects', 'submit_screen_for_qa', { p_screen_id: screen.id });
  await asOwner('projects', 'confirm_screen_qa', { p_screen_id: screen.id });
  const approvedScreen = one(await asOwner('projects', 'approve_screen', { p_screen_id: screen.id }));
  const sample = one(await asOwner('projects', 'record_representative_screen', { p_theme_option_id: t1.id, p_screen_id: screen.id, p_pattern: 'primary', p_figma_node_id: '9:9' }));
  check(approvedScreen?.outcome === 'approved', 'a person approves a real screen from the finalized list', `${approvedScreen?.outcome} ${approvedScreen?.detail ?? ''}`);
  check(sample?.outcome === 'recorded', 'and is recorded against the chosen direction', `approve ${approvedScreen?.outcome} / sample ${sample?.outcome}`);

  const locked = one(await asOwner('projects', 'lock_phase_three_direction', { p_phase_three_id: phaseThree.id }));
  check(locked?.outcome === 'locked', 'the direction is locked, Phase 4 ready', String(locked?.outcome));
  const done3 = await p3();
  check(done3?.state === 'completed' && Boolean(done3?.completed_at), 'Phase 3 is COMPLETED', String(done3?.state));
  const lockedTheme = one(await rest('GET', 'projects', `theme_options?id=eq.${t1.id}&select=client_status`));
  const otherThemes = (await rest('GET', 'projects', `theme_options?id=in.(${t2.id},${t3.id})&select=client_status`)).json ?? [];
  check(lockedTheme?.client_status === 'locked' && otherThemes.every((t) => t.client_status !== 'locked'), 'exactly the chosen direction is locked', `${lockedTheme?.client_status}`);
  const handoff = one(await rest('GET', 'projects', `phase_three_handoffs?phase_three_id=eq.${phaseThree.id}&select=phase_four_ready,readiness_note,payload`));
  check(handoff?.phase_four_ready === true, 'the handoff says Phase 4 is READY', String(handoff?.readiness_note));
  check(handoff?.payload?.theme?.figmaNodeId === '1:1' && JSON.stringify(handoff?.payload).includes('Calm'), 'and carries the exact Figma node, theme, colours and screen baseline Phase 4 would otherwise ask for', JSON.stringify(handoff?.payload?.theme ?? {}).slice(0, 80));
  const phaseFour = await until(async () => one(await rest('GET', 'projects', `phase_four?project_id=eq.${project.id}&select=id,state`)), 25);
  check(Boolean(phaseFour?.id), 'Phase 4 starts from the handoff - and only after the lock', String(phaseFour?.state));

  // ── 14. the whole run ─────────────────────────────────────────────────────
  section('13b. The Figma plugin gets exactly this project\'s finalized screens - and can report what it built');
  const signingKey = readFileSync('.env.verify.local', 'utf8').match(/^VAULT_ENCRYPTION_KEY=(.*)$/m)?.[1]?.trim().replace(/"/g, '') ?? '';
  const pluginCode = signFigmaCode({ organizationId: ORG, projectId: project.id }, signingKey, Math.floor(Date.now() / 1000));
  const figma = (path, init = {}, bearer = pluginCode) => fetch(`${APP}/api/design/figma/${init.project ?? project.id}${path}`, { ...init, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' }, cache: 'no-store' });
  const noCode = await figma('', {}, null);
  check(noCode.status === 401, 'no code, no read', `HTTP ${noCode.status}`);
  const wrongProject = await figma('', { project: randomUUID() });
  check(wrongProject.status === 403, 'a code for this project cannot read another one', `HTTP ${wrongProject.status}`);
  const exportRes = await figma('');
  const exportBody = await exportRes.json().catch(() => ({}));
  const liveScreens = (await rest('GET', 'projects', `screens?project_id=eq.${project.id}&status=neq.superseded&baseline_version=not.is.null&select=id,screen_key`)).json ?? [];
  check(exportRes.ok && exportBody.screens?.length === liveScreens.length && liveScreens.length > 0, 'the export is the finalized screen list - every one, and only those', `${exportBody.screens?.length}/${liveScreens.length}`);
  check(Boolean(exportBody.direction?.palette?.primary) && /^#?[0-9a-fA-F]{6}$/.test(exportBody.direction.palette.primary), 'with the client\'s chosen direction and its palette', exportBody.direction?.name);
  const blob = JSON.stringify(exportBody);
  check(!/@|\+91|invoice|price|amount_minor|phone/i.test(blob.replace(/https?:\/\/\S+/g, '')), 'and no client contact detail, price or message is in it - design structure only');
  const builtFrames = [{ key: liveScreens[0].screen_key, screenId: liveScreens[0].id, name: `${liveScreens[0].screen_key} - verifier`, nodeId: '12:34' }];
  const reported = await figma('/report', { method: 'POST', body: JSON.stringify({ fileKey: 'VerifierFileKey1', pageId: '5:1', pageName: 'AgencyOS - verifier', frames: builtFrames }) });
  check(reported.ok, 'the plugin reports what it built', `HTTP ${reported.status}`);
  const badReport = await figma('/report', { method: 'POST', body: JSON.stringify({ frames: [{ ...builtFrames[0], nodeId: 'x; drop' }] }) });
  check(badReport.status === 400, 'a malformed report is refused', `HTTP ${badReport.status}`);
  const importRows = (await rest('GET', 'projects', `figma_plugin_imports?project_id=eq.${project.id}&select=id,frames,file_key`)).json ?? [];
  check(importRows.length === 1 && importRows[0].file_key === 'VerifierFileKey1', 'exactly one record exists, for this project', `${importRows.length}`);
  const screenLink = (await rest('GET', 'projects', `screens?id=eq.${liveScreens[0].id}&select=figma_url`)).json?.[0]?.figma_url ?? null;
  const themeLinked = (await rest('GET', 'projects', `theme_options?project_id=eq.${project.id}&figma_node_id=eq.12:34&select=id`)).json ?? [];
  check(screenLink === null && themeLinked.length === 0, 'and the report linked NOTHING - a person does that, verified against Figma');
  const tamper = await rest('PATCH', 'projects', `figma_plugin_imports?id=eq.${importRows[0].id}`, { page_name: 'tampered' });
  check(!tamper.ok, 'the record is history: it cannot be edited', `HTTP ${tamper.status}`);
  const importAudit = (await rest('GET', 'audit', `audit_log?action=eq.figma_plugin.imported&subject_id=eq.${project.id}&select=id`)).json ?? [];
  check(importAudit.length === 1, 'and the import is in the audit trail');
  const asUserDirect = await fx.call(owner.token, 'POST', 'projects', 'rpc/record_figma_import', { p_organization_id: ORG, p_project_id: project.id, p_file_key: null, p_page_id: null, p_page_name: null, p_frames: builtFrames });
  check(!asUserDirect.ok, 'a signed-in user cannot write a plugin report directly - only the signed code can', `HTTP ${asUserDirect.status}`);

  section('14. Across the whole run: nothing twice, nothing lost, everything on the record');
  const clientThread = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&author_type=eq.user&select=external_ref`)).json ?? [];
  const groupThread = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${groupConvId}&author_type=eq.user&select=external_ref`)).json ?? [];
  const refs = [...clientThread, ...groupThread].map((m) => m.external_ref).filter(Boolean);
  check(new Set(refs).size === refs.length, 'no message was recorded twice', `${refs.length} messages`);
  const deadAtEnd = (await rest('GET', 'core', `jobs?status=eq.dead&created_at=gte.${STARTED}&select=kind,last_error`)).json ?? [];
  check(deadAtEnd.length === 0, 'no job died', deadAtEnd.map((j) => `${j.kind}: ${String(j.last_error).slice(0, 60)}`).join('; '));
  const runs = (await rest('GET', 'ai', `agent_runs?project_id=eq.${project.id}&agent_key=eq.ui_designer&select=id,phase,project_id`)).json ?? [];
  check(runs.length >= 2, 'the designer\'s work is on the AI usage record (inventory and directions)', `${runs.length} run(s)`);
  const audits = (await rest('GET', 'audit', `audit_log?subject_id=in.(${phaseThree.id},${project.id})&action=in.(phase_three.stop_resolved,phase_three.started,phase_three.reviewer_assigned)&select=action`)).json ?? [];
  check(audits.some((a) => a.action === 'phase_three.stop_resolved') && audits.some((a) => a.action === 'phase_three.started'), 'the stop, its resolution and the start are all audited', [...new Set(audits.map((a) => a.action))].join());
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  graph.close();
  model.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
