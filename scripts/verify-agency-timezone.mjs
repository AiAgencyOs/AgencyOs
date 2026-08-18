#!/usr/bin/env node
/**
 * The agency timezone is set through an audited function — G-137 operability.
 *
 * Proves, against a real database:
 *   1. A valid single-label zone (UTC) is ACCEPTED — the bug this closes: the
 *      app's Intl check accepted UTC while the column CHECK rejected it.
 *   2. A slashed zone (Asia/Kolkata) is accepted.
 *   3. A name Postgres does not know is refused as 'invalid', and nothing changes.
 *   4. A successful set writes an audit row (the trail the plain UPDATE lacked).
 *   5. A non-owner authenticated caller is refused 'forbidden'.
 *   6. A direct authenticated PATCH of the column is refused by the guard.
 *   7. The service role (identity-less) is unrestricted — the internal path works.
 *
 * Uses the seed organization and restores its timezone at the end.
 *
 *   node scripts/verify-agency-timezone.mjs
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// jwt:true — we mint an authenticated owner and member to prove the guard and
// the authority check.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-agency-timezone');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztz-${randomUUID().slice(0, 8)}`;
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

const setTz = (token, tz) =>
  call(token ?? KEY, 'POST', 'core', 'rpc/set_agency_timezone', { p_organization_id: ORG, p_timezone: tz });
const outcomeOf = (r) => (Array.isArray(r.json) ? r.json[0]?.outcome : r.json?.outcome);
const tzOf = async () =>
  one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=timezone`))?.timezone;

const created = { users: [] };
let original;

console.log('\n\x1b[1mAgencyOS — the agency timezone is set and audited (G-137)\x1b[0m');

try {
  original = await tzOf();

  // Authenticated owner + member, for the authority and guard proofs.
  const mkUser = async (role) => {
    const u = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ email: `${MARKER}-${role}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    created.users.push(u.id);
    await rest('POST', 'core', 'users', { id: u.id, email: u.email });
    await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: u.id, role, status: 'active' });
    return mint(u.id, role);
  };
  const owner = await mkUser('owner');
  const member = await mkUser('member');

  // ── 1. UTC is accepted — the mismatch this closes ───────────────────────
  console.log('\n1. A valid single-label zone (UTC) is accepted');
  {
    const r = await setTz(null, 'UTC');
    check(outcomeOf(r) === 'set', 'set_agency_timezone("UTC") returns set', `outcome ${outcomeOf(r)} / ${r.text}`);
    check((await tzOf()) === 'UTC', 'and the organization timezone is UTC');
  }

  // ── 2. a slashed zone ───────────────────────────────────────────────────
  console.log('\n2. A slashed IANA zone is accepted');
  {
    const r = await setTz(null, 'Asia/Kolkata');
    check(outcomeOf(r) === 'set', 'set_agency_timezone("Asia/Kolkata") returns set', `outcome ${outcomeOf(r)}`);
    check((await tzOf()) === 'Asia/Kolkata', 'and the timezone is Asia/Kolkata');
  }

  // ── 3. an unknown zone is refused, nothing changes ──────────────────────
  console.log('\n3. A name Postgres does not know is refused');
  {
    const r = await setTz(null, 'Not/A_Real_Zone');
    check(outcomeOf(r) === 'invalid', 'an unknown zone returns invalid', `outcome ${outcomeOf(r)}`);
    check((await tzOf()) === 'Asia/Kolkata', 'and the timezone is unchanged');
  }

  // ── 4. the write is audited ─────────────────────────────────────────────
  console.log('\n4. A successful set is audited');
  {
    await setTz(null, 'Europe/London');
    const audit = await rest('GET', 'audit',
      `audit_log?subject_id=eq.${ORG}&action=eq.organization.timezone_set&order=created_at.desc&limit=1&select=action,after`);
    const row = one(audit);
    check(!!row, 'an organization.timezone_set audit row exists', JSON.stringify(audit.json ?? audit.text));
    check(row?.after?.timezone === 'Europe/London', 'and it records the new zone', JSON.stringify(row?.after));
  }

  // ── 5. a non-owner is refused ───────────────────────────────────────────
  console.log('\n5. Authority is enforced in the database');
  {
    const r = await setTz(member, 'America/New_York');
    check(outcomeOf(r) === 'forbidden', 'a member calling the setter is forbidden', `outcome ${outcomeOf(r)}`);
    check((await tzOf()) === 'Europe/London', 'and the timezone is unchanged');
  }

  // ── 6. a direct authenticated PATCH is refused by the guard ─────────────
  console.log('\n6. The audit trail cannot be sidestepped');
  {
    const patch = await call(owner, 'PATCH', 'core', `organizations?id=eq.${ORG}`, { timezone: 'America/New_York' });
    check(patch.status >= 400, 'a direct authenticated PATCH of timezone is refused', `status ${patch.status}`);
    check((await tzOf()) === 'Europe/London', 'and the timezone is unchanged');
  }

  // ── 7. the service role (identity-less) is unrestricted ─────────────────
  console.log('\n7. The internal service path is unrestricted');
  {
    const patch = await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { timezone: 'UTC' });
    check(patch.status < 300, 'a service-role write of timezone succeeds (guard exempts identity-less)', `status ${patch.status}`);
    check((await tzOf()) === 'UTC', 'and the timezone is UTC');
  }
} finally {
  // Restore the seed org's timezone, and clean up the throwaway users.
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { timezone: original ?? null });
  for (const id of created.users) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    }).catch(() => {});
  }
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed.\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
