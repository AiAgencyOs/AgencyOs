import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

// ai.agents is the global agent registry (no organization_id). Its write policy
// was `for all to authenticated using core.is_owner()` — true for the owner of
// ANY organization — so on a multi-tenant deployment one tenant's owner could
// PATCH/DELETE a registry row every other tenant depends on (20260815380000).
// The mirror class — a permissive end-user write policy with no tenant predicate
// on a shared table — is made self-detecting by core.audit_untenanted_write_policies
// (20260815390000), which scripts/verify-untenanted-writes.mjs asserts is empty.
//
// This pins both: the end-user write policy is dropped, and the class audit +
// its CI check exist — so a future migration cannot silently reopen the write,
// nor a future policy reintroduce the shape while service-role scripts stay green.

const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const allSql = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => sqlCode(readFileSync(dir + f, 'utf8')))
  .join('\n');

describe('the global agent registry is not writable by a tenant owner', () => {
  test('the end-user write policy on ai.agents is dropped', () => {
    assert.match(
      allSql,
      /drop policy if exists agents_write on ai\.agents/i,
      'ai.agents must have its role-only end-user write policy dropped — is_owner() is true for any tenant',
    );
  });

  test('the untenanted-write-policy audit function exists', () => {
    assert.match(
      allSql,
      /create or replace function core\.audit_untenanted_write_policies\(\)/i,
      'the self-detecting audit for the untenanted end-user write policy class must be defined',
    );
  });

  test('the audit is granted to the service role and revoked from public', () => {
    assert.match(allSql, /revoke all on function core\.audit_untenanted_write_policies\(\) from public/i);
    assert.match(allSql, /grant execute on function core\.audit_untenanted_write_policies\(\) to service_role/i);
  });

  test('CI runs the untenanted-writes check', () => {
    const wf = readFileSync(fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url)), 'utf8');
    assert.match(wf, /db:verify:untenanted/, 'the untenanted-writes check must run in CI, or the class is not watched');
  });
});
