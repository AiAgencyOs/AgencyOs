#!/usr/bin/env node
/**
 * A guard that cannot fail open — G-281, proven against the live schema.
 *
 * `core.current_user_role()` reads the role out of the access token. A token
 * carrying no role makes it NULL, which makes `core.can_write()`,
 * `core.is_admin()`, `core.is_owner()` and `core.is_internal()` all NULL —
 * and `not NULL` is NULL, which plpgsql's `if` does not execute. Forty-eight
 * doors were written as `if ... or not (select core.can_write()) then refuse`
 * and therefore **fell through** for such a caller instead of refusing.
 *
 * This proves the fix the way the hole was found: **by minting the token and
 * calling the door**, not by reading the source. Three things are asserted,
 * and the third is the one that keeps the other two honest:
 *
 *   1. `core.fail_open_authority_guards()` is EMPTY — no function anywhere in
 *      the database still negates a role predicate without coalescing it.
 *   2. A token with an organisation and **no role** is refused by real doors,
 *      one per predicate shape — `forbidden`, not a fall-through.
 *   3. The same doors still ACCEPT a proper caller. A refusal test alone
 *      passes just as well against a door that refuses everybody, which is
 *      not a fix, it is an outage.
 *
 * The role-less token is legal today only because `custom_access_token_hook`
 * writes organisation and role together or neither — so it has to be minted
 * here by hand. That is precisely the invariant this gap exists to stop
 * depending on.
 *
 *   node scripts/verify-fail-open-guards.mjs
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// jwt:true — the whole point is a token the sign-in path cannot produce.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-fail-open-guards');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zzfog-${randomUUID().slice(0, 8)}`;
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
const outcomeOf = (r) => (Array.isArray(r.json) ? r.json[0]?.outcome : r.json?.outcome);

/**
 * `role` undefined mints the token this gap is about: an organisation, and no
 * role at all. Anything else mints an ordinary one.
 */
function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: role === undefined
      ? { organization_id: ORG, audience: 'internal' }
      : { organization_id: ORG, role, audience: 'internal' },
    iat: now, exp: now + 900,
  });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const created = { users: [], members: [] };
let originalName;

console.log('\n\x1b[1mAgencyOS — a guard that cannot fail open (G-281)\x1b[0m');

try {
  const mkUser = async (label, role) => {
    const u = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ email: `${MARKER}-${label}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    created.users.push(u.id);
    await rest('POST', 'core', 'users', { id: u.id, email: u.email });
    // A membership so the caller is a real person in this organisation. The
    // role the DOOR reads comes from the token, not from this row — which is
    // exactly why a token without one had to be refused rather than trusted.
    await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: u.id, role: 'owner', status: 'active' });
    return { id: u.id, token: mint(u.id, role) };
  };

  const roleless = await mkUser('noroleyet', undefined);
  const owner = await mkUser('owner', 'owner');

  // ── 1. nothing in the database is written the fail-open way ─────────────
  console.log('\n1. No authority guard anywhere negates a role predicate uncoalesced');
  {
    const r = await rest('POST', 'core', 'rpc/fail_open_authority_guards', {});
    const rows = Array.isArray(r.json) ? r.json : [];
    check(r.status < 300, 'core.fail_open_authority_guards() is callable', `status ${r.status} / ${r.text}`);
    check(
      rows.length === 0,
      'and it returns no functions',
      rows.map((x) => `${x.schema_name}.${x.function_name}(${x.arguments})`).join(', '),
    );
  }

  // ── 2. the token the hook cannot mint is refused by real doors ──────────
  //
  // One per predicate shape, so a fix applied to only one family would show.
  console.log('\n2. A token with an organisation and NO role is refused');
  {
    originalName = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=name`))?.name;

    // core.is_owner()
    const rename = await call(roleless.token, 'POST', 'core', 'rpc/set_organization_name',
      { p_organization_id: ORG, p_name: `${MARKER} renamed by nobody` });
    check(outcomeOf(rename) === 'forbidden',
      'set_organization_name (is_owner) refuses it', `outcome ${outcomeOf(rename)} / ${rename.text}`);
    check(one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=name`))?.name === originalName,
      'and the agency name is unchanged');

    // core.can_write()
    const team = await call(roleless.token, 'POST', 'projects', 'rpc/add_team_default',
      { p_display_name: `${MARKER} nobody`, p_phone: '+919999900001', p_role: 'member' });
    check(outcomeOf(team) === 'forbidden',
      'add_team_default (can_write) refuses it', `outcome ${outcomeOf(team)} / ${team.text}`);
    const planted = await rest('GET', 'projects', `group_team_defaults?display_name=eq.${encodeURIComponent(`${MARKER} nobody`)}&select=id`);
    check((planted.json ?? []).length === 0, 'and no team default was written');
  }

  // ── 3. the positive twin: a real caller still gets through ──────────────
  //
  // A refusal test on its own stays green against a door that refuses
  // everybody, and that is an outage rather than a fix.
  console.log('\n3. And a proper caller is still accepted');
  {
    const rename = await call(owner.token, 'POST', 'core', 'rpc/set_organization_name',
      { p_organization_id: ORG, p_name: `${MARKER} renamed by an owner` });
    check(outcomeOf(rename) === 'set', 'set_organization_name accepts an owner', `outcome ${outcomeOf(rename)} / ${rename.text}`);

    const team = await call(owner.token, 'POST', 'projects', 'rpc/add_team_default',
      { p_display_name: `${MARKER} somebody`, p_phone: '+919999900002', p_role: 'member' });
    check(outcomeOf(team) === 'added', 'add_team_default accepts an owner', `outcome ${outcomeOf(team)} / ${team.text}`);
    const row = one(await rest('GET', 'projects',
      `group_team_defaults?display_name=eq.${encodeURIComponent(`${MARKER} somebody`)}&select=id`));
    if (row) created.members.push(row.id);
    check(!!row, 'and the team default exists');
  }
} finally {
  if (originalName) await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { name: originalName });
  for (const id of created.members) await rest('DELETE', 'projects', `group_team_defaults?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    }).catch(() => {});
    await rest('DELETE', 'core', `users?id=eq.${id}`);
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed.\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
