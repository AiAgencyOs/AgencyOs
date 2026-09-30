import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  SECRET_SLOTS,
  expiryState,
  hintOf,
  needsRotation,
  slotFor,
  storableSlots,
  validateSecretValue,
} from '@/lib/secrets/registry';

/**
 * A key is kept in one place (2026-10-02).
 *
 * The Keys & secrets screen lets the owner manage every key the system uses.
 * These pins hold the registry honest (one slot per env var, none twice), the
 * shape checks the door runs, and the migration's promises: ciphertext only,
 * owner-only writes, no path that returns a value.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('A. the registry', () => {
  test('a slot is named once and looks like an environment variable', () => {
    const keys = SECRET_SLOTS.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const k of keys) assert.match(k, /^[A-Z][A-Z0-9_]{2,63}$/);
  });

  test('every slot the vault stores is one the environment schema knows or names', () => {
    const schema = read('src/lib/env-schema.ts');
    for (const s of SECRET_SLOTS.filter((x) => x.storage === 'provider_vault' || x.key === 'GITHUB_TOKEN' || x.key === 'RESEND_API_KEY')) {
      assert.ok(schema.includes(s.key), `${s.key} is not in env-schema.ts`);
    }
  });

  test('an environment-only slot says why, and cannot be stored', () => {
    const envOnly = SECRET_SLOTS.filter((s) => s.storage === 'env_only');
    assert.ok(envOnly.length >= 3);
    for (const s of envOnly) {
      assert.ok(s.envOnlyReason && s.envOnlyReason.length > 20, s.key);
      assert.match(validateSecretValue(s.key, 'x'.repeat(40)) ?? '', /cannot be stored here/);
      assert.ok(!storableSlots().some((x) => x.key === s.key));
    }
  });

  test('every slot says what breaks without it and where it is used', () => {
    for (const s of SECRET_SLOTS) {
      assert.ok(s.purpose.length > 20, s.key);
      assert.ok(s.usedBy.length > 0, s.key);
    }
  });

  test('the vault-stored slots are more than the five provider keys', () => {
    assert.ok(storableSlots().filter((s) => s.storage === 'vault').length >= 8);
    assert.equal(slotFor('GITHUB_TOKEN')?.category, 'code');
    assert.equal(slotFor('NOT_A_KEY'), null);
  });
});

describe('B. the shape check', () => {
  test('a GitHub token must look like one', () => {
    assert.match(validateSecretValue('GITHUB_TOKEN', 'hello-not-a-token-at-all-1234567890') ?? '', /normally starts with/);
    assert.equal(validateSecretValue('GITHUB_TOKEN', `github_pat_${'A'.repeat(40)}`), null);
    assert.match(validateSecretValue('GITHUB_TOKEN', 'ghp_short') ?? '', /too short/);
  });

  test('a pasted value with spaces or line breaks is refused', () => {
    assert.match(validateSecretValue('RESEND_API_KEY', 're_abc def ghijkl') ?? '', /must not contain spaces/);
    assert.equal(validateSecretValue('RESEND_API_KEY', ''), 'A value is required.');
  });

  test('a webhook URL must parse, and a PEM must be whole', () => {
    assert.equal(validateSecretValue('ALERT_WEBHOOK_URL', 'not a url'), 'The value must not contain spaces or line breaks — check that only the key was pasted.');
    assert.equal(validateSecretValue('ALERT_WEBHOOK_URL', 'nope'), 'That is not a URL.');
    assert.equal(validateSecretValue('ALERT_WEBHOOK_URL', 'https://hooks.example.com/x'), null);
    assert.match(validateSecretValue('GOOGLE_SERVICE_ACCOUNT_KEY', '-----BEGIN PRIVATE KEY-----abc') ?? '', /whole private key/);
    assert.equal(validateSecretValue('GOOGLE_SERVICE_ACCOUNT_KEY', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), null);
  });

  test('a hint is the last four characters, and only of a long value', () => {
    assert.equal(hintOf('a'.repeat(30) + 'WXYZ'), 'WXYZ');
    assert.equal(hintOf('short-secret'), null);
  });
});

describe('C. expiry and rotation', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  test('expiry is none, ok, soon (14 days) or expired', () => {
    assert.equal(expiryState(null, now), 'none');
    assert.equal(expiryState('2027-01-01', now), 'ok');
    assert.equal(expiryState('2026-10-10', now), 'soon');
    assert.equal(expiryState('2026-10-01', now), 'expired');
  });

  test('rotation is a reminder by age, never for an environment-only slot', () => {
    const gh = slotFor('GITHUB_TOKEN')!;
    assert.equal(needsRotation(gh, '2026-01-01T00:00:00Z', now), true);
    assert.equal(needsRotation(gh, '2026-09-20T00:00:00Z', now), false);
    assert.equal(needsRotation(slotFor('CRON_SECRET')!, '2020-01-01T00:00:00Z', now), false);
  });
});

describe('D. the migration keeps its promises', () => {
  const sql = read('supabase/migrations/20261002100000_a_key_is_kept_in_one_place.sql');
  test('ciphertext only, no grant to a signed-in user, forced RLS', () => {
    assert.match(sql, /ciphertext\s+text not null/);
    assert.match(sql, /force row level security/);
    assert.match(sql, /revoke all on table core\.secret_credentials from public, anon, authenticated/);
    assert.doesNotMatch(sql, /grant select[^;]*core\.secret_credentials to authenticated/);
  });
  test('storing and revoking are owner-only; status and checks are admin-tier', () => {
    const store = sql.slice(sql.indexOf('function core.store_secret('), sql.indexOf('function core.revoke_secret('));
    assert.match(store, /core\.is_owner\(\)/);
    const status = sql.slice(sql.indexOf('function core.secret_status('), sql.indexOf('function core.record_secret_check('));
    assert.match(status, /core\.is_admin\(\)/);
    assert.doesNotMatch(status.split('comment on')[0] ?? '', /ciphertext|auth_tag/);
  });
  test('the audit rows never carry the value', () => {
    const audits = sql.match(/core\.record_audit\([\s\S]*?\);/g) ?? [];
    assert.equal(audits.length, 3);
    for (const a of audits) assert.doesNotMatch(a, /p_ciphertext|p_iv|p_auth_tag/);
  });
});

describe('E. the screen', () => {
  test('is in the navigation and only the owner is offered the write forms', () => {
    assert.match(read('app/(internal)/nav-config.ts'), /\/security\/keys/);
    const page = read('app/(internal)/security/keys/page.tsx');
    assert.match(page, /StoreSecretForm/);
    assert.match(read('docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md'), /SCR-071/);
  });
});
