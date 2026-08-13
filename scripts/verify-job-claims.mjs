#!/usr/bin/env node
/**
 * The job claim, verified against a real database.
 *
 * Gap G-119. `core.claim_jobs` could claim **every queued job of a kind in one
 * statement** and hand them all to a single worker, leaving all but one
 * stranded in `running` with their attempts spent — invisible to every other
 * claim until the reaper released them fifteen minutes later.
 *
 * The mechanism was `limit p_batch_size` where the argument was null: in
 * Postgres **`LIMIT NULL` is no limit**. It is not an error and not zero; it
 * is every row. That is why `verify-requirement-proposal` §8c failed four
 * times in CI with two jobs sharing one `locked_by` and one `locked_at` to
 * the microsecond — one statement, not two claims.
 *
 * This script exists because the claim is the one piece of machinery every
 * queue in the system depends on, and it had no verification of its own. It
 * covers, in order:
 *
 *    1. the regression: a null, zero or negative batch size claims one
 *    2. a single worker, claiming and settling
 *    3. concurrent workers, and that one job never goes to two of them
 *    4. the lock itself: a claimed job is invisible to the next claim
 *    5. a worker that crashes mid-job — the row stays claimed, not lost
 *    6. lease recovery: the reaper returns a stalled job to the queue
 *    7. retries, and the attempt count that bounds them
 *    8. idempotency: dedupe_key refuses a second copy of the same work
 *
 *   node scripts/verify-job-claims.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-job-claims');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzclaim';
const ORG = '00000000-0000-4000-8000-000000000001';
/** A kind of this script's own, so nothing else in the sequence competes. */
const KIND = `${MARKER}.probe`;

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

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
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rows = async (path) => (await rest('GET', 'core', path)).json ?? [];

/** Claims through the RPC, exactly as the runner does. */
async function claim(worker, batch) {
  const body = { p_worker_id: worker, p_kind: KIND };
  // Distinguishes "omitted" from "explicitly null", which is the whole point.
  if (batch !== undefined) body.p_batch_size = batch;
  const r = await rest('POST', 'core', 'rpc/claim_jobs', body);
  return Array.isArray(r.json) ? r.json : [];
}

async function plant(n, extra = {}) {
  await rest('DELETE', 'core', `jobs?kind=eq.${KIND}`);
  const jobs = Array.from({ length: n }, (_, i) => ({
    organization_id: ORG,
    kind: KIND,
    payload: {},
    dedupe_key: `${MARKER}-${randomUUID().slice(0, 8)}-${i}`,
    status: 'queued',
    ...extra,
  }));
  await rest('POST', 'core', 'jobs', jobs);
}

const stateOf = async () => rows(`jobs?kind=eq.${KIND}&select=status,attempts,locked_by,locked_at&order=dedupe_key.asc`);

console.log('\n\x1b[1mAgencyOS — the job claim (G-119)\x1b[0m');

try {
  // ── 1. the regression ───────────────────────────────────────────────────
  console.log('\n1. A claim of one takes one, whatever it is asked with');
  {
    for (const [label, batch] of [['null', null], ['zero', 0], ['negative', -5], ['omitted', undefined]]) {
      await plant(4);
      const claimed = await claim(`w-${label}`, batch);
      check(
        claimed.length === 1,
        `a batch size of ${label} claims exactly one, not the whole queue`,
        `${claimed.length} claimed`,
      );
    }

    // The original defect, stated as the thing it produced: one worker id and
    // one timestamp across several rows. Two transactions cannot share a
    // locked_at — measured, they differ by microseconds — so more than one
    // distinct row under one timestamp is a single statement having taken them.
    await plant(4);
    await claim('w-shape', null);
    const state = await stateOf();
    const running = state.filter((j) => j.status === 'running');
    check(running.length === 1, 'so only one row is ever left running by one claim', `${running.length}`);
    check(
      state.filter((j) => j.attempts > 0).length === 1,
      'and only one attempt is spent — the rest are untouched',
      `${state.filter((j) => j.attempts > 0).length}`,
    );

    // And a genuine batch is still honoured: the fix bounds, it does not pin.
    await plant(4);
    const three = await claim('w-three', 3);
    check(three.length === 3, 'while an explicit batch of three still claims three', `${three.length}`);
  }

  // ── 2. a single worker ──────────────────────────────────────────────────
  console.log('\n2. One worker, claiming and settling');
  {
    await plant(2);
    const [job] = await claim('solo', 1);
    check(!!job && job.status === 'running', 'the claimed row comes back running', `${job?.status}`);
    check(job?.attempts === 1, 'with its attempt counted inside the claim', `${job?.attempts}`);
    check(job?.locked_by === 'solo', 'and the worker that took it recorded');

    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, {
      status: 'succeeded', locked_at: null, locked_by: null,
    });
    const after = await rows(`jobs?id=eq.${job.id}&select=status`);
    check(after[0]?.status === 'succeeded', 'settling releases it');

    const next = await claim('solo', 1);
    check(next.length === 1 && next[0].id !== job.id, 'and the next claim takes the other job');
  }

  // ── 3 & 13. concurrent workers ──────────────────────────────────────────
  console.log('\n3. Two workers never take the same job');
  {
    await plant(2);
    const [a, b] = await Promise.all([claim('con-a', 1), claim('con-b', 1)]);
    const ids = [...a, ...b].map((j) => j.id);
    check(ids.length === 2, 'both workers claimed something', `${ids.length}`);
    check(new Set(ids).size === 2, 'and never the same row twice', `${new Set(ids).size} distinct`);

    const state = await stateOf();
    check(
      state.every((j) => j.attempts === 1),
      'each row counted exactly one attempt',
      state.map((j) => j.attempts).join(','),
    );

    // The harder case: more workers than work. The losers must come back
    // empty rather than block, wait, or take somebody else's row.
    await plant(1);
    const many = await Promise.all([claim('m1', 1), claim('m2', 1), claim('m3', 1), claim('m4', 1)]);
    const winners = many.filter((r) => r.length > 0);
    check(winners.length === 1, 'with one job and four workers, exactly one wins', `${winners.length}`);
    const only = await stateOf();
    check(only[0]?.attempts === 1, 'and the row is claimed once, not four times', `${only[0]?.attempts}`);
  }

  // ── 4. the lock ─────────────────────────────────────────────────────────
  console.log('\n4. A claimed job is invisible to the next claim');
  {
    await plant(1);
    await claim('holder', 1);
    const second = await claim('later', 1);
    check(second.length === 0, 'a running job is not claimable again', `${second.length} claimed`);

    const state = await stateOf();
    check(state[0]?.attempts === 1, 'and its attempt count did not move', `${state[0]?.attempts}`);
    check(state[0]?.locked_by === 'holder', 'nor did the worker holding it');
  }

  // ── 5. a worker that crashes ────────────────────────────────────────────
  console.log('\n5. A worker that dies mid-job loses the work, not the record');
  {
    await plant(1);
    const [job] = await claim('doomed', 1);
    // No settle: this is what a killed process leaves behind.
    const state = await stateOf();
    check(state[0]?.status === 'running', 'the row stays running rather than vanishing');
    check(state[0]?.locked_by === 'doomed', 'still naming the worker that took it');
    check(state[0]?.attempts === 1, 'with the attempt it spent already counted');

    const other = await claim('rescuer', 1);
    check(other.length === 0, 'and nobody else may take it while it is held', `${other.length}`);
    void job;
  }

  // ── 6. lease recovery ───────────────────────────────────────────────────
  console.log('\n6. The lease expires and the work comes back');
  {
    // Backdated past the fifteen-minute threshold rather than waiting for it.
    await rest('PATCH', 'core', `jobs?kind=eq.${KIND}`, {
      locked_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });

    const reaped = await rest('POST', 'core', 'rpc/reap_stalled_jobs', { stall_timeout: '15 minutes' });
    check(reaped.status < 300, 'the reaper runs', `status ${reaped.status}`);

    const state = await stateOf();
    check(
      state[0]?.status === 'queued',
      'a job whose lease expired is queued again, not lost',
      `${state[0]?.status}`,
    );
    check(
      state[0]?.locked_by === null,
      'and released, so the next claim can take it',
      `${state[0]?.locked_by}`,
    );
    check(
      state[0]?.attempts === 1,
      'its spent attempt is kept — recovery is not a free retry',
      `${state[0]?.attempts}`,
    );

    const rescued = await claim('after-reap', 1);
    check(rescued.length === 1, 'and it is claimable again');
    check(rescued[0]?.attempts === 2, 'on its second attempt', `${rescued[0]?.attempts}`);
  }

  // ── 7. retries ──────────────────────────────────────────────────────────
  console.log('\n7. Retries are bounded by the attempts the claim counts');
  {
    await plant(1);
    const [job] = await claim('retry', 1);
    const max = (await rows(`jobs?id=eq.${job.id}&select=max_attempts`))[0]?.max_attempts;
    check(typeof max === 'number' && max > 0, 'a job carries a retry budget', `${max}`);

    // A retryable failure returns it to the queue with the attempt kept.
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, {
      status: 'queued', locked_at: null, locked_by: null, last_error: 'transient',
    });
    const again = await claim('retry', 1);
    check(again[0]?.attempts === 2, 'a retry counts the next attempt', `${again[0]?.attempts}`);
    check(
      again[0]?.attempts <= max,
      'and stays inside the budget the row declares',
      `${again[0]?.attempts}/${max}`,
    );
  }

  // ── 8. idempotency ──────────────────────────────────────────────────────
  console.log('\n8. The same work cannot be queued twice');
  {
    const key = `${MARKER}-idem-${randomUUID().slice(0, 8)}`;
    await rest('DELETE', 'core', `jobs?kind=eq.${KIND}`);

    const first = await rest('POST', 'core', 'jobs', {
      organization_id: ORG, kind: KIND, payload: {}, dedupe_key: key, status: 'queued',
    });
    check(first.status < 300, 'the first enqueue is accepted', `status ${first.status}`);

    const second = await rest('POST', 'core', 'jobs', {
      organization_id: ORG, kind: KIND, payload: {}, dedupe_key: key, status: 'queued',
    });
    check(
      second.status >= 400,
      'and a second with the same dedupe key is refused, so redelivery is free',
      `status ${second.status}`,
    );

    const all = await rows(`jobs?dedupe_key=eq.${key}&select=id`);
    check(all.length === 1, 'leaving exactly one job for that work', `${all.length}`);
  }
} finally {
  await rest('DELETE', 'core', `jobs?kind=eq.${KIND}`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A claim of one takes one, and one job has one owner\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
