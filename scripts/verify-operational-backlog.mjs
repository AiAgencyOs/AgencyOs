#!/usr/bin/env node
/**
 * Monitoring, verified against a real database.
 *
 * Gap G-053, with G-058 and the open half of G-080. The counts and the
 * suppression are both database behaviour, so both are driven here rather than
 * reasoned about: a monitor that miscounts is worse than none, and an alert
 * that fires every minute is worse than that.
 *
 * What it proves:
 *
 *   1. A dead job, a stalled job, a stuck queued job and an unpublished event
 *      are each counted — planted one at a time, so a count that is right by
 *      accident cannot pass.
 *   2. The backlog is RLS-scoped: an owner sees their organization, not the
 *      deployment.
 *   3. The first alert for a situation is claimed exactly once, even when two
 *      callers claim concurrently — the overlapping-cron case.
 *   4. The same situation is suppressed until the cooldown elapses.
 *   5. A changed situation is reported immediately, cooldown or not.
 *   6. alert_state is unreachable through the API by anybody.
 *   7. A wedged follow-up (G-012) — active, blocked, and overdue past the same
 *      fifteen-minute floor — is surfaced by reason, while a freshly-blocked
 *      one, an unblocked one, and a stopped one are not, and another
 *      organization sees none of it.
 *
 * What it creates and removes: jobs, an outbox event, one alert_state row and a
 * few follow-up sequences in the seeded demo organization, plus one auth user.
 * All removed in the `finally` block — jobs, events and sequences are ordinary
 * rows, unlike approvals.
 *
 *   node scripts/verify-operational-backlog.mjs
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
await announceTarget(target, 'verify-operational-backlog');

const URL_BASE = target.url;
const SERVICE_KEY = target.serviceKey;

const MARKER = 'zztest-g053';
/** The seeded demo organization — see verify-approvals.mjs on why not a new one. */
const ORG = '00000000-0000-4000-8000-000000000001';

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

const rest = (method, schema, path, body) => call(SERVICE_KEY, method, schema, path, body);
const one = (result) => (Array.isArray(result.json) ? result.json[0] : result.json);

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

const backlog = async (token = SERVICE_KEY) =>
  one(await call(token, 'POST', 'core', 'rpc/operational_backlog', {}));

const created = { users: [] };
const ALERT_KEY = 'operational-backlog';
/** All planted follow-up sequences share this situation_key, so cleanup is one delete. */
const WEDGE_KEY = `${MARKER}-wedged`;

/** Sixteen minutes ago — past the fifteen the function measures against. */
const longAgo = () => new Date(Date.now() - 16 * 60 * 1000).toISOString();

console.log('\n\x1b[1mAgencyOS — the operational backlog (G-053)\x1b[0m');

try {
  await rest('DELETE', 'core', `alert_state?key=eq.${ALERT_KEY}`);

  const base = await backlog();
  check(base !== null && base !== undefined, 'the backlog answers at all', `got ${JSON.stringify(base)}`);

  // ── 1. each state is counted, one at a time ─────────────────────────────
  console.log('\n1. Each kind of stuck work is counted');
  {
    const dead = one(
      await rest('POST', 'core', 'jobs', {
        organization_id: ORG,
        kind: `${MARKER}.dead`,
        status: 'dead',
        attempts: 5,
        max_attempts: 5,
        last_error: 'planted by verify-operational-backlog',
      }),
    );
    let now = await backlog();
    check(
      Number(now.dead_jobs) === Number(base.dead_jobs) + 1,
      'a dead job is counted',
      `${base.dead_jobs} → ${now.dead_jobs}`,
    );
    check(now.oldest_dead_at !== null, 'and its age is available', `${now.oldest_dead_at}`);

    const stalled = one(
      await rest('POST', 'core', 'jobs', {
        organization_id: ORG,
        kind: `${MARKER}.stalled`,
        status: 'running',
        locked_at: longAgo(),
        locked_by: MARKER,
      }),
    );
    now = await backlog();
    check(
      Number(now.stalled_jobs) === Number(base.stalled_jobs) + 1,
      'a job whose lock is older than the staleness constant is counted',
      `${base.stalled_jobs} → ${now.stalled_jobs}`,
    );

    // A `running` job locked just now must NOT count, or the number would be
    // "jobs currently working", which is not a problem at all.
    const busy = one(
      await rest('POST', 'core', 'jobs', {
        organization_id: ORG,
        kind: `${MARKER}.busy`,
        status: 'running',
        locked_at: new Date().toISOString(),
        locked_by: MARKER,
      }),
    );
    const withBusy = await backlog();
    check(
      Number(withBusy.stalled_jobs) === Number(now.stalled_jobs),
      'a job that is merely working is not counted as stalled',
      `${now.stalled_jobs} → ${withBusy.stalled_jobs}`,
    );

    const stuck = one(
      await rest('POST', 'core', 'jobs', {
        organization_id: ORG,
        kind: `${MARKER}.stuck`,
        status: 'queued',
        run_at: longAgo(),
      }),
    );
    now = await backlog();
    check(
      Number(now.stuck_queued_jobs) === Number(base.stuck_queued_jobs) + 1,
      'a job queued longer than the runner should take is counted',
      `${base.stuck_queued_jobs} → ${now.stuck_queued_jobs}`,
    );

    const event = one(
      await rest('POST', 'core', 'outbox_events', {
        organization_id: ORG,
        type: `${MARKER}.event`,
        created_at: longAgo(),
      }),
    );
    now = await backlog();
    check(
      Number(now.unpublished_events) === Number(base.unpublished_events) + 1,
      'an event unpublished for longer than that is counted',
      `${base.unpublished_events} → ${now.unpublished_events}`,
    );

    created.jobs = [dead?.id, stalled?.id, busy?.id, stuck?.id].filter(Boolean);
    created.event = event?.id;
  }

  // ── 2. tenancy ──────────────────────────────────────────────────────────
  console.log('\n2. The backlog is whatever the caller may read');
  {
    const outsiderOrg = randomUUID();
    const outsider = mint(randomUUID(), outsiderOrg, 'owner');

    const theirs = await backlog(outsider);
    check(
      Number(theirs.dead_jobs) === 0 && Number(theirs.stalled_jobs) === 0,
      'another organization sees none of this deployment’s backlog',
      `dead ${theirs?.dead_jobs}, stalled ${theirs?.stalled_jobs}`,
    );

    const service = await backlog();
    check(
      Number(service.dead_jobs) > 0,
      'while the service role, which the cron runs as, sees all of it',
      `dead ${service.dead_jobs}`,
    );
  }

  // ── 3-5. the claim, and what suppresses it ──────────────────────────────
  console.log('\n3. One alert per situation, and one sender');
  {
    const claim = (signature, hours = 1) =>
      rest('POST', 'core', 'rpc/claim_alert', {
        p_key: ALERT_KEY,
        p_signature: signature,
        p_cooldown_hours: hours,
      });

    // claim_alert returns the instant it stamped (a timestamp) when the send
    // should go out, or null when the cooldown suppresses it.
    const claimed = (r) => typeof r.json === 'string';

    const [a, b] = await Promise.all([claim('failing:1:0:0:0:0'), claim('failing:1:0:0:0:0')]);
    const granted = [a, b].filter(claimed);
    check(
      granted.length === 1,
      'two callers claiming the same alert at the same moment: exactly one wins',
      `results ${a.json}, ${b.json}`,
    );

    const again = await claim('failing:1:0:0:0:0');
    check(again.json === null, 'and the same situation stays suppressed', `returned ${again.json}`);

    const worse = await claim('failing:2:0:0:0:0');
    check(claimed(worse), 'a changed situation is reported immediately, cooldown or not', `returned ${worse.json}`);

    const expired = await claim('failing:2:0:0:0:0', 0);
    check(claimed(expired), 'and an elapsed cooldown lets the same situation be repeated', `returned ${expired.json}`);

    const state = await rest('GET', 'core', `alert_state?key=eq.${ALERT_KEY}&select=signature`);
    check(
      state.json?.[0]?.signature === 'failing:2:0:0:0:0',
      'the row records what was last said',
      `${state.json?.[0]?.signature}`,
    );

    // ── the claim is an intention, not a delivery ─────────────────────────
    // A claim whose delivery then fails must be released, or a blip suppresses
    // the situation for the whole cooldown. release_alert is a compare-and-swap
    // on the claim INSTANT, not the signature — a signature recurs.
    const release = (at) => rest('POST', 'core', 'rpc/release_alert', { p_key: ALERT_KEY, p_claimed_at: at });

    const staleRelease = await release('1999-01-01T00:00:00Z');
    check(staleRelease.json === false, 'releasing a stale instant does nothing — a newer claim keeps its cooldown');
    const heldState = await rest('GET', 'core', `alert_state?key=eq.${ALERT_KEY}&select=last_sent_at`);
    check(Boolean(heldState.json?.[0]?.last_sent_at), 'and the row is untouched');

    // The CAS in the case the bug lived in: a LATER claim reused the same
    // signature, moving the instant on; a stale release for the earlier instant
    // must not rewind the later one.
    const first = await claim('failing:2:0:0:0:0', 0);
    const firstAt = first.json;
    const second = await claim('failing:2:0:0:0:0', 0); // same signature, new instant
    check(claimed(second) && second.json !== firstAt, 'a re-claim of the same signature stamps a new instant', `${firstAt} vs ${second.json}`);
    const staleSameSig = await release(firstAt);
    check(staleSameSig.json === false, 'releasing the EARLIER instant of a reused signature is a no-op — no double page');

    const rightRelease = await release(second.json);
    check(rightRelease.json === true, 'releasing the current instant succeeds');
    const afterRelease = await claim('failing:2:0:0:0:0');
    check(claimed(afterRelease), 'and the same situation can now be re-claimed — the failed send is retried');

    // ── recovery clears a FAILING alert (not a flapping degraded one) ──────
    const cleared = await rest('POST', 'core', 'rpc/clear_alert', { p_key: ALERT_KEY });
    check(cleared.json === true, 'clearing on recovery removes a failing alert');
    const goneState = await rest('GET', 'core', `alert_state?key=eq.${ALERT_KEY}&select=key`);
    check((goneState.json ?? []).length === 0, 'the alert state is gone');
    const afterClear = await claim('failing:2:0:0:0:0');
    check(claimed(afterClear), 'and the returning failure is sent again, not suppressed');

    // A degraded alert is NOT cleared on recovery — it expires on its cooldown,
    // so a flapping degraded state does not page every threshold crossing.
    await rest('DELETE', 'core', `alert_state?key=eq.${ALERT_KEY}`);
    await claim('degraded:0:2:0:0:0');
    const degradedClear = await rest('POST', 'core', 'rpc/clear_alert', { p_key: ALERT_KEY });
    check(degradedClear.json === false, 'clearing a degraded alert is a no-op — it keeps its cooldown so a flap does not spam');
    const stillThere = await rest('GET', 'core', `alert_state?key=eq.${ALERT_KEY}&select=signature`);
    check(stillThere.json?.[0]?.signature === 'degraded:0:2:0:0:0', 'and the degraded row stands');

    // clearing a key that is not there is a harmless false, not an error
    await rest('DELETE', 'core', `alert_state?key=eq.${ALERT_KEY}`);
    const clearMissing = await rest('POST', 'core', 'rpc/clear_alert', { p_key: 'zz-no-such-alert-key' });
    check(clearMissing.json === false, 'clearing an absent alert is a harmless no-op');
  }

  // ── 6. operator state is not tenant data ────────────────────────────────
  console.log('\n4. Alert state is not published to anybody');
  {
    const owner = mint(randomUUID(), ORG, 'owner');
    const read = await call(owner, 'GET', 'core', 'alert_state?select=key');
    check(
      Array.isArray(read.json) && read.json.length === 0,
      'an owner reads no rows from alert_state',
      `status ${read.status}, ${read.text.slice(0, 120)}`,
    );

    const write = await call(owner, 'POST', 'core', 'alert_state', {
      key: `${MARKER}-forged`,
      signature: 'clear:0:0:0:0:0',
    });
    check(
      write.status >= 400 && !write.text.includes('PGRST106'),
      'and cannot write one, so nobody can silence an alert from the API',
      `status ${write.status}, ${write.text.slice(0, 120)}`,
    );
  }

  // ── 5. G-099 — a dead job goes back to the queue, and only a dead one ────
  //
  // The counting above says what the system gave up on. This says it can be
  // picked back up, and — the half that matters — that nothing else can be.
  // Resetting a *running* job is the one way to get the same work claimed
  // twice at once, which is the double-run the gap was worried about all
  // along; it is the case a structural test cannot prove, because it is the
  // database's `for update` doing the work.
  console.log('\n5. G-099 — reviving what was given up on');
  {
    const requeue = (id) => rest('POST', 'core', 'rpc/requeue_job', { p_job_id: id });

    const plant = async (status, extra = {}) =>
      one(
        await rest('POST', 'core', 'jobs', {
          organization_id: ORG,
          kind: `${MARKER}.requeue`,
          status,
          attempts: 5,
          max_attempts: 5,
          last_error: 'planted by verify-operational-backlog',
          ...extra,
        }),
      );

    const dead = await plant('dead', { locked_at: longAgo(), locked_by: MARKER });
    (created.jobs ??= []).push(dead.id);

    const answer = one(await requeue(dead.id));
    check(answer?.outcome === 'requeued', 'a dead job is requeued', `outcome: ${answer?.outcome}`);
    check(
      Number(answer?.attempts) === 5,
      'and the answer carries the attempts it had already spent',
      `attempts: ${answer?.attempts}`,
    );

    const after = one(
      await rest(
        'GET',
        'core',
        `jobs?id=eq.${dead.id}&select=status,attempts,locked_at,locked_by,last_error`,
      ),
    );
    check(after?.status === 'queued', 'the row is queued again', `status: ${after?.status}`);
    check(Number(after?.attempts) === 0, 'with its attempts reset', `attempts: ${after?.attempts}`);
    check(
      after?.locked_at === null && after?.locked_by === null,
      'and the claim it died holding cleared, so the reaper does not see it as stalled',
      `locked_at: ${after?.locked_at}, locked_by: ${after?.locked_by}`,
    );
    check(
      after?.last_error === 'planted by verify-operational-backlog',
      'and last_error kept — the only record of why the work stopped',
      `last_error: ${after?.last_error}`,
    );

    const audits = await rest(
      'GET',
      'audit',
      `audit_log?subject_id=eq.${dead.id}&action=eq.job.requeued&select=before,after`,
    );
    check(
      (audits.json ?? []).length === 1,
      'reviving it is audited, from inside the same transaction',
      `found ${(audits.json ?? []).length}`,
    );
    check(
      audits.json?.[0]?.before?.status === 'dead' && audits.json?.[0]?.after?.status === 'queued',
      'and the history records what it was, not only what it became',
      JSON.stringify(audits.json?.[0] ?? null),
    );

    // ── the half that matters ─────────────────────────────────────────────
    const running = await plant('running', { locked_at: new Date().toISOString(), locked_by: MARKER });
    created.jobs.push(running.id);

    const refusedRunning = one(await requeue(running.id));
    check(
      refusedRunning?.outcome === 'not_dead',
      'a RUNNING job is refused — resetting it is how the same work gets claimed twice',
      `outcome: ${refusedRunning?.outcome}`,
    );
    check(
      refusedRunning?.job_status === 'running',
      'and the refusal quotes the status the lock saw',
      `job_status: ${refusedRunning?.job_status}`,
    );

    const stillRunning = one(
      await rest('GET', 'core', `jobs?id=eq.${running.id}&select=status,locked_by`),
    );
    check(
      stillRunning?.status === 'running' && stillRunning?.locked_by === MARKER,
      'and it is left exactly as it was, claim and all',
      JSON.stringify(stillRunning ?? null),
    );

    // Requeuing the same job twice is refused the second time: it is queued by
    // then, not dead. Two operators on the page cannot both revive it.
    const twice = one(await requeue(dead.id));
    check(
      twice?.outcome === 'not_dead' && twice?.job_status === 'queued',
      'requeuing the same job twice is refused the second time',
      `outcome: ${twice?.outcome}, status: ${twice?.job_status}`,
    );

    const missing = one(await requeue('00000000-0000-4000-8000-0000000000ff'));
    check(
      missing?.outcome === 'not_found',
      'a job that does not exist is not_found, which is different news',
      `outcome: ${missing?.outcome}`,
    );

    // ── the path the operator actually takes: authenticated, not the service
    // role. core.jobs has no UPDATE policy, so an INVOKER requeue was silently
    // RLS-filtered to nothing while reporting success. The checks above all use
    // the SERVICE key, which bypasses RLS — so none of them exercised the real
    // caller, and the bug shipped green.
    const requeueAs = (token, id) => call(token, 'POST', 'core', 'rpc/requeue_job', { p_job_id: id });

    const opOwner = mint(randomUUID(), ORG, 'owner');
    const deadA = await plant('dead', { locked_at: longAgo(), locked_by: MARKER });
    created.jobs.push(deadA.id);
    const ownerRequeue = one(await requeueAs(opOwner, deadA.id));
    check(
      ownerRequeue?.outcome === 'requeued',
      'an owner (authenticated, not the service role) requeues a dead job',
      `outcome: ${ownerRequeue?.outcome}`,
    );
    const deadAAfter = one(await rest('GET', 'core', `jobs?id=eq.${deadA.id}&select=status,attempts`));
    check(
      deadAAfter?.status === 'queued' && Number(deadAAfter?.attempts) === 0,
      'and the job is ACTUALLY back on the queue — not a false success over a row RLS filtered away',
      `status ${deadAAfter?.status}, attempts ${deadAAfter?.attempts}`,
    );

    // An internal role WITHOUT job.requeue (delivery_lead) is refused, so a
    // direct RPC cannot slip past the /operations capability gate.
    const leadToken = mint(randomUUID(), ORG, 'delivery_lead');
    const deadB = await plant('dead', { locked_at: longAgo(), locked_by: MARKER });
    created.jobs.push(deadB.id);
    const leadRequeue = one(await requeueAs(leadToken, deadB.id));
    check(
      leadRequeue?.outcome === 'not_found',
      'a role without job.requeue is refused — the capability gate holds at the function too',
      `outcome: ${leadRequeue?.outcome}`,
    );
    check(
      one(await rest('GET', 'core', `jobs?id=eq.${deadB.id}&select=status`))?.status === 'dead',
      'and the job it may not touch is left dead',
    );

    // Another organization's owner cannot requeue this deployment's job.
    const foreignOwner = mint(randomUUID(), randomUUID(), 'owner');
    const foreignRequeue = one(await requeueAs(foreignOwner, deadB.id));
    check(
      foreignRequeue?.outcome === 'not_found',
      'another organization cannot requeue this deployment’s job',
      `outcome: ${foreignRequeue?.outcome}`,
    );
    check(
      one(await rest('GET', 'core', `jobs?id=eq.${deadB.id}&select=status`))?.status === 'dead',
      'and it stays dead across the tenant line',
    );
  }

  // ── 6. wedged follow-ups — G-012 ─────────────────────────────────────────
  //
  // A blocked evaluation is not an attempt and does not move next_due_at, so a
  // sequence stuck on the same reason sits active and overdue forever, sending
  // nothing, while nothing else in the backlog moves. core.wedged_follow_ups
  // surfaces it, GROUPED BY REASON so the expected G-137 timezone wait is told
  // apart from a real defect — and it counts only what is genuinely wedged:
  // active, overdue past the same fifteen-minute floor, and actually blocked.
  console.log('\n6. A follow-up the scheduler cannot advance is visible, by reason');
  {
    const wedged = async (token = SERVICE_KEY) =>
      (await call(token, 'POST', 'core', 'rpc/wedged_follow_ups', {})).json ?? [];
    const countFor = (rows, reason) => Number((rows ?? []).find((r) => r.reason === reason)?.wedged ?? 0);

    const plantSeq = (reason, minsOverdue, status = 'active', extra = {}) =>
      rest('POST', 'crm', 'follow_up_sequences', {
        organization_id: ORG,
        situation_key: WEDGE_KEY,
        subject_type: 'lead',
        subject_id: randomUUID(),
        triggered_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        status,
        last_block_reason: reason,
        last_evaluated_at: new Date().toISOString(),
        next_due_at: new Date(Date.now() - minsOverdue * 60 * 1000).toISOString(),
        ...extra,
      });

    const base = await wedged();
    const baseNoConv = countFor(base, 'no_conversation');
    const baseTz = countFor(base, 'timezone_unavailable');

    // Genuinely wedged: active, blocked, and overdue by sixteen minutes.
    await plantSeq('no_conversation', 16);
    let now = await wedged();
    check(
      countFor(now, 'no_conversation') === baseNoConv + 1,
      'a sequence blocked and overdue past fifteen minutes is counted under its reason',
      `${baseNoConv} → ${countFor(now, 'no_conversation')}`,
    );
    check(
      Boolean((now ?? []).find((r) => r.reason === 'no_conversation')?.oldest_due_at),
      'and its oldest due time is carried, so an operator sees how long it has been stuck',
    );

    // Freshly blocked (three minutes) must NOT count — the fifteen-minute floor
    // is what tells a wedge from a sequence the worker simply has not reached.
    await plantSeq('no_conversation', 3);
    now = await wedged();
    check(
      countFor(now, 'no_conversation') === baseNoConv + 1,
      'a sequence blocked only three minutes ago is not yet counted — the fifteen-minute floor holds',
      `still ${countFor(now, 'no_conversation')}`,
    );

    // A different reason is its own group — the expected G-137 wait is SHOWN,
    // not hidden, so the operator tells it apart from the defect above.
    await plantSeq('timezone_unavailable', 120);
    now = await wedged();
    check(
      countFor(now, 'timezone_unavailable') === baseTz + 1,
      'a different block reason is a separate group — the expected timezone wait is reported, not swallowed',
      `${baseTz} → ${countFor(now, 'timezone_unavailable')}`,
    );

    // Overdue but NOT blocked (no reason recorded) is a sequence about to send,
    // not a wedge: it must not appear.
    await plantSeq(null, 16);
    now = await wedged();
    check(
      !(now ?? []).some((r) => r.reason === null || r.reason === ''),
      'a sequence that is merely due, with no block recorded, is not a wedge',
      JSON.stringify((now ?? []).map((r) => r.reason)),
    );

    // A stopped sequence with a stale block reason is finished, not wedged —
    // only `active` counts. (stop_reason is required once it is not active.)
    await plantSeq('no_conversation', 16, 'stopped', { stop_reason: 'planted: already stopped' });
    now = await wedged();
    check(
      countFor(now, 'no_conversation') === baseNoConv + 1,
      'a stopped sequence is not wedged — only an active one the worker keeps evaluating counts',
      `still ${countFor(now, 'no_conversation')}`,
    );

    // Tenancy: the signal is whatever the caller may read, exactly like the
    // backlog above. Another organization sees none of it.
    const outsider = mint(randomUUID(), randomUUID(), 'owner');
    const theirs = await wedged(outsider);
    check(
      countFor(theirs, 'no_conversation') === 0 && countFor(theirs, 'timezone_unavailable') === 0,
      'another organization sees none of this deployment’s wedged follow-ups',
      JSON.stringify(theirs),
    );
  }
} finally {
  await rest('DELETE', 'crm', `follow_up_sequences?organization_id=eq.${ORG}&situation_key=eq.${WEDGE_KEY}`);
  for (const id of created.jobs ?? []) await rest('DELETE', 'core', `jobs?id=eq.${id}`);
  if (created.event) await rest('DELETE', 'core', `outbox_events?id=eq.${created.event}`);
  await rest('DELETE', 'core', `alert_state?key=eq.${ALERT_KEY}`);
  await rest('DELETE', 'core', `alert_state?key=eq.${MARKER}-forged`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `users?id=eq.${id}`);
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ The backlog is counted and the alert is not repeated\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
