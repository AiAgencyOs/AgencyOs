#!/usr/bin/env node
/**
 * The free-maintenance ₹0 document — Phase 2 Finance §9. Against the real
 * database and the running app, with a Graph stub.
 *
 *   node scripts/verify-free-maintenance.mjs
 *
 * Proves, each in both directions:
 *   • when the handover is accepted (Phase 7 complete) a project whose
 *     maintenance was included free gets its ₹0 document with no button, no
 *     payment to collect and no Admin verification
 *   • it is DELIVERED to the project group like any invoice (text and PDF), the
 *     text says nothing is owed and carries no figure
 *   • a project whose payment is not yet 100% VERIFIED is refused and staff are
 *     told - free maintenance does not wait on nothing
 *   • a project with no free maintenance gets nothing, and a replayed
 *     acceptance raises nothing a second time
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
await announceTarget(target, 'nothing to collect, so nothing to verify');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-freemaint-${randomUUID().slice(0, 8)}`;
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
async function tickUntil(predicate, budget = 40) {
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
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && req.url.endsWith('/media')) return res.end(JSON.stringify({ id: `MEDIA.STUB.${Date.now()}` }));
    graphSends.push({ url: req.url, body: parse(body) });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
await new Promise((resolve, reject) => { graph.once('error', reject); graph.listen(GRAPH_PORT, '127.0.0.1', resolve); })
  .catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));
const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.FREEMAINT' } });

let adminId = null;
async function ensureAdmin() {
  if (adminId) return adminId;
  const u = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ email: `zzfree-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json()).catch(() => ({}));
  adminId = u?.id;
  if (!adminId) fail('could not create the admin');
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: adminId, role: 'owner', status: 'active' });
  return adminId;
}

/** A project with the locked four-milestone plan, a project group, and (optionally) every milestone paid and verified. */
async function plant(label, { paid, freePlan }) {
  const name = `${MARKER}-${label}`;
  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${name} client` }));
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: client.id, name, status: 'active' }));
  const milestones = (await rest('POST', 'projects', 'milestones', [30, 20, 30, 20].map((p, i) => ({
    organization_id: ORG, project_id: project.id, name: `${name} M${i + 1}`, position: i + 1, payment_percent: p,
  })))).json ?? [];
  const group = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, kind: 'project_group', channel: 'whatsapp', project_id: project.id, external_ref: `${name}-group@g.us`, status: 'active',
  }));
  if (paid) {
    for (const m of milestones) {
      const inv = one(await rest('POST', 'finance', 'invoices', {
        organization_id: ORG, client_account_id: client.id, project_id: project.id, milestone_id: m.id,
        number: `${name}-I${m.position}`.toUpperCase().slice(0, 40), status: 'draft', currency: 'INR', subtotal_minor: 1000000, tax_minor: 0, total_minor: 1000000,
      }));
      await rest('POST', 'finance', 'invoice_items', { organization_id: ORG, invoice_id: inv.id, position: 0, description: `${name} line`, quantity: 1, unit_price_minor: 1000000, amount_minor: 1000000, tax_rate_bp: 0 });
      await rpc('finance', 'issue_invoice', { p_invoice_id: inv.id });
      const pay = one(await rpc('finance', 'record_manual_payment', {
        p_invoice_id: inv.id, p_provider_payment_id: `${name}-utr-${m.position}`, p_amount_minor: 1000000, p_captured_at: new Date().toISOString(), p_method: 'bank_transfer',
      }));
      await rpc('finance', 'verify_payment', { p_payment_id: pay?.payment_id, p_verified_by: await ensureAdmin() });
    }
  }
  // A maintenance plan needs a DELIVERED handover (Doc 18 §5), and a handover is delivered only through
  // its door (handovers_guard), which needs an item and an approval policy for the client's acceptance.
  const handover = one(await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: project.id }));
  await rest('POST', 'projects', 'handover_items', { organization_id: ORG, handover_id: handover.id, kind: 'repository', label: 'Repo' });
  const policy = await rest('GET', 'approvals', `approval_policies?organization_id=eq.${ORG}&subject_type=eq.handover&min_amount_minor=eq.0&select=id`);
  if (Array.isArray(policy.json) && policy.json.length === 0) {
    await rest('POST', 'approvals', 'approval_policies', { organization_id: ORG, subject_type: 'handover', min_amount_minor: 0, required_role: 'ops_admin', sla_hours: 48, audience: 'client' });
  }
  const delivered = one(await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: handover.id }));
  if (delivered?.outcome !== 'delivered') fail(`could not deliver the fixture handover: ${delivered?.outcome}`);
  let plan = null;
  if (freePlan) {
    plan = one(await rest('POST', 'projects', 'maintenance_plans', {
      organization_id: ORG, client_account_id: client.id, project_id: project.id, name: `${name} free maintenance`, billing_model: 'annual',
      entitlement: 'free_included', starts_on: '2026-11-01', ends_on: '2027-10-31', status: 'draft',
    }));
  }
  return { name, client, project, milestones, group, plan, handover };
}

const freeInvoices = async (planId) => (await rest('GET', 'finance', `invoices?maintenance_plan_id=eq.${planId}&select=id,number,status,total_minor`)).json ?? [];
const toGroup = (fx) => graphSends.filter((g) => JSON.stringify(g.body ?? {}).includes(`${fx.name}-group`));

console.log('\n\x1b[1mAgencyOS — the free-maintenance document (Phase 2 Finance §9)\x1b[0m');

try {
  section('1. Phase 7 complete: the document is raised and delivered with no payment to collect');
  const a = await plant('a', { paid: true, freePlan: true });
  await emit('handover.accepted', 'handover', a.handover.id);
  const raised = await tickUntil(async () => (await freeInvoices(a.plan.id))[0] ?? null);
  check(Boolean(raised), 'a free-maintenance document is raised when the handover is accepted');
  check(raised?.total_minor === 0 && raised?.status === 'paid', 'it is zero rupees and needs no collection', `${raised?.total_minor} / ${raised?.status}`);
  const delivered = await tickUntil(async () => {
    const rows = (await rest('GET', 'finance', `invoice_deliveries?invoice_id=eq.${raised.id}&select=channel,status`)).json ?? [];
    return rows.find((r) => r.channel === 'whatsapp')?.status === 'sent' && rows.some((r) => r.channel === 'email') ? rows : null;
  });
  check(Boolean(delivered), 'it is delivered to the project group');
  // The four milestone invoices were delivered too (issuing delivers); only the free document is looked at here.
  const texts = toGroup(a).filter((g) => g.body?.type === 'text' && /free maintenance/i.test(g.body?.text?.body ?? ''));
  const docs = toGroup(a).filter((g) => g.body?.type === 'document' && JSON.stringify(g.body).includes(raised.number));
  check(texts.length === 1 && docs.length === 1, 'one text and one PDF of the free document reached the group', `${texts.length} text(s), ${docs.length} PDF(s)`);
  const said = texts[0]?.body?.text?.body ?? '';
  check(/No payment is needed/.test(said) && /2027-10-31/.test(said), 'the text says nothing is owed and names the period the plan states', said.slice(0, 80));
  check(!/[₹$]|\brs\.?\s*\d|\brupees?\b|\binr\b/i.test(said), 'and carries no amount');
  const payments = (await rest('GET', 'finance', `payment_submissions?invoice_id=eq.${raised.id}&select=id`)).json ?? [];
  check(payments.length === 0, 'no payment was asked for and none needs verifying', `${payments.length}`);

  const before = graphSends.length;
  await emit('handover.accepted', 'handover', a.handover.id);
  for (let i = 0; i < 8; i += 1) await tick();
  check((await freeInvoices(a.plan.id)).length === 1 && graphSends.length === before, 'a replayed acceptance raises nothing and sends nothing again', `${graphSends.length - before} send(s)`);

  section('2. Payment not yet 100% verified: refused, and staff are told');
  const b = await plant('b', { paid: false, freePlan: true });
  await emit('handover.accepted', 'handover', b.handover.id);
  const told = await tickUntil(async () => ((await rest('GET', 'core', `alerts?fingerprint=eq.free-maintenance-refused:${b.project.id}&select=id`)).json ?? []).length === 1);
  check(Boolean(told), 'staff are told the document waits on verified payment');
  check((await freeInvoices(b.plan.id)).length === 0, 'and no document was raised');

  section('3. No free maintenance: nothing');
  const c = await plant('c', { paid: true, freePlan: false });
  await emit('handover.accepted', 'handover', c.handover.id);
  for (let i = 0; i < 10; i += 1) await tick();
  check(!toGroup(c).some((g) => /free maintenance/i.test(JSON.stringify(g.body ?? {}))), 'a project with no free-included plan is told nothing about free maintenance');
  const cInvoices = (await rest('GET', 'finance', `invoices?project_id=eq.${c.project.id}&total_minor=eq.0&select=id`)).json ?? [];
  check(cInvoices.length === 0, 'and no zero-rupee document exists for it');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  graph.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
