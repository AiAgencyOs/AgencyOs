// ═══════════════════════════════════════════════════════════════════════════
// A key is kept in one place.
//
// The Keys & secrets screen stores every integration secret in
// core.secret_credentials, encrypted in application code. This proves, against
// real Postgres, the four things that make that safe — none of which can be
// checked by reading TypeScript:
//
//   1. only the OWNER stores, replaces or revokes a key
//   2. an admin may read which slots are set and record a check; a member sees
//      nothing at all
//   3. nobody, in any role, can read or write the table directly through
//      PostgREST — every path is one of the four doors
//   4. the audit trail names the slot and the moment and never the value
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'a key is kept in one place');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-vault';
const SLOT = 'ZZTEST_VAULT_KEY';
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
  const key = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const rpc = (fn, args, token) => rest('POST', 'core', `rpc/${fn}`, args, token);

const created = { users: [] };

async function makeUser(role) {
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARKER}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${MARKER} ${role}` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: mint(authUser.id, role) };
}

const CIPHER = { p_ciphertext: 'Y2lwaGVydGV4dC1ub3QtYS1rZXk=', p_iv: 'aXYtaXYtaXYtaXY=', p_auth_tag: 'dGFnLXRhZy10YWctdGFn' };

try {
  const owner = await makeUser('owner');
  const admin = await makeUser('ops_admin');
  const member = await makeUser('member');

  // ── A. the owner stores, replaces and revokes ────────────────────────────
  console.log('\n  A. only the owner stores, replaces and revokes');
  const stored = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER, p_hint: 'abcd', p_expires_on: null }, owner.token));
  check(stored?.outcome === 'stored', 'the owner stores a new key', stored?.outcome);
  const replaced = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER, p_hint: 'wxyz', p_expires_on: '2099-01-01' }, owner.token));
  check(replaced?.outcome === 'replaced', 'storing the same slot again replaces it', replaced?.outcome);
  const row = one(await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=slot,ciphertext,hint,expires_on,updated_by`));
  check(row?.ciphertext === CIPHER.p_ciphertext, 'the vault holds exactly the ciphertext it was sent');
  check(row?.hint === 'wxyz' && row?.expires_on === '2099-01-01' && row?.updated_by === owner.id, 'the replacement carries its own hint, expiry and author');

  // ── B. the refusals ──────────────────────────────────────────────────────
  console.log('\n  B. nobody else may write, and the door refuses a bad request');
  const adminStore = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER }, admin.token));
  check(adminStore?.outcome === 'not_authorized', 'an ops admin may not store a key', adminStore?.outcome);
  const adminRevoke = one(await rpc('revoke_secret', { p_slot: SLOT }, admin.token));
  check(adminRevoke?.outcome === 'not_authorized', 'an ops admin may not revoke a key', adminRevoke?.outcome);
  const memberStore = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER }, member.token));
  check(memberStore?.outcome === 'not_authorized', 'a member may not store a key', memberStore?.outcome);
  const memberRevoke = one(await rpc('revoke_secret', { p_slot: SLOT }, member.token));
  check(memberRevoke?.outcome === 'not_authorized', 'a member may not revoke a key', memberRevoke?.outcome);
  const bad = one(await rpc('store_secret', { p_slot: 'lowercase_slot', ...CIPHER }, owner.token));
  check(bad?.outcome === 'invalid_slot', 'a slot that is not an env-var name is refused', bad?.outcome);
  const empty = one(await rpc('store_secret', { p_slot: SLOT, p_ciphertext: '  ', p_iv: 'x', p_auth_tag: 'y' }, owner.token));
  check(empty?.outcome === 'invalid_value', 'an empty ciphertext is refused', empty?.outcome);
  const past = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER, p_expires_on: '2001-01-01' }, owner.token));
  check(past?.outcome === 'expired', 'an expiry in the past is refused', past?.outcome);
  const after = one(await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=hint,expires_on`));
  check(after?.hint === 'wxyz' && after?.expires_on === '2099-01-01', 'and none of the refusals touched the stored key');

  // ── C. reading ───────────────────────────────────────────────────────────
  console.log('\n  C. an admin reads which slots are set; a member sees nothing');
  const adminStatus = await rpc('secret_status', {}, admin.token);
  const mine = (Array.isArray(adminStatus.json) ? adminStatus.json : []).find((r) => r.slot === SLOT);
  check(Boolean(mine) && mine.hint === 'wxyz', 'an ops admin sees the slot, its hint and its expiry');
  check(mine && !('ciphertext' in mine) && !('iv' in mine) && !('auth_tag' in mine), 'the status never carries ciphertext');
  check(typeof mine?.updated_by_name === 'string' && mine.updated_by_name.includes('owner'), 'it names who set it', mine?.updated_by_name);
  const memberStatus = await rpc('secret_status', {}, member.token);
  check(Array.isArray(memberStatus.json) && memberStatus.json.length === 0, 'a member sees no slot at all', `${(memberStatus.json ?? []).length} rows`);
  const checkOk = one(await rpc('record_secret_check', { p_slot: SLOT, p_ok: true, p_detail: 'the vendor accepted it' }, admin.token));
  check(checkOk?.outcome === 'recorded', 'an ops admin records a live check', checkOk?.outcome);
  const memberCheck = one(await rpc('record_secret_check', { p_slot: SLOT, p_ok: false, p_detail: 'x' }, member.token));
  check(memberCheck?.outcome === 'not_authorized', 'a member may not', memberCheck?.outcome);
  const checked = one(await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=last_verified_ok,last_verified_detail`));
  check(checked?.last_verified_ok === true && checked?.last_verified_detail === 'the vendor accepted it', 'the check is recorded beside the key');
  const rearmed = one(await rpc('store_secret', { p_slot: SLOT, ...CIPHER, p_hint: 'wxyz', p_expires_on: '2099-01-01' }, owner.token));
  const cleared = one(await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=last_verified_ok`));
  check(rearmed?.outcome === 'replaced' && cleared?.last_verified_ok === null, 'replacing a key clears the old check: the new value has not been tried');

  // ── D. no path but the doors ─────────────────────────────────────────────
  console.log('\n  D. no role can reach the table directly');
  for (const [who, token] of [['owner', owner.token], ['ops admin', admin.token], ['member', member.token]]) {
    const read = await rest('GET', 'core', `secret_credentials?select=slot,ciphertext`, null, token);
    check(!read.ok || (Array.isArray(read.json) && read.json.length === 0), `${who}: a direct read returns nothing`, `${read.status}`);
    const write = await rest('POST', 'core', 'secret_credentials', { slot: 'ZZTEST_DIRECT', ...{ ciphertext: 'a', iv: 'b', auth_tag: 'c' }, updated_by: owner.id }, token);
    check(!write.ok, `${who}: a direct insert is refused`, `${write.status}`);
    const patch = await rest('PATCH', 'core', `secret_credentials?slot=eq.${SLOT}`, { ciphertext: 'tampered' }, token);
    check(!patch.ok || (Array.isArray(patch.json) && patch.json.length === 0), `${who}: a direct update changes nothing`, `${patch.status}`);
    const del = await rest('DELETE', 'core', `secret_credentials?slot=eq.${SLOT}`, null, token);
    check(!del.ok || (Array.isArray(del.json) && del.json.length === 0), `${who}: a direct delete removes nothing`, `${del.status}`);
  }
  const still = one(await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=ciphertext`));
  check(still?.ciphertext === CIPHER.p_ciphertext, 'and the stored ciphertext is exactly what the owner sent');

  // ── E. revoke ────────────────────────────────────────────────────────────
  console.log('\n  E. revoking');
  const revoked = one(await rpc('revoke_secret', { p_slot: SLOT }, owner.token));
  check(revoked?.outcome === 'revoked', 'the owner revokes the key', revoked?.outcome);
  const gone = await rest('GET', 'core', `secret_credentials?slot=eq.${SLOT}&select=slot`);
  check(Array.isArray(gone.json) && gone.json.length === 0, 'it is gone');
  const again = one(await rpc('revoke_secret', { p_slot: SLOT }, owner.token));
  check(again?.outcome === 'not_found', 'revoking it again says not found', again?.outcome);

  // ── F. the audit ─────────────────────────────────────────────────────────
  console.log('\n  F. the audit names the slot and the moment, never the value');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(secret.stored,secret.replaced,secret.revoked,secret.verified)&or=(after->>slot.eq.${SLOT},before->>slot.eq.${SLOT})&select=action,actor_id,before,after&order=id.asc`);
  const actions = (Array.isArray(audit.json) ? audit.json : []).map((a) => a.action);
  check(actions.includes('secret.stored') && actions.includes('secret.replaced') && actions.includes('secret.revoked') && actions.includes('secret.verified'), 'stored, replaced, verified and revoked are each recorded', actions.join(' · '));
  const text = JSON.stringify(audit.json ?? []);
  check(!text.includes(CIPHER.p_ciphertext) && !text.includes(CIPHER.p_iv) && !/ciphertext|auth_tag/.test(text), 'and no audit row carries ciphertext');
  check((Array.isArray(audit.json) ? audit.json : []).every((a) => a.actor_id), 'every row names who did it');
} finally {
  await rest('DELETE', 'core', `secret_credentials?slot=in.(${SLOT},ZZTEST_DIRECT)`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
