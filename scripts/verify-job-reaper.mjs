#!/usr/bin/env node
/**
 * Stalled-job recovery, verified end to end against the real database.
 *
 * This drives the **real HTTP route**: it plants jobs in `running` with locks
 * of varying age, calls the runner with the cron secret, and checks what the
 * running application actually did to them.
 *
 *   • a lock older than the threshold is released back to `queued`
 *   • a lock inside the threshold is left strictly alone — including one only
 *     a minute short of it, which is the case that would double-process
 *   • a stale job that has spent its attempts is parked `dead`, not released
 *   • a second run recovers nothing again — recovery is not repeatable work
 *   • every job keeps its organization, and two organizations are recovered
 *     independently of one another
 *   • a job that was never `running` is untouched
 *
 * The planted jobs use a kind no handler subscribes to, so nothing executes
 * them once they are back on the queue: this verifies recovery, not the job
 * bodies, which milestone-unlock already covers.
 *
 * Requires the app to be running locally (npm run dev) and CRON_SECRET set in
 * .env.local. The secret is read, never printed.
 *
 *   npm run dev            # in another terminal
 *   node scripts/verify-job-reaper.mjs
 */

import { setTimeout as delay } from 'node:timers/promises';

import { STALE_AFTER_SECONDS } from '../src/lib/jobs/staleness.ts';

import { announceTarget, assertAppTarget, resolveTarget } from './verify-target.mjs';

/** Jobs are planted under a kind nothing claims, so recovery is observed alone. */
const PROBE_KIND = 'zztest.reaper.probe';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail);
const URL_BASE = target.url;
const SECRET = target.serviceKey;
const CRON_SECRET = target.cronSecret;
const APP = target.app;

async function request(method, schema, path, options = {}, attempt = 0) {
  try {
    return await requestOnce(method, schema, path, options);
  } catch (error) {
    if (attempt >= 3) throw error;
    await delay(250 * (attempt + 1));
    return request(method, schema, path, options, attempt + 1);
  }
}

async function requestOnce(method, schema, path, { body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET'
          ? { 'Accept-Profile': schema }
          : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body reported through text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) =>
  request('POST', schema, table, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);

/** One tick of the real runner. */
async function runJobs() {
  const res = await fetch(`${APP}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (cond, m) => (cond ? pass(m) : bad(m));
const section = (m) => console.log(`\n${m}`);

/** Seconds ago, as an ISO timestamp. */
const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

const jobById = async (id) => {
  const res = await select(
    'core',
    `jobs?id=eq.${id}&select=id,organization_id,status,attempts,max_attempts,locked_at,locked_by,last_error`,
  );
  return (res.json ?? [])[0] ?? null;
};

console.log('\n\x1b[1mStalled job recovery — end to end\x1b[0m');

let orgB = null;
const planted = [];

try {
  // ── 0. Preflight ────────────────────────────────────────────────────────
  section('0. Preflight');
  announceTarget(target);
  // This script drives the running application, so it must be talking to the
  // same database (gap G-083). Checked before any fixture is planted.
  await assertAppTarget(target, fail);

  let reachable = false;
  try {
    const res = await fetch(`${APP}/api/jobs/run`, { method: 'POST', cache: 'no-store' });
    reachable = res.status === 401;
  } catch {
    reachable = false;
  }
  if (!reachable) fail(`the app is not answering at ${APP}. Start it with: npm run dev`);
  pass(`app reachable at ${APP}`);
  pass('the runner refuses an unauthenticated call');

  // ── 1. Fixture ──────────────────────────────────────────────────────────
  section('1. Fixture (temporary jobs only)');

  /**
   * Drained BEFORE anything is planted, so the measured tick measures this
   * script and nothing else.
   *
   * The runner answers in two shapes: one when it claimed a job, one when it
   * claimed nothing — and only the second carries `reaped`. A stray job left
   * queued by whatever ran before therefore makes §2 read
   * `reclaimed=undefined`, which is a fact about the queue and not about the
   * reaper. It passed alone and failed in the chain, which is the signature.
   *
   * Before the plants, not after: the first attempt drained afterwards and
   * cancelled §D's own "a job that never ran" — proving the reaper had
   * touched something it had not.
   *
   * Cancelled rather than deleted: the row is a record that the work existed.
   */
  await request('PATCH', 'core', 'jobs?status=eq.queued', { body: { status: 'cancelled' } });

  const orgs = await select('core', 'organizations?select=id&limit=1');
  const orgA = (orgs.json ?? [])[0]?.id;
  if (!orgA) fail('no organization found to plant jobs under.');

  const madeOrg = await insert('core', 'organizations', {
    name: 'ZZTEST reaper isolation',
    slug: `zztest-reaper-${Date.now()}`,
  });
  orgB = (madeOrg.json ?? [])[0]?.id;
  if (!orgB) fail(`could not create the second organization: ${madeOrg.text}`);
  check(orgA !== orgB, 'two organizations exist for the isolation check');

  const plant = async (label, row) => {
    const res = await insert('core', 'jobs', { kind: PROBE_KIND, payload: { label }, ...row });
    const made = (res.json ?? [])[0];
    if (!made) fail(`could not plant "${label}": ${res.text}`);
    planted.push({ label, id: made.id, organization_id: made.organization_id });
    return made.id;
  };

  const staleId = await plant('stale-recoverable', {
    organization_id: orgA,
    status: 'running',
    locked_at: ago(STALE_AFTER_SECONDS + 300),
    locked_by: 'jobs-run:died',
    attempts: 1,
    max_attempts: 5,
  });

  const exhaustedId = await plant('stale-exhausted', {
    organization_id: orgA,
    status: 'running',
    locked_at: ago(STALE_AFTER_SECONDS + 300),
    locked_by: 'jobs-run:died',
    attempts: 5,
    max_attempts: 5,
  });

  const freshId = await plant('fresh', {
    organization_id: orgA,
    status: 'running',
    locked_at: ago(30),
    locked_by: 'jobs-run:alive',
    attempts: 1,
    max_attempts: 5,
  });

  // One minute short of the threshold. This is the row that separates a
  // correct reaper from one that races a live worker.
  const boundaryId = await plant('just-inside-threshold', {
    organization_id: orgA,
    status: 'running',
    locked_at: ago(STALE_AFTER_SECONDS - 60),
    locked_by: 'jobs-run:alive',
    attempts: 1,
    max_attempts: 5,
  });

  const queuedId = await plant('never-ran', {
    organization_id: orgA,
    status: 'queued',
    attempts: 0,
    max_attempts: 5,
  });

  const orgBStaleId = await plant('stale-in-other-org', {
    organization_id: orgB,
    status: 'running',
    locked_at: ago(STALE_AFTER_SECONDS + 300),
    locked_by: 'jobs-run:died',
    attempts: 2,
    max_attempts: 5,
  });

  pass(`${planted.length} jobs planted across two organizations`);

  // ── 2. One tick of the runner ───────────────────────────────────────────
  section('2. Recovery (stale, fresh, exhausted)');

  const first = await runJobs();
  check(first.status === 200, 'the runner accepted the cron call (200)');
  check(
    first.body?.reaped && typeof first.body.reaped.reclaimed === 'number',
    'the runner reports what it reaped',
  );
  check(
    (first.body?.reaped?.reclaimed ?? 0) >= 3,
    `at least the three stale jobs were released (reclaimed=${first.body?.reaped?.reclaimed})`,
  );

  const stale = await jobById(staleId);
  check(stale?.status === 'queued', 'A. a stale job is released back to queued');
  check(stale?.locked_at === null, 'A. its lock timestamp is cleared');
  check(stale?.locked_by === null, 'A. its dead owner is cleared');
  check(typeof stale?.last_error === 'string', 'A. why it was released is recorded');
  check(stale?.organization_id === orgA, 'A. it kept its organization');

  const exhausted = await jobById(exhaustedId);
  check(exhausted?.status === 'dead', 'B. a stale job with no attempts left is parked dead');
  check(exhausted?.status !== 'queued', 'B. it is not released for another run');
  check(exhausted?.organization_id === orgA, 'B. it kept its organization');

  const fresh = await jobById(freshId);
  check(fresh?.status === 'running', 'C. a freshly locked job is untouched');
  check(fresh?.locked_by === 'jobs-run:alive', 'C. its live owner is left in place');

  const boundary = await jobById(boundaryId);
  check(
    boundary?.status === 'running',
    'C. a job one minute inside the threshold is untouched — no race with a live worker',
  );
  check(boundary?.locked_at !== null, 'C. its lock is left in place');

  const queued = await jobById(queuedId);
  check(queued?.status === 'queued', 'D. a job that never ran is untouched');
  check(queued?.attempts === 0, 'D. its attempts are not spent by the reaper');

  // ── 3. Organization isolation ───────────────────────────────────────────
  section('3. Organization isolation');

  const orgBStale = await jobById(orgBStaleId);
  check(orgBStale?.status === 'queued', 'E. a stale job in the other organization is recovered too');
  check(orgBStale?.organization_id === orgB, 'E. it kept its own organization');
  check(
    stale?.organization_id !== orgBStale?.organization_id,
    'E. recovery did not merge the two organizations',
  );

  const strays = await select(
    'core',
    `jobs?kind=eq.${PROBE_KIND}&select=id,organization_id`,
  );
  const orgs_seen = new Set((strays.json ?? []).map((j) => j.organization_id));
  check(orgs_seen.size === 2, 'E. every planted job is still under the organization it started in');

  // ── 4. Repeated recovery ────────────────────────────────────────────────
  section('4. Running the reaper again changes nothing');

  const second = await runJobs();
  check(second.status === 200, 'a second tick is accepted');
  check(
    (second.body?.reaped?.reclaimed ?? -1) === 0,
    `the second tick reclaims nothing (reclaimed=${second.body?.reaped?.reclaimed})`,
  );

  const staleAgain = await jobById(staleId);
  check(staleAgain?.status === 'queued', 'F. the recovered job is still queued, not re-recovered');
  check(
    staleAgain?.attempts === stale?.attempts,
    'F. recovery did not spend another attempt on it',
  );

  const exhaustedAgain = await jobById(exhaustedId);
  check(exhaustedAgain?.status === 'dead', 'F. the dead job stays dead — it is not resurrected');

  const freshAgain = await jobById(freshId);
  check(freshAgain?.status === 'running', 'F. the fresh job is still running and still locked');
  check(freshAgain?.locked_at === fresh?.locked_at, 'F. its lock was not rewritten');

  const third = await runJobs();
  check(
    (third.body?.reaped?.reclaimed ?? -1) === 0,
    'G. a third tick is still a no-op — the operation is idempotent',
  );

  // ── 5. Compatibility with the claim path ────────────────────────────────
  section('5. The recovered job is claimable again');

  const recovered = await jobById(staleId);
  check(recovered?.status === 'queued', 'H. it sits in exactly the state the claim query looks for');
  check(recovered?.locked_at === null, 'H. with no lock, so a claim can take it');
  check(
    recovered?.attempts < recovered?.max_attempts,
    'H. with attempts remaining, so the work can actually be retried',
  );
  // ── 6. Concurrency ──────────────────────────────────────────────────────
  section('6. Concurrent runners cannot recover the same job twice');

  // Four runners fire at once against five stale jobs. The release is a single
  // UPDATE, so the reclaimed counts may split between them in any way — but
  // they must sum to exactly five. A sum above five would mean the same row was
  // released more than once, which is the failure this whole threshold and
  // predicate exist to prevent.
  const raceIds = [];
  for (let i = 0; i < 5; i += 1) {
    raceIds.push(
      await plant(`race-${i}`, {
        organization_id: i % 2 === 0 ? orgA : orgB,
        status: 'running',
        locked_at: ago(STALE_AFTER_SECONDS + 600),
        locked_by: 'jobs-run:died',
        attempts: 1,
        max_attempts: 5,
      }),
    );
  }

  const ticks = await Promise.all([runJobs(), runJobs(), runJobs(), runJobs()]);
  check(
    ticks.every((t) => t.status === 200),
    'I. every concurrent runner was accepted',
  );

  const total = ticks.reduce((sum, t) => sum + (t.body?.reaped?.reclaimed ?? 0), 0);
  check(
    total === raceIds.length,
    `I. the five stale jobs were released exactly once between them (sum=${total}, expected=5)`,
  );

  const raced = await Promise.all(raceIds.map(jobById));
  check(
    raced.every((j) => j?.status === 'queued'),
    'I. every raced job ended queued',
  );
  check(
    raced.every((j) => j?.locked_at === null && j?.locked_by === null),
    'I. none was left holding a lock',
  );
  check(
    raced.every((j) => j?.attempts === 1),
    'I. no job had an attempt spent twice by competing reapers',
  );
  const racedOrgs = new Set(raced.map((j) => j?.organization_id));
  check(racedOrgs.size === 2, 'I. both organizations were recovered, neither merged');
} catch (error) {
  bad(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // ── 7. Cleanup ────────────────────────────────────────────────────────────
  section('7. Cleanup');
  try {
    await remove('core', `jobs?kind=eq.${PROBE_KIND}`);
    const left = await select('core', `jobs?kind=eq.${PROBE_KIND}&select=id`);
    check((left.json ?? []).length === 0, 'planted jobs removed');

    if (orgB) {
      await remove('core', `organizations?id=eq.${orgB}`);
      const leftOrg = await select('core', `organizations?id=eq.${orgB}&select=id`);
      check((leftOrg.json ?? []).length === 0, 'the temporary organization removed');
    }
  } catch (error) {
    bad(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
