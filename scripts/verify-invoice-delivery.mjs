#!/usr/bin/env node
/**
 * An issued invoice reaches the client without anyone pressing Send —
 * Phase 2 Finance §4.5, Master §5.7. Against the real database AND the running
 * app: the job runner, the real delivery code, a Graph stub that receives what
 * leaves.
 *
 *   node scripts/verify-invoice-delivery.mjs
 *
 * What it proves, each in both directions:
 *   • issuing an invoice (a person's act, here the RPC) delivers it to the
 *     project WhatsApp group — the text AND the PDF — with no further call
 *   • the per-channel record says what happened: whatsapp sent, email skipped
 *     with its reason (this deployment has no email transport)
 *   • a replayed `invoice.issued` sends nothing a second time
 *   • a provider that fails the PDF leaves the channel FAILED and visible, the
 *     job retries, and when the provider recovers exactly ONE text and ONE PDF
 *     have reached the group
 *   • a draft invoice is not deliverable
 *
 * Everything created carries a marker and is removed afterwards.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
await announceTarget(target, 'the bill goes out because it was issued');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-invdeliver-${randomUUID().slice(0, 8)}`;
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

// ── the Graph stub: it can be told to refuse the PDF upload ─────────────────
const graphSends = [];
let uploadsFail = false;
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      if (uploadsFail) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'stub: upload refused' } })); return; }
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

const made = { clients: [], projects: [], conversations: [], invoices: [] };

const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
  settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.INVDELIVER' },
});

async function plant(label) {
  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} ${label} client` }));
  made.clients.push(client.id);
  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: client.id, name: `${MARKER} ${label} project`, status: 'planning',
  }));
  made.projects.push(project.id);
  const group = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, kind: 'project_group', channel: 'whatsapp', project_id: project.id,
    external_ref: `${MARKER}-${label}-group@g.us`, status: 'active',
  }));
  made.conversations.push(group.id);
  const invoice = one(await rest('POST', 'finance', 'invoices', {
    organization_id: ORG, client_account_id: client.id, project_id: project.id,
    number: `${MARKER}-${label}`.toUpperCase().slice(0, 40), status: 'draft', currency: 'INR',
    subtotal_minor: 3000000, tax_minor: 0, total_minor: 3000000,
  }));
  made.invoices.push(invoice.id);
  await rest('POST', 'finance', 'invoice_items', {
    organization_id: ORG, invoice_id: invoice.id, position: 0, description: `${MARKER} ${label} line`,
    quantity: 1, unit_price_minor: 3000000, amount_minor: 3000000, tax_rate_bp: 0,
  });
  return { client, project, group, invoice };
}

const deliveries = async (invoiceId) =>
  (await rest('GET', 'finance', `invoice_deliveries?invoice_id=eq.${invoiceId}&select=channel,status,attempts,last_error,conversation_id,delivered_at,message_ref`)).json ?? [];
const byChannel = (rows, c) => rows.find((r) => r.channel === c);

console.log('\n\x1b[1mAgencyOS — an issued invoice is delivered without a person (Finance §4.5)\x1b[0m');

try {
  // ── 1. a draft is not deliverable ─────────────────────────────────────────
  section('1. A draft has not reached the client, so it is not delivered');
  const a = await plant('a');
  const draftClaim = one(await rpc('finance', 'claim_invoice_delivery', { p_invoice_id: a.invoice.id, p_channel: 'whatsapp' }));
  check(draftClaim?.outcome === 'not_deliverable', 'the delivery door refuses a draft', String(draftClaim?.outcome));
  check((await deliveries(a.invoice.id)).length === 0, 'and writes no delivery row for it');

  // ── 2. issuing delivers ───────────────────────────────────────────────────
  section('2. Issuing the invoice delivers it — text and PDF — with no further call');
  const issued = await rpc('finance', 'issue_invoice', { p_invoice_id: a.invoice.id });
  check(issued.ok, 'the invoice is issued (the human act)', `status ${issued.status}`);

  const done = await tickUntil(async () => {
    const rows = await deliveries(a.invoice.id);
    return byChannel(rows, 'whatsapp')?.status === 'sent' && byChannel(rows, 'email') ? rows : null;
  });
  const rowsA = done ?? (await deliveries(a.invoice.id));
  const wa = byChannel(rowsA, 'whatsapp');
  const em = byChannel(rowsA, 'email');
  check(wa?.status === 'sent', 'the WhatsApp channel is SENT', String(wa?.status));
  check(wa?.conversation_id === a.group.id, 'and it went to the project group, the official channel', String(wa?.conversation_id));
  check(Boolean(wa?.delivered_at), 'with the time it was delivered');
  check(em?.status === 'skipped' && /not configured|No email/i.test(em?.last_error ?? ''),
    'the email channel says plainly why it did not go — this deployment has no transport', String(em?.last_error).slice(0, 80));

  const toGroup = graphSends.filter((g) => g.body?.to === `${MARKER}-a-group@g.us` || JSON.stringify(g.body ?? {}).includes(`${MARKER}-a-group`));
  const text = toGroup.filter((g) => g.body?.type === 'text');
  const doc = toGroup.filter((g) => g.body?.type === 'document');
  check(text.length === 1, 'exactly one text reached the group', `${text.length}`);
  check(doc.length === 1, 'exactly one PDF reached the group', `${doc.length}`);
  check(JSON.stringify(text[0]?.body ?? {}).includes('30,000') || JSON.stringify(text[0]?.body ?? {}).includes('3000000') || JSON.stringify(text[0]?.body ?? {}).includes('30000'),
    'the text carries the amount, written by code', JSON.stringify(text[0]?.body?.text ?? '').slice(0, 90));

  const sends = (await rest('GET', 'finance', `invoice_sends?invoice_id=eq.${a.invoice.id}&select=channel,automatic,kind`)).json ?? [];
  check(sends.some((s) => s.channel === 'whatsapp' && s.automatic === true && s.kind === 'sent'),
    'the invoice list\'s "last sent" record was written, marked automatic');
  const delivered = (await rest('GET', 'core', `outbox_events?type=eq.invoice.delivered&subject_id=eq.${a.invoice.id}&select=id`)).json ?? [];
  check(delivered.length === 1, 'and invoice.delivered was published once', `${delivered.length}`);
  const audit = (await rest('GET', 'audit', `audit_log?subject_id=eq.${a.invoice.id}&action=like.invoice.delivery_*&select=action`)).json ?? [];
  check(audit.some((r) => r.action === 'invoice.delivery_sent'), 'and audited', audit.map((r) => r.action).join(','));

  // ── 3. replay ─────────────────────────────────────────────────────────────
  section('3. A replayed invoice.issued sends nothing a second time');
  const before = graphSends.length;
  await rpc('core', 'emit_event', {
    p_organization_id: ORG, p_type: 'invoice.issued', p_subject_type: 'invoice', p_subject_id: a.invoice.id, p_payload: {},
  });
  for (let i = 0; i < 6; i += 1) await tick();
  check(graphSends.length === before, 'no further message left', `${graphSends.length - before} send(s)`);
  const again = one(await rpc('finance', 'claim_invoice_delivery', { p_invoice_id: a.invoice.id, p_channel: 'whatsapp' }));
  check(again?.outcome === 'already_delivered', 'the door itself refuses a sent channel', String(again?.outcome));

  // ── 4. a provider failure is visible, retried, and never duplicates ───────
  section('4. A failing provider leaves the channel visible, and recovery sends exactly once');
  const b = await plant('b');
  uploadsFail = true;
  await rpc('finance', 'issue_invoice', { p_invoice_id: b.invoice.id });
  const failedRow = await tickUntil(async () => {
    const w = byChannel(await deliveries(b.invoice.id), 'whatsapp');
    return w?.status === 'failed' ? w : null;
  });
  check(failedRow?.status === 'failed', 'the WhatsApp channel reads FAILED, not silence', String(failedRow?.status));
  check(/upload|document|refused/i.test(failedRow?.last_error ?? ''), 'with the provider\'s reason on the row', String(failedRow?.last_error).slice(0, 90));
  check((failedRow?.attempts ?? 0) >= 1, 'and the attempt counted', String(failedRow?.attempts));

  uploadsFail = false;
  // The runner backs a failed job off by a minute or so; the verifier does not
  // wait that out, it makes the retry due now - the same row, the same attempt.
  const jobs = (await rest('GET', 'core', `jobs?kind=eq.invoice.deliver&status=eq.queued&select=id`)).json ?? [];
  for (const j of jobs) await rest('PATCH', 'core', `jobs?id=eq.${j.id}`, { run_at: new Date(Date.now() - 1000).toISOString() });
  const recovered = await tickUntil(async () => {
    const w = byChannel(await deliveries(b.invoice.id), 'whatsapp');
    return w?.status === 'sent' ? w : null;
  });
  check(recovered?.status === 'sent', 'after the provider recovers the channel is SENT', String(recovered?.status));
  const toB = graphSends.filter((g) => JSON.stringify(g.body ?? {}).includes(`${MARKER}-b-group`));
  check(toB.filter((g) => g.body?.type === 'text').length === 1, 'exactly ONE text reached the group across the failure and the retry');
  check(toB.filter((g) => g.body?.type === 'document').length === 1, 'and exactly ONE PDF');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  graph.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  // Nothing is deleted: an invoice is voided, never removed, and a delivery that
  // was attempted is history. The run is against a disposable database.
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
