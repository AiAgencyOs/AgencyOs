import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ROLES } from '../src/lib/auth/claims.ts';
import { can } from '../src/lib/authz/permissions.ts';
import { pmWelcome, type PmLanguage } from '../src/modules/projects/pm-messages.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261011400000_what_a_client_sends_in_confidence_is_kept_encrypted.sql');
const service = read('src/modules/projects/client-secrets-service.ts');
const actions = read('src/modules/projects/client-secrets-actions.ts');

// ADM-106 (owner decision 2026-10-04): an encrypted vault per project. The live proof is
// scripts/verify-client-secrets.mjs; these hold the seams a live run cannot see.

describe('who may touch a client secret', () => {
  test('exactly the owner and the ops admin hold the capability every door in the service asks for', () => {
    assert.match(service, /can\(context, 'audit\.read'\)/);
    assert.equal(can('owner', 'audit.read'), true);
    assert.equal(can('ops_admin', 'audit.read'), true);
    for (const role of ROLES.filter((r) => r !== 'owner' && r !== 'ops_admin')) assert.equal(can(role, 'audit.read'), false, role);
  });

  test('every door in the database re-checks the admin tier itself', () => {
    for (const fn of ['store_client_secret', 'client_secret_list', 'reveal_client_secret', 'revoke_client_secret']) {
      const start = migration.indexOf(`function projects.${fn}(`);
      assert.ok(start > 0, fn);
      const end = migration.indexOf('comment on function', start);
      assert.match(migration.slice(start, end), /core\.is_admin\(\)/, fn);
    }
  });
});

describe('the table', () => {
  test('is closed to every end-user role and holds ciphertext only', () => {
    assert.match(migration, /revoke all on table projects\.client_secrets from public, anon, authenticated/);
    assert.doesNotMatch(migration, /grant[^;]*on table projects\.client_secrets to[^;]*authenticated/);
    assert.match(migration, /force row level security/);
  });

  test('is tenant-guarded like every org-scoped table', () => {
    assert.match(migration, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(migration, /core\.freeze_organization_id\(\)/);
  });

  test('records the view before it returns the ciphertext', () => {
    const start = migration.indexOf('function projects.reveal_client_secret(');
    const end = migration.indexOf('comment on function projects.reveal_client_secret', start);
    const body = migration.slice(start, end);
    assert.ok(body.indexOf("'client_secret.viewed'") > 0);
    assert.ok(body.indexOf("'client_secret.viewed'") < body.indexOf("'revealed'::text, v_row.label"), 'audit comes before the return');
  });
});

describe('the application never keeps or leaks a value', () => {
  test('encryption happens before the database is called, and no log line carries the value', () => {
    assert.ok(service.indexOf('encrypt(value)') < service.indexOf("rpc('store_client_secret'"));
    for (const line of service.split('\n').filter((l) => l.includes('console.error'))) assert.doesNotMatch(line, /value|ciphertext/);
  });

  test('revealing is not cached and not revalidated into a page', () => {
    assert.doesNotMatch(service, /new Map|cache\./);
    const reveal = actions.slice(actions.indexOf('export async function revealClientSecretAction'), actions.indexOf('export async function revokeClientSecretAction'));
    assert.doesNotMatch(reveal, /revalidatePath/);
  });
});

describe('the PM tells the client where secrets do not go', () => {
  test('the welcome says never to send passwords or keys in the chat, in all three languages', () => {
    const patterns: Record<PmLanguage, RegExp> = { en: /never send passwords or keys/, hinglish: /password ya keys is chat me kabhi na bhejein/, hindi: /पासवर्ड या कुंजियाँ/ };
    for (const language of ['en', 'hinglish', 'hindi'] as const) {
      assert.match(pmWelcome({ language, agencyName: 'A', projectName: 'P' }), patterns[language], language);
    }
  });
});
