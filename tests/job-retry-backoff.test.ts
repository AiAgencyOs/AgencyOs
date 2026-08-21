import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
  retryDelaySeconds,
  settlementFor,
  type RetryableJob,
} from '../src/lib/jobs/retry.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * Audit finding D18 — a retryable failure spent its whole budget in one tick.
 *
 * Both settle paths in the runner wrote `status = 'queued'` and left `run_at`
 * alone. Nothing in the application has ever written `run_at`; it only took its
 * `default now()` at insert. So a requeued job was immediately eligible again.
 *
 * On the unlock path that is not a slow retry, it is no retry at all. The drain
 * loop turns up to ten times per invocation and claims the oldest queued row —
 * and a row put back with its original `run_at` is still the oldest. Five
 * turns, five attempts, `dead`, inside a few hundred milliseconds.
 *
 * What that costs is precisely what D5 and D15 were for. Both went to trouble
 * to make a failed *read* retryable rather than permanent, so a transient blip
 * would not strand a milestone the client had already paid for. There was no
 * "later": every attempt happened inside the same blip, and the job was dead
 * before the database had finished recovering.
 *
 * The rule is pure, so it is called directly across the whole boundary rather
 * than sampled — the same treatment staleness.ts gets in job-reaper.test.ts.
 * What cannot be called (that the runner actually applies it, at both sites,
 * and writes run_at) is asserted against the route's source. That the real loop
 * then claims once instead of five times is proved against a real database in
 * verify-milestone-unlock.mjs §6.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const routeSource = RUNNER_SOURCE;

/** A fixed instant, so every runAt below is exact rather than approximate. */
const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);

const job = (attemptsMade: number, maxAttempts = 5): RetryableJob => ({
  attemptsMade,
  maxAttempts,
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The schedule
// ═══════════════════════════════════════════════════════════════════════════

describe('A. how long a failed job waits', () => {
  test('it doubles from the cron cadence: 1, 2, 4, 8 minutes', () => {
    assert.equal(retryDelaySeconds(1), 60);
    assert.equal(retryDelaySeconds(2), 120);
    assert.equal(retryDelaySeconds(3), 240);
    assert.equal(retryDelaySeconds(4), 480);
  });

  test('four retries span fifteen minutes of nominal delay', () => {
    // The number that matters commercially: with the default max_attempts of
    // 5, roughly how long a paid milestone waits on a failing database before
    // the job is parked.
    //
    // Nominal, not wall-clock. run_at is stamped just after the tick that
    // claimed the job, so each rung misses the tick it was aimed at and rounds
    // up to the next — about 19 minutes end to end. Asserting the nominal sum
    // is what this rule controls; the rounding is the scheduler's.
    const total = [1, 2, 3, 4].reduce((sum, n) => sum + retryDelaySeconds(n), 0);
    assert.equal(total, 900);
  });

  test('never shorter than the cron cadence, at any attempt', () => {
    // The whole property. A delay under a minute is not a shorter wait — the
    // job simply sits queued until the next tick — but it would let the drain
    // loop re-claim the row inside the same invocation, which is the defect.
    for (let n = 1; n <= 50; n += 1) {
      assert.ok(
        retryDelaySeconds(n) >= RETRY_BASE_SECONDS,
        `attempt ${n} would be eligible again before the next tick`,
      );
    }
  });

  test('and never longer than the cap, however many attempts a row allows', () => {
    for (const n of [1, 5, 10, 30, 100, 1_000, Number.MAX_SAFE_INTEGER]) {
      const delay = retryDelaySeconds(n);
      assert.ok(Number.isFinite(delay), `attempt ${n} produced ${delay}`);
      assert.ok(delay <= RETRY_MAX_SECONDS, `attempt ${n} waits ${delay}s`);
    }
  });

  test('monotonic — a later attempt never waits less than an earlier one', () => {
    for (let n = 1; n < 40; n += 1) {
      assert.ok(
        retryDelaySeconds(n + 1) >= retryDelaySeconds(n),
        `attempt ${n + 1} waits less than attempt ${n}`,
      );
    }
  });

  test('a nonsensical attempt count still yields a usable delay', () => {
    // Unreachable — settling happens after a claim, so attemptsMade is at
    // least 1 — but a rule that returns NaN here would write an invalid date
    // into run_at and make the row unclaimable forever.
    for (const n of [0, -1, -1_000, 1.5]) {
      const delay = retryDelaySeconds(n);
      assert.ok(Number.isFinite(delay) && delay >= RETRY_BASE_SECONDS, `${n} → ${delay}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. What becomes of the job
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the settlement', () => {
  test('a retryable failure with budget left is queued for the future', () => {
    const settled = settlementFor(job(1), false, NOW);

    assert.equal(settled.status, 'queued');
    assert.equal(settled.status === 'queued' && settled.delaySeconds, 60);
    assert.equal(
      settled.status === 'queued' && settled.runAt,
      new Date(NOW + 60_000).toISOString(),
    );
  });

  test('and that time is strictly after the instant the claim compares against', () => {
    // claimUnlockJob filters `run_at <= new Date()`. This is the assertion
    // that says the row cannot come back on the very next turn of the loop.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const settled = settlementFor(job(attempt), false, NOW);
      assert.equal(settled.status, 'queued');
      if (settled.status !== 'queued') continue;
      assert.ok(
        Date.parse(settled.runAt) > NOW,
        `attempt ${attempt} was scheduled at or before now, so the loop re-claims it`,
      );
    }
  });

  test('a permanent refusal is dead immediately, whatever the budget says', () => {
    // D5's distinction, preserved exactly: a wrong organization or a voided
    // invoice does not become true by waiting.
    const settled = settlementFor(job(1), true, NOW);
    assert.deepEqual(settled, { status: 'dead' });
  });

  test('a spent budget is dead even when the failure was transient', () => {
    assert.deepEqual(settlementFor(job(5), false, NOW), { status: 'dead' });
    assert.deepEqual(settlementFor(job(6), false, NOW), { status: 'dead' });
  });

  test('a dead settlement carries no time, so nothing can schedule what it parked', () => {
    const settled = settlementFor(job(5), false, NOW);
    assert.equal('runAt' in settled, false);
  });

  test('max_attempts of 1 means the first failure is the last', () => {
    assert.deepEqual(settlementFor(job(1, 1), false, NOW), { status: 'dead' });
  });

  test('a job that fails every time terminates, and takes about fifteen minutes to', () => {
    // The counterpart of job-reaper.test.ts's "terminates in max_attempts
    // rescues". Before D18 this loop ran to completion in one invocation.
    let attemptsMade = 0;
    let elapsedMs = 0;
    const statuses: string[] = [];

    for (let guard = 0; guard < 20; guard += 1) {
      attemptsMade += 1;
      const settled = settlementFor(job(attemptsMade), false, NOW + elapsedMs);
      statuses.push(settled.status);
      if (settled.status === 'dead') break;
      elapsedMs = Date.parse(settled.runAt) - NOW;
    }

    assert.deepEqual(statuses, ['queued', 'queued', 'queued', 'queued', 'dead']);
    assert.equal(attemptsMade, 5);
    assert.equal(elapsedMs, 900_000, 'the five attempts did not span fifteen minutes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The two callers count from different sides, and must still agree
// ═══════════════════════════════════════════════════════════════════════════

describe('C. one rule, and now one attempt convention', () => {
  test('the exhaustion boundary is where a row with one try left still gets it', () => {
    // settleUnlockJob holds the row AFTER the claim incremented attempts, so
    // it passes job.attempts. failJob holds the row as it was BEFORE the
    // claim, so it passes job.attempts + 1. Both therefore mean "attempts
    // including the one just spent", and the boundary below is what an
    // off-by-one in either would move: a row that had made 3 attempts is on
    // its 4th and must come back; one that had made 4 is on its 5th and is
    // spent. Comparing the two calls to each other would prove nothing — they
    // are the same expression — so what is pinned is the boundary itself,
    // with the source assertion below pinning that each caller reaches it.
    assert.equal(settlementFor(job(4), false, NOW).status, 'queued', 'a row with a try left was parked');
    assert.deepEqual(settlementFor(job(5), false, NOW), { status: 'dead' }, 'a spent row was retried');
  });

  test('and both paths now pass the same thing, because both claim the same way', () => {
    // This test used to pin two different conventions — the unlock path passed
    // its post-claim count, the extraction path added one to a pre-claim row —
    // and the comment above explained why an off-by-one was easy to introduce.
    // G-082 removed the second convention: both claim through core.claim_jobs,
    // which increments inside the statement that takes the lock.
    const calls = routeSource.match(
      /settlementFor\(\s*\{ attemptsMade: job\.attempts, maxAttempts: job\.max_attempts \},/g,
    ) ?? [];
    assert.equal(calls.length, 2, 'a settle path stopped using the post-claim count');
    assert.doesNotMatch(routeSource, /attemptsMade: job\.attempts \+ 1/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The runner actually applies it — at both sites, including run_at
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the runner writes the schedule it was given', () => {
  /** One settle function's body, so a match in the other cannot stand in. */
  function bodyOf(name: string): string {
    const at = routeSource.indexOf(`async function ${name}`);
    assert.ok(at > 0, `${name} is gone`);
    const end = routeSource.indexOf('\n}', at);
    assert.ok(end > at, `${name} has no end`);
    return routeSource.slice(at, end);
  }

  for (const name of ['settleUnlockJob', 'failJob']) {
    test(`${name} writes run_at from the settlement`, () => {
      assert.match(bodyOf(name), /run_at: settlement\.runAt/);
    });

    test(`${name} writes it only when the job is coming back`, () => {
      // A `dead` settlement has no runAt, so an unguarded spread would write
      // `run_at: undefined` — which PostgREST omits, quietly restoring the
      // defect for the one case that also looks fine in the row.
      assert.match(bodyOf(name), /settlement\.status === 'queued' \? \{ run_at: settlement\.runAt \} : \{\}/);
    });

    test(`${name} takes its status from the rule rather than re-deciding`, () => {
      assert.match(bodyOf(name), /status: settlement\.status/);
      assert.doesNotMatch(
        bodyOf(name),
        /exhausted \? 'dead' : 'queued'/,
        'the old inline expression is still here, so there are two rules again',
      );
    });
  }

  test('the claim refuses a job whose time has not come', () => {
    // One statement now rather than a select plus a swap that had to restate
    // the same bound (G-082), so there is one place for this predicate to be.
    const migration = read('supabase/migrations/20260812120009_claim_jobs_by_kind.sql');
    assert.match(migration, /and run_at <= now\(\)/);
    assert.match(migration, /for update skip locked/);
    return;
    // Four, not two: each kind selects a candidate and then compare-and-swaps
    // it, and BOTH have to bound run_at.
    //
    // The swap was the hole. `status = 'queued'` alone does not distinguish a
    // job that is due from one a backoff has just deferred — a backed-off row
    // is queued too. With two overlapping invocations, B could read a row as
    // due, watch A claim it, fail and defer it, and then swap it anyway on the
    // strength of a status that had come back. Worse, B writes
    // `attempts: candidate.attempts + 1` from its own stale read, so the count
    // goes *backwards* and the ladder restarts at rung one — a job that could
    // neither wait nor ever reach max_attempts.
    const filters = routeSource.match(/\.lte\('run_at', new Date\(\)\.toISOString\(\)\)/g) ?? [];
    assert.equal(filters.length, 4, 'a claim stopped honouring run_at');
  });

  test('and there is no compare-and-swap left to forget it on', () => {
    // The hand-rolled swaps are gone (G-082). This is what stops the old shape
    // coming back by habit: a `.update({ status: 'running' … })` in the route
    // means somebody has reintroduced a claim outside the database.
    assert.doesNotMatch(routeSource, /\.update\(\{\s*status: 'running'/);
    assert.equal((routeSource.match(/\.rpc\('claim_jobs'/g) ?? []).length, 2);
  });

  test('and the reaper is left alone', () => {
    // core.reap_stalled_jobs releases rows stuck in `running`, which is the
    // opposite case: nothing was tried, so nothing should be delayed. It is
    // also disjoint by construction — it matches `status = 'running'`, and a
    // backed-off row is `queued`, so it can neither see nor undo a backoff.
    const reaper = read('src/lib/jobs/reaper.ts');
    assert.doesNotMatch(reaper, /run_at/);
    assert.doesNotMatch(reaper, /settlementFor|retryDelaySeconds/);
  });
});
