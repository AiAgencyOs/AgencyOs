/**
 * Live proof for the Security Center's read path (core.security_posture()).
 *
 * Proves: the deployment's three structural invariants actually hold on a fresh
 * database (0 unguarded FKs, 0 unfrozen tables, 0 invoker-writes-without-policy),
 * an owner may read the posture, and a non-admin authenticated caller is REFUSED
 * — the function is authority-gated, not merely SECURITY DEFINER.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const fail = (m) => { console.error(`\x1b[31m${m}\x1b[0m`); process.exit(1); };
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target);

const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-secposture-${randomUUID().slice(0, 8)}`;
let failures = 0, checks = 0;
function check(cond, desc, detail = '') {
  checks += 1;
  if (cond) return void console.log(`  \x1b[32m✓\x1b[0m ${desc}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${desc}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
async function call(token, path, body) {
  const res = await fetch(`${target.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Profile': 'core' },
    cache: 'no-store',
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: parse(await res.text()) };
}
function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

console.log('\n\x1b[1mAgencyOS — security posture (owner-readable structural invariants)\x1b[0m');
const created = { users: [] };
try {
  console.log('\n1. Service role reads the posture and the invariants hold');
  const svc = await call(KEY, 'rpc/security_posture');
  const p = svc.json ?? {};
  check(svc.status === 200 && p && Array.isArray(p.unguarded_fks), 'security_posture() returns the three arrays', `status ${svc.status}`);
  check((p.unguarded_fks ?? []).length === 0, 'no unguarded org-scoped foreign key', `${(p.unguarded_fks ?? []).length}`);
  check((p.unfrozen_tables ?? []).length === 0, 'no org-scoped table can be re-tenanted', `${(p.unfrozen_tables ?? []).length}`);
  check((p.invoker_writes ?? []).length === 0, 'no invoker write path without a policy', `${(p.invoker_writes ?? []).length}`);

  // An owner + a non-admin member, both authenticated, to prove the gate.
  const owner = await fetch(`${target.url}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}-owner@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(owner.id);
  const member = await fetch(`${target.url}/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}-member@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(member.id);

  console.log('\n2. An owner may read it');
  const ownerRes = await call(mint(owner.id, 'owner'), 'rpc/security_posture');
  check(ownerRes.status === 200 && Array.isArray(ownerRes.json?.unguarded_fks), 'an owner reads the posture', `status ${ownerRes.status}`);

  console.log('\n3. A non-admin member is REFUSED (authority, not just definer)');
  const memberRes = await call(mint(member.id, 'member'), 'rpc/security_posture');
  check(memberRes.status >= 400, 'a member cannot read the posture', `status ${memberRes.status}`);
} finally {
  for (const id of created.users)
    await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
