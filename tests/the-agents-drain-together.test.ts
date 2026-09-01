import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * The agents drain together — G-174.
 *
 * The runner claimed exactly ONE agent job per invocation, and cron runs once
 * a minute. Ten queued agent jobs took ten minutes; a busy morning queued
 * faster than it drained. Eight enabled agents were not slow at their work —
 * they were standing in a queue for it.
 *
 * MEASURED, not argued. With the batch forced back to 1, six queued jobs
 * yielded `claimed: 1` from one tick. With the batch restored, the same six
 * yielded `claimed: 6` — one tick instead of six minutes.
 *
 * The comment that held the old limit in place was not wrong, it was
 * incomplete: "claiming more would leave rows running that nothing in this
 * tick will settle" is true of an UNBOUNDED loop. This one is bounded twice —
 * by a count, and by a wall-clock budget checked before each claim, which is
 * the bound that actually matters when every job makes a model call.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ROUTE = codeOnly(read('app/api/jobs/run/route.ts'));

describe('A. the batch is bounded twice, and the budget is the real bound', () => {
  test('a count AND a wall-clock budget', () => {
    assert.match(ROUTE, /const AGENT_BATCH = \d+;/);
    assert.match(ROUTE, /const AGENT_BUDGET_MS = [\d_]+;/);
  });

  test('the budget leaves room inside one cron minute', () => {
    const ms = Number(/const AGENT_BUDGET_MS = ([\d_]+);/.exec(ROUTE)?.[1]?.replace(/_/g, ''));
    assert.ok(ms > 0 && ms < 60_000, `the budget must fit inside a cron minute, got ${ms}`);
    const n = Number(/const AGENT_BATCH = (\d+);/.exec(ROUTE)?.[1]);
    assert.ok(n > 1, 'a batch of one is the bug this closes');
  });

  test('the budget is checked BEFORE the claim, never after', () => {
    // A row claimed and then abandoned is `running` with an attempt spent and
    // invisible until the reaper. The check has to gate the claim itself.
    const loop = ROUTE.indexOf('for (let i = 0; i < AGENT_BATCH');
    const guard = ROUTE.indexOf('if (Date.now() - tickStartedAt > AGENT_BUDGET_MS) break;', loop);
    const claim = ROUTE.indexOf("rpc('claim_agent_job'", loop);
    assert.ok(guard > loop && claim > guard, 'the budget must gate the claim');
  });

  test('and it measures from the START of the tick, not the first iteration', () => {
    // Reap, dispatch, unlock and announcement stages have already spent part
    // of the same minute before the agent batch begins.
    assert.match(ROUTE, /const tickStartedAt = Date\.now\(\);/);
    const stamp = ROUTE.indexOf('const tickStartedAt = Date.now();');
    const loop = ROUTE.indexOf('for (let i = 0; i < AGENT_BATCH');
    assert.ok(stamp > 0 && stamp < loop, 'the stamp must precede the batch');
  });
});

describe('B. one job’s failure is not the batch’s', () => {
  test('every branch returns a value instead of answering the request', () => {
    // A batch cannot return early on behalf of the jobs behind it. The old
    // shape had six `return NextResponse.json(...)` exits inside what is now
    // runOneAgentJob.
    const fn = ROUTE.slice(ROUTE.indexOf('async function runOneAgentJob'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.ok(!body.includes('NextResponse'), 'runOneAgentJob must not answer the request');
    for (const reason of ['no workflow', 'agent missing', 'agent disabled', 'agent autonomy']) {
      assert.ok(body.includes(`reason: '${reason}'`), `${reason} must survive as a value`);
    }
  });

  test('a failed claim mid-batch keeps the work already done', () => {
    // Discarding six settled jobs because the seventh claim blipped would
    // throw away work that actually happened.
    assert.match(ROUTE, /if \(agentClaimFailed && agentRuns\.length === 0\)/);
  });

  test('the response reports the count, not a boolean', () => {
    assert.match(ROUTE, /claimed: agentRuns\.length/);
  });
});
