import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { runnerAuthHeaders, runnerUrl } from '../src/lib/jobs/runner-address.ts';

/**
 * The agent answers without waiting for a clock — G-209.
 *
 * ── the finding, and what it is NOT ───────────────────────────────────────
 *
 * There is no artificial delay in this codebase. Grepping for one finds
 * nothing, and that is the point: the latency comes from somewhere less
 * obvious. **Nothing runs when a message arrives.** The webhook ingests,
 * writes a `reply.due` event and returns; the agent wakes only when the
 * external cron POSTs `/api/jobs/run` at `rate(1 minute)`.
 *
 * One tick dispatches the event AND drains the job it creates — worth
 * checking, because it makes the wait one tick rather than two — but a client
 * still sits in silence for 0–60 seconds before the agent starts thinking.
 *
 * ── and why the fix cannot make anything worse ────────────────────────────
 *
 * Every failure of the nudge leaves the work exactly where it already was:
 * queued for the next scheduled tick, which is what happens on every message
 * today. That property is what makes best-effort the right posture here
 * rather than a shrug, and section C is where it is pinned.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WEBHOOK = codeOnly(read('app/api/webhooks/whatsapp/route.ts'));
const NUDGE = codeOnly(read('src/lib/jobs/nudge.ts'));
/**
 * The raw file with its comment wrapping flattened, for the assertions that
 * are ABOUT the reasoning in it.
 *
 * Flattened because a docblock wraps: matching a sentence that happens to
 * span two lines fails on the newline and the ` * ` gutter, which says
 * nothing about whether the sentence is there.
 */
const NUDGE_PROSE = read('src/lib/jobs/nudge.ts').replace(/\s*\n\s*\*\s*/g, ' ');

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe('A. where the nudge goes, and with what', () => {
  test('the app’s own origin, at the runner’s path', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://agencyos.example';
    assert.equal(runnerUrl(), 'https://agencyos.example/api/jobs/run');
  });

  test('a trailing slash does not become a double one', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://agencyos.example/';
    assert.equal(runnerUrl(), 'https://agencyos.example/api/jobs/run');
  });

  test('VERCEL_URL is the fallback, and it carries no scheme of its own', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = 'agencyos-preview.vercel.app';
    assert.equal(runnerUrl(), 'https://agencyos-preview.vercel.app/api/jobs/run');
  });

  test('and with neither, there is no address to ring', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    assert.equal(runnerUrl(), null);
  });
});

describe('B. the two doors the runner has', () => {
  test('the app’s own auth is required', () => {
    delete process.env.CRON_SECRET;
    assert.equal(runnerAuthHeaders(), null);
  });

  test('sent exactly as the external cron sends it', () => {
    process.env.CRON_SECRET = 's3cret';
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    assert.deepEqual(runnerAuthHeaders(), { authorization: 'Bearer s3cret' });
  });

  test('and the edge bypass only when there is one', () => {
    // An empty header is a header that means nothing; a deployment without
    // preview protection does not need it.
    process.env.CRON_SECRET = 's3cret';
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypass';
    assert.deepEqual(runnerAuthHeaders(), {
      authorization: 'Bearer s3cret',
      'x-vercel-protection-bypass': 'bypass',
    });
  });

  test('the secret never appears in a URL', () => {
    // A query string is logged by every proxy between here and there.
    process.env.NEXT_PUBLIC_APP_URL = 'https://agencyos.example';
    process.env.CRON_SECRET = 's3cret';
    assert.ok(!runnerUrl()!.includes('s3cret'));
  });
});

describe('C. it can only remove waiting, never add it', () => {
  test('the response is sent BEFORE the nudge is rung', () => {
    // `after()` runs post-response. A webhook that answers slowly is one Meta
    // retries, so this ordering is the load-bearing part of the whole change.
    // Anchored on `after(` immediately preceding the call, so wrapping the
    // nudge in something that runs BEFORE the response would fail this.
    // The nudge now sits behind the organization's own switch, so the pin is
    // on the ORDERING that matters — `after(` opening the block the call ends
    // up in — rather than on the two being adjacent lines.
    assert.match(WEBHOOK, /after\(async \(\) => \{[\s\S]{0,900}?await nudgeRunner\('whatsapp\.inbound'\);[\s\S]{0,40}?\}\);/);
    const nudgeAt = WEBHOOK.indexOf('nudgeRunner');
    const returnAt = WEBHOOK.indexOf('return NextResponse.json({\n    received: messages.length');
    assert.ok(nudgeAt > 0 && returnAt > nudgeAt, 'the nudge must be registered before the return it follows');
  });

  test('and only when a message was actually taken in', () => {
    // A receipt, a replay, or an empty payload creates no work; a doorbell
    // rung for none of it is a tick spent finding an empty queue.
    assert.match(WEBHOOK, /if \(ingested > 0\) \{/);
  });

  test('an unconfigured nudge is skipped rather than attempted', () => {
    assert.match(NUDGE, /if \(!url \|\| !headers\) return 'skipped';/);
  });

  test('every failure is swallowed — the work stays queued either way', () => {
    assert.match(NUDGE, /return 'failed';/);
    assert.doesNotMatch(NUDGE, /throw /);
  });

  test('and it does not wait for the tick it starts', () => {
    // Waiting would tie the webhook's lifetime to the agent's, which is the
    // coupling the cron exists to avoid.
    assert.match(NUDGE, /signal: AbortSignal\.timeout\(1_500\)/);
  });
});

describe('D. the burst question, answered by removing a bound', () => {
  /**
   * A five-second "the runner just ran, ride that tick" window was built and
   * then removed, and the removal is the finding worth keeping.
   *
   * A live run showed the cost: the tick's stages are ordered — dispatch,
   * then the agent drain — so a message arriving after the dispatch stage of
   * a running tick is not picked up by it, and suppressing the nudge hands
   * that client the full minute this change exists to remove. Section T went
   * red on exactly that (`212 → 212 ticks`) before the bound came out.
   *
   * What the bound would have saved is invocations. What it cost, sometimes,
   * was the defect itself.
   */
  test('nothing suppresses a nudge on a timer', () => {
    assert.doesNotMatch(NUDGE, /RECENT_TICK_MS|recentTick|last_tick_at/);
    assert.match(NUDGE_PROSE, /A bound that occasionally restores the exact defect is a bad trade/);
  });

  test('and the webhook rings it with nothing but a reason', () => {
    assert.match(WEBHOOK, /await nudgeRunner\('whatsapp\.inbound'\);/);
  });

  test('the total model work is unchanged, and the file says why', () => {
    // Bounded by what is queued, not by how often the runner is asked to look.
    assert.match(NUDGE_PROSE, /the total model work is unchanged/);
  });
});

describe('E. it is a switch, not a behaviour', () => {
  /**
   * The first version rang the runner unconditionally. It worked, and it broke
   * three verification scripts — which is where the real objection surfaced.
   *
   * Those scripts own the clock deliberately: they assert what ONE tick does
   * to ONE job. Making every deployment's inbound path asynchronous,
   * implicitly, as a side effect of receiving a webhook, is a large change to
   * smuggle in under a latency fix. As a setting it is an operator control,
   * it ships inert, and the scripts that own tick timing keep owning it.
   */
  test('the webhook asks the organization before ringing', () => {
    assert.match(WEBHOOK, /\.eq\('wake_runner_on_inbound', true\)/);
  });

  test('and a failed read leaves it OFF', () => {
    // Defaulting a capability ON because a query failed is how a system
    // acquires behaviour nobody chose.
    assert.match(WEBHOOK, /scope: 'wakeRunnerOnInbound'/);
    assert.match(WEBHOOK, /if \(error\) \{[\s\S]{0,220}?return;/);
    assert.match(WEBHOOK, /if \(!data\) return;/);
  });

  test('the switch is owner-only in the database, not just the service', () => {
    const migration = read('supabase/migrations/20260905130000_the_agent_answers_without_waiting_for_a_clock.sql');
    assert.match(migration, /if v_actor is not null and not \(select core\.is_owner\(\)\) then/);
  });

  test('and both directions are audited', () => {
    // "Who turned it on" is the first question anybody asks about a latency
    // or invocation-volume change.
    const migration = read('supabase/migrations/20260905130000_the_agent_answers_without_waiting_for_a_clock.sql');
    assert.match(migration, /runner\.wake_on_inbound_enabled/);
    assert.match(migration, /runner\.wake_on_inbound_disabled/);
  });

  test('off by default — an agency that never touches it has today’s behaviour', () => {
    const migration = read('supabase/migrations/20260905130000_the_agent_answers_without_waiting_for_a_clock.sql');
    assert.match(migration, /add column if not exists wake_runner_on_inbound boolean not null default false/);
  });
});

describe('F. the clock is still there', () => {
  test('nothing in this change removes or reschedules the cron', () => {
    // The nudge is an addition. The scheduled tick remains the thing that
    // catches everything a nudge missed, and every job kind no webhook emits.
    const cron = read('docs/deployment/cron-external-trigger.md');
    assert.match(cron, /every minute/);
  });
});
