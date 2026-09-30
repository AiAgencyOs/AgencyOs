// ═══════════════════════════════════════════════════════════════════════════
// A model has a monthly budget of its own (W6 / SCR-064 "Set model budget/cap").
//
// Proves, against real Postgres, the rules that cannot be read off TypeScript:
//   1. only the OWNER sets or clears a model's cap
//   2. the model must be in the owner's registry
//   3. a bad cap is refused; setting the same cap again is "unchanged"
//   4. no role can write the table directly; an internal reader sees the status
//   5. the audit names the model and the cap
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'a model has a monthly budget of its own');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-modelbudget';
const MODEL = 'zztest-model-budget-1';
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
const setBudget = (cap, token, model = MODEL) => rest('POST', 'ai', 'rpc/set_model_budget', { p_model_id: model, p_monthly_cap_minor: cap }, token).then(one);

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

try {
  const owner = await makeUser('owner');
  const admin = await makeUser('ops_admin');
  const member = await makeUser('member');
  await rest('POST', 'ai', 'models', { organization_id: ORG, model_id: MODEL, provider: 'anthropic', status: 'available' });

  console.log('\n  A. the owner sets, changes and clears a cap');
  check((await setBudget(250000, owner.token))?.outcome === 'set', 'the owner sets a cap');
  check((await setBudget(250000, owner.token))?.outcome === 'unchanged', 'the same cap again is unchanged');
  check((await setBudget(300000, owner.token))?.outcome === 'set', 'a different cap replaces it');
  const status = one(await rest('GET', 'ai', `model_budget_status?model_id=eq.${MODEL}&select=monthly_cap_minor,spent_minor`, undefined, admin.token));
  check(Number(status?.monthly_cap_minor) === 300000 && Number(status?.spent_minor) === 0, 'an internal reader sees the cap beside this month\'s spend', JSON.stringify(status));

  console.log('\n  B. the refusals');
  check((await setBudget(1, admin.token))?.outcome === 'not_owner', 'an ops admin may not set a cap');
  check((await setBudget(1, member.token))?.outcome === 'not_owner', 'a member may not set a cap');
  check((await setBudget(1, owner.token, 'zztest-not-in-registry'))?.outcome === 'unknown_model', 'a model outside the registry is refused');
  check((await setBudget(-5, owner.token))?.outcome === 'bad_cap', 'a negative cap is refused');
  check((await setBudget(100000000001, owner.token))?.outcome === 'bad_cap', 'an absurd cap is refused');
  const stillThere = one(await rest('GET', 'ai', `model_budgets?model_id=eq.${MODEL}&select=monthly_cap_minor`));
  check(Number(stillThere?.monthly_cap_minor) === 300000, 'none of the refusals touched the cap');

  console.log('\n  C. no role can write the table directly');
  const direct = await rest('POST', 'ai', 'model_budgets', { organization_id: ORG, model_id: MODEL, monthly_cap_minor: 1 }, owner.token);
  check(!direct.ok, 'a direct insert as the owner is refused', String(direct.status));

  console.log('\n  D. clearing and the audit');
  check((await setBudget(0, owner.token))?.outcome === 'cleared', 'a zero cap clears it');
  check((await setBudget(0, owner.token))?.outcome === 'unchanged', 'clearing again is unchanged');
  const audit = await rest('GET', 'audit', `audit_log?action=in.(model_budget.set,model_budget.cleared)&or=(after->>model_id.eq.${MODEL},after->>model.eq.${MODEL})&actor_id=eq.${owner.id}&select=action,actor_id,after&order=id.asc`);
  const actions = (Array.isArray(audit.json) ? audit.json : []).map((a) => a.action);
  check(actions.filter((a) => a === 'model_budget.set').length === 2 && actions.filter((a) => a === 'model_budget.cleared').length === 1, 'two sets and one clear are each audited, by the owner', actions.join(' · '));
} finally {
  await rest('DELETE', 'ai', `model_budgets?model_id=eq.${MODEL}`);
  await rest('DELETE', 'ai', `models?model_id=eq.${MODEL}`);
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
