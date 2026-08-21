import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import {
  FUNCTION_CEILING_MS,
  MAX_RETRIES,
  NON_MODEL_RESERVE_MS,
  providerWorstCaseMs,
  remainingBudgetMs,
  REQUEST_TIMEOUT_MS,
  retryBackoffWorstCaseMs,
} from '../src/lib/ai/budget.ts';
import { STALE_AFTER_SECONDS, isStale, recoveryFor } from '../src/lib/jobs/staleness.ts';

/**
 * The AI extraction call, bounded.
 *
 * Left at the SDK's defaults the call could run ten minutes an attempt and
 * retry twice — far longer than the function is allowed to live — so the
 * platform decided how a slow extraction ended, killing the invocation before
 * it could record anything. The job stayed `running` until the reaper found it.
 *
 * Two things are proved here. That the arithmetic closes: the worst case the
 * provider can spend, retries and backoff included, still leaves the runner
 * time to write down what happened. And that the configuration behaves as
 * claimed, exercised against a local server standing in for the API — real SDK,
 * real retry loop, real error classes, no network and no key.
 */

// claude.ts now reads its key and base URL through serverEnv() (so a truncated
// key is caught and the base URL is passed explicitly, never ambiently). That
// pulls in @/lib/env, whose eager public-variable parse needs these set before
// the dynamic import of claude.ts below. Placeholders only — the SDK is pointed
// at a local stub, never the network.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const claudeSource = read('src/lib/ai/claude.ts');
const budgetSource = read('src/lib/ai/budget.ts');
const routeSource = read('app/api/jobs/run/route.ts');

/** The body of core.claim_jobs, where the claim's predicate now lives (G-082). */
const claimSql = (() => {
  const migration = read('supabase/migrations/20260812120009_claim_jobs_by_kind.sql');
  const from = migration.indexOf('as $$');
  return migration.slice(from, migration.indexOf('$$;', from));
})();


// ═══════════════════════════════════════════════════════════════════════════
// A. The budget closes
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the provider cannot outlive the function', () => {
  test('worst case plus the reserve fits inside the ceiling', () => {
    assert.ok(
      providerWorstCaseMs() + NON_MODEL_RESERVE_MS < FUNCTION_CEILING_MS,
      `${providerWorstCaseMs()} + ${NON_MODEL_RESERVE_MS} must be under ${FUNCTION_CEILING_MS}`,
    );
  });

  test('there is budget left over, not merely none missing', () => {
    assert.ok(remainingBudgetMs() > 0, `remaining ${remainingBudgetMs()}ms`);
  });

  test('the worst case is every attempt at full timeout plus every backoff', () => {
    assert.equal(
      providerWorstCaseMs(),
      (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS + retryBackoffWorstCaseMs(),
    );
  });

  test('the numbers are the ones derived: 110s per attempt, one retry', () => {
    assert.equal(REQUEST_TIMEOUT_MS, 110_000);
    assert.equal(MAX_RETRIES, 1);
    assert.equal(FUNCTION_CEILING_MS, 300_000);
    assert.equal(NON_MODEL_RESERVE_MS, 60_000);
  });

  test('a single attempt alone also fits — not only the sum', () => {
    assert.ok(REQUEST_TIMEOUT_MS + NON_MODEL_RESERVE_MS < FUNCTION_CEILING_MS);
  });
});

describe('A. the ceiling matches what the route actually declares', () => {
  test('the route declares no maxDuration, so the platform default applies', () => {
    // If a maxDuration is ever added, FUNCTION_CEILING_MS is the number that
    // has to move with it — this is what stops the two drifting apart.
    assert.doesNotMatch(routeSource, /export const maxDuration/);
    assert.equal(FUNCTION_CEILING_MS, 300_000);
  });

  test('the runtime is nodejs, which is what the ceiling was read for', () => {
    assert.match(routeSource, /export const runtime = 'nodejs'/);
  });
});

describe('A. the SDK defaults really were the problem', () => {
  test('the SDK default timeout alone exceeds the whole function ceiling', () => {
    const sdkDefaultTimeout = 600_000; // BaseAnthropic.DEFAULT_TIMEOUT
    assert.ok(sdkDefaultTimeout > FUNCTION_CEILING_MS);
  });

  test('the SDK default retry count would multiply that by three', () => {
    const sdkDefaultRetries = 2;
    const wouldSpend = (sdkDefaultRetries + 1) * 600_000;
    assert.ok(wouldSpend > FUNCTION_CEILING_MS * 5);
    assert.ok(MAX_RETRIES < sdkDefaultRetries, 'we retry fewer times than the SDK would');
  });

  test('the configured worst case is a small fraction of what it replaced', () => {
    assert.ok(providerWorstCaseMs() < (2 + 1) * 600_000 / 5);
  });
});

describe('A. backoff is counted, not waved away', () => {
  test('it follows the SDK schedule min(0.5 * 2^n, 8) seconds', () => {
    assert.equal(retryBackoffWorstCaseMs(0), 0);
    assert.equal(retryBackoffWorstCaseMs(1), 500);
    assert.equal(retryBackoffWorstCaseMs(2), 1_500);
    assert.equal(retryBackoffWorstCaseMs(3), 3_500);
  });

  test('it is capped at eight seconds a retry, as the SDK caps it', () => {
    assert.equal(retryBackoffWorstCaseMs(10) - retryBackoffWorstCaseMs(9), 8_000);
  });

  test('the worst case in use includes it', () => {
    assert.ok(providerWorstCaseMs() > (MAX_RETRIES + 1) * REQUEST_TIMEOUT_MS);
  });
});

describe('A. a timeout is handled in-process, with the reaper only as backstop', () => {
  test('the whole invocation ends long before a lock is considered stale', () => {
    // The point of bounding the call: the runner settles its own job. The
    // reaper stays a backstop for a genuinely killed process, not the normal
    // route by which a slow extraction is recovered.
    assert.ok(FUNCTION_CEILING_MS < STALE_AFTER_SECONDS * 1_000);
    assert.ok(providerWorstCaseMs() + NON_MODEL_RESERVE_MS < STALE_AFTER_SECONDS * 1_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The client is configured from the budget, not from a number typed in
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the provider takes its bounds from the budget module', () => {
  test('both options are passed to the Anthropic constructor', () => {
    assert.match(claudeSource, /new Anthropic\(\{[\s\S]*?timeout: REQUEST_TIMEOUT_MS[\s\S]*?\}\)/);
    assert.match(claudeSource, /new Anthropic\(\{[\s\S]*?maxRetries: MAX_RETRIES[\s\S]*?\}\)/);
  });

  test('they are imported, not re-typed as literals', () => {
    assert.match(claudeSource, /import \{ MAX_RETRIES, REQUEST_TIMEOUT_MS \} from '\.\/budget'/);
    assert.doesNotMatch(claudeSource, /timeout: \d/);
    assert.doesNotMatch(claudeSource, /maxRetries: \d/);
  });

  test('the budget module derives rather than declares a preference', () => {
    assert.match(budgetSource, /FUNCTION_CEILING_MS/);
    assert.match(budgetSource, /NON_MODEL_RESERVE_MS/);
    assert.match(budgetSource, /export function providerWorstCaseMs/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Behaviour, against a local stand-in for the API
// ═══════════════════════════════════════════════════════════════════════════

type Reply = { status: number; body: unknown; delayMs?: number };

let server: Server;
let baseURL: string;
let requests = 0;
let replies: Reply[] = [];

/** The message body the provider expects on the happy path. */
const message = (text: string, over: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 11, output_tokens: 7 },
  ...over,
});

/** Queues the replies this server will give, in order; the last one repeats. */
function willReply(...queue: Reply[]) {
  replies = queue;
  requests = 0;
}

before(async () => {
  server = createServer((req, res) => {
    requests += 1;
    const reply = replies[Math.min(requests - 1, replies.length - 1)] ?? {
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'no reply queued' } },
    };
    const send = () => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    };
    req.resume();
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${address.port}`;

  // The provider reads both at construction. The key is a stand-in that never
  // leaves this machine; the base URL is what keeps the SDK off the network.
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
  process.env.ANTHROPIC_BASE_URL = baseURL;
});

after(async () => {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A provider bound to the stand-in server, built the way production builds it. */
async function provider() {
  const { createClaudeProvider } = await import('../src/lib/ai/claude.ts');
  const made = createClaudeProvider();
  assert.ok(made, 'provider should exist when a key is configured');
  return made;
}

const request = {
  model: 'claude-sonnet-5',
  system: 'extract',
  messages: [{ role: 'user' as const, content: 'we need a website' }],
  jsonSchema: { type: 'object' },
  schemaName: 'RequirementPayload',
};

describe('C. a successful extraction', () => {
  test('returns the parsed JSON, the model and the usage', async () => {
    willReply({ status: 200, body: message('{"summary":"a website"}') });
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.json, { summary: 'a website' });
    assert.equal(result.data.model, 'claude-sonnet-5');
    assert.equal(result.data.usage.inputTokens, 11);
    assert.equal(result.data.usage.outputTokens, 7);
    assert.equal(result.data.usage.costMinor, 0);
    assert.equal(requests, 1, 'a success is not retried');
  });

  test('the output format is unchanged — json stays unknown until Zod sees it', async () => {
    willReply({ status: 200, body: message('{"a":1,"b":[2,3]}') });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.json, { a: 1, b: [2, 3] });
  });
});

describe('C. answers that are not usable output', () => {
  test('a refusal is an error, not an empty extraction', async () => {
    willReply({ status: 200, body: message('', { stop_reason: 'refusal', content: [] }) });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /declined/i);
  });

  test('running out of output budget is an error', async () => {
    willReply({ status: 200, body: message('{"partial":', { stop_reason: 'max_tokens' }) });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /output budget/i);
  });

  test('empty text is an error rather than an empty object', async () => {
    willReply({ status: 200, body: message('   ') });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /no output/i);
  });

  test('output that is not JSON is refused, never coerced', async () => {
    willReply({ status: 200, body: message('I think they want a website.') });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /not valid JSON/i);
  });
});

describe('C. provider failures', () => {
  test('a rejected key is reported as such', async () => {
    willReply({ status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /key was rejected/i);
  });

  test('a 404 points at the agent registry, where the model id comes from', async () => {
    willReply({ status: 404, body: { type: 'error', error: { type: 'not_found_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /ai\.agents\.default_model/);
  });

  test('a 400 is not retried — a bad request does not improve by repeating', async () => {
    willReply({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
  });

  test('a failure never carries the API key into its message', async () => {
    willReply({ status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.error.message, /test-key-not-a-real-credential/);
      assert.doesNotMatch(result.error.message, /x-api-key/i);
    }
  });
});

describe('C. retry behaviour is the configured one', () => {
  test('a transient 500 is retried once and then succeeds', async () => {
    willReply(
      { status: 500, body: { type: 'error', error: { type: 'api_error' } } },
      { status: 200, body: message('{"recovered":true}') },
    );
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, true);
    assert.equal(requests, 2, 'one attempt plus one retry');
  });

  test('a persistent 500 stops after the configured retry, not the SDK default', async () => {
    willReply({ status: 500, body: { type: 'error', error: { type: 'api_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    assert.equal(requests, MAX_RETRIES + 1);
    assert.equal(requests, 2, 'the SDK default of 2 retries would have made 3 requests');
  });

  test('a 429 is retried too, and is reported as rate limiting', async () => {
    willReply({ status: 429, body: { type: 'error', error: { type: 'rate_limit_error' } } });
    const result = await (await provider()).generateStructured(request);
    assert.equal(result.ok, false);
    assert.equal(requests, MAX_RETRIES + 1);
    if (!result.ok) assert.match(result.error.message, /Rate limited/i);
  });

  test('the total attempts are what the budget assumed', async () => {
    willReply({ status: 500, body: { type: 'error', error: { type: 'api_error' } } });
    await (await provider()).generateStructured(request);
    assert.equal(
      providerWorstCaseMs(),
      requests * REQUEST_TIMEOUT_MS + retryBackoffWorstCaseMs(),
      'the arithmetic must assume exactly the attempts the client makes',
    );
  });
});

describe('C. the timeout is real and is the one configured', () => {
  test('a request that outlasts the timeout raises APIConnectionTimeoutError', async () => {
    // Built exactly as the provider builds its client, but with a timeout
    // short enough to observe. This is what proves the option is honoured at
    // all — messages.create only computes its own timeout when the client has
    // none, so an explicit value has to be the one that wins.
    willReply({ status: 200, body: message('{"slow":true}'), delayMs: 400 });
    const client = new Anthropic({
      apiKey: 'test-key-not-a-real-credential',
      baseURL,
      timeout: 50,
      maxRetries: 0,
    });

    await assert.rejects(
      () =>
        client.messages.create({
          model: 'claude-sonnet-5',
          max_tokens: 8_000,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      (error: unknown) => error instanceof Anthropic.APIConnectionTimeoutError,
    );
  });

  test('a timeout is described as a timeout, not as an unreachable host', async () => {
    const { describeProviderError } = await import('../src/lib/ai/claude.ts');
    const message = describeProviderError(new Anthropic.APIConnectionTimeoutError({}));
    assert.match(message, /did not respond within 110s/);
    assert.match(message, /retried/i);
    assert.doesNotMatch(message, /Could not reach/);
  });

  test('a genuine connection failure still reads as one', async () => {
    const { describeProviderError } = await import('../src/lib/ai/claude.ts');
    assert.equal(
      describeProviderError(new Anthropic.APIConnectionError({ message: 'socket hang up' })),
      'Could not reach Anthropic.',
    );
  });

  test('the timeout message quotes the configured bound, not a literal', () => {
    assert.match(claudeSource, /REQUEST_TIMEOUT_MS \/ 1000/);
  });

  test('the timeout check precedes the connection check it extends', () => {
    assert.ok(
      claudeSource.indexOf('APIConnectionTimeoutError') <
        claudeSource.indexOf('instanceof Anthropic.APIConnectionError'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. A failed or timed-out extraction settles cleanly
// ═══════════════════════════════════════════════════════════════════════════

describe('D. a provider failure settles the job rather than stranding it', () => {
  test('the run is closed and the job failed before the handler returns', () => {
    // Settles through failExtraction rather than failJob directly since the
    // proposal lifecycle landed: it still requeues while attempts remain (the
    // next test pins that), and additionally records a `failed` requirement
    // version once they are spent, so a permanently failed extraction is
    // visible to the owner instead of only inside the queue.
    assert.match(
      routeSource,
      /if \(!response\.ok\) \{\s*await finishRun\([^)]*\);\s*await failExtraction\(admin, job, conversation\.id, runId, response\.error\.message, messageCount\);/,
    );
  });

  test('failJob requeues while attempts remain, and clears the lock either way', () => {
    // Sliced to failJob's own body. The old form of this test matched
    // `job.attempts + 1 >= job.max_attempts` anywhere in the file, which after
    // D18 moved the expression out of failJob would still have matched — the
    // identical line inside failExtraction sits a few hundred characters away.
    // It would have passed while asserting nothing about failJob at all.
    const at = routeSource.indexOf('async function failJob');
    assert.ok(at > 0, 'failJob is gone');
    const body = routeSource.slice(at, routeSource.indexOf('\n}', at));

    // `job` here is the pre-claim row, so the attempt just spent is +1. The
    // unlock path counts from the other side; the rule takes "attempts made"
    // from both so the two cannot drift into an off-by-one.
    // `job.attempts` is the attempt now in progress: core.claim_jobs
    // increments it inside the statement that takes the lock (G-082), where
    // the old two-step handed back the pre-claim row and every caller had to
    // add one. Adding one here now would spend the budget an attempt early.
    assert.match(
      body,
      /settlementFor\(\s*\{ attemptsMade: job\.attempts, maxAttempts: job\.max_attempts \},/,
    );
    assert.match(body, /status: settlement\.status/);
    assert.match(body, /locked_at: null,\s*locked_by: null,/);
  });

  test('and it schedules the retry rather than releasing it instantly (D18)', () => {
    const at = routeSource.indexOf('async function failJob');
    const body = routeSource.slice(at, routeSource.indexOf('\n}', at));
    assert.match(body, /run_at: settlement\.runAt/);
  });

  test('the reason is written down, so a timeout is visible in the queue', () => {
    assert.match(routeSource, /last_error: reason/);
  });

  test('a settled job cannot be double-claimed — the predicate is status = queued', () => {
  // The claim moved into core.claim_jobs (G-082): one statement, with the
  // status filter, the run_at bound and the attempt increment together, and
  // `for update skip locked` so a second runner steps over a held row. The
  // predicate is asserted where it now lives — the migration Postgres runs —
  // rather than as a PostgREST filter that no longer exists.
    assert.match(claimSql, /where kind = p_kind/);
    assert.match(claimSql, /and status = 'queued'/);
    assert.match(claimSql, /for update skip locked/);
  });

  test('the model call is still traced whatever its outcome', () => {
    // recordModelCall runs before the ok/failed branch, so a timeout leaves a
    // step with its error rather than no evidence at all.
    assert.ok(routeSource.indexOf('recordModelCall(admin') < routeSource.indexOf('if (!response.ok)'));
  });
});

describe('D. the reaper still covers an AI job that dies anyway', () => {
  test('recovery is by lock age, never by kind — extraction jobs included', () => {
    const migration = read('supabase/migrations/20260807120002_core.sql');
    const body = migration.slice(
      migration.indexOf('function core.reap_stalled_jobs'),
      migration.indexOf('$$;', migration.indexOf('function core.reap_stalled_jobs')),
    );
    assert.doesNotMatch(body, /kind/);
  });

  test('a stalled extraction job is stale on the same rule as any other', () => {
    const stalled = {
      status: 'running',
      locked_at: new Date(Date.now() - (STALE_AFTER_SECONDS + 60) * 1_000).toISOString(),
      attempts: 1,
      max_attempts: 5,
    };
    assert.equal(isStale(stalled, Date.now()), true);
    assert.equal(recoveryFor(stalled), 'queued');
  });

  test('a live extraction is never reaped — the bound is shorter than the threshold', () => {
    // An invocation cannot exceed the ceiling, and the ceiling is well inside
    // the staleness threshold, so a running extraction can never look stale.
    const running = {
      status: 'running',
      locked_at: new Date(Date.now() - FUNCTION_CEILING_MS).toISOString(),
      attempts: 1,
      max_attempts: 5,
    };
    assert.equal(isStale(running, Date.now()), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. A failed extraction has to say what was wrong with it
// ═══════════════════════════════════════════════════════════════════════════

/**
 * On production, `requirement.extract` failed five times and died with
 * `Anthropic returned 400.` in core.jobs.last_error. That sentence is true and
 * useless: a 400 means the request itself is malformed, so all five attempts
 * sent the same malformed request, and nothing anywhere recorded which part of
 * it the provider objected to. The body carried the answer the whole time.
 */
describe('E. a rejected request records the reason, not just the number', () => {
  const invalidRequest = (message: string) => ({
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message } },
  });

  test('the provider’s own words survive into the message', async () => {
    willReply(invalidRequest('output_config.format.schema: unsupported keyword "$schema"'));
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /400/);
      assert.match(result.error.message, /unsupported keyword "\$schema"/);
    }
  });

  test('a body with no message still reads as a sentence', async () => {
    // Not every provider error carries prose. The bare form is the fallback,
    // never a dangling colon.
    willReply({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error' } } });
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.message, 'Anthropic returned 400.');
      assert.doesNotMatch(result.error.message, /:\s*$/);
    }
  });

  test('a malformed body is not trusted into the message', async () => {
    willReply({ status: 400, body: { type: 'error', error: 'not an object' } });
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.message, 'Anthropic returned 400.');
  });

  test('the classes that identify themselves still win over the body', async () => {
    // A 401 knows what it is from its own type. Reading the body here would
    // replace a sentence written for whoever has to fix it with the API's.
    willReply({
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    });
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /key was rejected/i);
  });

  test('the detail is bounded — it lands in a column somebody reads', async () => {
    willReply(invalidRequest('x'.repeat(5_000)));
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.message.length < 600, result.error.message.length + ' chars');
  });

  test('and it still never carries the API key', async () => {
    willReply(invalidRequest('rejected: test-key-not-a-real-credential was sent as x-api-key'));
    const result = await (await provider()).generateStructured(request);

    assert.equal(result.ok, false);
    if (!result.ok) {
      // The body is echoed, so this asserts the one thing that would make
      // echoing it unsafe: a provider that quotes the key back is not a reason
      // to write it into core.jobs.last_error.
      assert.doesNotMatch(result.error.message, /test-key-not-a-real-credential/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The schema handed to the decoder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `requirementJsonSchema()` is derived from the Zod schema so the two cannot
 * drift — but what a JSON Schema *library* wants and what a constrained decoder
 * accepts are not the same document. The decoder builds a grammar from the
 * schema and rejects the whole request over a keyword it cannot express, which
 * is a 400 that no retry improves.
 *
 * The keyword was not guessed. Production said so, once the error carried the
 * provider's words: *"For 'array' type, property 'maxItems' is not
 * supported"* — from the three `.max(50)` bounds on the arrays.
 */
describe('F. the schema the provider is asked to decode against', () => {
  test('carries no array-length bound — the keyword the decoder named', async () => {
    const { requirementJsonSchema } = await import('../src/modules/crm/schema.ts');
    const wire = JSON.stringify(requirementJsonSchema());

    assert.doesNotMatch(wire, /"maxItems"/);
    assert.doesNotMatch(wire, /"minItems"/);
  });

  test('carries no dialect declaration at the root', async () => {
    const { requirementJsonSchema } = await import('../src/modules/crm/schema.ts');
    assert.equal('$schema' in requirementJsonSchema(), false);
  });

  test('is still an object schema that closes itself', async () => {
    const { requirementJsonSchema } = await import('../src/modules/crm/schema.ts');
    const schema = requirementJsonSchema();

    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['summary', 'scopeItems', 'constraints', 'openQuestions']);
  });

  test('keeps every constraint the decoder did NOT object to', async () => {
    const { requirementJsonSchema } = await import('../src/modules/crm/schema.ts');
    const schema = requirementJsonSchema();

    /** Walks to a nested key, so the assertions below read as paths. */
    const at = (path: string): unknown =>
      path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], schema);

    // Stripping is targeted, not a blanket clear-out: string bounds survive,
    // and the refusal named arrays only. Over-stripping would quietly widen
    // what the model may produce.
    assert.equal(at('properties.summary.minLength'), 1);
    assert.equal(at('properties.summary.maxLength'), 2_000);
    assert.equal(at('properties.scopeItems.items.properties.title.maxLength'), 200);
    assert.equal(at('properties.constraints.items.maxLength'), 500);
  });

  test('the difference from Zod is exactly those keywords and nothing else', async () => {
    const { requirementJsonSchema, requirementPayloadSchema } = await import(
      '../src/modules/crm/schema.ts'
    );
    const { z } = await import('zod');

    // Re-derive the expectation by deleting the named keywords from Zod's own
    // output. If a future change starts editing anything *else* on the way to
    // the wire, this fails rather than letting the two drift apart.
    const expected = JSON.parse(
      JSON.stringify(z.toJSONSchema(requirementPayloadSchema), (key, value) =>
        key === '$schema' || key === 'maxItems' || key === 'minItems' ? undefined : value,
      ),
    );

    assert.deepEqual(requirementJsonSchema(), expected);
  });

  test('a property legitimately NAMED maxItems survives — it is not the keyword', async () => {
    const { decoderSafeSchema } = await import('../src/modules/crm/schema.ts');

    // The reason this walks the document instead of deleting the key wherever
    // it appears: `properties` maps user-chosen names to schemas, and a field
    // called `maxItems` is data, not a bound the decoder cannot express.
    const out = decoderSafeSchema({
      type: 'object',
      maxItems: 3, // the keyword — goes
      properties: {
        maxItems: { type: 'number', maxItems: 9 }, // the name stays, its keyword goes
        rows: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['maxItems'],
    }) as Record<string, unknown>;

    assert.equal('maxItems' in out, false, 'the root keyword should be gone');

    const props = out.properties as Record<string, Record<string, unknown>>;
    assert.ok(props && 'maxItems' in props, 'the property NAME must survive');
    assert.equal(props.maxItems?.type, 'number');
    assert.equal('maxItems' in (props.maxItems ?? {}), false, 'but its own keyword goes');
    assert.equal('minItems' in (props.rows ?? {}), false);

    // `required` is a list of names, not schemas: copied through untouched.
    assert.deepEqual(out.required, ['maxItems']);
  });

  test('and the payload Zod accepts is still the payload described', async () => {
    const { requirementJsonSchema, requirementPayloadSchema } = await import(
      '../src/modules/crm/schema.ts'
    );
    const schema = requirementJsonSchema();
    const payload = {
      summary: 'A booking site for a salon',
      scopeItems: [{ title: 'Booking calendar', detail: 'Staff and slots' }, { title: 'Payments' }],
      constraints: ['Launch before Diwali'],
      openQuestions: ['Which payment gateway?'],
    };

    assert.equal(requirementPayloadSchema.safeParse(payload).success, true);
    // Every key the model is told to produce is a key Zod knows about.
    const described = Object.keys(schema.properties as Record<string, unknown>);
    assert.deepEqual(described.sort(), Object.keys(payload).sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. A silent row must not silence the whole request
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recording media gave `crm.conversation_messages` its first rows with an
 * empty `body`, and the transcript builder passed `body` through as message
 * content. An empty content block is not a smaller input — it is a malformed
 * request, and the provider rejects the entire call over it.
 *
 * Extraction is not queued *for* a media message, which is what hides this:
 * reaching it takes a voice note and then a text message, at which point the
 * text queues an extraction whose transcript still contains the silent row.
 */
describe('G. a message with no text still says something to the model', () => {
  test('a voice note is named rather than sent as an empty turn', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    assert.equal(transcriptContent('', 'audio'), '[voice note — not transcribed]');
  });

  test('every kind the ingest admits has a word', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    for (const kind of ['audio', 'image', 'video', 'document', 'sticker', 'location'] as const) {
      const line = transcriptContent('', kind);
      assert.ok(line, `${kind} produced nothing`);
      assert.notEqual(line?.trim(), '', `${kind} produced blank content`);
    }
  });

  test('a text message is untouched — no placeholder, no reformatting', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    assert.equal(
      transcriptContent('Mujhe app development service chahiye', null),
      'Mujhe app development service chahiye',
    );
  });

  test('text wins over the kind — a captioned photo sends the caption', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    assert.equal(transcriptContent('here is the logo', 'image'), 'here is the logo');
  });

  test('an empty row with nothing to explain it contributes nothing', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    // Forbidden by the body check constraint, so this is the belt to its
    // braces: it drops out of the transcript rather than costing the call.
    assert.equal(transcriptContent('', null), null);
    assert.equal(transcriptContent('   ', null), null);
    assert.equal(transcriptContent(null, null), null);
  });

  test('no transcript line is ever empty — which is the whole point', async () => {
    const { transcriptContent } = await import('../src/modules/crm/types.ts');
    const rows: Array<[string | null, 'audio' | 'image' | null]> = [
      ['hello', null],
      ['', 'audio'],
      ['   ', 'image'],
      ['', null],
    ];
    for (const [body, kind] of rows) {
      const line = transcriptContent(body, kind);
      if (line !== null) assert.notEqual(line.trim(), '');
    }
  });
});

/**
 * The turn-for-turn mapping is gone. It claimed the transcript was a dialogue
 * the model took part in, and the API then applied a dialogue's rules to a
 * sales thread: a conversation ending on a staff message ends on an
 * `assistant` turn, which is a prefill — *"the conversation must end with a
 * user message"*. Production hit exactly that, on a thread whose last line was
 * "Staff: nothing".
 */
describe('G. the transcript goes over as a document, not as a dialogue', () => {
  test('who spoke is stated rather than implied by a role', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    const doc = transcriptForModel([
      { author_type: 'client', body: 'we need a booking site', metadata: {} },
      { author_type: 'user', body: 'what is the scope?', metadata: {} },
      { author_type: 'agent', body: 'follow-up sent', metadata: {} },
      { author_type: 'system', body: 'conversation opened', metadata: {} },
    ]);

    assert.equal(
      doc,
      [
        'Client: we need a booking site',
        'Staff: what is the scope?',
        'Agent: follow-up sent',
        'System: conversation opened',
      ].join('\n'),
    );
  });

  test('a conversation ending on staff is no longer a prefill', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    // The exact shape production failed on. As a document it is unremarkable.
    const doc = transcriptForModel([
      { author_type: 'client', body: 'Mujhe app development service chahiye', metadata: {} },
      { author_type: 'user', body: 'nothing', metadata: {} },
    ]);
    assert.match(doc, /^Client: /);
    assert.match(doc, /Staff: nothing$/);
  });

  test('a voice note keeps its place in the order', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    const doc = transcriptForModel([
      { author_type: 'client', body: 'hello', metadata: {} },
      { author_type: 'client', body: '', metadata: { media_type: 'audio' } },
      { author_type: 'user', body: 'got it', metadata: {} },
    ]);
    assert.equal(doc.split('\n')[1], 'Client: [voice note — not transcribed]');
  });

  test('an unreadable row drops out without leaving a blank line', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    const doc = transcriptForModel([
      { author_type: 'client', body: 'first', metadata: {} },
      { author_type: 'client', body: '   ', metadata: {} },
      { author_type: 'client', body: 'second', metadata: {} },
    ]);
    assert.equal(doc, 'Client: first\nClient: second');
    assert.doesNotMatch(doc, /\n\s*\n/);
  });

  test('an unrecognised author is labelled by its own name, not guessed at', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    assert.equal(
      transcriptForModel([{ author_type: 'auditor', body: 'noted', metadata: {} }]),
      'auditor: noted',
    );
  });

  test('no rows means no document, which the route refuses before calling out', async () => {
    const { transcriptForModel } = await import('../src/modules/crm/types.ts');
    assert.equal(transcriptForModel([]), '');
  });
});

describe('G. the route sends that document, and counts rows separately', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../app/api/jobs/run/route.ts', import.meta.url)),
    'utf8',
  );

  test('it reads metadata, without which the media kind is invisible', () => {
    assert.match(source, /select\('seq, author_type, body, metadata'\)/);
  });

  test('the model gets one user turn, built by the rule', () => {
    assert.match(source, /const document = transcriptForModel\(rows\)/);
    assert.match(source, /const transcript: AiMessage\[\] = \[\{ role: 'user', content: document \}\]/);
  });

  test('the old dialogue mapping is gone — that shape was the prefill bug', () => {
    assert.doesNotMatch(source, /author_type === 'client' \? 'user' : 'assistant'/);
    assert.doesNotMatch(source, /content: m\.body\b/);
  });

  test('the count is rows read, not lines sent — the dedupe key depends on it', () => {
    // `transcript.length` is now 1. Keying source_message_count on it would
    // silently collapse every transcript state onto one.
    assert.match(source, /const messageCount = rows\.length/);
    assert.doesNotMatch(source, /transcript\.length/);
    assert.match(source, /\.eq\('source_message_count', messageCount\)/);
    assert.match(source, /p_source_message_count: messageCount/);
  });

  test('an empty document is refused rather than sent as an empty request', () => {
    assert.match(source, /if \(document === ''\)/);
    assert.match(source, /nothing readable to extract from/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. A failure is not an answer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * From the owner's screen: three requirement versions for one conversation,
 * v1 v2 v3, every one **Failed**, under a button offering to queue the
 * extraction again — and queueing it again could never have run anything.
 *
 * The route asks whether this transcript has already been extracted, keyed on
 * (organization, conversation, message count). It selected `status` and never
 * read it, so a row recording that extraction FAILED answered "already
 * extracted": the job was marked `succeeded` and no model was called. Marked
 * `succeeded` rather than `dead` also shut the one escape hatch, since
 * `core.requeue_job` accepts only a dead job.
 *
 * The sibling check — keyed on source_job_id — reads the same column and
 * handles `failed` distinctly. That asymmetry is what makes this an oversight
 * rather than a decision.
 *
 * The index half of this is proved against real Postgres in
 * `scripts/verify-extraction-retry.mjs`, because whether `status <> 'failed'`
 * excludes a row is a claim about SQL rather than about JavaScript.
 */
describe('H. a failed version does not answer "already extracted"', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../app/api/jobs/run/route.ts', import.meta.url)),
    'utf8',
  );

  const transcriptCheck = source.slice(
    source.indexOf('const { data: sameTranscript }'),
    source.indexOf('if (sameTranscript)'),
  );

  test('the transcript-state check excludes failed versions', () => {
    assert.notEqual(transcriptCheck, '', 'the transcript-state check moved');
    assert.match(transcriptCheck, /\.neq\('status', 'failed'\)/);
  });

  test('it is still scoped by organization and by transcript length', () => {
    // The exclusion must not have been bolted on in place of the scoping the
    // audit added in 20260811120001.
    assert.match(transcriptCheck, /\.eq\('organization_id', job\.organization_id\)/);
    assert.match(transcriptCheck, /\.eq\('source_message_count', messageCount\)/);
  });

  test('and so does the sibling check — the asymmetry ran the other way', () => {
    // When this was written the source_job_id check DID read status, and that
    // read was cited as evidence the transcript check merely forgot to. It was
    // the wrong lesson: what the sibling did with `failed` was refuse the
    // retry forever, which made Requeue a no-op. Both now exclude it.
    assert.match(source, /\.eq\('source_job_id', job\.id\)[\s\S]{0,2200}?\.neq\('status', 'failed'\)/);
    assert.doesNotMatch(source, /const failed = alreadyProduced\.status === 'failed'/);
  });

  test('the index excludes failures too — correcting the read alone moves the wedge', () => {
    // Without the migration, a retry that finally succeeded would collide with
    // the failed row still occupying the slot: a silent skip becomes a 23505.
    const migration = readFileSync(
      fileURLToPath(
        new URL('../supabase/migrations/20260821130000_a_failure_is_not_an_answer.sql', import.meta.url),
      ),
      'utf8',
    );
    assert.match(migration, /where source_message_count is not null and status <> 'failed'/);
    assert.match(migration, /create unique index if not exists requirement_versions_transcript_state_key/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. A succeeded job does not carry the reason it once died
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The first extraction ever to succeed on production settled `succeeded` with
 * `last_error` still reading *"Anthropic returned 400: This model does not
 * support assistant message prefill"* — the reason its previous life ended.
 *
 * `core.requeue_job` keeps the error on purpose: it is the only record of why
 * the work stopped, and the operator read it before deciding to revive the
 * job. That holds right up until the work succeeds. After that the queue shows
 * a contradiction, and an operator scanning `core.jobs` has to know the
 * history of one row to read its status correctly.
 *
 * `settleUnlockJob` already cleared it. The four extraction paths did not, and
 * one of them left the lock fields set as well — the same concept in four
 * spellings, which is how three of them came to be wrong together.
 */
describe('I. settling succeeded is one shape, not four', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../app/api/jobs/run/route.ts', import.meta.url)),
    'utf8',
  );

  test('the shape clears the error and the lock', () => {
    const at = source.indexOf('const settledSucceeded = {');
    assert.ok(at > 0, 'the shared shape is gone');
    const shape = source.slice(at, source.indexOf('} as const;', at));

    assert.match(shape, /status: 'succeeded'/);
    assert.match(shape, /last_error: null/);
    assert.match(shape, /locked_at: null/);
    assert.match(shape, /locked_by: null/);
  });

  test('every extraction path settles through it', () => {
    // Four: already-produced, transcript-already-extracted, the allocation
    // race, and the real success.
    const uses = [...source.matchAll(/\.update\(settledSucceeded\)/g)].length;
    assert.equal(uses, 4, `expected four settle sites, found ${uses}`);
  });

  test('and none of them spells it out by hand any more', () => {
    // The literal that three of the four carried. Its absence is the fix.
    assert.doesNotMatch(source, /update\(\{ status: 'succeeded' \}\)/);
    assert.doesNotMatch(source, /\.update\(\{ status: 'succeeded', locked_at: null, locked_by: null \}\)/);
  });

  test('the handler that always got it right is unchanged', () => {
    // settleUnlockJob cleared last_error before this change and still does.
    // It is the precedent, not a casualty of following it.
    const at = source.indexOf('async function settleUnlockJob');
    const body = source.slice(at, at + 900);
    assert.match(body, /last_error: null/);
  });

  test('requeue still keeps the error, which is the half that must not change', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../supabase/migrations/20260813120012_requeue_a_dead_job.sql', import.meta.url)),
      'utf8',
    );
    // Clearing on success must not be mistaken for clearing on revival.
    assert.match(migration, /last_error` is deliberately left where it is|last_error is kept/);
    assert.doesNotMatch(migration, /set[\s\S]{0,200}last_error\s*=\s*null/);
  });
});
