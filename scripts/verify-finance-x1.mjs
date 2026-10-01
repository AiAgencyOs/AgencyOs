// ═══════════════════════════════════════════════════════════════════════════
// The finance doors added for PDF gap X1 keep their promises (real Postgres).
//
//   1. expense categories: the owner's list (decision 6). Add / rename /
//      retire / restore through one audited door; owner and ops_admin only;
//      a retired category is not offered to a new expense but an old expense
//      keeps it (and can still be edited); the last active one cannot be
//      retired; a new organization is seeded with the six; nobody writes the
//      table directly
//   2. the finance role reads a client's NAME and nothing else (decision 7)
//   3. the GST setup is an organization setting (decision 9): three keys,
//      closed vocabularies, owner / ops_admin only, audited; every earlier
//      key is still on the whitelist
//   4. an uploaded proof / receipt is a tenant-scoped path (decision 5)
//
// Writes carry the marker zzbuild-x1 and are removed (or restored) at the end.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'finance doors (X1)');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzbuild-x1';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'b96d23ff-3ca4-4054-a6b9-cf32399e91c6';

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

// A role the seed does not carry (CI seeds only an owner) gets a fixture user for this run, removed again in cleanup().
const fixtureUsers = [];
const users = async (role) => {
  const m = await rest('GET', 'core', `memberships?role=eq.${role}&organization_id=eq.${ORG}&select=user_id&limit=1`);
  if (m.json?.[0]?.user_id) return m.json[0].user_id;
  const email = `${MARKER}-${role}-${randomUUID().slice(0, 8)}@example.invalid`;
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  if (!authUser?.id) return null;
  fixtureUsers.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return authUser.id;
};
const dropFixtureUsers = async () => {
  for (const id of fixtureUsers) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
};

const ownerId = await users('owner');
const opsId = await users('ops_admin');
const financeId = await users('finance');
const memberId = await users('member');
if (!ownerId || !financeId || !memberId) fail('the fixture needs an owner, a finance and a member membership in the local organization');
const owner = mint(ownerId, 'owner');
const ops = opsId ? mint(opsId, 'ops_admin') : null;
const finance = mint(financeId, 'finance');
const member = mint(memberId, 'member');

const created = { categories: [], expenses: [], client: null, otherClient: null, org: null, retired: [] };
const SETTING_KEYS = ['gst_registration_type', 'gst_filing_frequency', 'gst_period_basis'];

async function cleanup() {
  for (const id of created.expenses) await rest('DELETE', 'finance', `expenses?id=eq.${id}`);
  // restore anything this run retired
  for (const key of created.retired) await rpc('finance', 'set_expense_category', { p_action: 'restore', p_key: key, p_label: '' }, owner);
  for (const key of created.categories) await rest('DELETE', 'finance', `expense_categories?organization_id=eq.${ORG}&key=eq.${key}`);
  if (created.client) await rest('DELETE', 'core', `client_accounts?id=eq.${created.client}`);
  if (created.otherClient) await rest('DELETE', 'core', `client_accounts?id=eq.${created.otherClient}`);
  if (created.org) await rest('DELETE', 'core', `organizations?id=eq.${created.org}`);
  for (const k of SETTING_KEYS) await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: k, p_value: '' }, owner);
}

try {
  console.log('\n1. the expense categories are the owner’s list');
  const list = await rest('GET', 'finance', `expense_categories?organization_id=eq.${ORG}&select=key,label,retired_at&order=sort_order`, undefined, owner);
  const keys = (list.json ?? []).map((c) => c.key);
  for (const k of ['infrastructure', 'ai', 'tooling', 'vendor', 'contractor', 'other']) check(keys.includes(k), `the starting list holds ${k}`);
  const asFinanceList = await rest('GET', 'finance', `expense_categories?organization_id=eq.${ORG}&select=key`, undefined, finance);
  check(asFinanceList.ok && asFinanceList.json.length === keys.length, 'the finance role reads the same list');
  const asMemberList = await rest('GET', 'finance', 'expense_categories?select=key', undefined, member);
  check(asMemberList.ok && asMemberList.json.length === 0, 'a member reads none');
  const direct = await rest('POST', 'finance', 'expense_categories', { organization_id: ORG, key: 'zzdirect', label: 'Direct' }, owner);
  check(!direct.ok, 'the owner cannot write the table directly', `${direct.status}`);

  const added = await rpc('finance', 'set_expense_category', { p_action: 'add', p_key: '', p_label: `${MARKER} Legal Fees` }, owner);
  check(row(added)?.outcome === 'added' && row(added)?.category_key === `${MARKER.replace('-', '_')}_legal_fees`.replace(/^zzbuild_x1/, 'zzbuild_x1'), 'the owner adds a category; its key is the label’s slug', added.text);
  const newKey = row(added)?.category_key;
  if (newKey) created.categories.push(newKey);
  const dupe = await rpc('finance', 'set_expense_category', { p_action: 'add', p_key: '', p_label: `${MARKER} legal fees` }, owner);
  check(row(dupe)?.outcome === 'exists', 'the same name again is refused, whatever the case');
  const badLabel = await rpc('finance', 'set_expense_category', { p_action: 'add', p_key: '', p_label: '   ' }, owner);
  check(row(badLabel)?.outcome === 'invalid_label', 'an empty name is refused');
  const byFinance = await rpc('finance', 'set_expense_category', { p_action: 'add', p_key: '', p_label: 'Finance Made' }, finance);
  check(row(byFinance)?.outcome === 'forbidden', 'the finance role cannot change the list');
  const byMember = await rpc('finance', 'set_expense_category', { p_action: 'add', p_key: '', p_label: 'Member Made' }, member);
  check(row(byMember)?.outcome === 'forbidden', 'a member cannot change the list');
  if (ops) {
    const byOps = await rpc('finance', 'set_expense_category', { p_action: 'rename', p_key: newKey, p_label: `${MARKER} Legal` }, ops);
    check(row(byOps)?.outcome === 'renamed', 'ops_admin may rename', byOps.text);
  }
  const clash = await rpc('finance', 'set_expense_category', { p_action: 'rename', p_key: newKey, p_label: 'Tooling' }, owner);
  check(row(clash)?.outcome === 'exists', 'a rename onto another category’s name is refused');
  const unknown = await rpc('finance', 'set_expense_category', { p_action: 'retire', p_key: 'no_such_key', p_label: '' }, owner);
  check(row(unknown)?.outcome === 'not_found', 'an unknown key is not_found');
  const badAction = await rpc('finance', 'set_expense_category', { p_action: 'delete', p_key: newKey, p_label: '' }, owner);
  check(row(badAction)?.outcome === 'invalid_action', 'there is no delete verb');

  // an expense under the new category, then retire it
  const ex = await rest('POST', 'finance', 'expenses', { organization_id: ORG, category: newKey, description: `${MARKER} counsel`, amount_minor: 1000, incurred_on: '2026-10-01' });
  const exId = row(ex)?.id;
  if (exId) created.expenses.push(exId);
  check(ex.ok, 'an expense may be filed under the new category', ex.text);
  const retire = await rpc('finance', 'set_expense_category', { p_action: 'retire', p_key: newKey, p_label: '' }, owner);
  check(row(retire)?.outcome === 'retired', 'the owner retires it', retire.text);
  const again = await rpc('finance', 'set_expense_category', { p_action: 'retire', p_key: newKey, p_label: '' }, owner);
  check(row(again)?.outcome === 'unchanged', 'retiring twice changes nothing');
  const stillThere = row(await rest('GET', 'finance', `expenses?id=eq.${exId}&select=category`));
  check(stillThere?.category === newKey, 'the old expense keeps its category');
  const edit = await rest('PATCH', 'finance', `expenses?id=eq.${exId}`, { description: `${MARKER} counsel (edited)` });
  check(edit.ok, 'and can still be edited while it keeps it', edit.text);
  const refile = await rest('POST', 'finance', 'expenses', { organization_id: ORG, category: newKey, description: `${MARKER} new`, amount_minor: 1, incurred_on: '2026-10-01' });
  check(!refile.ok, 'a NEW expense cannot be filed under a retired category', `${refile.status} ${String(refile.text).slice(0, 80)}`);
  const unlisted = await rest('POST', 'finance', 'expenses', { organization_id: ORG, category: 'zz_not_a_category', description: `${MARKER} nope`, amount_minor: 1, incurred_on: '2026-10-01' });
  check(!unlisted.ok, 'nor under a key the list never held', `${unlisted.status}`);
  const move = await rest('PATCH', 'finance', `expenses?id=eq.${exId}`, { category: 'zz_not_a_category' });
  check(!move.ok, 'an expense cannot be moved to an unlisted category');
  const toOther = await rest('PATCH', 'finance', `expenses?id=eq.${exId}`, { category: 'other' });
  check(toOther.ok, 'but may be re-filed under an active one', toOther.text);
  const restore = await rpc('finance', 'set_expense_category', { p_action: 'restore', p_key: newKey, p_label: '' }, owner);
  check(row(restore)?.outcome === 'restored', 'the owner restores it');
  const audit = await rest('GET', 'audit', `audit_log?subject_type=eq.expense_category&select=action&order=created_at.desc&limit=20`);
  const actions = new Set((audit.json ?? []).map((a) => a.action));
  check(['finance.expense_category_added', 'finance.expense_category_retired', 'finance.expense_category_restored'].every((a) => actions.has(a)), 'every change is audited', [...actions].join(', '));

  // the last active category cannot be retired
  const active = (await rest('GET', 'finance', `expense_categories?organization_id=eq.${ORG}&retired_at=is.null&select=key`, undefined, owner)).json.map((c) => c.key);
  let last = null;
  for (const k of active) {
    const r = row(await rpc('finance', 'set_expense_category', { p_action: 'retire', p_key: k, p_label: '' }, owner));
    if (r?.outcome === 'retired') created.retired.push(k);
    else {
      last = r?.outcome;
      break;
    }
  }
  check(last === 'last_active', 'the last active category cannot be retired');
  for (const k of created.retired.splice(0)) await rpc('finance', 'set_expense_category', { p_action: 'restore', p_key: k, p_label: '' }, owner);

  const newOrg = await rest('POST', 'core', 'organizations', { name: `${MARKER} org`, slug: `${MARKER}-${Date.now()}` });
  created.org = row(newOrg)?.id ?? null;
  if (created.org) {
    const seeded = await rest('GET', 'finance', `expense_categories?organization_id=eq.${created.org}&select=key`);
    check((seeded.json ?? []).length === 6, 'a new organization is seeded with the six', `${seeded.json?.length}`);
  } else {
    check(false, 'a new organization could be created for the seeding check', newOrg.text.slice(0, 120));
  }

  console.log('\n2. the finance role reads a client’s name and nothing else');
  const cl = await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client`, billing_email: 'secret@example.test' });
  created.client = row(cl)?.id ?? null;
  const oc = await rest('POST', 'core', 'client_accounts', { organization_id: OTHER_ORG, name: `${MARKER} other-tenant client` });
  created.otherClient = row(oc)?.id ?? null;
  if (!created.client || !created.otherClient) fail(`clients not created: ${cl.text} ${oc.text}`);
  const names = await rpc('finance', 'client_names', { p_ids: [created.client, created.otherClient] }, finance);
  check(names.ok && names.json.length === 1 && names.json[0].name === `${MARKER} client`, 'finance gets the name of its own tenant’s client', names.text);
  check(names.ok && Object.keys(names.json[0] ?? {}).sort().join() === 'id,name', 'and only the name: no contact, no e-mail', Object.keys(names.json?.[0] ?? {}).join());
  check(!JSON.stringify(names.json).includes('secret@example.test'), 'the billing e-mail does not leave the function');
  const direct2 = await rest('GET', 'core', `client_accounts?id=eq.${created.client}&select=id,name`, undefined, finance);
  check(direct2.ok && direct2.json.length === 0, 'finance still cannot read core.client_accounts directly');
  const asOwner = await rpc('finance', 'client_names', { p_ids: [created.client] }, owner);
  check(asOwner.ok && asOwner.json.length === 1, 'the owner reads through it too');
  const asMember = await rpc('finance', 'client_names', { p_ids: [created.client] }, member);
  check(asMember.ok && asMember.json.length === 0, 'a member gets nothing');
  const all = await rpc('finance', 'client_names', {}, finance);
  check(all.ok && all.json.some((c) => c.id === created.client) && !all.json.some((c) => c.id === created.otherClient), 'no ids lists this organization’s clients, names only, never another tenant’s');

  console.log('\n3. the GST setup is an organization setting');
  for (const [k, v] of [['gst_registration_type', 'regular'], ['gst_filing_frequency', 'monthly'], ['gst_period_basis', 'calendar_month'], ['gst_filing_frequency', 'quarterly']]) {
    const r = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: k, p_value: v }, owner);
    check(row(r)?.outcome === 'set', `the owner sets ${k} = ${v}`, r.text);
  }
  for (const [k, v] of [['gst_registration_type', 'partnership'], ['gst_filing_frequency', 'weekly'], ['gst_period_basis', 'financial_year']]) {
    const r = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: k, p_value: v }, owner);
    check(row(r)?.outcome === 'invalid_value', `${k} = ${v} is refused`);
  }
  const fin = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'gst_filing_frequency', p_value: 'monthly' }, finance);
  check(row(fin)?.outcome === 'forbidden', 'the finance role cannot change the GST setup');
  const settings = row(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`))?.settings ?? {};
  check(settings.gst_filing_frequency === 'quarterly' && settings.gst_registration_type === 'regular', 'the values are stored', JSON.stringify({ f: settings.gst_filing_frequency, r: settings.gst_registration_type }));
  const sAudit = await rest('GET', 'audit', `audit_log?action=eq.organization.setting_set&subject_id=eq.${ORG}&select=before,after&order=created_at.desc&limit=12`);
  check((sAudit.json ?? []).some((a) => a.after?.key === 'gst_filing_frequency' && a.after?.value === 'quarterly' && a.before?.value === 'monthly'), 'the change is audited with the old and the new value');
  const clear = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'gst_filing_frequency', p_value: '' }, owner);
  check(row(clear)?.outcome === 'cleared', 'clearing a key returns it to the default');
  // every earlier key is still on the whitelist
  for (const [k, v] of [['quotation_validity_days', '20'], ['funnel_min_leads_to_name_leak', '25'], ['meeting_offer_horizon_days', '10'], ['won_requires_payment_evidence', 'on'], ['pricing_day_rate_rupees', '9000']]) {
    const before = (await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)).json[0].settings[k] ?? '';
    const r = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: k, p_value: v }, owner);
    check(row(r)?.outcome === 'set', `${k} is still on the whitelist`, r.text);
    await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: k, p_value: before }, owner);
  }
  const bad = await rpc('core', 'set_organization_setting', { p_organization_id: ORG, p_key: 'not_a_key', p_value: 'x' }, owner);
  check(row(bad)?.outcome === 'invalid_key', 'an unknown key is still refused');

  console.log('\n4. an uploaded proof or receipt is a tenant-scoped path');
  const own = await rest('POST', 'finance', 'expenses', { organization_id: ORG, category: 'other', description: `${MARKER} receipt`, amount_minor: 5, incurred_on: '2026-10-01', receipt_storage_path: `${ORG}/finance/expense-receipt/x/r.pdf`, receipt_file_name: 'r.pdf' });
  if (row(own)?.id) created.expenses.push(row(own).id);
  check(own.ok, 'a receipt path under the tenant’s own folder is accepted', own.text.slice(0, 120));
  const foreign = await rest('POST', 'finance', 'expenses', { organization_id: ORG, category: 'other', description: `${MARKER} foreign`, amount_minor: 5, incurred_on: '2026-10-01', receipt_storage_path: `${OTHER_ORG}/finance/expense-receipt/x/r.pdf` });
  if (row(foreign)?.id) created.expenses.push(row(foreign).id);
  check(!foreign.ok, 'a path into another tenant’s folder is refused', `${foreign.status}`);
} finally {
  await cleanup();
  await dropFixtureUsers().catch(() => {});
}

console.log(failures === 0 ? '\n  all finance X1 checks passed\n' : `\n  ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
