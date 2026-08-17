import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { configStatus } from '../src/lib/admin/config-status.ts';

/**
 * The config-status module is what the Settings page renders. Its whole reason
 * to exist is to report PRESENCE without ever carrying a value — so the tests
 * that matter are (1) it reflects presence correctly and (2) it never leaks a
 * value, even into the problem strings.
 */

const base = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://real-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-long-enough-to-pass-000',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-long-enough-000',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  CRON_SECRET: 'cron-secret-16plus-chars',
} satisfies Record<string, string>;

describe('configStatus', () => {
  test('reports presence per variable, never a value', () => {
    const secret = 'THE-ACTUAL-SERVICE-ROLE-SECRET-VALUE';
    const status = configStatus({ ...base, SUPABASE_SERVICE_ROLE_KEY: secret });

    const item = status.items.find((i) => i.key === 'SUPABASE_SERVICE_ROLE_KEY');
    assert.equal(item?.present, true, 'a set secret reads as present');
    assert.equal(item?.secret, true, 'and is marked secret');

    // The value must appear nowhere in the serialized status — not in an item,
    // not in a problem string, not anywhere.
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes(secret), 'the secret value never appears in the payload');
  });

  test('an unset required variable reads as not present', () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omit, ...withoutKey } = base;
    const status = configStatus(withoutKey);
    const item = status.items.find((i) => i.key === 'SUPABASE_SERVICE_ROLE_KEY');
    assert.equal(item?.present, false);
    assert.equal(item?.requiredInProduction, true);
  });

  test('an empty string is not present', () => {
    const status = configStatus({ ...base, ALERT_WEBHOOK_URL: '   ' });
    assert.equal(status.items.find((i) => i.key === 'ALERT_WEBHOOK_URL')?.present, false);
  });

  test('production problems come from the same rules the app boots with', () => {
    // A complete, safe production env → no problems.
    assert.deepEqual(configStatus(base).productionProblems, []);

    // A localhost app URL is unsafe for production and is named as a problem.
    const local = configStatus({ ...base, NEXT_PUBLIC_APP_URL: 'http://localhost:3000' });
    assert.ok(
      local.productionProblems.some((p) => p.variable === 'NEXT_PUBLIC_APP_URL'),
      'a localhost app URL is flagged',
    );
    assert.equal(local.looksLocal, true);

    // A missing CRON_SECRET is refused in production.
    const { CRON_SECRET: _drop, ...noCron } = base;
    assert.ok(configStatus(noCron).productionProblems.some((p) => p.variable === 'CRON_SECRET'));
  });

  test('every item belongs to a known area', () => {
    const areas = new Set(['Database', 'Application', 'Scheduler', 'WhatsApp', 'AI provider', 'Alerts']);
    for (const item of configStatus(base).items) assert.ok(areas.has(item.area), `${item.key} has a known area`);
  });
});
