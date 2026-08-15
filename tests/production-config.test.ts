import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { productionConfigProblems, type ServerEnv } from '../src/lib/env-schema.ts';

/**
 * The production boot check (queue #4 of the runway sweep).
 *
 * src/instrumentation.ts calls serverEnv() at startup, which runs these rules;
 * a violated one refuses the server rather than letting it boot and 503 its
 * cron heartbeat or 500 per request. Every rule is exercised both ways — a
 * check that never fails is not a check — and the "never invents a value"
 * property is asserted structurally: the function only ever REPORTS.
 */

const base: ServerEnv = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-long-enough-to-pass-x',
  NODE_ENV: 'production',
  CRON_SECRET: 'a-cron-secret-16-or-more',
  ANTHROPIC_API_KEY: undefined,
  WHATSAPP_VERIFY_TOKEN: undefined,
  WHATSAPP_APP_SECRET: undefined,
  ALERT_WEBHOOK_URL: undefined,
  WHATSAPP_ACCESS_TOKEN: undefined,
  WHATSAPP_GRAPH_BASE_URL: undefined,
  ANTHROPIC_BASE_URL: undefined,
};
const HTTPS = 'https://app.agencyos.example';

const has = (probs: { variable: string }[], v: string) => probs.some((p) => p.variable === v);

describe('production config — the boot check', () => {
  test('a complete, safe production environment has no problems', () => {
    assert.deepEqual(productionConfigProblems(base, HTTPS), []);
  });

  test('outside production, nothing is required', () => {
    const dev = { ...base, NODE_ENV: 'development' as const, CRON_SECRET: undefined };
    assert.deepEqual(productionConfigProblems(dev, 'http://localhost:3000'), []);
  });

  test('CRON_SECRET is required in production', () => {
    const problems = productionConfigProblems({ ...base, CRON_SECRET: undefined }, HTTPS);
    assert.ok(has(problems, 'CRON_SECRET'));
  });

  test('the webhook pair must be set together — verify without secret fails', () => {
    const problems = productionConfigProblems({ ...base, WHATSAPP_VERIFY_TOKEN: 'verify-token-16-plus' }, HTTPS);
    assert.ok(has(problems, 'WHATSAPP_APP_SECRET'));
  });

  test('the webhook pair must be set together — secret without verify fails', () => {
    const problems = productionConfigProblems({ ...base, WHATSAPP_APP_SECRET: 'app-secret-16-plus-x' }, HTTPS);
    assert.ok(has(problems, 'WHATSAPP_VERIFY_TOKEN'));
  });

  test('both halves of the webhook pair set is fine', () => {
    const both = { ...base, WHATSAPP_VERIFY_TOKEN: 'verify-token-16-plus', WHATSAPP_APP_SECRET: 'app-secret-16-plus-x' };
    assert.deepEqual(productionConfigProblems(both, HTTPS), []);
  });

  test('a test base-URL override is refused in production', () => {
    assert.ok(has(productionConfigProblems({ ...base, ANTHROPIC_BASE_URL: 'http://127.0.0.1:54399' }, HTTPS), 'ANTHROPIC_BASE_URL'));
    assert.ok(has(productionConfigProblems({ ...base, WHATSAPP_GRAPH_BASE_URL: 'http://127.0.0.1:54398' }, HTTPS), 'WHATSAPP_GRAPH_BASE_URL'));
  });

  test('the app URL must be https and not a loopback/any address in production', () => {
    for (const bad of [
      'http://app.agencyos.example',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://0.0.0.0:3000',
      'https://[::1]:3000',
      'https://[::1]',
      'https://LOCALHOST',
    ]) {
      assert.ok(has(productionConfigProblems(base, bad), 'NEXT_PUBLIC_APP_URL'), `expected ${bad} to be rejected`);
    }
    // A real host that merely contains "localhost" as a substring is fine.
    assert.deepEqual(productionConfigProblems(base, 'https://localhost.agencyos.example'), []);
    assert.deepEqual(productionConfigProblems(base, HTTPS), []);
  });

  test('it never invents a value — it only reports variable + problem strings', () => {
    const problems = productionConfigProblems({ ...base, CRON_SECRET: undefined }, 'http://localhost');
    for (const p of problems) {
      assert.equal(typeof p.variable, 'string');
      assert.equal(typeof p.problem, 'string');
      assert.deepEqual(Object.keys(p).sort(), ['problem', 'variable']);
    }
  });
});
