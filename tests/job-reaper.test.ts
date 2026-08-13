import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  isStale,
  recoveryFor,
  STALE_AFTER,
  STALE_AFTER_SECONDS,
  type ReapableJob,
} from '../src/lib/jobs/staleness.ts';

/**
 * Recovery of jobs whose worker died mid-run.
 *
 * The rule is pure, so it is called directly across the whole boundary rather
 * than sampled. What cannot be called — the atomicity of the release, its
 * grants, the fact that it never writes an organization — lives in SQL, so it
 * is asserted against the migration that Postgres actually ran.
 *
 * The property under test throughout is not "stale jobs come back". It is that
 * **a job whose worker might still be alive is never touched**, because that is
 * the only way this mechanism could turn a stalled job into a repeated one.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const reaperSource = read('src/lib/jobs/reaper.ts');
const stalenessSource = read('src/lib/jobs/staleness.ts');
const coreMigration = read('supabase/migrations/20260807120002_core.sql');
const routeSource = read('app/api/jobs/run/route.ts');

/** The body of core.claim_jobs, where the claim's predicate now lives (G-082). */
const claimSql = (() => {
  const migration = read('supabase/migrations/20260812120009_claim_jobs_by_kind.sql');
  const from = migration.indexOf('as $$');
  return migration.slice(from, migration.indexOf('$$;', from));
})();


/**
 * The SQL body of core.reap_stalled_jobs — between `as $$` and `$$;`, so the
 * function's own header (language, security definer, search_path) is excluded
 * and assertions below speak only about the statement that runs.
 */
const reapBody = (() => {
  const fn = coreMigration.slice(coreMigration.indexOf('function core.reap_stalled_jobs'));
  return fn.slice(fn.indexOf('as $$') + 'as $$'.length, fn.indexOf('$$;'));
})();

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const SECOND = 1_000;

/** A job locked `agoSeconds` before NOW. */
function lockedFor(agoSeconds: number, over: Partial<ReapableJob> = {}): ReapableJob {
  return {
    status: 'running',
    locked_at: new Date(NOW - agoSeconds * SECOND).toISOString(),
    attempts: 1,
    max_attempts: 5,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Stale jobs are identified
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a genuinely stale job is recognised', () => {
  test('a lock held well past the threshold is stale', () => {
    assert.equal(isStale(lockedFor(STALE_AFTER_SECONDS + 60), NOW), true);
  });

  for (const hours of [1, 6, 24, 24 * 30]) {
    test(`a lock held for ${hours}h is stale`, () => {
      assert.equal(isStale(lockedFor(hours * 3600), NOW), true);
    });
  }

  test('staleness is measured from locked_at, not from attempts or kind', () => {
    const old = lockedFor(STALE_AFTER_SECONDS + 1, { attempts: 0, max_attempts: 99 });
    assert.equal(isStale(old, NOW), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Fresh jobs are left strictly alone
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a job whose worker may still be alive is never stale', () => {
  test('a lock taken a moment ago is not stale', () => {
    assert.equal(isStale(lockedFor(0), NOW), false);
    assert.equal(isStale(lockedFor(1), NOW), false);
  });

  for (const seconds of [60, 300, 600, 800]) {
    test(`a lock held ${seconds}s is not stale — a worker can still be running`, () => {
      // 300s is the platform default ceiling and 800s the highest the plan
      // allows. Both must be strictly inside the threshold or the reaper could
      // land on a live invocation.
      assert.equal(isStale(lockedFor(seconds), NOW), false);
    });
  }

  test('the threshold is strictly greater than the largest possible worker life', () => {
    const PLATFORM_MAX_SECONDS = 800;
    assert.ok(
      STALE_AFTER_SECONDS > PLATFORM_MAX_SECONDS,
      `${STALE_AFTER_SECONDS}s must exceed the ${PLATFORM_MAX_SECONDS}s ceiling`,
    );
  });

  test('the boundary is exclusive — exactly at the threshold is not yet stale', () => {
    assert.equal(isStale(lockedFor(STALE_AFTER_SECONDS), NOW), false);
    assert.equal(isStale(lockedFor(STALE_AFTER_SECONDS - 1), NOW), false);
    assert.equal(isStale(lockedFor(STALE_AFTER_SECONDS + 1), NOW), true);
  });

  test('a clock that runs backwards produces no reaping', () => {
    // A lock stamped in the future is nonsense, but it must fail closed.
    assert.equal(isStale(lockedFor(-3600), NOW), false);
  });
});

describe('B. only running jobs are candidates', () => {
  for (const status of ['queued', 'succeeded', 'failed', 'cancelled', 'dead']) {
    test(`a ${status} job is never stale, however old its lock`, () => {
      assert.equal(isStale(lockedFor(24 * 3600, { status }), NOW), false);
    });
  }

  test('a running job with no lock timestamp is not stale at any age', () => {
    // Nothing to measure. Guessing here would mean reaping a row whose claim
    // is merely part-written.
    assert.equal(isStale({ ...lockedFor(0), locked_at: null }, NOW), false);
  });

  test('an unparseable lock timestamp is refused rather than treated as ancient', () => {
    assert.equal(isStale({ ...lockedFor(0), locked_at: 'not-a-date' }, NOW), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Repeated recovery terminates
// ═══════════════════════════════════════════════════════════════════════════

describe('C. a job cannot be recovered forever', () => {
  test('a job with attempts left goes back on the queue', () => {
    assert.equal(recoveryFor(lockedFor(9999, { attempts: 1, max_attempts: 5 })), 'queued');
  });

  test('a job that has spent its attempts is parked dead, not released', () => {
    assert.equal(recoveryFor(lockedFor(9999, { attempts: 5, max_attempts: 5 })), 'dead');
  });

  test('an over-spent job is parked too — the guard is not an equality test', () => {
    assert.equal(recoveryFor(lockedFor(9999, { attempts: 7, max_attempts: 5 })), 'dead');
  });

  test('a job that stalls every time terminates in max_attempts rescues', () => {
    // Each claim increments attempts, so each rescue costs one. Simulating the
    // loop is the point: it must end, and it must end as `dead`.
    const job = { ...lockedFor(9999), attempts: 0, max_attempts: 5 };
    let rescues = 0;
    while (recoveryFor(job) === 'queued') {
      job.attempts += 1; // the claim that follows the rescue
      rescues += 1;
      assert.ok(rescues <= 5, 'recovery must not loop forever');
    }
    assert.equal(rescues, 5);
    assert.equal(recoveryFor(job), 'dead');
  });

  test('a job whose budget is one attempt gets no free rescue', () => {
    assert.equal(recoveryFor(lockedFor(9999, { attempts: 1, max_attempts: 1 })), 'dead');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Concurrency and repetition are safe
// ═══════════════════════════════════════════════════════════════════════════

describe('D. reaping is safe to run repeatedly and concurrently', () => {
  test('the release is a single UPDATE — two reapers cannot both win a row', () => {
    // Atomicity is the whole defence against a double release. It is one
    // statement in SQL rather than a read-then-write in TypeScript, which is
    // why the second caller updates zero rows instead of racing.
    const body = reapBody;
    assert.equal((body.match(/update core\.jobs/g) ?? []).length, 1);
    assert.doesNotMatch(body, /select .* into /i);
  });

  test('the predicate excludes what it has already released', () => {
    const body = reapBody;
    // Released rows leave `running`, so a second pass cannot match them.
    assert.match(body, /where status = 'running'/);
    assert.match(body, /locked_at < now\(\) - stall_timeout/);
  });

  test('a released job is unlocked, so nothing inherits a stale owner', () => {
    const body = reapBody;
    assert.match(body, /locked_at\s*=\s*null/);
    assert.match(body, /locked_by\s*=\s*null/);
  });

  test('an idle tick reaps nothing — the common case is a no-op', () => {
    for (const seconds of [0, 30, 120, 300]) {
      assert.equal(isStale(lockedFor(seconds), NOW), false);
    }
  });

  test('reaping the same fresh job a thousand times still does nothing', () => {
    const fresh = lockedFor(30);
    for (let i = 0; i < 1000; i += 1) assert.equal(isStale(fresh, NOW), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Organization isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('E. recovery never crosses an organization', () => {
  test('the SQL never writes organization_id', () => {
    const body = reapBody;
    assert.doesNotMatch(body, /organization_id\s*=/);
  });

  test('the rule itself reads no organization — it cannot be steered by one', () => {
    assert.doesNotMatch(stalenessSource, /organization/i);
  });

  test('the wrapper takes no organization argument from anywhere', () => {
    assert.match(reaperSource, /export async function reapStalledJobs\(admin: Admin\)/);
    assert.doesNotMatch(reaperSource, /organizationId|organization_id:/);
  });

  test('a job keeps its organization across a rescue — status is all that moves', () => {
    const body = reapBody;
    const assigned = [...body.matchAll(/^\s*(?:set\s+)?([a-z_]+)\s*=/gm)].map((m) => m[1]);
    assert.deepEqual(new Set(assigned), new Set(['status', 'locked_at', 'locked_by', 'last_error']));
  });

  test('the function is reachable only by the service role', () => {
    assert.match(
      coreMigration,
      /revoke all on function core\.reap_stalled_jobs\(interval\) from public, anon, authenticated;/,
    );
    assert.match(
      coreMigration,
      /grant execute on function core\.reap_stalled_jobs\(interval\) to service_role;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Compatibility with the existing queue
// ═══════════════════════════════════════════════════════════════════════════

describe('F. recovery fits the claim, dedupe and idempotency rules already in place', () => {
  test('a recovered job returns to queued — the state the claims already look for', () => {
    assert.equal(recoveryFor(lockedFor(9999, { attempts: 0, max_attempts: 5 })), 'queued');
    assert.match(claimSql, /and status = 'queued'/);
  });

  test('recovery never touches dedupe_key, so no duplicate job can appear', () => {
    const body = reapBody;
    assert.doesNotMatch(body, /dedupe_key/);
    assert.doesNotMatch(reaperSource, /dedupe_key/);
  });

  test('recovery inserts nothing — it only moves a row that already exists', () => {
    const body = reapBody;
    assert.doesNotMatch(body, /insert into/i);
    assert.doesNotMatch(reaperSource, /\.insert\(/);
  });

  test('the reason a job was released is recorded, not swallowed', () => {
    const body = reapBody;
    assert.match(body, /last_error\s*=/);
  });

  test('the runner reaps before it claims, so a rescue lands on the same tick', () => {
    const reapAt = routeSource.indexOf('reapStalledJobs(admin)');
    const dispatchAt = routeSource.indexOf('dispatchOutbox(admin)');
    const unlockAt = routeSource.indexOf('runEventJobs(');
    assert.ok(reapAt > 0, 'the runner must call the reaper');
    assert.ok(reapAt < dispatchAt && reapAt < unlockAt);
  });

  test('the reaper runs behind the same CRON_SECRET door as everything else', () => {
    const authAt = routeSource.indexOf('authorizeCronRequest(');
    assert.ok(authAt > 0 && authAt < routeSource.indexOf('reapStalledJobs(admin)'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. The threshold is derived, and stays that way
// ═══════════════════════════════════════════════════════════════════════════

describe('G. the threshold is justified rather than picked', () => {
  test('the two spellings of the threshold agree', () => {
    assert.equal(STALE_AFTER, '15 minutes');
    assert.equal(STALE_AFTER_SECONDS, 900);
    assert.equal(STALE_AFTER_SECONDS, 15 * 60);
  });

  test('the SQL default is not relied upon — it equals the ceiling exactly', () => {
    // core.reap_stalled_jobs defaults to 5 minutes, which is the platform's
    // default max duration to the second. Passing an explicit interval is what
    // keeps reaping and a live worker off the same instant.
    assert.match(coreMigration, /stall_timeout interval default '5 minutes'/);
    assert.match(reaperSource, /stall_timeout: STALE_AFTER/);
    assert.notEqual(STALE_AFTER, '5 minutes');
  });

  test('the runner does not let a caller choose the threshold', () => {
    assert.doesNotMatch(routeSource, /STALE_AFTER|stall_timeout/);
    assert.match(reaperSource, /stall_timeout: STALE_AFTER/);
  });

  test('the observation window uses the same threshold as the release', () => {
    // Two different numbers here would make the runner report one set of jobs
    // and release another.
    assert.match(reaperSource, /Date\.now\(\) - STALE_AFTER_SECONDS \* 1_000/);
    assert.match(reaperSource, /\.lt\('locked_at', cutoff\)/);
    assert.match(reaperSource, /\.eq\('status', 'running'\)/);
  });
});
