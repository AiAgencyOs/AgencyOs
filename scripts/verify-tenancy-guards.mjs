#!/usr/bin/env node
/**
 * A child belongs to its parent's tenant — proven against the live schema.
 *
 * A foreign key proves the parent exists; it does not prove the child and the
 * parent share an organization. `core.enforce_parent_org` is the trigger that
 * closes that, applied to every org-scoped foreign key whose parent is also
 * org-scoped. This drives the graft the trigger exists to refuse, from a
 * service-role client (the surface that bypasses RLS and could write the
 * mismatch), across four schemas and the two ways a mismatch appears —
 * INSERT, and UPDATE (reparent or re-tenant) — and confirms the legitimate
 * paths still pass: a same-org write, and a SET NULL cascade.
 *
 * Structural completeness is checked too: the count of generated triggers,
 * read from the catalogue, must match the number of org-scoped relationships,
 * so a table added later without a guard is caught here rather than in
 * production.
 *
 * Hermetic: two throwaway organizations, deleted at the end.
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-tenancy-guards');

const URL_BASE = target.url;
const KEY = target.serviceKey;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json refusal */ }
  return { status: res.status, text, json };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const refused = (r) => r.status >= 400 && /tenancy:|belongs to organization/i.test(r.text);
const MARK = `zzten-${randomUUID().slice(0, 8)}`;

console.log('\n\x1b[1mAgencyOS — a child belongs to its parent\'s tenant (live)\x1b[0m');

const orgs = [];
async function makeOrg(label) {
  const o = one(await rest('POST', 'core', 'organizations', { name: `${MARK} ${label}`, slug: `${MARK}-${label}` }));
  orgs.push(o.id);
  return o.id;
}

try {
  const A = await makeOrg('a');
  const B = await makeOrg('b');

  // ── 0. structural completeness: no org-scoped fk is left unguarded ──────
  // core.unguarded_org_fks() reads the live catalogue, so a table added later
  // without a guard shows up here rather than in production.
  console.log('\n0. Every org-scoped foreign key is guarded, and every org is frozen');
  const unguarded = await rest('POST', 'core', 'rpc/unguarded_org_fks', {});
  const gaps = Array.isArray(unguarded.json) ? unguarded.json : [];
  check(gaps.length === 0, 'no org-scoped foreign key is missing its org-consistency guard',
    gaps.map((g) => `${g.child}.${g.fk_column}`).join(', '));
  const unfrozen = await rest('POST', 'core', 'rpc/unfrozen_org_tables', {});
  const thaw = Array.isArray(unfrozen.json) ? unfrozen.json : [];
  check(thaw.length === 0, 'no org-scoped table can be re-tenanted (organization_id frozen)',
    thaw.map((t) => t.org_table).join(', '));

  // ── 1. the guard refuses a cross-tenant graft on INSERT ─────────────────
  console.log('\n1. The guard refuses a cross-tenant graft on INSERT');

  // crm: an activity in org A pointing at org B's lead
  const leadA = one(await rest('POST', 'crm', 'leads', { organization_id: A, title: `${MARK} a`, status: 'qualifying' }));
  const leadB = one(await rest('POST', 'crm', 'leads', { organization_id: B, title: `${MARK} b`, status: 'qualifying' }));
  const graftCrm = await rest('POST', 'crm', 'lead_activities', { organization_id: A, lead_id: leadB.id, kind: 'note' });
  check(refused(graftCrm), 'crm.lead_activities → crm.leads: cross-tenant INSERT refused', graftCrm.text.slice(0, 90));

  // sales: an opportunity in org A pointing at org B's lead (cross-schema fk)
  const graftSales = await rest('POST', 'sales', 'opportunities', { organization_id: A, name: `${MARK} opp`, lead_id: leadB.id });
  check(refused(graftSales), 'sales.opportunities → crm.leads: cross-schema cross-tenant INSERT refused', graftSales.text.slice(0, 90));

  // finance: an invoice in org A pointing at org B's client account
  const caA = one(await rest('POST', 'core', 'client_accounts', { organization_id: A, name: `${MARK} caA` }));
  const caB = one(await rest('POST', 'core', 'client_accounts', { organization_id: B, name: `${MARK} caB` }));
  const graftFin = await rest('POST', 'finance', 'invoices', { organization_id: A, client_account_id: caB.id, number: `${MARK}-INV` });
  check(refused(graftFin), 'finance.invoices → core.client_accounts: cross-tenant INSERT refused', graftFin.text.slice(0, 90));

  // projects: a project in org A pointing at org B's client account
  const graftProj = await rest('POST', 'projects', 'projects', { organization_id: A, client_account_id: caB.id, name: `${MARK} proj` });
  check(refused(graftProj), 'projects.projects → core.client_accounts: cross-tenant INSERT refused', graftProj.text.slice(0, 90));

  // ── 2. the legitimate same-org write still passes ───────────────────────
  console.log('\n2. A same-tenant write is accepted');
  const act = one(await rest('POST', 'crm', 'lead_activities', { organization_id: A, lead_id: leadA.id, kind: 'note' }));
  check(Boolean(act?.id), 'crm.lead_activities same-org INSERT accepted', JSON.stringify(act).slice(0, 90));
  const oppA = one(await rest('POST', 'sales', 'opportunities', { organization_id: A, name: `${MARK} oppA`, lead_id: leadA.id }));
  check(Boolean(oppA?.id), 'sales.opportunities same-org INSERT accepted');

  // ── 3. the two UPDATE grafts are refused ────────────────────────────────
  console.log('\n3. Reparent and re-tenant are refused on UPDATE');
  const reparent = await rest('PATCH', 'crm', `lead_activities?id=eq.${act.id}`, { lead_id: leadB.id });
  check(refused(reparent), 'reparent-UPDATE (move fk to another tenant) refused', reparent.text.slice(0, 90));
  const retenant = await rest('PATCH', 'crm', `lead_activities?id=eq.${act.id}`, { organization_id: B });
  check(refused(retenant), 're-tenant-UPDATE (change own org) refused', retenant.text.slice(0, 90));

  // The parent-side move a child trigger cannot see: re-tenanting the PARENT
  // would orphan its children. The frozen organization_id refuses it.
  const parentOrphan = await rest('PATCH', 'core', `client_accounts?id=eq.${caA.id}`, { organization_id: B });
  check(refused(parentOrphan), 'parent re-tenant (which would orphan its children) refused', parentOrphan.text.slice(0, 90));

  // ── 4. a SET NULL cascade passes (the fk is nulled, nothing to match) ────
  console.log('\n4. A legitimate SET NULL cascade is not refused');
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: A, full_name: `${MARK} c`, phone: `+9198${Date.now() % 100000000}` }));
  const leadC = one(await rest('POST', 'crm', 'leads', { organization_id: A, title: `${MARK} lc`, status: 'qualifying', contact_id: contact.id }));
  // leads.contact_id is ON DELETE SET NULL; deleting the contact nulls it and
  // must not trip the org guard.
  const delContact = await rest('DELETE', 'crm', `contacts?id=eq.${contact.id}`);
  check(delContact.status < 400, 'deleting a SET NULL parent is allowed', `HTTP ${delContact.status}`);
  const nulled = one(await rest('GET', 'crm', `leads?id=eq.${leadC.id}&select=contact_id`));
  check(nulled?.contact_id === null, 'and the cascade nulled the fk, org guard skipped it');

  // The self-referential relationship (approvals.approval_requests.escalated_from)
  // is guarded by the same generated trigger, but is NOT exercised here: an
  // approval request is undeletable by design (approvals.reject_delete), so a
  // fixture would leave its throwaway organization uncleanable. That
  // relationship is proven in the migration's psql red-proofs instead.
} finally {
  for (const id of orgs) {
    const gone = await rest('DELETE', 'core', `organizations?id=eq.${id}`);
    check(gone.status < 400, `probe organization deletes cleanly (${id.slice(0, 8)})`, `HTTP ${gone.status}`);
  }
}

console.log(`\n  ${checks} checks`);
if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ A child cannot claim a tenant its parent does not share\x1b[0m');
