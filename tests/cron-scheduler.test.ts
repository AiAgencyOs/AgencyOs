import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  authorizeCronRequest,
  CRON_DISABLED,
  CRON_UNAUTHORIZED,
} from '../src/lib/cron-auth.ts';

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
const routeSource = read('app/api/jobs/run/route.ts');

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

  test('env.ts still requires a non-trivial secret when one is set', () => {
    const envSource = read('src/lib/env.ts');
    assert.match(envSource, /CRON_SECRET: z\.string\(\)\.min\(16/);
    assert.match(envSource, /CRON_SECRET: process\.env\.CRON_SECRET/);
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

describe('vercel.json registers the runner', () => {
  test('there is a crons array with exactly one entry', () => {
    assert.ok(Array.isArray(vercelConfig.crons), 'vercel.json has no crons array');
    assert.equal(vercelConfig.crons?.length, 1);
  });

  test('it points at the job runner path Next actually serves', () => {
    assert.equal(vercelConfig.crons?.[0]?.path, '/api/jobs/run');
  });

  test('the path resolves to the route file that exports the handler', () => {
    // `/api/jobs/run` is served by app/api/jobs/run/route.ts. A cron entry
    // aimed at a path with no route handler is a silent 404 every minute.
    assert.match(routeSource, /export async function POST\(request: NextRequest\)/);
  });
});

describe('the schedule is exactly once per minute', () => {
  const schedule = vercelConfig.crons?.[0]?.schedule ?? '';

  test('the expression is "* * * * *"', () => {
    assert.equal(schedule, '* * * * *');
  });

  test('all five cron fields are unrestricted — no hour or day window', () => {
    const fields = schedule.split(' ');
    assert.equal(fields.length, 5, 'a Vercel cron expression has five fields');
    assert.deepEqual(fields, ['*', '*', '*', '*', '*']);
  });

  test('the minute field is not a step or a list — every minute, not some', () => {
    const minute = schedule.split(' ')[0];
    assert.equal(minute, '*');
    assert.doesNotMatch(minute ?? '', /[/,-]/);
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

  test('vercel.json declares only the cron — no env block was added', () => {
    const parsed = JSON.parse(configText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['$schema', 'crons']);
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
      routeSource.indexOf('dispatchOutbox(admin)') < routeSource.indexOf('runUnlockJobs(admin)'),
      'the outbox must be drained before unlocks are claimed',
    );
  });

  test('unlocks are still drained before the AI extraction path', () => {
    assert.ok(
      routeSource.indexOf('runUnlockJobs(admin)') < routeSource.indexOf('resolveProvider('),
      'the revenue path must not queue behind a model call',
    );
  });

  test('the unlock batch is still bounded, as a serverless wall clock requires', () => {
    assert.match(routeSource, /const UNLOCK_BATCH = 10/);
  });

  test('jobs are still claimed with status = queued in the predicate', () => {
    const claims = routeSource.match(/\.eq\('status', 'queued'\)/g) ?? [];
    assert.equal(claims.length, 4, 'both claim paths still select and lock on queued');
  });

  test('every job query is still scoped by organization by hand', () => {
    assert.match(routeSource, /\.eq\('organization_id', job\.organization_id\)/);
  });

  test('the handler still owns the unlock decision — the runner only settles', () => {
    assert.match(routeSource, /const result = await handleInvoicePaid\(admin, job\)/);
    assert.match(routeSource, /await settleUnlockJob\(admin, job, result\)/);
  });

  test('a permanent refusal is still parked dead rather than retried', () => {
    assert.match(routeSource, /result\.permanent \|\| job\.attempts >= job\.max_attempts/);
  });

  test('no payment gateway or scheduler SDK was introduced', () => {
    for (const forbidden of ['stripe', 'razorpay', 'node-cron', 'bullmq', 'agenda', 'whatsapp']) {
      assert.doesNotMatch(routeSource, new RegExp(forbidden, 'i'));
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
