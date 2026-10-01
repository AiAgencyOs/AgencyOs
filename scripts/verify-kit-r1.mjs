// Shared scaffolding for the round-3 stream R1 verifiers (sprints, department,
// classification, requirement plan, folders). Each verifier proves a database
// rule against real Postgres through PostgREST; this file only holds the
// plumbing they share: the target, a minted JWT per role, fixture users and a
// project, and cleanup.

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

export const ORG = '00000000-0000-4000-8000-000000000001';

export async function startKit(title, marker) {
  const fail = (message) => {
    console.error(`\n  ✗ ${message}\n`);
    process.exit(1);
  };
  const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
  announceTarget(target, title);
  const KEY = target.serviceKey;

  const mint = (userId, role) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
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

  const created = { users: [], projects: [], accounts: [], extra: [] };

  const makeUser = async (role) => {
    const authUser = await fetch(`${target.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${marker}-${role}-${randomUUID().slice(0, 8)}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    created.users.push(authUser.id);
    await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email, full_name: `${marker} ${role}` });
    await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
    return { id: authUser.id, token: mint(authUser.id, role) };
  };

  const makeProject = async (label = '') => {
    if (created.accounts.length === 0) {
      const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${marker} client` }));
      created.accounts.push(account.id);
    }
    const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: created.accounts[0], name: `${marker} ${label} ${randomUUID().slice(0, 8)}`, status: 'planning' }));
    if (!project?.id) fail(`could not create the fixture project: ${JSON.stringify(project)}`);
    created.projects.push(project.id);
    return project;
  };

  const cleanup = async (extraSteps) => {
    if (extraSteps) await extraSteps();
    for (const id of created.projects) {
      await rest('DELETE', 'projects', `tasks?project_id=eq.${id}&parent_task_id=not.is.null`);
      await rest('DELETE', 'projects', `tasks?project_id=eq.${id}`);
      await rest('DELETE', 'projects', `projects?id=eq.${id}`);
    }
    for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
    for (const id of created.users) {
      await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
      await rest('DELETE', 'core', `users?id=eq.${id}`);
      await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    }
  };

  const finish = () => {
    if (failures > 0) {
      console.error(`\n  ${failures} check(s) failed\n`);
      process.exit(1);
    }
    console.log('\n  All checks passed.\n');
  };

  return { target, KEY, check, rest, one, rpc, makeUser, makeProject, created, cleanup, finish, fail, section: (t) => console.log(`\n  ${t}`) };
}
