#!/usr/bin/env node
/**
 * The untenanted end-user write policy class cannot silently return.
 *
 * `ai.agents` is a GLOBAL table (no organization_id), and its write policy was
 * `for all to authenticated using core.is_owner()` — and is_owner() is true for
 * the owner of ANY organization. On a multi-tenant deployment an owner of tenant
 * A could PATCH or DELETE a registry row every OTHER tenant depends on
 * (disable an agent, zero a ceiling, break a model): a cross-tenant DoS,
 * credential-free beyond one tenant's own owner token, and invisible to CI —
 * every verify script drives the registry through the service role, which
 * bypasses RLS. Closed in 20260815380000 (the end-user write policy dropped).
 *
 * This proves two things against a real database:
 *   1. THE CLASS — core.audit_untenanted_write_policies() (20260815390000)
 *      returns every permissive end-user write policy with no tenant predicate.
 *      This asserts it is empty, so a future role-only write policy on a shared
 *      table fails CI instead of shipping a cross-tenant hole.
 *   2. THE INSTANCE — an authenticated owner can no longer write or delete
 *      ai.agents, while the service role still can (the registry is managed
 *      server-side, e.g. verify-agent-definitions' validation stamp).
 *
 *   npm run db:verify:untenanted
 */
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// jwt:true — the instance red-proof mints an authenticated owner token; the
// class audit itself runs through the service role.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-untenanted-writes');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function mint(role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: '11111111-1111-1111-1111-111111111111',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

async function call(token, method, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Profile': 'ai',
      'Content-Profile': 'ai',
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}
const rest = (m, p, b) => call(KEY, m, p, b);

console.log('\n\x1b[1mAgencyOS — the untenanted write-policy class cannot silently return\x1b[0m\n');

// ── 1. THE CLASS: the audit is empty ───────────────────────────────────────
const audit = await fetch(`${URL_BASE}/rest/v1/rpc/audit_untenanted_write_policies`, {
  method: 'POST',
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'core',
    'Content-Profile': 'core',
  },
  cache: 'no-store',
  body: '{}',
});
const auditText = await audit.text();
if (!audit.ok) fail(`could not run the audit (HTTP ${audit.status}): ${auditText.slice(0, 200)}`);
let rows;
try {
  rows = JSON.parse(auditText);
} catch {
  fail(`the audit returned non-JSON: ${auditText.slice(0, 200)}`);
}
check(
  Array.isArray(rows) && rows.length === 0,
  'no permissive end-user write policy lacks a tenant predicate',
  Array.isArray(rows) ? rows.map((r) => `${r.target}/${r.policy_name} ${r.op} (${r.roles})`).join('; ') : 'not an array',
);
if (Array.isArray(rows) && rows.length > 0) {
  console.error(
    '\n  Each of these grants an INSERT/UPDATE/DELETE to an end-user role with no organization scoping,\n' +
      '  so RLS admits the write regardless of tenant — a cross-tenant write on a shared table. Add the\n' +
      '  tenant predicate the policy needs, or — if the table is genuinely global and managed server-side —\n' +
      '  add the policy to the allowlist in core.audit_untenanted_write_policies() with its reason.',
  );
}

// ── 2. THE INSTANCE: an authenticated owner cannot write the global registry ─
const owner = mint('owner');
const anAgent = (await rest('GET', 'agents?select=key,enabled,max_cost_minor&limit=1')).json?.[0];
check(Boolean(anAgent?.key), 'the registry has a row to attempt against', `got ${JSON.stringify(anAgent)}`);

if (anAgent?.key) {
  // A well-formed disable an attacker would try (satisfies the disabled_reason CHECK):
  const disable = await call(owner, 'PATCH', `agents?key=eq.${encodeURIComponent(anAgent.key)}`, {
    enabled: false,
    disabled_reason: 'zz cross-tenant tamper attempt',
  });
  check(
    disable.status >= 400 || (Array.isArray(disable.json) && disable.json.length === 0),
    'an authenticated owner cannot disable a global agent (cross-tenant write refused)',
    `status ${disable.status}, ${disable.text.slice(0, 120)}`,
  );

  const del = await call(owner, 'DELETE', `agents?key=eq.${encodeURIComponent(anAgent.key)}`);
  check(
    del.status >= 400 || (Array.isArray(del.json) && del.json.length === 0),
    'an authenticated owner cannot delete a global agent',
    `status ${del.status}, ${del.text.slice(0, 120)}`,
  );

  // The row is untouched — the attack changed nothing.
  const after = (await rest('GET', `agents?key=eq.${encodeURIComponent(anAgent.key)}&select=enabled`)).json?.[0];
  check(
    after?.enabled === anAgent.enabled,
    'the registry row is unchanged after the refused writes',
    `enabled ${anAgent.enabled} → ${after?.enabled}`,
  );

  // And the service role still manages the registry (the legitimate path).
  const svc = await rest('PATCH', `agents?key=eq.${encodeURIComponent(anAgent.key)}`, {
    max_cost_minor: anAgent.max_cost_minor,
  });
  check(
    svc.status >= 200 && svc.status < 300,
    'the service role still writes the registry (server-side management is unaffected)',
    `status ${svc.status}`,
  );
}

if (failures === 0) {
  console.log(`\n\x1b[32m✔ ${checks} checks passed — the registry is not tenant-writable, and the class is watched\x1b[0m\n`);
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`);
process.exit(1);
