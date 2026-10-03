import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import { createChatCompletionsProvider } from '../src/lib/ai/chat-completions.ts';
import { isProviderUnavailable, providerUnavailable } from '../src/lib/ai/failure.ts';
import { runWithFallback, type Candidate } from '../src/lib/ai/fallback.ts';
import { err, ok, type Result } from '../src/lib/result.ts';

// The owner's rules for what happens when the model first chosen cannot serve
// the call (2026-10-03): only an UNAVAILABLE failure moves on; money-bearing
// work stays with the same vendor; a candidate is tried once; every attempt is
// reported. Live-proved separately by pointing a policy at a model that does
// not exist and watching the default serve the call.

const CLAUDE_A: Candidate = { model: 'claude-a', providerId: 'anthropic' };
const GPT: Candidate = { model: 'gpt-x', providerId: 'openai' };
const CLAUDE_B: Candidate = { model: 'claude-b', providerId: 'anthropic' };

const down = (): Result<string> => providerUnavailable('Rate limited by Anthropic.');
const refused = (): Result<string> => err('PROVIDER_ERROR', 'The model declined to process this conversation.');

function scripted(script: Record<string, () => Result<string>>) {
  const calls: string[] = [];
  return {
    calls,
    attempt: async (c: Candidate) => {
      calls.push(c.model);
      const r = script[c.model];
      return r ? r() : ok(`served by ${c.model}`);
    },
  };
}

describe('A. only an unavailable model moves on', () => {
  test('an unavailable first choice falls through to the next, and both attempts are reported', async () => {
    const s = scripted({ 'claude-a': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a', 'gpt-x']);
    assert.equal(out.result.ok, true);
    assert.equal(out.final?.model, 'gpt-x');
    assert.deepEqual(out.attempts.map((a) => [a.model, a.ok, a.fallbackOf]), [
      ['claude-a', false, null],
      ['gpt-x', true, 'claude-a'],
    ]);
    assert.equal(out.exhausted, false);
  });

  test('the positive twin: a first choice that works is the only call made', async () => {
    const s = scripted({});
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a']);
    assert.equal(out.attempts.length, 1);
  });

  test('a refusal or bad output stops here: another model would fail the same way', async () => {
    const s = scripted({ 'claude-a': refused });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a']);
    assert.equal(out.result.ok, false);
    assert.equal(out.exhausted, false);
  });
});

describe('B. money stays with the vendor that failed', () => {
  test('the next candidate is the same vendor, skipping another vendor in between', async () => {
    const s = scripted({ 'claude-a': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT, CLAUDE_B], sameVendorOnly: true, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a', 'claude-b']);
    assert.equal(out.final?.model, 'claude-b');
  });

  test('with no same-vendor candidate it fails normally for the job to retry, and does not alert', async () => {
    const s = scripted({ 'claude-a': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: true, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a']);
    assert.equal(out.result.ok, false);
    assert.equal(out.exhausted, false);
  });

  test('and cross-vendor is allowed when the work is not money-bearing', async () => {
    const s = scripted({ 'claude-a': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: false, attempt: s.attempt });
    assert.equal(out.final?.model, 'gpt-x');
  });
});

describe('C. the chain is bounded and honest', () => {
  test('every candidate unavailable: each tried once, and the owner is told', async () => {
    const s = scripted({ 'claude-a': down, 'gpt-x': down, 'claude-b': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT, CLAUDE_B], sameVendorOnly: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a', 'gpt-x', 'claude-b']);
    assert.equal(out.result.ok, false);
    assert.equal(out.exhausted, true);
  });

  test('a single candidate that is down is not an exhausted chain — there was no chain', async () => {
    const out = await runWithFallback({ candidates: [CLAUDE_A], sameVendorOnly: false, attempt: scripted({ 'claude-a': down }).attempt });
    assert.equal(out.exhausted, false);
  });

  test('a pinned run (tool results already exchanged) never switches model', async () => {
    const s = scripted({ 'claude-a': down });
    const out = await runWithFallback({ candidates: [CLAUDE_A, GPT], sameVendorOnly: false, canSwitch: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a']);
    assert.equal(out.exhausted, false);
  });

  test('a model listed twice is tried once', async () => {
    const s = scripted({ 'claude-a': down, 'gpt-x': down });
    await runWithFallback({ candidates: [CLAUDE_A, GPT, { ...GPT }], sameVendorOnly: false, attempt: s.attempt });
    assert.deepEqual(s.calls, ['claude-a', 'gpt-x']);
  });
});

describe('D. the adapter says which failures are the vendor\'s', () => {
  const provider = createChatCompletionsProvider({
    id: 'openai', name: 'OpenAI', baseUrl: 'http://stub.invalid/v1', apiKey: 'k', supports: () => true, keyPatterns: [],
  });
  const request = { model: 'gpt-x', system: 's', messages: [{ role: 'user' as const, content: 'hi' }], jsonSchema: {}, schemaName: 'X' };

  afterEach(() => mock.restoreAll());

  const answer = (status: number, body: unknown) =>
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));

  test('a rejected key, a missing model, a rate limit and a 5xx are unavailable', async () => {
    for (const status of [401, 403, 404, 429, 503]) {
      answer(status, { error: { message: 'no' } });
      const r = await provider.generateStructured(request);
      assert.equal(r.ok, false, String(status));
      assert.equal(!r.ok && isProviderUnavailable(r.error), true, `${status} should be unavailable`);
      mock.restoreAll();
    }
  });

  test('a 400 (the request is wrong) is NOT unavailable — every vendor would refuse it', async () => {
    answer(400, { error: { message: 'bad field' } });
    const r = await provider.generateStructured(request);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && isProviderUnavailable(r.error), false);
  });

  test('a refusal that arrives as a 200 is NOT unavailable', async () => {
    answer(200, { choices: [{ message: { refusal: 'no' }, finish_reason: 'stop' }] });
    const r = await provider.generateStructured(request);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && isProviderUnavailable(r.error), false);
  });

  test('a connection that cannot be made is unavailable', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
    const r = await provider.generateStructured(request);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && isProviderUnavailable(r.error), true);
  });
});
