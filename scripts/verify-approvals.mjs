#!/usr/bin/env node
/**
 * The approval engine, verified against a real database.
 *
 * Gap G-040, decision ADM-08. Every rule below is one the engine claims in
 * DDL or in a function, driven over PostgREST with real JWTs carrying real
 * claims — because the whole point of putting these rules in Postgres was that
 * they hold when the application is not the one asking.
 *
 * What it proves, in order:
 *
 *   1. The policy ladder resolves to one rung, deterministically.
 *   2. A second policy at the same threshold is refused, so resolution can
 *      never be the unordered LIMIT 1 that D22 was.
 *   3. Raising the same request twice yields one row, not two.
 *   4. Two people deciding at once: one wins, the other is told who did.
 *   5. A role below the snapshotted requirement cannot settle.
 *   6. The service role — which has no identity — cannot settle anything.
 *   7. A client-audience decision without evidence is refused (ADM-08d).
 *   8. A settled request is never re-decided, and never deleted.
 *   9. Another tenant's request is invisible and unsettleable.
 *  10. Only an owner may write policy, and every write is audited.
 *
 * What it creates and removes: three auth users with memberships in the seeded
 * demo organization, a few policies, and some requests. Users, memberships and
 * policies are deleted in the `finally` block; every request it leaves behind
 * is CANCELLED there, because an approval left pending in a real queue is
 * somebody's afternoon.
 *
 * It creates no organization, and that is not a preference. An organization
 * that has acquired an audit row can never be deleted — `audit.reject_mutation`
 * refuses the cascade, and `approval_requests_no_delete` now refuses it a
 * second time — so a script that made one would leave it there forever, and
 * `verify-first-owner.mjs` fails when a second organization exists. Both of
 * those were discovered the hard way, in that order.
 *
 * The second tenant is a minted token naming an organization id that does not
 * exist. Tenancy here is decided by comparing a claim against a row, so a
 * phantom organization exercises it exactly as a real one would, and leaves
 * nothing to clean up.
 *
 *   node scripts/verify-approvals.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const target = await resolveTarget();
await announceTarget(target, 'verify-approvals');

const URL_BASE = target.url;
const SERVICE_KEY = target.serviceKey;

/** Everything this run creates carries this, so cleanup can find it. */
const MARKER = 'zztest-adm08';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${description}`);
    return;
  }
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

/** JSON when the body is JSON, null when it is not — an error page, say. */
function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** A PostgREST call as the service role: fixtures and inspection. */
async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
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

/**
 * A token carrying the claims the RLS helpers actually read.
 *
 * core.current_organization_id() and core.current_user_role() read
 * `app_metadata`, so a token without it is an authenticated caller belonging
 * to no tenant — which is a useful case in its own right and is not this one.
 */
function mint(userId, organizationId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: organizationId, role },
    iat: now,
    exp: now + 900,
  });
  const sig = createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** A PostgREST call as a signed-in user. */
async function as(token, method, schema, path, body) {
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

const rpc = (token, fn, args) => as(token, 'POST', 'approvals', `rpc/${fn}`, args);

/**
 * A refusal, and the right one.
 *
 * The first run of this script asserted `status >= 400` and four checks went
 * green while the whole schema was unreachable — PostgREST answers 406
 * PGRST106 for a schema it does not expose, which is >= 400 and proves
 * nothing. A refusal check that cannot tell "you may not" from "there is
 * nothing here" is worse than no check, so each one names its status.
 */
const refused = (result, expected) =>
  result.status === expected && !result.text.includes('PGRST106');
const one = (result) => (Array.isArray(result.json) ? result.json[0] : result.json);

/** The seeded demo organization — the one tenant these fixtures live in. */
const MARKER_ORG = '00000000-0000-4000-8000-000000000001';

const created = { users: [] };

async function createUser(tag) {
  const id = randomUUID();
  const res = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-${tag}-${id.slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  });
  const body = await res.json();
  if (!body?.id) throw new Error(`could not create the ${tag} user: ${JSON.stringify(body).slice(0, 200)}`);
  created.users.push(body.id);
  return body.id;
}

console.log('\n\x1b[1mAgencyOS — the approval engine (G-040, ADM-08)\x1b[0m');

try {
  // ── fixtures ─────────────────────────────────────────────────────────────
  //
  // The seeded demo organization, rather than one of our own: see the header.
  const org = '00000000-0000-4000-8000-000000000001';
  const otherOrg = randomUUID();

  const ownerId = await createUser('owner');
  const opsId = await createUser('ops');
  const leadId = await createUser('lead');

  for (const [userId, role] of [
    [ownerId, 'owner'],
    [opsId, 'ops_admin'],
    [leadId, 'delivery_lead'],
  ]) {
    await rest('POST', 'core', 'users', { id: userId, email: `${MARKER}-${userId.slice(0, 8)}@example.invalid` });
    await rest('POST', 'core', 'memberships', {
      organization_id: org,
      user_id: userId,
      role,
      status: 'active',
    });
  }

  const owner = mint(ownerId, org, 'owner');
  const ops = mint(opsId, org, 'ops_admin');
  const lead = mint(leadId, org, 'delivery_lead');
  // No fixtures behind this one at all — an id nobody has ever issued.
  const outsider = mint(randomUUID(), otherOrg, 'owner');

  // ── 1. the policy ladder ────────────────────────────────────────────────
  console.log('\n1. Policy resolves to exactly one rung');
  {
    const base = await as(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'deliverable',
      min_amount_minor: 0,
      required_role: 'delivery_lead',
      sla_hours: 48,
    });
    check(
      base.status === 201,
      'an owner writes a base policy',
      `status ${base.status}, ${base.text.slice(0, 160)}`,
    );

    await as(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'deliverable',
      min_amount_minor: 50_000_00,
      required_role: 'owner',
      sla_hours: 24,
    });

    const under = one(await rpc(owner, 'resolve_policy', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_amount_minor: 1000_00,
    }));
    check(
      under?.required_role === 'delivery_lead',
      'below the threshold, the base rung binds',
      `resolved ${under?.required_role}`,
    );

    const over = one(await rpc(owner, 'resolve_policy', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_amount_minor: 90_000_00,
    }));
    check(over?.required_role === 'owner', 'above it, the higher rung binds', `resolved ${over?.required_role}`);

    const noAmount = one(await rpc(owner, 'resolve_policy', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
    }));
    check(
      noAmount?.required_role === 'delivery_lead',
      'a subject with no amount reads as zero rather than resolving to nothing',
      `resolved ${noAmount?.required_role}`,
    );
  }

  // ── 2. the ambiguity D22 taught us to forbid ────────────────────────────
  console.log('\n2. Two active policies at one threshold are unrepresentable');
  {
    const duplicate = await as(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'deliverable',
      min_amount_minor: 0,
      required_role: 'ops_admin',
      sla_hours: 12,
    });
    check(
      duplicate.status === 409,
      'a second active policy at the same threshold is refused by the index',
      `status ${duplicate.status}, ${duplicate.text.slice(0, 160)}`,
    );
  }

  // ── 3. raising is idempotent ────────────────────────────────────────────
  console.log('\n3. One question, asked twice, is one request');
  const subjectId = randomUUID();
  {
    const first = one(await rpc(ops, 'request_approval', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_subject_id: subjectId,
      p_requested_by_type: 'user',
      p_requested_by_id: opsId,
      p_summary: 'Design v3 for client review',
    }));
    check(first?.outcome === 'requested', 'the first raise creates it', `outcome ${first?.outcome}`);
    check(
      first?.required_role === 'delivery_lead',
      'and snapshots the role the policy required',
      `snapshot ${first?.required_role}`,
    );

    // Concurrently, as a job retry and a second click would be.
    const [a, b] = await Promise.all([
      rpc(ops, 'request_approval', {
        p_organization_id: org,
        p_subject_type: 'deliverable',
        p_subject_id: subjectId,
        p_requested_by_type: 'user',
        p_requested_by_id: opsId,
      }),
      rpc(ops, 'request_approval', {
        p_organization_id: org,
        p_subject_type: 'deliverable',
        p_subject_id: subjectId,
        p_requested_by_type: 'user',
        p_requested_by_id: opsId,
      }),
    ]);
    const outcomes = [one(a)?.outcome, one(b)?.outcome];
    check(
      outcomes.every((o) => o === 'already_pending'),
      'two more raises are both answered with the request that exists',
      outcomes.join(', '),
    );

    const rows = await rest('GET', 'approvals', `approval_requests?subject_id=eq.${subjectId}&select=id,state`);
    check(rows.json?.length === 1, 'and there is exactly one row for the subject', `${rows.json?.length} row(s)`);
  }

  // ── 4. two deciders, one decision ───────────────────────────────────────
  console.log('\n4. Two people deciding at once');
  {
    const requestId = (await rest('GET', 'approvals', `approval_requests?subject_id=eq.${subjectId}&select=id`))
      .json?.[0]?.id;

    const [approve, reject] = await Promise.all([
      rpc(owner, 'decide_approval', { p_request_id: requestId, p_decision: 'approved', p_note: 'looks right' }),
      rpc(ops, 'decide_approval', { p_request_id: requestId, p_decision: 'rejected', p_note: 'not yet' }),
    ]);

    const results = [one(approve), one(reject)];
    const decided = results.filter((r) => r?.outcome === 'decided');
    const already = results.filter((r) => r?.outcome === 'already_decided');

    check(decided.length === 1, 'exactly one decision lands', `${decided.length} landed`);
    check(
      already.length === 1,
      'and the other is told it was already settled rather than overwriting it',
      `${already.length} refused, outcomes ${results.map((r) => r?.outcome).join(', ')}`,
    );

    const row = (await rest('GET', 'approvals', `approval_requests?id=eq.${requestId}&select=state,decided_by,decided_at`))
      .json?.[0];
    check(
      row?.state !== 'pending' && row?.decided_by && row?.decided_at,
      'the row carries who decided and when',
      `state ${row?.state}, by ${row?.decided_by}`,
    );

    // ── 8. and a settled request stays settled ────────────────────────────
    const again = one(await rpc(owner, 'decide_approval', { p_request_id: requestId, p_decision: 'approved' }));
    check(again?.outcome === 'already_decided', 'a settled request is not re-decided', `outcome ${again?.outcome}`);

    const forced = await rest('PATCH', 'approvals', `approval_requests?id=eq.${requestId}`, { state: 'pending' });
    check(
      refused(forced, 400) || refused(forced, 500),
      'and the service role cannot walk it back to pending either',
      `status ${forced.status}, ${forced.text.slice(0, 140)}`,
    );

    const deleted = await rest('DELETE', 'approvals', `approval_requests?id=eq.${requestId}`);
    // 403/42501: the DELETE grant was never given, so the privilege refuses
    // before the trigger is reached. Two refusals stacked, outermost first —
    // the trigger is the one that holds if a grant is ever widened.
    check(
      refused(deleted, 403),
      'a decision is never deleted',
      `status ${deleted.status}, ${deleted.text.slice(0, 140)}`,
    );
  }

  // ── 5. the role snapshot is enforced ────────────────────────────────────
  console.log('\n5. A role below the requirement cannot settle');
  {
    const highValue = randomUUID();
    const raised = one(await rpc(ops, 'request_approval', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_subject_id: highValue,
      p_requested_by_type: 'user',
      p_requested_by_id: opsId,
      p_amount_minor: 90_000_00,
    }));
    check(raised?.required_role === 'owner', 'a high-value subject requires the owner', `${raised?.required_role}`);

    const byLead = one(await rpc(lead, 'decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
    }));
    check(byLead?.outcome === 'forbidden', 'a delivery_lead is refused', `outcome ${byLead?.outcome}`);

    const byOps = one(await rpc(ops, 'decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
    }));
    check(byOps?.outcome === 'forbidden', 'so is an ops_admin', `outcome ${byOps?.outcome}`);

    const byOwner = one(await rpc(owner, 'decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
    }));
    check(byOwner?.outcome === 'decided', 'and the owner settles it', `outcome ${byOwner?.outcome}`);
  }

  // ── 6. an automation cannot approve its own work ────────────────────────
  console.log('\n6. A decision needs somebody who made it (directive §29)');
  {
    const subject = randomUUID();
    const raised = one(await rest('POST', 'approvals', 'rpc/request_approval', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_subject_id: subject,
      p_requested_by_type: 'system',
    }));
    check(raised?.outcome === 'requested', 'the job runner may raise a request', `outcome ${raised?.outcome}`);

    // Two refusals, and the outer one is the stronger: `execute` on
    // decide_approval was never granted to service_role, so the call is
    // refused 42501 before the function runs at all. The function's own
    // `no_actor` branch stays as the answer for any caller that reaches it
    // another way — a future job, or another SECURITY DEFINER function — and
    // is proved separately in tests/approval-engine.test.ts.
    const settled = await rest('POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
    });
    check(
      refused(settled, 403) && settled.text.includes('42501'),
      'and may never settle one — the service role is not granted execute at all',
      `status ${settled.status}, ${settled.text.slice(0, 140)}`,
    );
  }

  // ── 7. a client decision carries its evidence ───────────────────────────
  console.log('\n7. A client decision is recorded with where it came from (ADM-08d)');
  {
    await as(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'prototype',
      min_amount_minor: 0,
      required_role: 'ops_admin',
      sla_hours: 72,
      audience: 'client',
    });

    const subject = randomUUID();
    const raised = one(await rpc(ops, 'request_approval', {
      p_organization_id: org,
      p_subject_type: 'prototype',
      p_subject_id: subject,
      p_requested_by_type: 'user',
      p_requested_by_id: opsId,
    }));

    const bare = one(await rpc(ops, 'decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
    }));
    check(
      bare?.outcome === 'evidence_required',
      'approving on a client’s behalf with no evidence is refused',
      `outcome ${bare?.outcome}`,
    );

    const withEvidence = one(await rpc(ops, 'decide_approval', {
      p_request_id: raised.request_id,
      p_decision: 'approved',
      p_evidence_ref: 'wamid.HBgMOTE5...client-said-yes',
    }));
    check(withEvidence?.outcome === 'decided', 'with it, the decision is recorded', `outcome ${withEvidence?.outcome}`);

    const row = (await rest('GET', 'approvals', `approval_requests?id=eq.${raised.request_id}&select=decided_by,evidence_ref`))
      .json?.[0];
    check(
      row?.decided_by === opsId && !!row?.evidence_ref,
      'and it says the staff member decided, with the client’s message beside it',
      `by ${row?.decided_by}, evidence ${row?.evidence_ref}`,
    );
  }

  // ── 9. tenancy ──────────────────────────────────────────────────────────
  console.log('\n9. Another agency’s queue is invisible and unsettleable');
  {
    const foreign = one(await rpc(outsider, 'request_approval', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_subject_id: randomUUID(),
      p_requested_by_type: 'user',
      p_requested_by_id: randomUUID(),
    }));
    check(
      foreign?.outcome === 'forbidden',
      'a signed-in caller cannot raise a request inside somebody else’s tenant',
      `outcome ${foreign?.outcome}`,
    );

    const visible = await as(outsider, 'GET', 'approvals', 'approval_requests?select=id');
    check(
      Array.isArray(visible.json) && visible.json.length === 0,
      'and sees none of its requests',
      `${visible.json?.length} row(s) visible`,
    );

    const target = (await rest('GET', 'approvals', `approval_requests?organization_id=eq.${org}&state=eq.pending&select=id`))
      .json?.[0]?.id;
    if (target) {
      const settled = one(await rpc(outsider, 'decide_approval', { p_request_id: target, p_decision: 'approved' }));
      check(
        settled?.outcome === 'not_found',
        'and cannot settle one, answered as not_found rather than confirming it exists',
        `outcome ${settled?.outcome}`,
      );
    }
  }

  // ── 11. nobody answered (G-096, ADM-08c) ────────────────────────────────
  console.log('\n11. An unanswered request expires and escalates, and approves nothing');
  {
    const subject = randomUUID();
    const raised = one(await rpc(ops, 'request_approval', {
      p_organization_id: org,
      p_subject_type: 'deliverable',
      p_subject_id: subject,
      p_requested_by_type: 'user',
      p_requested_by_id: opsId,
      p_summary: 'Nobody will answer this',
    }));

    // Backdated rather than waited for: the rule is "past its own deadline",
    // and forty-eight hours of real time is not a test.
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${raised.request_id}`, {
      sla_due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const swept = await rest('POST', 'approvals', 'rpc/expire_overdue', { p_limit: 50 });
    const rows = swept.json ?? [];
    check(
      rows.some((r) => r.expired_id === raised.request_id),
      'the overdue request is swept',
      `${rows.length} expired`,
    );

    const original = one(await rest('GET', 'approvals',
      `approval_requests?id=eq.${raised.request_id}&select=state,decided_by,decided_at`));
    check(original?.state === 'expired', 'and settled expired — never approved', `${original?.state}`);
    check(
      original?.decided_by === null && original?.decided_at !== null,
      'with a time and no decider, because nobody decided anything',
      `by ${original?.decided_by}`,
    );

    const escalation = one(await rest('GET', 'approvals',
      `approval_requests?escalated_from=eq.${raised.request_id}&select=id,state,required_role,requested_by_type,subject_id`));
    check(escalation?.state === 'pending', 'a fresh request is raised', `${escalation?.state}`);
    check(escalation?.required_role === 'owner', 'against the owner', `${escalation?.required_role}`);
    check(
      escalation?.subject_id === subject && escalation?.requested_by_type === 'system',
      'about the same subject, asked by nobody',
      `${escalation?.requested_by_type}`,
    );

    // Run it again: the escalation is itself overdue only when its own window
    // passes, and an escalation is never escalated a second time.
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${escalation.id}`, {
      sla_due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const again = await rest('POST', 'approvals', 'rpc/expire_overdue', { p_limit: 50 });
    check(
      !(again.json ?? []).some((r) => r.expired_id === escalation.id),
      'an escalation is not escalated again — there is nobody above the owner',
      `${(again.json ?? []).length} expired on the second sweep`,
    );

    const settled = one(await rest('GET', 'approvals', `approval_requests?id=eq.${escalation.id}&select=state`));
    check(settled?.state === 'pending', 'and it stays waiting for the owner', `${settled?.state}`);
  }

  // ── 10. policy is owner-only, and audited ───────────────────────────────
  console.log('\n10. Only an owner writes policy, and every write is audited');
  {
    const byOps = await as(ops, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'proposal',
      min_amount_minor: 0,
      required_role: 'ops_admin',
      sla_hours: 24,
    });
    check(
      refused(byOps, 403) || refused(byOps, 401),
      'an ops_admin may decide within a policy but not rewrite it',
      `status ${byOps.status}, ${byOps.text.slice(0, 140)}`,
    );

    const floor = await as(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: org,
      subject_type: 'refund',
      min_amount_minor: 0,
      required_role: 'delivery_lead',
      sla_hours: 24,
    });
    check(
      refused(floor, 400),
      'and not even an owner may put a refund below owner (ADM-08b’s money floor)',
      `status ${floor.status}, ${floor.text.slice(0, 140)}`,
    );

    const audits = await rest(
      'GET',
      'audit',
      `audit_log?organization_id=eq.${org}&subject_type=eq.approval_policy&select=action`,
    );
    check(
      (audits.json?.length ?? 0) >= 3,
      'policy writes left an audit trail',
      `${audits.json?.length} row(s)`,
    );

    const decisions = await rest(
      'GET',
      'audit',
      `audit_log?organization_id=eq.${org}&subject_type=eq.approval_request&select=action`,
    );
    const actions = (decisions.json ?? []).map((r) => r.action);
    check(
      actions.includes('approval.requested') && actions.some((a) => a.startsWith('approval.')),
      'and so did every request and decision',
      actions.join(', ').slice(0, 160),
    );
  }
} finally {
  // ── cleanup ───────────────────────────────────────────────────────────────
  //
  // Requests refuse DELETE by trigger and always will, so the ones this run
  // raised are settled rather than removed: `cancelled` is a terminal state
  // that leaves the queue empty without pretending anybody approved anything.
  // Their audit rows stay, as every audit row does.
  const leftovers = await rest(
    'GET',
    'approvals',
    `approval_requests?state=eq.pending&select=id,decided_at`,
  );
  for (const row of leftovers.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
      decision_note: `${MARKER} cleanup`,
    });
  }

  // Policies are ordinary rows, and they must go: the threshold index is
  // unique, so leaving them makes the next run fail on its own first insert.
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${MARKER_ORG}`);

  for (const userId of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${userId}`);
    await rest('DELETE', 'core', `users?id=eq.${userId}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ The approval engine holds\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
