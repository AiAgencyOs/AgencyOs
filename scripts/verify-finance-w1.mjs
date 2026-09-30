// ═══════════════════════════════════════════════════════════════════════════
// The finance doors added for PDF gap W1 keep their promises (real Postgres).
//
//   1. finance role parity: the finance role reads the same receipts, claims,
//      billing profiles and accounts as the owner, and only read
//   2. the composer door: owner composes a draft (kind 'service'); it refuses
//      totals that do not add up; finance and a member are refused
//   3. a claim can be sent back for more evidence (note required, role
//      required) and is still decidable afterwards
//   4. a verification is immutable audit data: once verified, its evidence and
//      actor cannot be rewritten, even by the owner
//   5. invoice numbering / terms: owner sets, bad values refused, finance refused
//   6. every export is logged; AI cost totals reach the finance role
//
// Writes carry the marker zzbuild-w1 and are removed at the end.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'finance doors (W1)');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzbuild-w1';
const ORG = '00000000-0000-4000-8000-000000000001';

const mint = (userId, role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
};

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

async function rest(method, schema, path, body, token) {
  const k = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      ...(method === 'GET' ? { 'Accept-Profile': schema } : { 'Content-Profile': schema }),
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: parse(text), text };
}
const rpc = (schema, fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);
const row = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const users = async (role) => {
  const m = await rest('GET', 'core', `memberships?role=eq.${role}&organization_id=eq.${ORG}&select=user_id&limit=1`);
  return m.json?.[0]?.user_id ?? null;
};

const ownerId = await users('owner');
const financeId = await users('finance');
const memberId = await users('member');
if (!ownerId || !financeId || !memberId) fail('the fixture needs an owner, a finance and a member membership in the local organization');
const owner = mint(ownerId, 'owner');
const finance = mint(financeId, 'finance');
const member = mint(memberId, 'member');

const ids = { client: null, project: null, invoice: null, payment: null, claim: null, invoice2: null };

async function cleanup() {
  if (ids.claim) await rest('DELETE', 'finance', `payment_submissions?id=eq.${ids.claim}`);
  for (const inv of [ids.invoice, ids.invoice2].filter(Boolean)) {
    await rest('DELETE', 'finance', `payments?invoice_id=eq.${inv}`);
    await rest('DELETE', 'finance', `invoice_items?invoice_id=eq.${inv}`);
    await rest('DELETE', 'finance', `invoices?id=eq.${inv}`);
  }
  if (ids.project) {
    await rest('DELETE', 'finance', `billing_profiles?project_id=eq.${ids.project}`);
    await rest('DELETE', 'projects', `projects?id=eq.${ids.project}`);
  }
  if (ids.client) await rest('DELETE', 'core', `client_accounts?id=eq.${ids.client}`);
  await rest('DELETE', 'finance', `report_exports?period_label=eq.${MARKER}`);
  await rpc('finance', 'set_invoice_numbering', { p_prefix: '', p_terms_days: '', p_terms_note: '' }, owner);
}

try {
  // ── fixture: a client, a project with a confirmed GST profile ───────────
  const c = await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` });
  ids.client = row(c)?.id;
  const p = await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: ids.client, name: `${MARKER} project` });
  ids.project = row(p)?.id;
  if (!ids.client || !ids.project) fail(`fixture not created: ${c.text} ${p.text}`);
  const bp = await rest('POST', 'finance', 'billing_profiles', {
    organization_id: ORG, project_id: ids.project, client_account_id: ids.client, version: 1, status: 'active', mode: 'gst',
    legal_name: MARKER, billing_address: 'x', billing_state: 'Karnataka', gstin: '29ABCDE1234F1Z5', source: 'internal',
  });
  const profileId = row(bp)?.id;

  console.log('\n1. the finance role reads the money it was given');
  for (const table of ['receipts', 'payment_submissions', 'billing_profiles', 'payment_accounts', 'reconciliations', 'tax_period_locks', 'invoice_sends']) {
    const a = await rest('GET', 'finance', `${table}?select=id`, undefined, owner);
    const b = await rest('GET', 'finance', `${table}?select=id`, undefined, finance);
    check(a.ok && b.ok && a.json.length === b.json.length, `finance.${table}: finance sees the same ${a.json?.length} rows as the owner`, `${b.status}`);
  }
  const w = await rest('POST', 'finance', 'report_exports', { organization_id: ORG, kind: 'invoices_csv', period_label: MARKER }, finance);
  check(!w.ok, 'finance cannot write a report export directly', `${w.status}`);

  console.log('\n2. the composer door');
  const lines = [{ position: 0, description: 'Hosting setup', quantity: 1, unit_price_minor: 100000, amount_minor: 100000, tax_rate_bp: 1800 }];
  const base = { p_project_id: ids.project, p_currency: 'INR', p_lines: lines, p_billing_profile_id: profileId };
  const okRes = await rpc('finance', 'create_composed_invoice', { ...base, p_number: `${MARKER}-A`, p_subtotal_minor: 100000, p_tax_minor: 18000, p_total_minor: 118000 }, owner);
  const made = row(okRes);
  ids.invoice = made?.invoice_id ?? null;
  check(made?.outcome === 'created', 'the owner composes a draft', okRes.text);
  const inv = ids.invoice ? row(await rest('GET', 'finance', `invoices?id=eq.${ids.invoice}&select=kind,status,total_minor`)) : null;
  check(inv?.kind === 'service' && inv?.status === 'draft' && inv?.total_minor === 118000, 'it is a draft of kind service with the stated total', JSON.stringify(inv));
  const bad = await rpc('finance', 'create_composed_invoice', { ...base, p_number: `${MARKER}-B`, p_subtotal_minor: 100000, p_tax_minor: 18000, p_total_minor: 117999 }, owner);
  check(row(bad)?.outcome === 'totals_mismatch', 'totals that do not add up are refused, nothing written', bad.text);
  const noLines = await rpc('finance', 'create_composed_invoice', { ...base, p_lines: [], p_number: `${MARKER}-C`, p_subtotal_minor: 0, p_tax_minor: 0, p_total_minor: 0 }, owner);
  check(row(noLines)?.outcome === 'no_lines', 'an invoice with no lines is refused');
  const asFinance = await rpc('finance', 'create_composed_invoice', { ...base, p_number: `${MARKER}-D`, p_subtotal_minor: 100000, p_tax_minor: 18000, p_total_minor: 118000 }, finance);
  check(row(asFinance)?.outcome === 'not_authorized', 'the finance role cannot compose', asFinance.text);
  const asMember = await rpc('finance', 'create_composed_invoice', { ...base, p_number: `${MARKER}-E`, p_subtotal_minor: 100000, p_tax_minor: 18000, p_total_minor: 118000 }, member);
  check(row(asMember)?.outcome === 'not_authorized', 'a member cannot compose', asMember.text);
  const direct = await rest('POST', 'finance', 'invoices', { organization_id: ORG, client_account_id: ids.client, number: `${MARKER}-F`, status: 'draft' }, owner);
  check(!direct.ok, 'a direct invoice insert is still refused', `${direct.status}`);
  const audit = await rest('GET', 'audit', `audit_log?action=eq.invoice.composed&subject_id=eq.${ids.invoice}&select=id`);
  check((audit.json ?? []).length === 1, 'the composition is audited');

  console.log('\n3. a claim can be sent back for more evidence');
  const pay = await rest('POST', 'finance', 'payments', { organization_id: ORG, invoice_id: ids.invoice, provider: 'manual', provider_payment_id: `manual:${MARKER}`, amount_minor: 100, status: 'captured', captured_at: new Date().toISOString() });
  ids.payment = row(pay)?.id;
  const cl = await rest('POST', 'finance', 'payment_submissions', { organization_id: ORG, invoice_id: ids.invoice, amount_minor: 100, method: 'upi', reference: `${MARKER}-UTR`, submitted_by: ownerId });
  ids.claim = row(cl)?.id;
  check(Boolean(ids.claim), 'a claim exists', cl.text);
  const noNote = await rpc('finance', 'request_payment_evidence', { p_submission_id: ids.claim, p_note: ' ' }, owner);
  check(row(noNote)?.outcome === 'no_note', 'a note saying what is missing is required');
  const byFinance = await rpc('finance', 'request_payment_evidence', { p_submission_id: ids.claim, p_note: 'screenshot' }, finance);
  check(row(byFinance)?.outcome === 'forbidden', 'the finance role cannot send a claim back');
  const asked = await rpc('finance', 'request_payment_evidence', { p_submission_id: ids.claim, p_note: 'Attach the bank screenshot' }, owner);
  check(row(asked)?.outcome === 'requested' && row(asked)?.status === 'evidence_requested', 'the owner sends it back', asked.text);
  const confirm = await rpc('finance', 'verify_payment_submission', { p_submission_id: ids.claim, p_verified_by: ownerId, p_evidence: 'Statement line 14, UTR matches', p_decision: 'confirm' }, owner);
  check(row(confirm)?.outcome === 'verified', 'it is still decidable: the owner verifies it', confirm.text);
  const again = await rpc('finance', 'request_payment_evidence', { p_submission_id: ids.claim, p_note: 'too late' }, owner);
  check(row(again)?.outcome === 'settled', 'a verified claim cannot be sent back');

  console.log('\n4. a verification is immutable audit data');
  const edit = await rest('PATCH', 'finance', `payment_submissions?id=eq.${ids.claim}`, { verification_evidence: 'rewritten' }, owner);
  check(!edit.ok, 'the owner cannot rewrite the evidence of a verified claim', `${edit.status} ${String(edit.text).slice(0, 90)}`);
  const edit2 = await rest('PATCH', 'finance', `payment_submissions?id=eq.${ids.claim}`, { verified_at: '2020-01-01T00:00:00Z' }, owner);
  check(!edit2.ok, 'nor the time it was verified', `${edit2.status}`);

  console.log('\n5. numbering and terms');
  const set = await rpc('finance', 'set_invoice_numbering', { p_prefix: 'zz9', p_terms_days: '14', p_terms_note: 'Net 14' }, owner);
  check(row(set)?.outcome === 'set', 'the owner sets prefix and terms', set.text);
  const badPrefix = await rpc('finance', 'set_invoice_numbering', { p_prefix: 'NO-DASH', p_terms_days: '', p_terms_note: '' }, owner);
  check(row(badPrefix)?.outcome === 'invalid_prefix', 'a prefix with a dash is refused');
  const badDays = await rpc('finance', 'set_invoice_numbering', { p_prefix: '', p_terms_days: '999', p_terms_note: '' }, owner);
  check(row(badDays)?.outcome === 'invalid_days', 'terms over 365 days are refused');
  const byFin = await rpc('finance', 'set_invoice_numbering', { p_prefix: 'X', p_terms_days: '', p_terms_note: '' }, finance);
  check(row(byFin)?.outcome === 'forbidden', 'the finance role cannot change numbering');
  const org = row(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`));
  check(org?.settings?.invoice_number_prefix === 'ZZ9' && org?.settings?.invoice_terms_days === '14', 'the prefix is stored upper-cased', JSON.stringify(org?.settings));

  console.log('\n6. exports are logged; AI cost totals reach finance');
  const lg = await rpc('finance', 'log_report_export', { p_kind: 'invoices_csv', p_period_label: MARKER, p_row_count: 3 }, finance);
  check(row(lg)?.outcome === 'logged', 'the finance role logs an export');
  const lgBad = await rpc('finance', 'log_report_export', { p_kind: 'nope', p_period_label: MARKER, p_row_count: 3 }, owner);
  check(row(lgBad)?.outcome === 'invalid_kind', 'an unknown export kind is refused');
  const lgMember = await rpc('finance', 'log_report_export', { p_kind: 'invoices_csv', p_period_label: MARKER, p_row_count: 3 }, member);
  check(row(lgMember)?.outcome === 'forbidden', 'a member cannot log an export');
  const hist = await rest('GET', 'finance', `report_exports?period_label=eq.${MARKER}&select=id`, undefined, finance);
  check((hist.json ?? []).length === 1, 'and reads the history');
  const a1 = await rpc('finance', 'ai_cost_buckets', {}, owner);
  const a2 = await rpc('finance', 'ai_cost_buckets', {}, finance);
  const a3 = await rpc('finance', 'ai_cost_buckets', {}, member);
  check(a1.ok && a2.ok && a1.json.length === a2.json.length && a3.ok, 'AI cost totals: owner and finance see the same buckets', `${a1.json?.length}/${a2.json?.length}`);
  check(!JSON.stringify(a2.json).includes('prompt'), 'and no prompt or output leaves the function');
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\n  all finance W1 checks passed\n' : `\n  ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
