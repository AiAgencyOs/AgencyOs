/**
 * The reactivation pilot gate — G-140 / ADM-87.
 *
 * The inactive_lead follow-up situation (ADM-69) would reach every open lead.
 * Reactivating 1,200+ historical leads that way is a commercial decision with
 * consent and volume risk, so it is now opt-in per org and per lead. This proves
 * the gate holds where it must, and — the check that matters most — that an
 * authenticated end-user cannot flip it past the sanctioned functions.
 *
 * Every negative here is red-proofed: default-off emits nothing, an unenrolled
 * lead emits nothing, a consent-less lead cannot be enrolled, and a direct
 * Data-API PATCH of either flag is refused even to an owner. The positives are
 * the counterpart: enable the org, enrol a consented lead, and the observer
 * offers exactly it.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

// Needs the service key (drives the DB directly) and the JWT secret (mints an
// authenticated owner to prove the guard refuses a direct write). No cron.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-reactivation-pilot');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest-g140-${randomUUID().slice(0, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

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
  return { status: res.status, json: parse(text), text };
}
const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900,
  });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const setPilot = (enabled) =>
  rest('POST', 'core', 'rpc/set_reactivation_pilot', { p_organization_id: ORG, p_enabled: enabled });
const addLead = (leadId) =>
  rest('POST', 'crm', 'rpc/add_lead_to_reactivation_pilot', { p_lead_id: leadId });
const offeredInactive = async (leadId) => {
  const r = await rest('POST', 'crm', 'rpc/observe_follow_up_candidates', { p_limit: 1000 });
  const rows = Array.isArray(r.json) ? r.json : [];
  return rows.filter((c) => c.subject_id === leadId && c.situation_key === 'inactive_lead').length;
};
const leadFlag = async (leadId) =>
  one(await rest('GET', 'crm', `leads?id=eq.${leadId}&select=in_reactivation_pilot`))?.in_reactivation_pilot;

async function makeLead(consented) {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} contact`, phone: `+9198${Math.floor(Math.random() * 1e8)}`,
  }));
  created.contacts.push(contact.id);
  if (consented) {
    await rest('POST', 'crm', 'communication_consent', {
      organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
    });
  }
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, title: `${MARKER} lead`, status: 'qualifying', contact_id: contact.id,
  }));
  created.leads.push(lead.id);
  return lead.id;
}

const created = { users: [], leads: [], contacts: [] };
console.log('\n\x1b[1mAgencyOS — reactivation pilot gate (G-140 / ADM-87)\x1b[0m');

try {
  // An authenticated owner, for the "cannot bypass" proofs.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active' });
  const owner = mint(authUser.id, 'owner');

  // Start from a known-off gate regardless of prior state.
  await setPilot(false);

  console.log('\n1. Default OFF — a consented, open lead is not offered');
  const lead = await makeLead(true);
  check(await offeredInactive(lead) === 0, 'the observer offers nothing while the org gate is off', `${await offeredInactive(lead)}`);

  console.log('\n2. Org ON but the lead is not enrolled — still nothing');
  check(one(await setPilot(true))?.outcome === 'enabled', 'the org gate turns on');
  check(await offeredInactive(lead) === 0, 'an unenrolled lead is still not offered');

  console.log('\n3. A lead without granted whatsapp consent cannot be enrolled');
  const cold = await makeLead(false);
  check(one(await addLead(cold))?.outcome === 'no_consent', 'enrolment is refused as no_consent');
  check(await leadFlag(cold) === false, 'and the cohort flag is not set');

  console.log('\n4. A consented lead can be enrolled');
  check(one(await addLead(lead))?.outcome === 'added', 'enrolment succeeds');
  check(await leadFlag(lead) === true, 'and the cohort flag is set');
  check(one(await addLead(lead))?.outcome === 'already_in', 'a second enrolment is idempotent');

  console.log('\n5. Enrolled + gate ON — the observer offers exactly this lead');
  check(await offeredInactive(lead) === 1, 'the enrolled lead is offered once');

  console.log('\n6. The gate cannot be flipped by a direct authenticated write');
  {
    // As an OWNER — the role RLS would otherwise let write the row — a direct
    // PATCH of either flag is refused by the guard trigger. This is the check
    // the whole feature stands on.
    const patchLead = await call(owner, 'PATCH', 'crm', `leads?id=eq.${cold}`, { in_reactivation_pilot: true });
    check(patchLead.status >= 400, 'a direct PATCH of crm.leads.in_reactivation_pilot is refused', `status ${patchLead.status}`);
    check(await leadFlag(cold) === false, 'and the flag is unchanged');

    const patchOrg = await call(owner, 'PATCH', 'core', `organizations?id=eq.${ORG}`, { reactivation_pilot_enabled: false });
    check(patchOrg.status >= 400, 'a direct PATCH of core.organizations.reactivation_pilot_enabled is refused', `status ${patchOrg.status}`);
    const orgFlag = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=reactivation_pilot_enabled`))?.reactivation_pilot_enabled;
    check(orgFlag === true, 'and the org gate is unchanged (still on)');

    // The guard is column-scoped: an ordinary lead write by the same owner still
    // works, so this is a lock on one column, not on the table.
    const patchTitle = await call(owner, 'PATCH', 'crm', `leads?id=eq.${cold}`, { title: `${MARKER} renamed` });
    check(patchTitle.status < 300, 'but an ordinary lead write by the same owner still succeeds', `status ${patchTitle.status}`);
  }

  console.log('\n7. The enable and the enrolment are audited');
  {
    const orgAudit = await rest('GET', 'audit',
      `audit_log?subject_id=eq.${ORG}&action=eq.organization.reactivation_pilot_enabled&select=action&limit=1`);
    check(Array.isArray(orgAudit.json) && orgAudit.json.length === 1, 'the org enable wrote an audit row');
    const leadAudit = await rest('GET', 'audit',
      `audit_log?subject_id=eq.${lead}&subject_type=eq.lead&order=created_at.desc&select=action,after&limit=5`);
    const rows = Array.isArray(leadAudit.json) ? leadAudit.json : [];
    check(rows.some((r) => r.after && r.after.in_reactivation_pilot === true), 'the enrolment is captured in the lead audit trail');
  }
} finally {
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    });
  }
  // Return the shared org's gate to its default.
  await setPilot(false);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ The reactivation pilot is off by default, consent-gated, and cannot be bypassed\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
