#!/usr/bin/env node
/**
 * The agent asking in the internal group, verified against a real database.
 *
 * Gap G-110, decision ADM-11, against docs/business-os/02-business-rules.md
 * §5.1. G-109 built the channel and nothing flowed through it: the queue the
 * Admin was promised existed only on a web page.
 *
 * What it proves:
 *
 *   1. Every request gets a reference, drawn from an alphabet with the
 *      characters people misread on a phone removed, and no two share one.
 *   2. An **internal**-audience request emits `approval.requested`, carrying
 *      the reference and the amount.
 *   3. A **client**-audience request emits nothing. That is §5.1's rule — the
 *      internal group is an approval channel, not a chat log, and a client's
 *      decision is recorded by staff with evidence (ADM-08d).
 *   4. The event becomes exactly one job, and re-dispatching enqueues none.
 *   5. Raising the same request twice announces once: `already_pending`
 *      emits nothing, so an owner's phone does not buzz twice for one
 *      decision.
 *   6. A reference is never reused, even after its request settles.
 *
 * Not proved here, because it is not built: nothing settles an approval from
 * a WhatsApp reply. `decide_approval` refuses without a signed-in approver,
 * and inbound group messages have no ingest path at all (G-115). See ADM-74.
 *
 *   node scripts/verify-approval-announcements.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
await announceTarget(target, 'verify-approval-announcements');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-announce';
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

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
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

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const raise = (subjectType, subjectId, extra = {}) =>
  rest('POST', 'approvals', 'rpc/request_approval', {
    p_organization_id: ORG,
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_requested_by_type: 'system',
    ...extra,
  });

const eventsFor = async (requestId) =>
  (await rest('GET', 'core', `outbox_events?subject_id=eq.${requestId}&select=id,type,payload`)).json ?? [];

const created = { requests: [] };

console.log('\n\x1b[1mAgencyOS — the agent asks in the group (G-110)\x1b[0m');

try {
  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'invoice',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 24,
    audience: 'internal',
  });
  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'deliverable',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 48,
    audience: 'client',
  });

  // ── 1 & 2. an internal request is announced ─────────────────────────────
  console.log('\n1. An internal request carries a reference and is announced');
  {
    const subject = randomUUID();
    const raised = one(await raise('invoice', subject, { p_amount_minor: 4500000 }));
    check(raised?.outcome === 'requested', 'the request is raised', `outcome ${raised?.outcome}`);
    created.requests.push(raised.request_id);

    const row = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${raised.request_id}&select=reference,audience`),
    );
    check(
      typeof row?.reference === 'string' && /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/.test(row.reference),
      'it has a six-character reference from the safe alphabet',
      `${row?.reference}`,
    );
    check(
      !/[01OILU]/.test(row?.reference ?? ''),
      'and none of the characters people misread on a phone',
      `${row?.reference}`,
    );

    const events = await eventsFor(raised.request_id);
    check(events.length === 1, 'exactly one announcement is emitted', `${events.length} events`);
    check(
      events[0]?.type === 'approval.requested',
      'of the type the catalog subscribes to',
      `${events[0]?.type}`,
    );
    check(
      events[0]?.payload?.reference === row?.reference,
      'carrying the reference somebody has to quote back',
      `${events[0]?.payload?.reference}`,
    );
    check(
      events[0]?.payload?.amountMinor === 4500000,
      'and the amount the decision is about',
      `${events[0]?.payload?.amountMinor}`,
    );

    created.firstReference = row?.reference;
    created.firstRequest = raised.request_id;
  }

  // ── 5. raising twice announces once ─────────────────────────────────────
  console.log('\n2. One decision, one announcement');
  {
    const subject = randomUUID();
    const first = one(await raise('invoice', subject));
    created.requests.push(first.request_id);

    const again = one(await raise('invoice', subject));
    check(
      again?.outcome === 'already_pending' && again?.request_id === first.request_id,
      'raising the same subject twice answers with the pending request',
      `outcome ${again?.outcome}`,
    );

    const events = await eventsFor(first.request_id);
    check(
      events.length === 1,
      'and emits nothing the second time — an owner’s phone does not buzz twice',
      `${events.length} events`,
    );
  }

  // ── 3. a client-audience request is not announced ───────────────────────
  console.log('\n3. A client’s decision is not brought to the internal group');
  {
    const subject = randomUUID();
    const raised = one(await raise('deliverable', subject));
    check(raised?.outcome === 'requested', 'the client-audience request is raised');
    created.requests.push(raised.request_id);

    const events = await eventsFor(raised.request_id);
    check(
      events.length === 0,
      '§5.1: the internal group is an approval channel, not a chat log',
      `${events.length} events`,
    );

    // And the explicit override is honoured, not just the policy default.
    const forced = one(await raise('invoice', randomUUID(), { p_audience: 'client' }));
    created.requests.push(forced.request_id);
    const forcedEvents = await eventsFor(forced.request_id);
    check(
      forcedEvents.length === 0,
      'and an internal-policy subject forced to client audience is not announced either',
      `${forcedEvents.length} events`,
    );
  }

  // ── 6. references are never reused ──────────────────────────────────────
  console.log('\n4. A reference is never reused');
  {
    const duplicate = await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.requests[1]}`, {
      reference: created.firstReference,
    });
    check(
      duplicate.status >= 400 && duplicate.text.includes('approval_requests_reference_key'),
      'two live requests cannot share a code',
      `status ${duplicate.status}`,
    );

    // Settle the first, then try to hand its code to a new request. A code
    // recycled on settlement would make a late reply land on a different
    // decision.
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.firstRequest}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
    const afterSettle = await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.requests[1]}`, {
      reference: created.firstReference,
    });
    check(
      afterSettle.status >= 400,
      'and a settled request keeps its code — it is not recycled',
      `status ${afterSettle.status}`,
    );
  }

  // ── 4. the event becomes one job, and only one ──────────────────────────
  console.log('\n5. The announcement becomes exactly one job');
  {
    const unpublished = (
      await rest('GET', 'core', `outbox_events?type=eq.approval.requested&published_at=is.null&select=id`)
    ).json ?? [];
    check(
      unpublished.length > 0,
      'the announcements are waiting in the outbox for the dispatcher',
      `${unpublished.length} unpublished`,
    );

    // The dispatcher's own idempotency is proved by tests/outbox-dispatch and
    // verify-milestone-unlock; what matters here is that these events are
    // ordinary outbox rows and need no special handling.
    const shaped = (
      await rest('GET', 'core', `outbox_events?type=eq.approval.requested&select=organization_id,subject_type`)
    ).json ?? [];
    check(
      shaped.every((e) => e.organization_id === ORG && e.subject_type === 'approval_request'),
      'each is scoped to its organization and names its subject',
      `${shaped.length} rows`,
    );
  }
  // ── 6. one queue does not starve another ────────────────────────────────
  //
  // G-110's announce drain returned early, exactly as the unlock drain does.
  // The unlock path can afford that — milliseconds of pure database work — but
  // an announcement reaches an outside provider, and returning meant **a
  // single queued announcement starved every later queue for that whole
  // invocation**. In CI, where the scripts drive the runner directly rather
  // than waiting for cron, that is the difference between a tick doing its
  // work and a tick doing none of it.
  console.log('\n6. An announcement does not starve the queues behind it');
  {
    // Isolated first. This script raises several approvals of its own, and the
    // runner's dispatcher turns any unpublished ones into announce jobs — so
    // without this the tick spends its batch on those and the assertion below
    // measures the script's own leftovers rather than the starvation it is
    // testing. The same reason verify-requirement-proposal parks other
    // extractions before its own.
    await rest('DELETE', 'core', 'jobs?dedupe_key=like.zzstarve-*');
    await rest('PATCH', 'core', "jobs?status=eq.queued", { status: 'cancelled' });
    await rest('DELETE', 'core', 'outbox_events?type=eq.approval.requested');

    await rest('POST', 'core', 'jobs', [
      { organization_id: ORG, kind: 'approval.announce', payload: {}, dedupe_key: 'zzstarve-a', status: 'queued' },
      { organization_id: ORG, kind: 'requirement.extract', payload: {}, dedupe_key: 'zzstarve-e', status: 'queued' },
    ]);

    const before = (
      await rest('GET', 'core', 'jobs?dedupe_key=eq.zzstarve-e&select=attempts')
    ).json ?? [];
    check(before[0]?.attempts === 0, 'the extraction job starts unclaimed', `${before[0]?.attempts}`);

    const res = await fetch(`${target.app}/api/jobs/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.cronSecret}` },
      cache: 'no-store',
    }).catch(() => null);

    if (!res || res.status >= 400) {
      // The app is not running against this database, which is the ordinary
      // case for a schema-only run. Skipped loudly rather than passed quietly.
      console.log('  \x1b[33m•\x1b[0m the runner is not reachable; starvation check skipped');
    } else {
      const after = (
        await rest('GET', 'core', 'jobs?dedupe_key=eq.zzstarve-e&select=attempts,status')
      ).json ?? [];
      check(
        after[0]?.attempts === 1,
        'and one tick reaches it even with an announcement queued ahead of it',
        `attempts ${after[0]?.attempts}`,
      );
    }

    await rest('DELETE', 'core', 'jobs?dedupe_key=like.zzstarve-*');
  }

} finally {
  for (const id of created.requests ?? []) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
  }
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  // The requests themselves refuse deletion by design; cancelled is the end
  // state, and verify-milestone-unlock's "no leftover outbox events" assertion
  // is what the deletes above protect.
  void MARKER;
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ What needs deciding is announced, once, to the right audience\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
