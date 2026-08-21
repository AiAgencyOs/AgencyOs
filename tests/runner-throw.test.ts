import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * Gap G-081 — a throw skipped the settle entirely.
 *
 * Every failure the runner knows how to answer arrives as a returned value: a
 * `{ error }` from PostgREST, a `HandlerResult` from the projects module. But a
 * Supabase client can also *throw* — an undici socket error, a malformed
 * response, a JSON parse failure — and a database blip is precisely when it
 * does. Nothing caught that.
 *
 * The cost differed by path, and the unlock one was worse than it looks:
 *
 *   The unlock loop called `handleInvoicePaid` unguarded, so a throw left that
 *   row `running` with its attempt already spent — invisible to every claim
 *   until the reaper released it fifteen minutes on — *and* propagated out of
 *   the loop, so the rest of the batch never ran and the whole tick answered
 *   500. One bad job took the tick with it.
 *
 *   The extraction path claims one job and then runs three hundred lines of
 *   transcript read, model call and validated insert before it settles. A throw
 *   anywhere in there stranded that job the same way.
 *
 * Both now settle through the ordinary path, which means D18's backoff spaces
 * the retry rather than the reaper's fifteen minutes doing it. Retryable, not
 * permanent: a throw says nothing about whether the work is possible, only that
 * this attempt did not finish.
 *
 * Asserted against the route's source. Executing it would need a running Next
 * request context and a service-role client, which a node:test run has no
 * business holding — the same line tests/cron-scheduler.test.ts draws.
 */

const routeSource = RUNNER_SOURCE;

/**
 * One function's body, so a match in a neighbour cannot stand in.
 *
 * Returns null rather than asserting, and every caller checks. It used to
 * assert, and it was called in a `describe` body — so when G-110 renamed the
 * loop, the throw happened while the suite was being collected and **all five
 * tests below silently stopped existing**. The run stayed green and the count
 * dropped by five, which is the only place it showed.
 *
 * A test that disappears when the thing it guards is renamed is worse than one
 * that fails, because nothing draws attention to it.
 */
function bodyOf(name: string): string | null {
  const at = routeSource.indexOf(`async function ${name}`);
  if (at < 0) return null;
  const end = routeSource.indexOf('\n}', at);
  if (end <= at) return null;
  return routeSource.slice(at, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The unlock loop
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a handler that throws', () => {
  // Resolved inside a test rather than in the describe body — see bodyOf.
  const loopOrNull = () => bodyOf('runEventJobs');

  test('the loop this suite guards still exists', () => {
    // The assertion that would have caught the silent disappearance above.
    assert.ok(loopOrNull(), 'runEventJobs is gone — the tests below guard nothing');
  });

  test('is caught rather than allowed out of the loop', () => {
    const loop = loopOrNull()!;
    // The handler is a parameter since the loop was generalised over the kind
    // (G-110), so what is pinned is that whatever handler it was given is the
    // thing wrapped — for every queue, not just the unlock one.
    assert.match(loop, /try \{\s*result = await handler\(admin, job\);\s*\} catch/);
  });

  test('and becomes a retryable failure, not a permanent one', () => {
    const loop = loopOrNull()!;
    // A throw says nothing about whether the work is possible. Parking it
    // `dead` would strand a paid milestone on one socket error — the exact
    // outcome D5 and D15 exist to prevent.
    assert.match(loop, /permanent: false, detail: `handler threw/);
    assert.doesNotMatch(loop, /permanent: true/);
  });

  test('which is then settled like any other failure', () => {
    const loop = loopOrNull()!;
    // So D18's backoff applies and the retry is spaced, rather than the job
    // waiting fifteen minutes on the reaper.
    const caught = loop.indexOf('catch (error)');
    const settle = loop.indexOf('await settleUnlockJob(admin, job, result, kind, scope)');
    assert.ok(caught > 0 && settle > caught, 'the settle no longer follows the catch');
  });

  test('and the rest of the batch still runs', () => {
    const loop = loopOrNull()!;
    // The loop continues: `results.push` is after the settle and inside the
    // for, so a throwing job costs one iteration rather than the tick.
    const settle = loop.indexOf('await settleUnlockJob(admin, job, result, kind, scope)');
    assert.ok(loop.indexOf('results.push', settle) > settle);

    // No re-throw. Matched against the code with comments stripped, because
    // the prose in this catch block explains what a throw means and would
    // otherwise satisfy the assertion by talking about one.
    const code = loop
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, /^\s*throw /m);
  });

  test('the throw is logged with the job it belonged to', () => {
    const loop = loopOrNull()!;
    // The scope is the caller's label now, so a parked job still says which
    // queue it came from even though the loop is shared.
    assert.match(loop, /scope,/);
    assert.match(loop, /jobId: job\.id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The extraction path
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a tick that throws after claiming', () => {
  test('POST wraps the work rather than being the work', () => {
    // The body moved to runTick untouched. A `try` around it in place would
    // have meant reindenting three hundred lines and fifteen exits, which is a
    // large diff to hide a mistake in for a ten-line fix.
    assert.match(routeSource, /export async function POST\(request: NextRequest\)/);
    assert.match(routeSource, /return await runTick\(request, claimed\);/);
    assert.match(routeSource, /async function runTick\(request: NextRequest, claimed: ClaimHolder\)/);
  });

  test('the claimed job is recorded, so a throw has something to settle', () => {
    const tick = routeSource.indexOf('async function runTick');
    const record = routeSource.indexOf('claimed.job = job;', tick);
    assert.ok(record > 0, 'the claim is never recorded');

    // After the compare-and-swap succeeded — before it, the row is not ours
    // and settling it would be settling somebody else's job.
    const swap = routeSource.indexOf('if (!claimedRow) {', tick);
    assert.ok(swap > 0 && record > swap, 'the claim is recorded before it is won');
  });

  test('and a throw settles it through the ordinary path', () => {
    const post = bodyOf('POST');
    assert.ok(post, 'POST is gone');
    assert.match(post, /if \(claimed\.job\)/);
    assert.match(post, /await failJob\(createAdminClient\(\), claimed\.job, `runner threw/);
  });

  test('a failure to settle is logged rather than thrown again', () => {
    // The settle can fail for the same reason the tick did. Throwing out of a
    // catch block would replace a stranded job with an unhandled rejection.
    const post = bodyOf('POST');
    assert.ok(post, 'POST is gone');
    assert.match(post, /could not settle after a throw/);
  });

  test('the tick answers 500, so the scheduler sees a failure', () => {
    const post = bodyOf('POST');
    assert.ok(post, 'POST is gone');
    assert.match(post, /\{ error: 'runner failed' \}, \{ status: 500 \}/);
  });

  test('nothing is claimed and nothing is settled when the throw is earlier', () => {
    // Reaping and dispatch own no row, so a throw there has nothing to settle
    // and must not invent one.
    const post = bodyOf('POST');
    assert.ok(post, 'POST is gone');
    assert.match(post, /jobId: claimed\.job\?\.id \?\? null/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. What did not change
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the route is otherwise as it was', () => {
  test('authentication still happens before any work', () => {
    const tick = bodyOf('runTick');
    assert.ok(tick, 'runTick is gone');
    const auth = tick.indexOf('authorizeCronRequest');
    const reap = tick.indexOf('await reapStalledJobs');
    assert.ok(auth > 0 && reap > auth, 'the runner works before it checks the secret');
  });

  test('and there is still exactly one authentication check', () => {
    assert.equal((routeSource.match(/authorizeCronRequest\(/g) ?? []).length, 1);
  });

  test('GET still delegates to POST, which is the wrapper', () => {
    // Vercel Cron issues GET. It must reach the guarded entry point, not the
    // inner function.
    assert.match(routeSource, /export async function GET\(request: NextRequest\) \{\s*return POST\(request\);/);
  });
});
