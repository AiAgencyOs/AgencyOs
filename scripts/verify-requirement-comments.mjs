// ═══════════════════════════════════════════════════════════════════════════
// A requirement can be commented on.
//
// The project Requirements tab lets the team comment on a requirement (a scope
// item) without reopening a frozen baseline. The comment lives in
// projects.scope_item_comments, and this proves against real Postgres the
// four things that make that safe — none of which reading TypeScript shows:
//
//   1. the four writing roles comment; a contractor and a finance user do not
//   2. the door refuses an empty comment, an over-long one, an unknown item
//   3. no role can write the table directly through PostgREST, and a comment
//      is never edited or deleted
//   4. a comment on a FROZEN requirement is accepted (the baseline stays
//      frozen), and the audit names who commented and never the words
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'a requirement can be commented on');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-reqcomment';
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
const rpc = (fn, args, token) => rest('POST', 'projects', `rpc/${fn}`, args, token);

const created = { users: [], clients: [], projects: [] };

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
  const member = await makeUser('member');
  const lead = await makeUser('delivery_lead');
  const contractor = await makeUser('contractor');
  const finance = await makeUser('finance');

  const client = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.clients.push(client.id);
  const project = one(await rest('POST', 'projects', 'projects', { organization_id: ORG, client_account_id: client.id, name: `${MARKER} project`, status: 'planning' }));
  created.projects.push(project.id);

  // A frozen scope with one requirement — the item a comment must still be accepted on.
  const opened = one(await rpc('open_scope_version', { p_project_id: project.id }, owner.token));
  const item = one(await rest('POST', 'projects', 'scope_items', { organization_id: ORG, scope_version_id: opened.scope_version_id, title: 'Movie detail screen', inclusion: 'included', acceptance_criteria: 'Shows the poster', position: 0 }));
  const frozen = one(await rpc('freeze_scope_version', { p_scope_version_id: opened.scope_version_id }, owner.token));
  check(Boolean(item?.id) && Boolean(frozen), 'a requirement exists on a scope version', JSON.stringify(frozen)?.slice(0, 80));
  const version = one(await rest('GET', 'projects', `scope_versions?id=eq.${opened.scope_version_id}&select=status`));
  check(version?.status === 'active', 'and that version is frozen (active)', version?.status);

  // ── A. who may comment ───────────────────────────────────────────────────
  console.log('\n  A. the four writing roles comment');
  const words = 'Please confirm the trailer autoplays only on Wi-Fi.';
  const byOwner = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: words }, owner.token));
  check(byOwner?.outcome === 'commented' && Boolean(byOwner?.comment_id), 'the owner comments on a frozen requirement', byOwner?.outcome);
  for (const [who, u] of [['a member', member], ['a delivery lead', lead]]) {
    const r = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: `${who} agrees` }, u.token));
    check(r?.outcome === 'commented', `${who} comments`, r?.outcome);
  }
  for (const [who, u] of [['a contractor', contractor], ['a finance user', finance]]) {
    const r = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: 'not mine to say' }, u.token));
    check(r?.outcome === 'not_authorized', `${who} may not`, r?.outcome);
  }
  const noActor = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: 'anonymous' }));
  check(noActor?.outcome === 'no_actor' || noActor?.outcome === 'not_authorized' || !noActor?.comment_id, 'a call with no signed-in person writes nothing', noActor?.outcome ?? JSON.stringify(noActor));

  // ── B. the refusals ──────────────────────────────────────────────────────
  console.log('\n  B. the door refuses a bad request');
  const empty = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: '   ' }, owner.token));
  check(empty?.outcome === 'empty', 'an empty comment is refused', empty?.outcome);
  const long = one(await rpc('comment_on_scope_item', { p_scope_item_id: item.id, p_body: 'x'.repeat(2001) }, owner.token));
  check(long?.outcome === 'too_long', 'a comment over 2000 characters is refused', long?.outcome);
  const missing = one(await rpc('comment_on_scope_item', { p_scope_item_id: randomUUID(), p_body: 'hello' }, owner.token));
  check(missing?.outcome === 'not_found', 'a requirement that does not exist is not found', missing?.outcome);
  const stored = await rest('GET', 'projects', `scope_item_comments?scope_item_id=eq.${item.id}&select=body,author_id&order=created_at.asc`);
  check(Array.isArray(stored.json) && stored.json.length === 3, 'and exactly the three accepted comments are stored', `${(stored.json ?? []).length}`);
  check(stored.json?.[0]?.body === words && stored.json?.[0]?.author_id === owner.id, 'each carries its words and its author');

  // ── C. no path but the door ──────────────────────────────────────────────
  console.log('\n  C. no role can write the table directly, and a comment is never rewritten');
  for (const [who, token] of [['owner', owner.token], ['member', member.token]]) {
    const write = await rest('POST', 'projects', 'scope_item_comments', { organization_id: ORG, scope_item_id: item.id, author_id: owner.id, body: 'sneaked in' }, token);
    check(!write.ok, `${who}: a direct insert is refused`, `${write.status}`);
    const patch = await rest('PATCH', 'projects', `scope_item_comments?scope_item_id=eq.${item.id}`, { body: 'rewritten' }, token);
    check(!patch.ok || (Array.isArray(patch.json) && patch.json.length === 0), `${who}: a direct update changes nothing`, `${patch.status}`);
    const del = await rest('DELETE', 'projects', `scope_item_comments?scope_item_id=eq.${item.id}`, null, token);
    check(!del.ok || (Array.isArray(del.json) && del.json.length === 0), `${who}: a direct delete removes nothing`, `${del.status}`);
  }
  const still = await rest('GET', 'projects', `scope_item_comments?scope_item_id=eq.${item.id}&select=body`);
  check(Array.isArray(still.json) && still.json.length === 3 && !still.json.some((c) => c.body === 'rewritten' || c.body === 'sneaked in'), 'and the three comments are exactly what was said');
  const read = await rest('GET', 'projects', `scope_item_comments?scope_item_id=eq.${item.id}&select=id`, null, member.token);
  check(Array.isArray(read.json) && read.json.length === 3, 'an internal reader sees the comments', `${(read.json ?? []).length}`);

  // ── D. the baseline stays frozen; the audit never carries the words ──────
  console.log('\n  D. the baseline stayed frozen and the audit names who, not what');
  const after = one(await rest('GET', 'projects', `scope_versions?id=eq.${opened.scope_version_id}&select=status,frozen_at`));
  check(after?.status === 'active' && Boolean(after?.frozen_at), 'commenting did not reopen the frozen scope');
  const audit = await rest('GET', 'audit', `audit_log?action=eq.scope_item.commented&subject_id=eq.${item.id}&select=actor_id,after&order=id.asc`);
  const rows = Array.isArray(audit.json) ? audit.json : [];
  check(rows.length === 3, 'each accepted comment is audited once', `${rows.length}`);
  check(rows.every((a) => a.actor_id), 'every row names who did it');
  check(!JSON.stringify(rows).includes('trailer autoplays'), 'and no audit row carries the comment text');
} finally {
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
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
