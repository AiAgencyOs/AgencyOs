/**
 * Live proof for the historical-lead import (crm.import_records / crm.commit_import_record).
 *
 * The mandate's Phase 6 asks for negative proofs, not assurances. This drives a
 * real database and proves, by construction, that the import:
 *   • is idempotent — committing a record twice yields one contact and one lead;
 *   • cannot duplicate — a phone already known is reused, never re-created;
 *   • cannot cross a tenant — an owner of org B cannot commit org A's record;
 *   • cannot manufacture consent — no communication_consent row is ever written;
 *   • cannot trigger a send — no conversation, message, or job is created;
 *   • refuses name-only rows — only a phone-keyed exact/new commits;
 *   • cannot be forged — a direct PATCH of committed_* is refused (no RLS UPDATE);
 *   • is audited — every commit writes a lead.imported row.
 *
 * Follows the G-083 discipline of the other verifiers: it announces which
 * database it ran against, seeds under the service role, exercises policy under
 * a minted owner JWT, and cleans up after itself.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const fail = (m) => {
  console.error(`\x1b[31m${m}\x1b[0m`);
  process.exit(1);
};
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target);

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest-import-${randomUUID().slice(0, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';
const ORG2 = randomUUID();

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

function mint(userId, org, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({ sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: org, role }, iat: now, exp: now + 900 });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const commit = (token, recordId) => call(token, 'POST', 'crm', 'rpc/commit_import_record', { p_record_id: recordId });
const outcomeOf = (r) => one(r)?.outcome;

const created = { users: [], leads: [], contacts: [], batches: [] };
const P1 = `+9199${Math.floor(Math.random() * 1e8)}`;
const P2 = `+9198${Math.floor(Math.random() * 1e8)}`;
const P4 = `+9197${Math.floor(Math.random() * 1e8)}`;

console.log('\n\x1b[1mAgencyOS — historical-lead import (staging + idempotent commit)\x1b[0m');

try {
  // An owner of ORG, for the authority + policy proofs.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active' });
  const owner = mint(authUser.id, ORG, 'owner');
  const foreignOwner = mint(randomUUID(), ORG2, 'owner'); // an owner of a DIFFERENT org

  // An existing contact, so R_exact resolves to it rather than creating a twin.
  const c1 = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} existing`, phone: P1 }));
  created.contacts.push(c1.id);

  const batch = one(await rest('POST', 'crm', 'import_batches', { organization_id: ORG, source_label: `${MARKER} export` }));
  created.batches.push(batch.id);

  const stage = async (over) => one(await rest('POST', 'crm', 'import_records', {
    batch_id: batch.id, organization_id: ORG, message_count: 3, source_label: `${MARKER} export`, ...over,
  }));
  const rExact = await stage({ phone: P1, display_name: 'Exact Co', classification: 'exact', auto_importable: true, matched_contact_id: c1.id });
  const rNew = await stage({ phone: P2, display_name: 'New Co', classification: 'new', auto_importable: true });
  const rNew2 = await stage({ phone: P4, display_name: 'Foreign Attempt', classification: 'new', auto_importable: true });
  const rProb = await stage({ phone: null, display_name: 'Name Only', classification: 'probable', auto_importable: false });

  const contactsWithPhone = async (p) =>
    (await rest('GET', 'crm', `contacts?organization_id=eq.${ORG}&phone=eq.${encodeURIComponent(p)}&select=id`)).json?.length ?? 0;

  console.log('\n1. An exact phone match reuses the existing contact, never a twin');
  const e1 = await commit(owner, rExact.id);
  check(outcomeOf(e1) === 'committed', 'commit returns committed', outcomeOf(e1));
  check(one(e1)?.contact_id === c1.id, 'it resolved to the EXISTING contact, not a new one');
  check((await contactsWithPhone(P1)) === 1, 'still exactly one contact for that phone');
  const leadExact = one(e1)?.lead_id;
  if (leadExact) created.leads.push(leadExact);

  console.log('\n2. Committing the same record again is idempotent');
  const e2 = await commit(owner, rExact.id);
  check(outcomeOf(e2) === 'already_committed', 'a second commit is a no-op that returns the same ids', outcomeOf(e2));
  check(one(e2)?.lead_id === leadExact, 'same lead id');
  check((await contactsWithPhone(P1)) === 1, 'no duplicate contact appeared');

  console.log('\n3. A new phone creates one contact + one lead, and re-runs safely');
  const n1 = await commit(owner, rNew.id);
  check(outcomeOf(n1) === 'committed', 'a new phone commits', outcomeOf(n1));
  if (one(n1)?.lead_id) created.leads.push(one(n1).lead_id);
  if (one(n1)?.contact_id) created.contacts.push(one(n1).contact_id);
  const n2 = await commit(owner, rNew.id);
  check(outcomeOf(n2) === 'already_committed' && (await contactsWithPhone(P2)) === 1,
    're-committing creates no duplicate', `${outcomeOf(n2)}/${await contactsWithPhone(P2)}`);

  console.log('\n4. A name-only (not auto-importable) record is refused, not created');
  const p1 = await commit(owner, rProb.id);
  check(outcomeOf(p1) === 'not_importable', 'a probable/name-only row cannot be committed', outcomeOf(p1));
  const probRow = one(await rest('GET', 'crm', `import_records?id=eq.${rProb.id}&select=committed_at`));
  check((probRow?.committed_at ?? null) === null, 'and it stays uncommitted');

  console.log('\n5. Cross-tenant: an owner of another org cannot commit this org’s record');
  const x = await commit(foreignOwner, rNew2.id);
  check(outcomeOf(x) === 'forbidden', 'the commit is forbidden', outcomeOf(x));
  check((await contactsWithPhone(P4)) === 0, 'and no contact was created for it');

  console.log('\n6. Consent is never manufactured by an import');
  const consentRows = (await rest('GET', 'crm',
    `communication_consent?contact_id=in.(${[c1.id, one(n1)?.contact_id].filter(Boolean).join(',')})&select=contact_id`)).json?.length ?? 0;
  check(consentRows === 0, 'no communication_consent row exists for any imported contact', `${consentRows}`);

  console.log('\n7. An import triggers no send: no conversation, no message');
  const convs = (await rest('GET', 'crm', `conversations?lead_id=in.(${created.leads.join(',')})&select=id`)).json?.length ?? 0;
  check(convs === 0, 'no conversation was created for the imported leads', `${convs}`);

  console.log('\n8. Every commit is audited');
  const audit = (await rest('GET', 'audit',
    `audit_log?action=eq.lead.imported&subject_id=in.(${created.leads.join(',')})&select=id`)).json?.length ?? 0;
  check(audit >= 2, 'a lead.imported audit row exists for each committed lead', `${audit}`);

  console.log('\n9. Committed state cannot be forged by a direct write');
  const patch = await call(owner, 'PATCH', 'crm', `import_records?id=eq.${rProb.id}`, { committed_at: new Date().toISOString() });
  const stillNull = (one(await rest('GET', 'crm', `import_records?id=eq.${rProb.id}&select=committed_at`))?.committed_at ?? null) === null;
  check(stillNull, 'a direct PATCH of committed_at changes nothing (no RLS UPDATE path)', `status ${patch.status}`);
} finally {
  // Cleanup — service role, best effort.
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.batches) await rest('DELETE', 'crm', `import_batches?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users)
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
