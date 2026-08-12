import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Gap G-080 — a job is parked forever and nothing says so.
 *
 * Nothing in this repository moves a row out of `dead`. The reaper matches
 * `status = 'running'` only; the outbox cannot re-enqueue, because the job's
 * `dedupe_key` still exists and the unique index turns the retry into a no-op.
 * So the moment a job is parked is the last moment anybody could act on it.
 *
 * Until now that moment produced no distinct signal. `last_error` was written
 * to the row, and nothing reads `core.jobs` — no page, no API, no metric. A
 * permanent refusal did log its reason from the handler, but that is a
 * different fact: "this attempt failed" and "this will not be attempted again"
 * are the same line today and only the second is worth waking somebody for.
 *
 * What is fixed here is the announcement. What is not is the recovery: a dead
 * job still cannot be revived, and the standing backlog is still displayed
 * nowhere. Both need a surface to put them on, which is G-053 and ADM-21.
 *
 * A backlog count in the runner's response was considered and rejected. Only
 * two of the tick's fifteen exits are summaries — a tick that does extraction
 * work returns from the middle — so the count would appear on some ticks and
 * not others, which is worse than no count at all.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const routeSource = read('app/api/jobs/run/route.ts');

function bodyOf(name: string): string {
  const at = routeSource.indexOf(`function ${name}`);
  assert.ok(at > 0, `${name} is gone`);
  const end = routeSource.indexOf('\n}', at);
  assert.ok(end > at, `${name} has no end`);
  return routeSource.slice(at, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The signal
// ═══════════════════════════════════════════════════════════════════════════

describe('A. parking a job announces it', () => {
  const helper = bodyOf('logJobParked');

  test('at error level, because nothing will retry it', () => {
    assert.match(helper, /level: 'error'/);
    assert.match(helper, /scope: 'jobs\/dead'/);
  });

  test('carrying the fields an alert would filter on', () => {
    for (const field of ['jobId', 'organizationId', 'kind', 'attempts', 'detail']) {
      assert.match(helper, new RegExp(`\\b${field}:`), `the signal omits ${field}`);
    }
  });

  test('and says plainly that this is the end of the line', () => {
    // The distinction the whole gap is about: a reader seeing one of these in
    // a log should not have to know the queue's internals to know it is final.
    assert.match(helper, /nothing retries this/);
  });

  test('it logs and does nothing else — no write, no throw', () => {
    assert.doesNotMatch(helper, /await |\.from\(|throw /);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Both paths that can park a job use it
// ═══════════════════════════════════════════════════════════════════════════

describe('B. every death is announced', () => {
  for (const [name, kind] of [
    ['settleUnlockJob', 'UNLOCK_JOB_KIND'],
    ['failJob', 'JOB_KIND'],
  ] as const) {
    test(`${name} announces a job it parks`, () => {
      const body = bodyOf(name);
      assert.match(body, /if \(settlement\.status === 'dead'\) \{/);
      assert.match(body, new RegExp(`logJobParked\\(`));
      assert.match(body, new RegExp(kind));
    });

    test(`${name} announces it before the write, so a failed write is still visible`, () => {
      // The settle can fail for the same reason the job did (D18). Announcing
      // afterwards would lose the one signal precisely when it matters most.
      const body = bodyOf(name);
      const announce = body.indexOf('logJobParked(');
      assert.ok(announce > 0, 'nothing is announced');
      // Searched from the announcement: settleUnlockJob writes to `jobs`
      // earlier too, in its succeeded branch, and matching that one would
      // compare the announcement against an unrelated write.
      const write = body.indexOf(".from('jobs')", announce);
      assert.ok(write > announce, 'the death is announced after the write it describes');
    });

    test(`${name} announces only a death, not every failure`, () => {
      // A retryable failure is not news: it is the ordinary case, and at error
      // level once per attempt it would bury the line that matters.
      const body = bodyOf(name);
      const guard = body.indexOf("if (settlement.status === 'dead')");
      const call = body.indexOf('logJobParked(');
      assert.ok(guard >= 0 && call > guard, 'the announcement is not guarded by the outcome');
    });
  }

  test('both paths report the attempt in progress, from one convention', () => {
    // They used to differ: the extraction path held the pre-claim row and had
    // to add one, the unlock path did not. G-082 moved both onto
    // core.claim_jobs, which increments inside the statement that takes the
    // lock — so the row each path holds already describes the attempt it is
    // making, and neither adjusts it.
    assert.match(bodyOf('failJob'), /logJobParked\(job, JOB_KIND/);
    assert.match(bodyOf('settleUnlockJob'), /logJobParked\(job, UNLOCK_JOB_KIND/);
    assert.doesNotMatch(bodyOf('failJob'), /attempts: job\.attempts \+ 1/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. What is still true, and is not claimed otherwise
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the half that is not fixed', () => {
  test('nothing revives a dead job', () => {
    // The reaper is `running`-only, and this is the assertion that keeps the
    // gap honest: if a requeue path is ever added, this fails and G-080 should
    // be re-read rather than assumed closed.
    // The reaper names `dead` — it is what a stalled job with no attempts
    // left becomes — but it never *reads* one. Asserted as the predicate
    // rather than the word, which the first version of this test got wrong.
    const reaper = read('src/lib/jobs/reaper.ts');
    assert.doesNotMatch(reaper, /eq\('status', 'dead'\)|status = 'dead'/);

    const core = read('supabase/migrations/20260807120002_core.sql');
    const fn = core.slice(core.indexOf('function core.reap_stalled_jobs'));
    assert.match(fn.slice(0, fn.indexOf('$$;')), /where status = 'running'/);
  });

  test('and nothing displays the backlog', () => {
    // No page, no API, no metric reads core.jobs. Asserted so that the day one
    // does, this test fails and the gap gets revisited.
    const app = read('app/api/health/route.ts');
    assert.doesNotMatch(app, /from\('jobs'\)/);
  });
});
