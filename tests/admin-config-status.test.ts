import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  test('every item belongs to an area the page renders', () => {
    // Derived rather than restated. This list used to be a third copy of the
    // areas — beside the module's and the page's — so adding one meant
    // remembering three places, and forgetting the third failed a test that
    // was itself the stale copy.
    const page = readFileSync(
      fileURLToPath(new URL('../app/(internal)/settings/page.tsx', import.meta.url)),
      'utf8',
    );
    for (const item of configStatus(base).items) {
      assert.ok(page.includes(`'${item.area}'`), `${item.key} is in an area the page never renders`);
    }
  });
});

/**
 * The two lists that must agree — the second time this shape has been found.
 *
 * `serverSchema` declares what a variable is; `configStatus` decides whether
 * the owner is told about it. Adding `OPENAI_API_KEY` to the schema and
 * forgetting this list gave a Configuration page that reported every key
 * except the one somebody had just been asked to set — and nothing failed,
 * because a page cannot know what it was not told to show.
 *
 * The first instance was `serverEnv()`'s literal reads, pinned in
 * `tests/what-the-client-sent-is-read.test.ts`. This is the same defect one
 * layer up.
 */
describe('every server variable the schema declares is reported to the owner', () => {
  test('the schema and the Configuration page name the same set', () => {
    const schema = readFileSync(
      fileURLToPath(new URL('../src/lib/env-schema.ts', import.meta.url)),
      'utf8',
    );
    const status = readFileSync(
      fileURLToPath(new URL('../src/lib/admin/config-status.ts', import.meta.url)),
      'utf8',
    );

    const block = schema.slice(schema.indexOf('export const serverSchema'));
    const declared = [
      ...block.slice(0, block.indexOf('\n});')).matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm),
    ].map((m) => m[1]!);

    const listed = new Set(
      [...status.matchAll(/\{ key: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]!),
    );

    assert.ok(declared.length >= 10, `expected the server variables, found ${declared.length}`);
    // NODE_ENV is the runtime's, not a deployment's to set.
    const missing = declared.filter((name) => name !== 'NODE_ENV' && !listed.has(name));
    assert.deepEqual(missing, [], `declared but never reported: ${missing.join(', ')}`);
  });

  test('and every area a key claims is one the page renders', () => {
    const status = readFileSync(
      fileURLToPath(new URL('../src/lib/admin/config-status.ts', import.meta.url)),
      'utf8',
    );
    const page = readFileSync(
      fileURLToPath(new URL('../app/(internal)/settings/page.tsx', import.meta.url)),
      'utf8',
    );
    const areas = new Set([...status.matchAll(/area: '([^']+)'/g)].map((m) => m[1]!));
    assert.ok(areas.size >= 5);
    for (const area of areas) {
      // A key in an area the page does not list is a key nobody sees.
      assert.ok(page.includes(`'${area}'`), `the settings page never renders the ${area} area`);
    }
  });
});
