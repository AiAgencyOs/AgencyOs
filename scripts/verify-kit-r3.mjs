// Shared scaffolding for the round-3 stream R3 verifier (stored files, the
// calendar id, period reports). Each check runs against real Postgres through
// PostgREST. UNLIKE verify-kit-r1.mjs it assumes NOTHING about the database
// beyond what a fresh one holds: it creates its own organizations (a tenant
// and "another tenant"), its own users through the auth admin API and its own
// fixtures, and removes all of them in `cleanup`. No UUID is hard-coded, so it
// runs on CI's fresh database and on a long-lived local one alike.

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

export async function startKit(title, marker) {
  const fail = (message) => {
    console.error(`\n  ✗ ${message}\n`);
    process.exit(1);
  };
  const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
  announceTarget(target, title);
  const KEY = target.serviceKey;

  const mint = (userId, role, orgId) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: orgId, role }, iat: now, exp: now + 900 });
    return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
  };

  let failures = 0;
  const check = (condition, description, detail = '') => {
    console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  };
  const parse = (t) => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return t;
    }
  };
  const rest = async (method, schema, path, body, token) => {
    const key = token ?? KEY;
    const res = await fetch(`${target.url}/rest/v1/${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Profile': schema, 'Accept-Profile': schema, Prefer: 'return=representation' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: res.ok, status: res.status, json: parse(await res.text()) };
  };
  const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
  const rpc = (schema) => (fn, args, token) => rest('POST', schema, `rpc/${fn}`, args, token);

  const created = { orgs: [], users: [] };

  /** A fresh organization of this run's own. */
  const makeOrg = async (label) => {
    const org = one(await rest('POST', 'core', 'organizations', { name: `${marker} ${label}`, slug: `${marker}-${label}-${randomUUID().slice(0, 8)}` }));
    if (!org?.id) fail(`could not create an organization: ${JSON.stringify(org)}`);
    created.orgs.push(org.id);
    return org;
  };

  /** A user holding `role` in `orgId`, created through the auth admin API; `token` is a JWT for that membership. */
  const makeUser = async (role, orgId) => {
    const authUser = await fetch(`${target.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${marker}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    if (!authUser?.id) fail(`could not create a ${role} user: ${JSON.stringify(authUser)}`);
    created.users.push(authUser.id);
    await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${marker} ${role}` });
    await rest('POST', 'core', 'memberships', { organization_id: orgId, user_id: authUser.id, role, status: 'active' });
    return { id: authUser.id, token: mint(authUser.id, role, orgId) };
  };

  const finish = () => {
    if (failures > 0) {
      console.error(`\n  ${failures} check(s) failed\n`);
      process.exit(1);
    }
    console.log('\n  All checks passed.\n');
  };

  /** Removes what this run made: `extraSteps` first (rows with RESTRICT references), then organizations (cascade), then users. */
  const cleanup = async (extraSteps) => {
    try {
      if (extraSteps) await extraSteps();
      for (const id of created.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
    } finally {
      for (const id of created.users) {
        await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
        await rest('DELETE', 'core', `users?id=eq.${id}`);
        await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
      }
    }
  };

  return { target, KEY, check, rest, one, rpc, makeOrg, makeUser, created, cleanup, finish, fail, section: (t) => console.log(`\n  ${t}`) };
}
