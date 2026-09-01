#!/usr/bin/env node
/**
 * An approval nobody was told about — G-176, against a real database and the
 * running application.
 *
 * The quietest failure in the system, found by a fresh zero-trust audit.
 * `handleApprovalRequested` looks up the organization's internal channel and,
 * with none linked, answers:
 *
 *     { status: 'succeeded', outcome: 'no_group' }
 *
 * The job settles GREEN. Nothing the operational backlog counted moved. The
 * quotation sat at `pending_approval` for ever and the only way anybody found
 * it was by opening /approvals and happening to look.
 *
 * What this proves, in order:
 *
 *   A. A pending internal approval in an organization with no channel is
 *      COUNTED — `unannounced_approvals` rises, and the backlog turns
 *      `failing` rather than staying clear.
 *   B. The announcement job still settles as a success. That branch was never
 *      wrong: there is nowhere to send, and failing would retry into the same
 *      absence until the job parked dead. Only the silence was wrong.
 *   C. Linking the channel ANNOUNCES WHAT WAS ALREADY WAITING. Without this,
 *      the manual setup step repairs the future and abandons the past.
 *   D. The count returns to its baseline once the channel exists.
 *   E. Announcing twice writes one message. `handleApprovalRequested` keys on
 *      `approval:<request id>`, so the re-announcement cannot buzz a phone
 *      about a decision it already carried.
 *   F. A client-audience request is never counted. It was never going to be
 *      announced anywhere (ADM-08d).
 *   G. `announce_waiting_approvals` cannot reach another tenant's requests.
 *
 * Its OWN two organizations, which is the only way to be sure "no internal
 * channel" is true. They are reset rather than dropped — see the note on the
 * slugs below — and reset at both ends, so the second run of this script
 * measures exactly the world the first one did. That property is proved by
 * running it twice, which is the rule G-175 established.
 *
 *   node scripts/verify-unannounced-approvals.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false });
await announceTarget(target, 'an approval nobody was told about');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const MARKER = 'zztest-unannounced';
/**
 * Two FIXED organizations, reused rather than recreated.
 *
 * `approvals.reject_delete` refuses to delete an approval request under any
 * circumstances — *"approval requests are never deleted; cancel them"* — and
 * that cascades: an organization that has ever raised one cannot be dropped.
 * So the whatsapp-ingest pattern of build-a-tenant-and-drop-it is unavailable
 * here, and a fresh slug per run would leave a new undeletable organization
 * behind every time.
 *
 * Fixed slugs instead, with the preflight below returning them to a known
 * state: every pending request cancelled, every conversation removed. That is
 * the same discipline stated the other way round — this script owns these two
 * tenants, and owning them means leaving them as it found them.
 */
const SLUG = `${MARKER}-a`;
const SLUG_B = `${MARKER}-b`;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);

const tick = () => fetch(`${APP}/api/jobs/run`, {
  method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store',
}).then((r) => r.text()).catch(() => '');

async function until(predicate, budget = 20) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

const backlog = async () => one(await rpc('core', 'operational_backlog', {}));

/**
 * Return one of this script's organizations to the state it assumes: existing,
 * with no internal channel and nothing pending.
 *
 * Run at the START, because a previous interrupted run must not change what
 * this one observes (the discipline verify-whatsapp-ingest states), and again
 * at the END so the next run starts from the same place. Idempotent both ways.
 */
async function reset(slug, name) {
  const found = one(await rest('GET', 'core', `organizations?slug=eq.${slug}&select=id`));
  const id = found?.id ?? one(await rest('POST', 'core', 'organizations', {
    name, slug, timezone: 'Asia/Kolkata',
  }))?.id ?? null;
  if (!id) return null;

  // Cancel rather than delete — the database refuses the latter, on purpose.
  const pending = (await rest('GET', 'approvals',
    `approval_requests?organization_id=eq.${id}&state=eq.pending&select=id`)).json ?? [];
  for (const row of pending) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled', decided_at: new Date().toISOString(), decision_note: `${MARKER} reset`,
    });
  }

  const convs = (await rest('GET', 'crm', `conversations?organization_id=eq.${id}&select=id`)).json ?? [];
  for (const c of convs) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${c.id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${c.id}`);
  }
  await rest('DELETE', 'core', `outbox_events?organization_id=eq.${id}`);
  await rest('DELETE', 'core', `jobs?organization_id=eq.${id}`);
  return id;
}

console.log('\n\x1b[1mAn approval nobody was told about — G-176\x1b[0m');

// Declared without an initial value: the `finally` reads them, and ESLint is
// right that assigning null first is dead — `reset()` is the only writer.
let orgA;
let orgB;

try {
  // ── 0. baseline ─────────────────────────────────────────────────────────
  //
  // The backlog counts the whole deployment, not one tenant, so every
  // assertion below is a DELTA against what was already there. An absolute
  // count would pass or fail depending on what else the database happens to
  // hold, which is the shape of a check that flakes.
  console.log('\n0. Baseline');
  const before = await backlog();
  check(before !== null && before !== undefined, 'the backlog answers', JSON.stringify(before ?? {}).slice(0, 60));
  const baseline = Number(before?.unannounced_approvals ?? 0);
  check(
    Object.hasOwn(before ?? {}, 'unannounced_approvals'),
    'and it reports unannounced_approvals at all — the column exists',
    `baseline ${baseline}`,
  );

  // ── 1. an organization with no internal channel ─────────────────────────
  console.log('\n1. An organization with nowhere to be told');
  orgA = await reset(SLUG, `${MARKER} agency`);
  check(Boolean(orgA), 'an organization exists, reset to a known state', orgA ? '' : 'the insert was refused');
  if (!orgA) throw new Error('cannot continue without an organization');

  const channels = await rest('GET', 'crm',
    `conversations?organization_id=eq.${orgA}&kind=in.(internal_direct,internal_group)&select=id`);
  check((channels.json ?? []).length === 0, 'and it has no internal channel', `${(channels.json ?? []).length}`);

  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: orgA, subject_type: 'proposal', min_amount_minor: 0,
    required_role: 'owner', sla_hours: 24, active: true, note: `${MARKER} rung`,
  });

  const raised = one(await rpc('approvals', 'request_approval', {
    p_organization_id: orgA,
    p_subject_type: 'proposal',
    p_subject_id: randomUUID(),
    p_requested_by_type: 'system',
    p_requested_by_id: null,
    p_summary: `${MARKER} quotation v1`,
    p_payload: null,
    p_amount_minor: 5000000,
    p_audience: 'internal',
    p_correlation_id: null,
  }));
  const requestId = raised?.request_id ?? raised?.id ?? null;
  check(Boolean(requestId), 'an internal approval is raised', requestId ? '' : JSON.stringify(raised).slice(0, 160));

  // ── 2. it is counted ────────────────────────────────────────────────────
  console.log('\n2. The system says so');
  const during = await backlog();
  check(
    Number(during?.unannounced_approvals ?? 0) === baseline + 1,
    'the backlog counts one approval nobody was told about',
    `${baseline} → ${during?.unannounced_approvals}`,
  );
  check(Boolean(during?.oldest_unannounced_at), 'and says how long it has been waiting', String(during?.oldest_unannounced_at ?? 'null'));

  // ── 3. the job is still a success, and that is correct ──────────────────
  console.log('\n3. The announcement job settles green, which was never the bug');
  const settled = await until(async () => {
    const jobs = await rest('GET', 'core',
      `jobs?organization_id=eq.${orgA}&kind=eq.approval.announce&select=id,status,last_error`);
    const row = (jobs.json ?? [])[0];
    return row && row.status !== 'queued' && row.status !== 'running' ? row : null;
  });
  check(settled?.status === 'succeeded', 'the announce job succeeded rather than dying', `${settled?.status}`);
  const messagesBefore = await rest('GET', 'crm',
    `conversation_messages?organization_id=eq.${orgA}&select=id`);
  check((messagesBefore.json ?? []).length === 0, 'and nothing was sent, because there was nowhere to send it',
    `${(messagesBefore.json ?? []).length} message(s)`);

  // ── 4. linking the channel announces what was waiting ───────────────────
  console.log('\n4. Linking the channel announces what was already waiting');
  const linked = one(await rpc('crm', 'link_internal_recipient', {
    p_organization_id: orgA, p_phone: '919876500001', p_title: `${MARKER} owner`,
  }));
  check(linked?.outcome === 'linked', 'the owner links their own number', `${linked?.outcome}`);

  const reEmitted = await rest('GET', 'core',
    `outbox_events?organization_id=eq.${orgA}&type=eq.approval.requested&select=id`);
  check(
    (reEmitted.json ?? []).length === 2,
    'a SECOND approval.requested is emitted for the request that was waiting',
    `${(reEmitted.json ?? []).length} event(s)`,
  );

  const told = await until(async () => {
    const rows = await rest('GET', 'crm',
      `conversation_messages?organization_id=eq.${orgA}&select=id,body,external_ref`);
    return (rows.json ?? []).length > 0 ? rows.json : null;
  });
  check(Array.isArray(told) && told.length > 0, 'and the owner is finally told', `${(told ?? []).length} message(s)`);
  check(
    (told ?? [])[0]?.external_ref === `approval:${requestId}`,
    'keyed on the request, so a re-announcement collapses onto one message',
    String((told ?? [])[0]?.external_ref ?? ''),
  );

  // ── 5. the count clears ─────────────────────────────────────────────────
  console.log('\n5. And the backlog clears');
  const after = await backlog();
  check(
    Number(after?.unannounced_approvals ?? -1) === baseline,
    'nothing is unannounced any more',
    `${during?.unannounced_approvals} → ${after?.unannounced_approvals}`,
  );

  // ── 6. announcing twice writes once ─────────────────────────────────────
  console.log('\n6. Announcing twice writes one message');
  const again = one(await rpc('crm', 'announce_waiting_approvals', { p_organization_id: orgA }));
  check(Number(again ?? -1) === 1, 're-announcing finds the request still pending', `${again}`);
  for (let i = 0; i < 6; i += 1) await tick();
  const stillOne = await rest('GET', 'crm',
    `conversation_messages?organization_id=eq.${orgA}&external_ref=eq.${encodeURIComponent(`approval:${requestId}`)}&select=id`);
  check((stillOne.json ?? []).length === 1, 'and the owner’s phone buzzes once, not twice',
    `${(stillOne.json ?? []).length} message(s)`);

  // ── 7. a client-audience request is not counted ─────────────────────────
  console.log('\n7. A client decision was never going to be announced');
  orgB = await reset(SLUG_B, `${MARKER} agency B`);
  check(Boolean(orgB), 'a second organization, with no channel either');

  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: orgB, subject_type: 'proposal', min_amount_minor: 0,
    required_role: 'owner', sla_hours: 24, active: true, note: `${MARKER} client rung`,
  });
  await rpc('approvals', 'request_approval', {
    p_organization_id: orgB,
    p_subject_type: 'proposal',
    p_subject_id: randomUUID(),
    p_requested_by_type: 'system',
    p_requested_by_id: null,
    p_summary: `${MARKER} client decision`,
    p_payload: null,
    p_amount_minor: 100000,
    p_audience: 'client',
    p_correlation_id: null,
  });

  const withClient = await backlog();
  check(
    Number(withClient?.unannounced_approvals ?? -1) === baseline,
    'a client-audience request adds nothing to the count',
    `${withClient?.unannounced_approvals}`,
  );

  // ── 8. it cannot reach another tenant ───────────────────────────────────
  console.log('\n8. And it announces only its own tenant’s requests');
  // orgB has a pending CLIENT request and no internal ones, so asking for
  // orgA's id from a call that names orgB must not carry orgA's work across.
  const crossed = one(await rpc('crm', 'announce_waiting_approvals', { p_organization_id: orgB }));
  check(Number(crossed ?? -1) === 0, 'a tenant with no internal request announces nothing', `${crossed}`);
} finally {
  // Left as they were found: the organizations survive (their approvals cannot
  // be deleted) but nothing pending, no channel, no messages, no queue. The
  // next run of this script measures the same world this one did.
  await reset(SLUG, `${MARKER} agency`);
  await reset(SLUG_B, `${MARKER} agency B`);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ An approval nobody was told about is counted, and linking a channel tells them\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`);
process.exit(1);
