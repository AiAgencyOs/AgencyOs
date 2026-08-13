#!/usr/bin/env node
/**
 * The design and prototype loop, verified against a real database.
 *
 * Phase 12 — gaps G-021, G-022, G-023. This is the first thing that drives the
 * approval engine from a real caller rather than from a test of the engine
 * itself, so it proves the two halves fit: a deliverable submitted for review
 * becomes an approval request, and the client's decision comes back onto the
 * deliverable.
 *
 * What it proves:
 *
 *   1. Versions are per kind, allocated under the project's lock — two
 *      simultaneous uploads produce v1 and v2, never two v1s.
 *   2. A deliverable is immutable apart from status. An approval names a
 *      version, and a version that can be edited afterwards makes the approval
 *      refer to something that no longer exists.
 *   3. Submitting raises a client-audience approval request, and submitting
 *      twice does not raise two.
 *   4. The client's answer comes back: approved approves, rejection asks for
 *      changes, and an approved version supersedes the earlier ones.
 *   5. An approved version cannot be moved afterwards.
 *   6. Without an approval policy, submission is refused rather than silently
 *      leaving a client waiting on nobody.
 *
 *   node scripts/verify-deliverables.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

/**
 * Refuses an environment it cannot run against, with a message rather than a
 * crash. `resolveTarget` takes the caller's own exit function — the first
 * version of this script passed none, so an incomplete .env.verify.local
 * produced "fail is not a function" instead of the sentence explaining what
 * was missing. The error path nobody had executed.
 */
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// This script needs a service key and the JWT secret: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-deliverables');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-ph12';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
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
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

const add = (projectId, kind, title) =>
  rest('POST', 'projects', 'rpc/add_deliverable', {
    p_project_id: projectId,
    p_kind: kind,
    p_title: title,
  });

const created = { users: [] };

console.log('\n\x1b[1mAgencyOS — the deliverable loop (Phase 12)\x1b[0m');

try {
  // A project belongs to a client account, so the fixture needs one.
  const account = one(
    await rest('POST', 'core', 'client_accounts', {
      organization_id: ORG,
      name: `${MARKER} client`,
    }),
  );
  created.account = account?.id;

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: created.account,
      name: `${MARKER} project`,
      status: 'active',
    }),
  );
  created.project = project?.id;
  if (!created.project) throw new Error(`could not create the project fixture`);

  // ── 6, first: no policy means no submission ─────────────────────────────
  console.log('\n1. Without a reviewer, nothing is submitted');
  {
    const draft = one(await add(created.project, 'design', 'Home screen'));
    const refused = one(
      await rest('POST', 'projects', 'rpc/submit_deliverable', { p_deliverable_id: draft.deliverable_id }),
    );
    check(
      refused?.outcome === 'no_policy',
      'submission is refused when no approval policy covers deliverables',
      `outcome ${refused?.outcome}`,
    );

    const row = one(
      await rest('GET', 'projects', `deliverables?id=eq.${draft.deliverable_id}&select=status`),
    );
    check(row?.status === 'draft', 'and the deliverable stays a draft', `${row?.status}`);
    created.firstDraft = draft.deliverable_id;
  }

  // The policy the rest of the run needs.
  // Through the Auth admin API, because core.users references auth.users:
  // inserting an id that never signed up fails the foreign key, and the
  // failure only shows up later as "decided_by is not present in users".
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-owner-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  const ownerId = authUser?.id;
  if (!ownerId) throw new Error(`could not create the owner: ${JSON.stringify(authUser).slice(0, 200)}`);

  await rest('POST', 'core', 'users', { id: ownerId, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG,
    user_id: ownerId,
    role: 'owner',
    status: 'active',
  });
  created.users.push(ownerId);
  const owner = mint(ownerId, 'owner');

  await call(owner, 'POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'deliverable',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 48,
    audience: 'client',
  });

  // ── 1. versions per kind, allocated under the lock ──────────────────────
  console.log('\n2. Versions are per kind, and two at once do not collide');
  {
    const [a, b] = await Promise.all([
      add(created.project, 'prototype', 'Customer APK'),
      add(created.project, 'prototype', 'Delivery APK'),
    ]);
    const versions = [one(a)?.version, one(b)?.version].sort();
    check(
      versions[0] === 1 && versions[1] === 2,
      'two simultaneous uploads become v1 and v2, never two v1s',
      versions.join(' and '),
    );

    const design = one(await add(created.project, 'design', 'Home screen v2'));
    check(
      design?.version === 2,
      'and a different kind keeps its own sequence',
      `design v${design?.version}`,
    );
    created.design2 = design.deliverable_id;
  }

  // ── 2. immutability ─────────────────────────────────────────────────────
  console.log('\n3. A version is never rewritten');
  {
    const edited = await rest('PATCH', 'projects', `deliverables?id=eq.${created.design2}`, {
      title: 'Quietly renamed',
    });
    check(
      edited.status >= 400 && !edited.text.includes('PGRST106'),
      'the title cannot be changed after the fact',
      `status ${edited.status}, ${edited.text.slice(0, 120)}`,
    );

    const url = await rest('PATCH', 'projects', `deliverables?id=eq.${created.design2}`, {
      artifact_url: 'https://example.invalid/swapped',
    });
    check(
      url.status >= 400,
      'and neither can the thing it points at — which is what an approval names',
      `status ${url.status}`,
    );
  }

  // ── 3. submitting raises one request ────────────────────────────────────
  console.log('\n4. Submitting puts it in front of the client, once');
  {
    const first = one(
      await rest('POST', 'projects', 'rpc/submit_deliverable', { p_deliverable_id: created.design2 }),
    );
    check(first?.outcome === 'submitted', 'the first submission raises a request', `outcome ${first?.outcome}`);
    created.request = first.request_id;

    const request = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${created.request}&select=audience,subject_type,state`),
    );
    check(
      request?.subject_type === 'deliverable' && request?.audience === 'client',
      'against the deliverable, for the client to answer (ADM-08d)',
      `${request?.subject_type}/${request?.audience}`,
    );

    const again = one(
      await rest('POST', 'projects', 'rpc/submit_deliverable', { p_deliverable_id: created.design2 }),
    );
    check(
      again?.outcome === 'already_in_review' && again?.request_id === created.request,
      'submitting twice does not raise a second review',
      `outcome ${again?.outcome}`,
    );
  }

  // ── 4. the answer comes back ────────────────────────────────────────────
  console.log('\n5. The client’s answer lands on the deliverable');
  {
    const decidedRaw = await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: created.request,
      p_decision: 'approved',
      p_evidence_ref: 'wamid.CLIENT-SAID-YES',
    });
    const decided = one(decidedRaw);
    check(
      decided?.outcome === 'decided',
      'the decision is recorded with its evidence',
      `${decided?.outcome} · status ${decidedRaw.status} · ${decidedRaw.text.slice(0, 200)}`,
    );

    const synced = await rest('POST', 'projects', 'rpc/sync_deliverable_decision', {
      p_deliverable_id: created.design2,
    });
    check(synced.json === 'approved', 'and comes back onto the deliverable', `returned ${synced.json}`);

    const older = one(
      await rest('GET', 'projects', `deliverables?id=eq.${created.firstDraft}&select=status`),
    );
    check(
      older?.status === 'superseded',
      'the earlier version of that kind is superseded, not deleted',
      `${older?.status}`,
    );

    const history = await rest(
      'GET',
      'projects',
      `deliverables?project_id=eq.${created.project}&kind=eq.design&select=version,status&order=version`,
    );
    check(
      history.json?.length === 2,
      'so the revision history survives in full',
      `${history.json?.length} versions`,
    );
  }

  // ── 5. an approved version is settled ───────────────────────────────────
  console.log('\n6. An approved version stays approved');
  {
    const moved = await rest('PATCH', 'projects', `deliverables?id=eq.${created.design2}`, {
      status: 'in_review',
    });
    check(
      moved.status >= 400,
      'it cannot be sent back for review',
      `status ${moved.status}, ${moved.text.slice(0, 120)}`,
    );

    const resubmit = one(
      await rest('POST', 'projects', 'rpc/submit_deliverable', { p_deliverable_id: created.design2 }),
    );
    check(resubmit?.outcome === 'settled', 'and submitting it again is refused', `outcome ${resubmit?.outcome}`);
  }
} finally {
  if (created.project) {
    await rest('DELETE', 'projects', `deliverables?project_id=eq.${created.project}`);
    await rest('DELETE', 'projects', `projects?id=eq.${created.project}`);
  }
  // Approval requests refuse deletion by design; they are cancelled instead.
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A version is shown, answered, and never rewritten\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
