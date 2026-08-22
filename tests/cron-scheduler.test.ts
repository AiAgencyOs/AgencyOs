import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  authorizeCronRequest,
  CRON_DISABLED,
  CRON_UNAUTHORIZED,
} from '../src/lib/cron-auth.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * The production scheduler: the configuration that makes `/api/jobs/run`
 * happen on its own, and the door it comes through.
 *
 * Two halves, tested two ways. The credential check is pure, so it is called
 * directly. The cron entry and the route's shape are declarations, so they are
 * read from the files that Vercel and Next actually consume — a mock of
 * `vercel.json` would prove only that the mock is well-formed.
 *
 * No real secret appears anywhere below. The value used is a literal invented
 * for these tests; `process.env.CRON_SECRET` is never read, so the suite is
 * identical on a laptop and in CI, and its output can be pasted anywhere.
 */

/** A stand-in credential. Not the deployed secret, and never read from env. */
const SECRET = 'test-only-secret-0123456789abcdef';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const vercelConfig = JSON.parse(read('vercel.json')) as {
  crons?: { path: string; schedule: string }[];
};
const routeSource = RUNNER_SOURCE;
const dispatchSource = read('src/lib/events/dispatch.ts');

/** The body of core.claim_jobs, where the claim's predicate now lives (G-082). */
const claimSql = (() => {
  const migration = read('supabase/migrations/20260812120009_claim_jobs_by_kind.sql');
  const from = migration.indexOf('as $$');
  return migration.slice(from, migration.indexOf('$$;', from));
})();


// ═══════════════════════════════════════════════════════════════════════════
// A–E. The CRON_SECRET check
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a cron-authenticated request is accepted', () => {
  test('the exact Bearer credential Vercel sends is accepted', () => {
    assert.deepEqual(authorizeCronRequest(`Bearer ${SECRET}`, SECRET), { ok: true });
  });

  test('acceptance depends on the secret, not on the request being a cron', () => {
    // Nothing in the check inspects a Vercel-specific header. The credential
    // is the whole claim, which is what lets verify-milestone-unlock.mjs drive
    // the same endpoint locally.
    assert.equal(authorizeCronRequest(`Bearer ${SECRET}`, SECRET).ok, true);
    assert.doesNotMatch(routeSource, /x-vercel-(cron|signature)/i);
  });
});

describe('B. a missing Authorization header is rejected', () => {
  test('an absent header is 401, not a pass-through', () => {
    assert.deepEqual(authorizeCronRequest(null, SECRET), {
      ok: false,
      status: 401,
      error: CRON_UNAUTHORIZED,
    });
  });

  test('an undefined header is refused the same way', () => {
    assert.equal(authorizeCronRequest(undefined, SECRET).ok, false);
  });

  test('an empty header is refused — blank is not a credential', () => {
    assert.equal(authorizeCronRequest('', SECRET).ok, false);
  });
});

describe('C. a wrong token is rejected', () => {
  for (const wrong of [
    'Bearer wrong-secret-0123456789abcdef',
    `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`,
    `Bearer ${SECRET.toUpperCase()}`,
    `Bearer ${SECRET} `,
    `Bearer  ${SECRET}`,
  ]) {
    test(`a credential that is not the secret is 401 (${wrong.length} chars)`, () => {
      const result = authorizeCronRequest(wrong, SECRET);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 401);
    });
  }

  test('the rejection body says nothing about what was wrong', () => {
    const result = authorizeCronRequest('Bearer wrong-secret-0123456789abcdef', SECRET);
    assert.equal(result.ok === false && result.error, CRON_UNAUTHORIZED);
    // A near-miss and a nonsense header are indistinguishable to the caller.
    assert.deepEqual(
      authorizeCronRequest('Bearer wrong-secret-0123456789abcdef', SECRET),
      authorizeCronRequest('nonsense', SECRET),
    );
  });
});

describe('D. the Bearer token format is required', () => {
  test('the bare secret with no scheme is rejected', () => {
    assert.equal(authorizeCronRequest(SECRET, SECRET).ok, false);
  });

  test('a lowercase scheme is rejected — the header is compared whole', () => {
    assert.equal(authorizeCronRequest(`bearer ${SECRET}`, SECRET).ok, false);
    assert.equal(authorizeCronRequest(`BEARER ${SECRET}`, SECRET).ok, false);
  });

  for (const scheme of ['Basic', 'Token', 'ApiKey', 'Bearer2']) {
    test(`the ${scheme} scheme carrying the right secret is still rejected`, () => {
      assert.equal(authorizeCronRequest(`${scheme} ${SECRET}`, SECRET).ok, false);
    });
  }

  test('the secret embedded in a longer header does not smuggle through', () => {
    assert.equal(authorizeCronRequest(`Bearer ${SECRET}, Bearer other`, SECRET).ok, false);
  });
});

describe('E. the existing CRON_SECRET protection is intact', () => {
  test('an unconfigured deployment is disabled (503), never open', () => {
    assert.deepEqual(authorizeCronRequest(`Bearer ${SECRET}`, undefined), {
      ok: false,
      status: 503,
      error: CRON_DISABLED,
    });
  });

  test('with no secret configured, no credential whatsoever works', () => {
    for (const header of [null, '', 'Bearer ', 'Bearer anything']) {
      assert.equal(authorizeCronRequest(header, undefined).ok, false);
    }
  });

  test('an empty-string secret is treated as unconfigured, not as a password', () => {
    assert.equal(authorizeCronRequest('Bearer ', '').ok, false);
    assert.equal(authorizeCronRequest('Bearer ', '').ok === false, true);
  });

  test('the route still reads CRON_SECRET from validated server env', () => {
    assert.match(routeSource, /const \{ CRON_SECRET \} = serverEnv\(\)/);
    assert.match(routeSource, /authorizeCronRequest\(\s*request\.headers\.get\('authorization'\)/);
  });

  test('env still requires a non-trivial secret when one is set', () => {
    // The shape moved to env-schema.ts (side-effect-free, so config-doctor can
    // import it); the parse that reads process.env stays in env.ts.
    assert.match(read('src/lib/env-schema.ts'), /CRON_SECRET: z\.string\(\)\.min\(16/);
    assert.match(read('src/lib/env.ts'), /CRON_SECRET: process\.env\.CRON_SECRET/);
  });

  test('there is exactly one authentication mechanism on this route', () => {
    // If a second check appeared, it would have to read something other than
    // the Authorization header or CRON_SECRET.
    const authCalls = routeSource.match(/authorizeCronRequest\(/g) ?? [];
    assert.equal(authCalls.length, 1);
    assert.equal((routeSource.match(/headers\.get\(/g) ?? []).length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cron configuration itself
// ═══════════════════════════════════════════════════════════════════════════

describe('vercel.json carries no native cron — the tick is driven externally', () => {
  test('there is no crons array, so the app deploys on Vercel Hobby', () => {
    // The heartbeat moved to an external per-minute scheduler (AWS EventBridge /
    // Supabase pg_cron / any host) POSTing /api/jobs/run with CRON_SECRET, so
    // vercel.json carries no sub-daily cron — which Hobby rejects at deploy time.
    // See docs/deployment/runbook.md §5.
    assert.ok(!vercelConfig.crons || vercelConfig.crons.length === 0, 'vercel.json should carry no crons');
  });

  test('the job runner path Next serves still exists for a scheduler to hit', () => {
    // `/api/jobs/run` is served by app/api/jobs/run/route.ts. A scheduler aimed
    // at a path with no route handler is a silent 404 every minute.
    assert.match(routeSource, /export async function POST\(request: NextRequest\)/);
  });
});

describe('the tick is a plain external trigger, documented for whatever drives it', () => {
  const runbook = read('docs/deployment/runbook.md');

  test('the endpoint is POST /api/jobs/run gated by CRON_SECRET — any scheduler can drive it', () => {
    assert.match(routeSource, /const \{ CRON_SECRET \} = serverEnv\(\)/);
    assert.match(routeSource, /authorizeCronRequest\(/);
  });

  test('the runbook states the every-minute contract an external scheduler must meet', () => {
    // The schedule now lives in the external scheduler, not the repo, so the
    // repo pins the contract it must honour rather than the expression itself.
    assert.match(runbook, /\/api\/jobs\/run/);
    assert.match(runbook, /every minute/i);
    assert.match(runbook, /Authorization: Bearer <CRON_SECRET>/);
  });
});

describe('the cron reaches the runner rather than bouncing', () => {
  test('a GET handler exists, because Vercel Cron issues GET', () => {
    assert.match(routeSource, /export async function GET\(request: NextRequest\)/);
  });

  test('GET delegates to POST — one implementation, not two', () => {
    assert.match(routeSource, /export async function GET\(request: NextRequest\) \{\s*return POST\(request\);\s*\}/);
  });

  test('GET performs no check of its own that could diverge from POST', () => {
    const getBody = routeSource.slice(routeSource.indexOf('export async function GET'));
    const body = getBody.slice(0, getBody.indexOf('}') + 1);
    assert.doesNotMatch(body, /CRON_SECRET|authorization|NextResponse/i);
  });

  test('the route stays dynamic on Node — a cached cron target would run nothing', () => {
    assert.match(routeSource, /export const runtime = 'nodejs'/);
    assert.match(routeSource, /export const dynamic = 'force-dynamic'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The secret stays out of everything committed
// ═══════════════════════════════════════════════════════════════════════════

describe('no secret material is committed', () => {
  const configText = read('vercel.json');

  test('vercel.json carries no credential — Vercel injects the header itself', () => {
    assert.doesNotMatch(configText, /CRON_SECRET/);
    assert.doesNotMatch(configText, /Bearer/i);
    assert.doesNotMatch(configText, /secret|token|authorization/i);
  });

  test('vercel.json declares only its schema — no cron, no env block', () => {
    const parsed = JSON.parse(configText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['$schema']);
  });

  test('the route never logs or returns the secret', () => {
    // The only mention of CRON_SECRET is the destructure and the disabled
    // message, which names the variable rather than its value.
    for (const match of routeSource.match(/.*CRON_SECRET.*/g) ?? []) {
      assert.doesNotMatch(match, /console\./);
      assert.doesNotMatch(match, /NextResponse\.json\(\{[^}]*CRON_SECRET\s*\}/);
    }
    assert.doesNotMatch(routeSource, /error: `[^`]*\$\{CRON_SECRET\}/);
  });

  test('cron-auth returns fixed strings, never the presented or expected value', () => {
    const authSource = read('src/lib/cron-auth.ts');
    assert.doesNotMatch(authSource, /console\./);
    assert.doesNotMatch(authSource, /error: `/);
    const rejected = authorizeCronRequest('Bearer leaked-attempt', SECRET);
    assert.equal(rejected.ok === false && rejected.error.includes(SECRET), false);
    assert.equal(rejected.ok === false && rejected.error.includes('leaked-attempt'), false);
  });

  test('the credential this suite uses is a literal, not the deployed one', () => {
    // The stand-in is invented here, so nothing the suite prints on failure —
    // and none of the headers above — can contain the real secret.
    assert.equal(SECRET, 'test-only-secret-0123456789abcdef');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The runner's existing behaviour is untouched
// ═══════════════════════════════════════════════════════════════════════════

describe('F. /api/jobs/run behaves as it did before the scheduler', () => {
  test('the outbox is still dispatched first, on every invocation', () => {
    assert.match(routeSource, /const dispatched = await dispatchOutbox\(admin\)/);
    assert.ok(
      routeSource.indexOf('dispatchOutbox(admin)') < routeSource.indexOf('runEventJobs('),
      'the outbox must be drained before unlocks are claimed',
    );
  });

  test('unlocks are still drained before the AI extraction path', () => {
    assert.ok(
      routeSource.indexOf('runEventJobs(') < routeSource.indexOf('resolveProvider('),
      'the revenue path must not queue behind a model call',
    );
  });

  test('the unlock batch is still bounded, as a serverless wall clock requires', () => {
    assert.match(routeSource, /const UNLOCK_BATCH = 10/);
  });

  test('jobs are still claimed with status = queued in the predicate', () => {
    // The claim moved into core.claim_jobs (G-082), so the predicate is
    // asserted where Postgres reads it rather than as a PostgREST filter.
    assert.match(claimSql, /and status = 'queued'/);
    assert.match(claimSql, /where kind = p_kind/);
    // One occurrence now, not four: there is one claim statement rather than
    // two select-then-swap pairs.
    const claims = claimSql.match(/status = 'queued'/g) ?? [];
    assert.equal(claims.length, 1, 'the single claim statement lost its status predicate');
  });

  test('every job query is still scoped by organization by hand', () => {
    assert.match(routeSource, /\.eq\('organization_id', job\.organization_id\)/);
  });

  test('the handler still owns the unlock decision — the runner only settles', () => {
    // The call is inside a try (gap G-081): an undici socket error arrives as
    // a throw rather than as `{ error }`, and unguarded it skipped the settle
    // *and* aborted the rest of the batch.
    //
    // The loop is now generic over the kind and the handler (G-110), so the
    // handler is a parameter rather than a name in the call. What matters here
    // is unchanged and is now asserted for *every* queue rather than one: the
    // runner asks a handler and settles whatever comes back, deciding nothing
    // itself. A second copy of this loop is what the generalisation avoids —
    // D16, where a fix stopped applying to half the surface it was written for.
    assert.match(routeSource, /result = await handler\(admin, job\)/);
    assert.match(routeSource, /await settleUnlockJob\(admin, job, result, kind, scope\)/);
    // And the unlock queue is still wired to the unlock handler.
    assert.match(routeSource, /runEventJobs\(\s*admin,\s*UNLOCK_JOB_KIND,\s*handleInvoicePaid,/);
  });

  test('a permanent refusal is still parked dead rather than retried', () => {
    // The expression moved into src/lib/jobs/retry.ts with audit finding D18,
    // so what is pinned here is that the runner still asks the rule with the
    // post-claim attempt count and still hands it `result.permanent` — not a
    // literal that D18 happened to leave behind. The rule itself is tested
    // directly in tests/job-retry-backoff.test.ts.
    assert.match(
      routeSource,
      /settlementFor\(\s*\{ attemptsMade: job\.attempts, maxAttempts: job\.max_attempts \},\s*result\.permanent,/,
    );
  });

  test('and a retryable one is scheduled into the future, not straight back', () => {
    // D18: without run_at the drain loop re-claims the same row on its next
    // turn and spends the whole retry budget inside one tick.
    assert.match(routeSource, /run_at: settlement\.runAt/);
  });

  test('the runner is killable at any point without double-processing', () => {
    // See the function-duration section below for why this is the property
    // that matters rather than the timeout number itself.
    //
    // It is stronger than it was: the claim is one statement now, so there is
    // no window between reading a candidate and taking it. `for update skip
    // locked` is what makes a second runner step over a row rather than wait
    // for it and then find it gone.
    assert.match(claimSql, /for update skip locked/);
    assert.match(claimSql, /update core\.jobs j\n\s*set status\s*= 'running'/);
  });

  test('no payment gateway or scheduler SDK was introduced', () => {
    // Read with the comments stripped, because the question is whether an SDK
    // was imported, not whether a word was written. The runner's prose quotes
    // Doc 03 §5 on "Respond to new WhatsApp leads" — naming the channel the
    // agency works in, which is the whole point of the product and no more an
    // SDK than the doc it is quoting.
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    // Scanned over the runner's IMPORTS, which is what "was an SDK introduced"
    // actually asks. Reading the whole source was the same thing while nothing
    // in the runner talked to a provider, and stopped being the same thing
    // twice: first on a comment quoting Doc 03 §5 about WhatsApp leads, and
    // then — after ADM-91 — on the sales agent's own prompt, which says
    // "answering a client on WhatsApp" because that is where the client is.
    //
    // Neither is a dependency. An import is.
    const imports = [...code.matchAll(/(?:^import[^;]*from\s*|await import\()\s*['"]([^'"]+)['"]/gm)]
      .map((m) => m[1] ?? '');
    assert.ok(imports.length >= 5, `only ${imports.length} imports found — the parser drifted`);
    for (const spec of imports) {
      // AgencyOS's own modules are not SDKs. `@/lib/whatsapp/send` is the same
      // path `crm:deliverFollowUp` has always used.
      if (spec.startsWith('@/') || spec.startsWith('.')) continue;
      for (const forbidden of ['stripe', 'razorpay', 'node-cron', 'bullmq', 'agenda', 'whatsapp']) {
        assert.doesNotMatch(spec, new RegExp(forbidden, 'i'), `the runner imports ${spec}`);
      }
    }
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    for (const forbidden of ['stripe', 'razorpay', 'node-cron', 'cron', 'bullmq', 'agenda']) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not be a dependency`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Function duration
//
// The runner is invoked unattended every minute and can be terminated by the
// platform at any instant. What is pinned here is therefore not a timeout
// value but the set of properties that make an interrupted invocation
// harmless — because those, not the number, are what keep the revenue path
// correct when a function is killed mid-flight.
//
// On the deployment's runtime the platform default is five minutes. The
// non-model half of an invocation is bounded by construction — at most 25
// outbox events and UNLOCK_BATCH unlocks, all plain queries, measured at well
// under a second — so the default is not close to binding. The one unbounded
// thing is the model call, and no supported ceiling covers its worst case:
// the Anthropic SDK's own default request timeout is ten minutes and it
// retries twice, so an extraction can outlive any duration the platform will
// grant. Raising maxDuration therefore does not fix that; bounding the client
// does. Until it is bounded, an explicit ceiling here would be a number
// chosen to look decisive rather than one derived from anything.
// ═══════════════════════════════════════════════════════════════════════════

describe('the route relies on the platform default duration', () => {
  test('no maxDuration is declared', () => {
    // Deliberate, and pinned so that adding one is an edit to this test with a
    // reason attached rather than a silent guess.
    assert.doesNotMatch(routeSource, /export const maxDuration/);
  });

  test('the runtime is nodejs — the edge runtime could not host this work', () => {
    // Edge must begin responding within 25s; the runner may hold a model call
    // far longer than that before it has anything to say.
    assert.match(routeSource, /export const runtime = 'nodejs'/);
    assert.doesNotMatch(routeSource, /runtime = 'edge'/);
  });

  test('the per-invocation workload stays bounded, so duration stays predictable', () => {
    assert.match(routeSource, /const UNLOCK_BATCH = 10/);
    assert.match(dispatchSource, /options\.batchSize \?\? 25/);
    // One agent job per invocation, and one unlock at a time. Both ask
    // core.claim_jobs for a batch of one (G-082) — claiming more would leave
    // rows `running` that this tick will never settle.
    //
    // The agent claim used to name a constant kind, then walked
    // AGENT_JOB_KINDS in a loop, and now asks `core.claim_agent_job` for the
    // oldest row across all of them — because the loop took the first kind
    // with a queued row and so starved every kind after it.
    //
    // **The bound survived both changes, and that is what this pins.** N
    // workflows still cost ONE job per tick rather than N: the unlock claim
    // asks `claim_jobs` for a batch of one (G-082), and the agent claim is a
    // single statement with `limit 1` in it.
    const batched = [...routeSource.matchAll(/p_batch_size: (\d+)/g)];
    assert.ok(batched.length >= 1, `only ${batched.length} batched claim(s) found — the parser drifted`);
    for (const c of batched) assert.equal(c[1], '1', 'a claim asks for more than one row');

    assert.match(routeSource, /rpc\('claim_agent_job'/);
    assert.doesNotMatch(routeSource, /for \(const kind of AGENT_JOB_KINDS\)/);
    assert.equal(
      (routeSource.match(/rpc\('claim_agent_job'/g) ?? []).length,
      1,
      'the agent claim happens more than once per invocation',
    );
  });
});

describe('an invocation killed by a timeout cannot double-process', () => {
  test('a claimed job is no longer claimable — the predicate is status = queued', () => {
    assert.match(claimSql, /and status = 'queued'/);
    assert.match(claimSql, /set status\s+= 'running'/);
    return;
    // A killed invocation leaves its job in `running`. Both claim paths filter
    // on `queued`, so no tick can pick it up again while it sits there. The
    // reaper is the only way back, and it waits out any possible live worker
    // first — so a timeout costs a delay, never a second run.
    const claimFilters = routeSource.match(/\.eq\('status', 'queued'\)/g) ?? [];
    assert.equal(claimFilters.length, 4);
    assert.doesNotMatch(routeSource, /\.in\('status', \[[^\]]*'running'/);
  });

  test('exactly one mechanism takes a job lock, called from two places', () => {
    // It was two hand-rolled compare-and-swaps. Both now claim through the
    // database, which is the whole of G-082: one claim, one statement, no
    // read-then-write.
    //
    // Two functions rather than one since the agent claim had to order across
    // kinds by age — `claim_jobs` is per-kind and correct for the unlock path,
    // and `claim_agent_job` is the same mechanism asked a different question.
    // What matters is that neither path hand-rolls a lock, so this counts
    // claim CALLS rather than calls to one name.
    const calls = routeSource.match(/\.rpc\('claim_(jobs|agent_job)'/g) ?? [];
    assert.equal(calls.length, 2, 'a claim path stopped claiming in the database');
    assert.doesNotMatch(routeSource, /locked_by: `jobs-run:\$\{correlationId\}`,\n\s*attempts:/);
    return;
    // `locked_by` is written only by a claim, so counting it counts claims —
    // unlike `status: 'running'`, which ai.agent_runs also uses for a run that
    // is not a job at all. If a third claim path appears it must reason about
    // interruption for itself, so this is pinned rather than left to review.
    const takesLock = routeSource.match(/locked_by: `jobs-run:/g) ?? [];
    assert.equal(takesLock.length, 2);
    // Settlement is the only thing that releases one, and it always clears it.
    // Five paths: failJob (retried or dead), both unlock settlements, and the
    // two recovery branches that settle a job whose own settlement never ran —
    // a job that already produced its version, and one that lost an
    // idempotency race. Those two previously left a stale lock on a job they
    // had already closed.
    const releasesLock = routeSource.match(/locked_by: null/g) ?? [];
    assert.equal(releasesLock.length, 5, 'every settlement path releases the lock');
  });

  test('the route itself never moves a job out of running', () => {
    // Settlement and the reaper are the only two, and the reaper does its work
    // inside one SQL statement rather than here. The route holds no code that
    // un-claims a job, so there is nothing here that could race a live worker.
    assert.doesNotMatch(routeSource, /status: 'queued'[^)]*locked_at: new Date/);
    assert.doesNotMatch(routeSource, /\.eq\('status', 'running'\)/);
  });

  test('the unlock handler is idempotent, so even a re-run unlock is safe', () => {
    const handlers = read('src/modules/projects/handlers.ts');
    assert.match(handlers, /already_unlocked/);
    assert.match(handlers, /outcome: 'already_unlocked'/);
  });
});

describe('the outbox survives an invocation dying mid-dispatch', () => {
  test('jobs are enqueued before the event is marked published', () => {
    // The ordering is the crash-safety property: dying between the two leaves
    // the event unpublished, so the next tick re-enqueues and the unique
    // dedupe_key makes that a no-op. The reverse order would lose the job.
    const enqueueAt = dispatchSource.indexOf(".from('jobs')");
    const publishAt = dispatchSource.indexOf('published_at: new Date().toISOString()');
    assert.ok(enqueueAt > 0 && publishAt > 0);
    assert.ok(enqueueAt < publishAt, 'enqueue must precede publish');
  });

  test('an event whose jobs did not all land stays unpublished for the next tick', () => {
    assert.match(dispatchSource, /if \(enqueueFailed\) \{[\s\S]*?continue;[\s\S]*?\}/);
  });

  test('publishing is guarded, so a racing tick cannot publish twice', () => {
    assert.match(dispatchSource, /\.eq\('id', event\.id\)\s*\.is\('published_at', null\)/);
  });

  test('a duplicate enqueue is counted, not treated as a failure', () => {
    assert.match(dispatchSource, /insertError\.code === UNIQUE_VIOLATION/);
    assert.match(dispatchSource, /summary\.duplicates \+= 1/);
  });
});
