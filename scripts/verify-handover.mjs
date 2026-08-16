#!/usr/bin/env node
/**
 * Handover, verified against a real database.
 *
 * Phase 12, gap G-032, directive §22. Two things are worth driving rather than
 * reasoning about: that a credential row cannot hold a credential, and that
 * broken or empty work cannot be handed over.
 *
 * What it proves:
 *
 *   1. A credential item refuses a reference and demands a transfer method —
 *      the value travels out of band and leaves a receipt, because a column
 *      holding a client's production password is the same leak as the chat
 *      message with a longer retention period.
 *   2. An empty handover is refused: it would claim nothing was delivered.
 *   3. An open blocker refuses delivery (ARCHITECTURE.md §4.8, directive §20).
 *   4. Delivery raises a client-audience acceptance, and reports the
 *      outstanding balance WITHOUT gating on it.
 *   5. A delivered package cannot be edited afterwards.
 *   6. The client's acceptance lands on the handover.
 *
 *   node scripts/verify-handover.mjs
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
await announceTarget(target, 'verify-handover');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g032';
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

const created = { users: [] };

console.log('\n\x1b[1mAgencyOS — handover (G-032, directive §22)\x1b[0m');

try {
  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
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
  if (!created.project) throw new Error('could not create the project fixture');

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
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active',
  });
  const owner = mint(authUser.id, 'owner');

  await call(owner, 'POST', 'approvals', 'approval_policies', {
    organization_id: ORG, subject_type: 'handover', min_amount_minor: 0,
    required_role: 'ops_admin', sla_hours: 72, audience: 'client',
  });

  const handover = one(
    await rest('POST', 'projects', 'handovers', {
      organization_id: ORG, project_id: created.project, summary: 'v1 delivery',
    }),
  );
  created.handover = handover?.id;

  // ── 1. the credentials rule ─────────────────────────────────────────────
  console.log('\n1. A credential item cannot hold a credential');
  {
    const withSecret = await rest('POST', 'projects', 'handover_items', {
      organization_id: ORG, handover_id: created.handover, kind: 'credential',
      label: 'Production database password', reference: 'hunter2-the-actual-password',
      transfer_method: '1Password share',
    });
    check(
      withSecret.status >= 400 && !withSecret.text.includes('PGRST106'),
      'a credential row with a reference is refused in DDL',
      `status ${withSecret.status}, ${withSecret.text.slice(0, 100)}`,
    );

    const noMethod = await rest('POST', 'projects', 'handover_items', {
      organization_id: ORG, handover_id: created.handover, kind: 'credential',
      label: 'Production database password',
    });
    check(noMethod.status >= 400, 'and one that does not say how it was transferred is too', `status ${noMethod.status}`);

    const receipt = await rest('POST', 'projects', 'handover_items', {
      organization_id: ORG, handover_id: created.handover, kind: 'credential',
      label: 'Production database password', transfer_method: '1Password share, accepted 13 Aug',
    });
    check(receipt.status === 201, 'a receipt — method, no value — is what gets recorded', `status ${receipt.status}`);
  }

  // ── 2. empty ────────────────────────────────────────────────────────────
  console.log('\n2. Nothing is handed over by accident');
  {
    // Asserted on the refusal itself: an earlier version of this check tested
    // for a null row and failed while the index was working perfectly, because
    // PostgREST answers a conflict with an error body rather than nothing.
    const second = await rest('POST', 'projects', 'handovers', {
      organization_id: ORG, project_id: created.project,
    });
    check(
      second.status === 409 && second.text.includes('handovers_open_project_key'),
      'a project has one live handover at a time',
      `status ${second.status}, ${second.text.slice(0, 100)}`,
    );

    // Empty is tested on a separate project, since ours now has an item.
    const otherProject = one(
      await rest('POST', 'projects', 'projects', {
        organization_id: ORG, client_account_id: created.account,
        name: `${MARKER} empty`, status: 'active',
      }),
    );
    created.otherProject = otherProject?.id;
    const empty = one(
      await rest('POST', 'projects', 'handovers', {
        organization_id: ORG, project_id: created.otherProject,
      }),
    );
    created.emptyHandover = empty?.id;
    const attempt = one(await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: empty.id }));
    check(attempt?.outcome === 'empty', 'an empty package is refused', `outcome ${attempt?.outcome}`);
  }

  // ── 3. broken work ──────────────────────────────────────────────────────
  console.log('\n3. Broken work is not handed over');
  {
    const blocker = one(
      await rest('POST', 'qa', 'defects', {
        organization_id: ORG, project_id: created.project, severity: 'blocker',
        title: `${MARKER} blocker`, reproduction: 'It falls over on launch.',
      }),
    );
    const attempt = one(await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: created.handover }));
    check(attempt?.outcome === 'blocked', 'an open blocker refuses delivery', `outcome ${attempt?.outcome}`);

    await rest('PATCH', 'qa', `defects?id=eq.${blocker.id}`, {
      status: 'wontfix', resolution: 'not part of this scope',
    });
  }

  // ── 4. delivery, and the balance it reports but does not enforce ────────
  console.log('\n4. Delivery raises an acceptance and reports the balance');
  {
    const delivered = one(
      await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: created.handover }),
    );
    check(delivered?.outcome === 'delivered', 'the handover is delivered', `outcome ${delivered?.outcome}`);
    check(
      delivered?.outstanding_minor !== null && delivered?.outstanding_minor !== undefined,
      'with the outstanding balance reported rather than enforced',
      `outstanding ${delivered?.outstanding_minor}`,
    );
    created.request = delivered.request_id;

    const request = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${created.request}&select=subject_type,audience`),
    );
    check(
      request?.subject_type === 'handover' && request?.audience === 'client',
      'and the client is the one asked to accept it',
      `${request?.subject_type}/${request?.audience}`,
    );
  }

  // ── 5. a delivered package is settled ───────────────────────────────────
  console.log('\n5. What was delivered is what was delivered');
  {
    const added = await rest('POST', 'projects', 'handover_items', {
      organization_id: ORG, handover_id: created.handover, kind: 'documentation',
      label: 'Added after the fact', reference: 'https://example.invalid/late',
    });
    check(
      added.status >= 400,
      'nothing can be added to a delivered package',
      `status ${added.status}, ${added.text.slice(0, 100)}`,
    );
  }

  // ── 6. acceptance ───────────────────────────────────────────────────────
  console.log('\n6. The client accepts it');
  {
    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: created.request, p_decision: 'approved',
      p_evidence_ref: 'wamid.CLIENT-ACCEPTED-HANDOVER',
    });

    const synced = await rest('POST', 'projects', 'rpc/sync_handover_acceptance', {
      p_handover_id: created.handover,
    });
    check(synced.json === 'accepted', 'and the acceptance lands on the handover', `returned ${synced.json}`);

    const row = one(await rest('GET', 'projects', `handovers?id=eq.${created.handover}&select=status,accepted_at`));
    check(!!row?.accepted_at, 'with the time it happened', `${row?.accepted_at}`);
  }

  // ── the direct-write bypasses the audit found are refused ─────────────
  console.log('\n(security). A handover is delivered and accepted only through the engine');
  {
    const fresh = one(await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: created.project }));
    // The client's acceptance cannot be forged by a direct write.
    const forgedAccept = await rest('PATCH', 'projects', `handovers?id=eq.${fresh.id}`, { status: 'accepted', accepted_at: new Date().toISOString() });
    check(forgedAccept.status >= 400, 'a direct write to accepted is refused', `status ${forgedAccept.status}, ${forgedAccept.text.slice(0, 90)}`);
    // Nor delivery, which needs the empty-package/QA gate and a client approval.
    const forgedDeliver = await rest('PATCH', 'projects', `handovers?id=eq.${fresh.id}`, { status: 'delivered', delivered_at: new Date().toISOString() });
    check(forgedDeliver.status >= 400, 'and a direct write to delivered is refused', `status ${forgedDeliver.status}`);
    check(
      one(await rest('GET', 'projects', `handovers?id=eq.${fresh.id}&select=status`))?.status === 'preparing',
      'the handover stays in preparing',
    );
    // And it cannot be BORN delivered, which would skip the empty-package gate.
    const bornDelivered = await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: created.project, status: 'delivered', delivered_at: new Date().toISOString() });
    check(bornDelivered.status >= 400, 'a handover cannot be born delivered — the empty-package gate cannot be skipped', `status ${bornDelivered.status}`);
    await rest('DELETE', 'projects', `handovers?id=eq.${fresh.id}`);
  }
} finally {
  for (const p of [created.project, created.otherProject].filter(Boolean)) {
    const hs = await rest('GET', 'projects', `handovers?project_id=eq.${p}&select=id`);
    for (const h of hs.json ?? []) {
      await rest('PATCH', 'projects', `handovers?id=eq.${h.id}`, { status: 'cancelled' });
      await rest('DELETE', 'projects', `handover_items?handover_id=eq.${h.id}`);
      await rest('DELETE', 'projects', `handovers?id=eq.${h.id}`);
    }
    await rest('DELETE', 'qa', `defects?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `projects?id=eq.${p}`);
  }
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled', decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Handed over, receipted, and holding no secrets\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
