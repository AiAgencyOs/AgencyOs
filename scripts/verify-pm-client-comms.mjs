#!/usr/bin/env node
/**
 * The project manager talks to the client during Phase 2 — PM §6 PM-03/05/06/08.
 * Against the real database and the running app: the job runner, the real
 * handlers, a Graph stub that receives what leaves.
 *
 *   node scripts/verify-pm-client-comms.mjs
 *
 * Proves, each in both directions:
 *   • Phase 2 starting welcomes the client and asks GST or Non-GST — once, even
 *     when the event is replayed — and a project whose mode is already
 *     confirmed is not asked again
 *   • a client's clear answer ("GST") tells STAFF to confirm it; it creates no
 *     billing profile (billing mode is a person's act, Finance §4.1), and a
 *     question about GST is not mistaken for an answer
 *   • a GST project missing its details is asked for them; a Non-GST one is not
 *   • a payment submitted, verified (the advance), and rejected each reach the
 *     client in words, once, and no amount appears in any of them
 *
 * Nothing is deleted: the run is against a disposable database.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
await announceTarget(target, 'the PM speaks, a person decides');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-pmcomms-${randomUUID().slice(0, 8)}`;
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
  return { ok: res.ok, status: res.status, json: parse(text) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);
const emit = (type, subjectType, subjectId) =>
  rpc('core', 'emit_event', { p_organization_id: ORG, p_type: type, p_subject_type: subjectType, p_subject_id: subjectId, p_payload: {} });

const tick = () =>
  fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' })
    .then(async (r) => ({ status: r.status, json: parse(await r.text()) }));
async function ticks(n = 8) { for (let i = 0; i < n; i += 1) await tick(); }
async function tickUntil(predicate, budget = 30) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── the Graph stub ──────────────────────────────────────────────────────────
const graphSends = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `MEDIA.STUB.${Date.now()}` }));
      return;
    }
    graphSends.push({ url: req.url, body: parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
await new Promise((resolve, reject) => { graph.once('error', reject); graph.listen(GRAPH_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));

const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.PMCOMMS' } });

/** A client with consent, a recent inbound message, a won deal and a project in Phase 2. */
async function plant(label, { phaseTwo = true } = {}) {
  const phone = `+9198${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`;
  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} ${label} client` }));
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: client.id, full_name: `${MARKER} ${label}`, phone }));
  await rest('POST', 'crm', 'communication_consent', { organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted' });
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, title: `${MARKER} ${label}`, source: 'whatsapp', source_ref: `${MARKER}:${label}`, status: 'new',
  }));
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct', channel: 'whatsapp',
    external_ref: `${MARKER}:conv:${label}`, status: 'active',
  }));
  await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 0, author_type: 'client', body: `${MARKER} hello`,
    external_ref: `${MARKER}:in:${label}`, occurred_at: new Date().toISOString(),
  });
  const opp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${label} deal`, stage: 'discovery', client_account_id: client.id }));
  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: client.id, opportunity_id: opp.id, name: `${MARKER} ${label} project`, status: 'planning',
  }));
  if (phaseTwo) {
    const handoff = one(await rest('POST', 'ai', 'handoffs', {
      organization_id: ORG, correlation_id: randomUUID(), from_agent: 'sales', to_agent: 'project_manager', objective: `${MARKER} handoff`,
    }));
    await rest('POST', 'projects', 'phase_two', { organization_id: ORG, project_id: project.id, handoff_id: handoff.id });
  }
  return { client, contact, lead, conv, opp, project, phone };
}

const sentTo = (phone) => graphSends.filter((g) => g.body?.to === phone.replace('+', '') || g.body?.to === phone);
const texts = (phone) => sentTo(phone).filter((g) => g.body?.type === 'text').map((g) => g.body?.text?.body ?? '');
const alertCount = async (fingerprint) =>
  ((await rest('GET', 'core', `alerts?fingerprint=eq.${encodeURIComponent(fingerprint)}&select=id,occurrences`)).json ?? []);

console.log('\n\x1b[1mAgencyOS — the project manager talks to the client (Phase 2 PM §6)\x1b[0m');

try {
  // ── 1. the welcome ────────────────────────────────────────────────────────
  section('1. Phase 2 starting welcomes the client and asks GST or Non-GST — once');
  const a = await plant('a');
  await emit('project.handoff_bound', 'project', a.project.id);
  await tickUntil(async () => texts(a.phone).length >= 2);
  const first = texts(a.phone);
  check(first.length === 2, 'the client received exactly two messages: the welcome and the billing question', `${first.length}`);
  check(/project manager/i.test(first[0] ?? '') && (first[0] ?? '').includes(`${MARKER} a project`), 'the welcome names the project and the PM', (first[0] ?? '').slice(0, 70));
  check(/GST invoice or a Non-GST invoice/.test(first[1] ?? ''), 'the question is the specification\'s own words', (first[1] ?? '').slice(0, 70));
  check(first.every((t) => !/[₹$]|\bRs\b/.test(t)), 'no amount appears in either message');

  const before = graphSends.length;
  await emit('project.handoff_bound', 'project', a.project.id);
  await ticks(8);
  check(graphSends.length === before, 'a replayed event sends nothing a second time', `${graphSends.length - before} send(s)`);

  const b = await plant('b');
  await rest('POST', 'finance', 'billing_profiles', {
    organization_id: ORG, project_id: b.project.id, client_account_id: b.client.id, version: 1, status: 'active', mode: 'non_gst', source: 'internal',
  });
  await emit('project.handoff_bound', 'project', b.project.id);
  await tickUntil(async () => texts(b.phone).length >= 1);
  await ticks(4);
  const bTexts = texts(b.phone);
  check(bTexts.length === 1 && !/GST invoice or a Non-GST/.test(bTexts[0] ?? ''), 'a project whose billing mode is already confirmed is welcomed but not asked again', `${bTexts.length} message(s)`);

  // ── 2. the client's answer ────────────────────────────────────────────────
  section('2. A clear answer tells staff to confirm it — and confirms nothing itself');
  const ask = async (conv, body) => rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: 1 + Math.floor(Math.random() * 1e6), author_type: 'client', body,
    external_ref: `${MARKER}:in:${randomUUID().slice(0, 8)}`, occurred_at: new Date().toISOString(),
  });
  const q = await ask(a.conv, 'kya GST zaruri hai? samajh nahi aaya');
  await ticks(10);
  check(q.ok && (await alertCount(`billing-answer:${a.project.id}`)).length === 0, 'a question about GST is not mistaken for an answer');

  await ask(a.conv, 'GST invoice chahiye');
  const alerted = await tickUntil(async () => (await alertCount(`billing-answer:${a.project.id}`)).length === 1);
  check(Boolean(alerted), 'a clear "GST invoice chahiye" raises an alert for staff');
  const profiles = (await rest('GET', 'finance', `billing_profiles?project_id=eq.${a.project.id}&select=id`)).json ?? [];
  check(profiles.length === 0, 'and NO billing profile exists - the mode is still a person\'s to confirm', `${profiles.length}`);

  // ── 3. the GST details ────────────────────────────────────────────────────
  section('3. A GST project missing its details is asked for them; Non-GST is not');
  await rest('POST', 'finance', 'billing_profiles', {
    organization_id: ORG, project_id: a.project.id, client_account_id: a.client.id, version: 1, status: 'active', mode: 'gst', source: 'client_confirmation',
  });
  await emit('project.billing_mode_confirmed', 'project', a.project.id);
  const gstAsked = await tickUntil(async () => texts(a.phone).some((t) => /GSTIN/.test(t)));
  check(Boolean(gstAsked), 'the client is asked for business name, GSTIN, address and state');
  const afterGst = graphSends.length;
  await emit('project.billing_mode_confirmed', 'project', a.project.id);
  await ticks(8);
  check(graphSends.length === afterGst, 'asked once, not on every replay');

  await emit('project.billing_mode_confirmed', 'project', b.project.id);
  const bBefore = graphSends.length;
  await ticks(8);
  check(graphSends.length === bBefore, 'a Non-GST project is not asked for GST details');

  // ── 4. payment status ─────────────────────────────────────────────────────
  section('4. Where the payment stands reaches the client, once, with no amount');
  const c = await plant('c');
  // The locked 30/20/30/20 plan, inserted together because the database refuses
  // a plan that does not total 100.
  const plan = (await rest('POST', 'projects', 'milestones', [30, 20, 30, 20].map((percent, i) => ({
    organization_id: ORG, project_id: c.project.id, name: `${MARKER} M${i + 1}`, position: i + 1, payment_percent: percent,
  })))).json ?? [];
  const milestone = plan.find((m) => m.position === 1);
  check(Boolean(milestone?.id), 'the project has its locked four-milestone plan (fixture)');
  const invoice = one(await rest('POST', 'finance', 'invoices', {
    organization_id: ORG, client_account_id: c.client.id, project_id: c.project.id, milestone_id: milestone?.id,
    number: `${MARKER}-C`.toUpperCase().slice(0, 40), status: 'draft', currency: 'INR', subtotal_minor: 3000000, tax_minor: 0, total_minor: 3000000,
  }));
  await rest('POST', 'finance', 'invoice_items', {
    organization_id: ORG, invoice_id: invoice.id, position: 0, description: `${MARKER} line`, quantity: 1, unit_price_minor: 3000000, amount_minor: 3000000, tax_rate_bp: 0,
  });
  await rpc('finance', 'issue_invoice', { p_invoice_id: invoice.id });
  const submission = one(await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 3000000, method: 'upi', reference: `${MARKER}-utr`, submitted_by_agent: 'sales',
  }));
  const gotAck = await tickUntil(async () => texts(c.phone).some((t) => /received your payment details/.test(t)));
  check(Boolean(gotAck), '"we have received your payment details" reaches the client when proof is submitted');

  // An Admin CHECKS the claim (the claims queue's Confirm). That records that somebody looked; it is not the
  // money (Doc 15 §12, G-272), so the client is NOT told "advance verified" - it would be a promise the system
  // does not hold, because the project still cannot move.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `zzpmcomms-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json()).catch(() => ({}));
  const adminId = authUser?.id;
  if (!adminId) fail('could not create the verifying admin');
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: adminId, role: 'owner', status: 'active' });
  const checked = one(await rpc('finance', 'verify_payment_submission', {
    p_submission_id: submission.id, p_verified_by: adminId, p_evidence: 'bank statement line 12', p_approve: true,
  }));
  check(checked?.outcome === 'verified', 'an admin checks the claim', JSON.stringify(checked).slice(0, 60));
  for (let i = 0; i < 8; i += 1) await tick();
  check(!texts(c.phone).some((t) => /advance payment has been verified/.test(t)), 'a CHECKED claim is not announced as the verified advance - the money is not confirmed yet');

  // The money: the payment is recorded and a PERSON confirms it - which pays the invoice and publishes invoice.paid.
  const money = one(await rpc('finance', 'record_manual_payment', {
    p_invoice_id: invoice.id, p_provider_payment_id: `${MARKER}-utr-money`, p_amount_minor: 3000000,
    p_captured_at: new Date().toISOString(), p_method: 'bank_transfer',
  }));
  const confirmed = one(await rpc('finance', 'verify_payment', { p_payment_id: money?.payment_id, p_verified_by: adminId }));
  check(confirmed?.outcome === 'verified', 'the payment is confirmed by a person', String(confirmed?.outcome));
  const gotAdvance = await tickUntil(async () => texts(c.phone).some((t) => /advance payment has been verified/.test(t)));
  check(Boolean(gotAdvance), 'NOW the client is told the ADVANCE is verified (milestone 1), in words and with no amount');
  check(texts(c.phone).filter((t) => /advance payment has been verified/.test(t)).length === 1, 'and told once');

  const rejected = one(await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 1000, method: 'upi', reference: `${MARKER}-utr2`, submitted_by_agent: 'sales',
  }));
  await rest('PATCH', 'finance', `payment_submissions?id=eq.${rejected.id}`, { status: 'rejected', rejected_reason: 'internal: reference does not match the statement' });
  const gotNeeds = await tickUntil(async () => texts(c.phone).some((t) => /could not match the payment details/.test(t)));
  check(Boolean(gotNeeds), 'a rejected payment tells the client only that it could not be matched yet');
  check(texts(c.phone).every((t) => !/internal|statement|reference does not match/i.test(t)), 'and the staff\'s own reason never reaches the client');
  // The bill itself (the invoice delivery) names its amount, written by code; the PM's payment MESSAGES never do.
  check(texts(c.phone).filter((t) => !/^Invoice /.test(t)).every((t) => !/[₹$]|\bRs\b|30,000|3000000/.test(t)), 'and no amount appears in any payment message');

  const cBefore = graphSends.length;
  await emit('payment.submitted', 'payment_submission', submission.id);
  await ticks(8);
  check(graphSends.length === cBefore, 'a replayed payment event sends nothing again', `${graphSends.length - cBefore} send(s)`);

  // ── 5. a client who has not answered is reminded - if the owner chose to ───
  section('5. A client who has not answered is reminded only when the owner chose a wait, inside the sending window, and never twice in a row');
  const orgNow = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings,timezone`));
  const zone = orgNow?.timezone ?? 'UTC';
  const local = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const weekday = local.find((p) => p.type === 'weekday')?.value;
  const hour = Number(local.find((p) => p.type === 'hour')?.value);
  // The sending window is the AGENCY's setting. Left at its 10-19 default this section tested the send path only when the suite happened to run
  // inside it - on a weekday, in business hours - and otherwise asserted that nothing was sent, which is also true of a broken sender. So the
  // test sets its own wide window (restored at the end) and the send path is exercised on every weekday run; the weekend/late-night
  // refusal is still asserted whenever the clock is outside it.
  const win = { start: 0, end: 23 };
  const inWindow = !['Sat', 'Sun'].includes(weekday) && hour >= win.start && hour < win.end;

  const f = await plant('f');
  await rest('PATCH', 'projects', `phase_two?project_id=eq.${f.project.id}`, { state: 'waiting_client' });
  const three = new Date(Date.now() - 3 * 86_400_000).toISOString();
  // The fixture's own "hello" is stamped NOW, and the ask below is backdated three days. A client message NEWER than the ask is, to the
  // app, a client who has answered - so the reminder was (correctly) never sent, and this section only ever passed when the clock was
  // outside the sending window, where "held" is also "nothing sent". The greeting belongs before the ask it precedes.
  const four = new Date(Date.now() - 4 * 86_400_000).toISOString();
  await rest('PATCH', 'crm', `conversation_messages?conversation_id=eq.${f.conv.id}&author_type=eq.client`, { created_at: four, occurred_at: four });
  const asked3 = await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: f.conv.id, seq: 3, author_type: 'user', body: 'For billing, please confirm whether you need a GST invoice or a Non-GST invoice.',
    external_ref: `pm:billing-question:${f.project.id}`, occurred_at: three, created_at: three,
  });
  check(asked3.ok, 'the billing question was asked three days ago and not answered (fixture)');

  await ticks(6);
  check(!texts(f.phone).some((t) => /gentle reminder/i.test(t)), 'with no wait chosen by the owner, nothing chases');

  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...(orgNow?.settings ?? {}), whatsapp_phone_number_id: 'PN.STUB.PMCOMMS', onboarding_followup_days: '2', outreach_window_start_hour: String(win.start), outreach_window_end_hour: String(win.end) } });
  const reminded = await tickUntil(async () => texts(f.phone).some((t) => /gentle reminder/i.test(t)), 10);
  if (inWindow) {
    // When it does not go, say WHY: the sweep's own counts and whether a reminder row was written and how it ended.
    let why = '';
    if (!reminded) {
      const t = await tick();
      const msgs = await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${f.conv.id}&select=seq,author_type,created_at,external_ref&order=seq`);
      const prof = await rest('GET', 'finance', `billing_profiles?project_id=eq.${f.project.id}&select=status,mode`);
      const ph = await rest('GET', 'projects', `phase_two?project_id=eq.${f.project.id}&select=state`);
      const org = await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings,timezone`);
      why = `sweep ${JSON.stringify(t.json?.onboardingFollowUps)}; now ${new Date().toISOString()}; messages ${JSON.stringify(msgs.json)}; billing profiles ${JSON.stringify(prof.json)}; phase ${JSON.stringify(ph.json)}; org ${JSON.stringify(org.json)}; graph sends to this phone ${texts(f.phone).length}`;
    }
    check(Boolean(reminded), 'a wait of two days is chosen: the reminder goes (we are inside the sending window)', why);
    await ticks(6);
    check(texts(f.phone).filter((t) => /gentle reminder/i.test(t)).length === 1, 'and only one - the second waits the same number of days from the first');
  } else {
    check(!reminded, 'outside the sending window (night or weekend) the reminder is HELD, not sent', `${weekday} ${hour}:00 ${zone}`);
  }

  const g = await plant('g');
  await rest('PATCH', 'projects', `phase_two?project_id=eq.${g.project.id}`, { state: 'waiting_client' });
  await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: g.conv.id, seq: 3, author_type: 'user', body: 'For billing, please confirm whether you need a GST invoice or a Non-GST invoice.',
    external_ref: `pm:billing-question:${g.project.id}`, occurred_at: three, created_at: three,
  });
  await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: g.conv.id, seq: 4, author_type: 'client', body: 'one minute, checking with my accountant', external_ref: `${MARKER}:g-reply`, occurred_at: new Date().toISOString(),
  });
  await ticks(8);
  check(!texts(g.phone).some((t) => /gentle reminder/i.test(t)), 'a client who has written since the ask is never chased');
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: orgNow?.settings ?? {} });
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  graph.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
