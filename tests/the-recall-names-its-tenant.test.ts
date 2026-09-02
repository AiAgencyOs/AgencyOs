import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * The recall names its tenant — G-189.
 *
 * ── the defect, measured before it was fixed ──────────────────────────────
 *
 * `ai.recall` is SECURITY INVOKER and filters by scope, never by
 * organization: **RLS is its tenancy**, which is correct for a signed-in
 * caller and the reason it must never become a definer.
 *
 * The two organization-scoped callers are not signed in. `pricingDecisionsFor`
 * (G-180) and `revisionCorrectionsFor` (G-185) run in the job runner with the
 * **service role**, which bypasses RLS — so `recall` handed them every
 * organization's memories, and a `.filter()` in TypeScript kept another
 * agency's decisions out of the prompt.
 *
 * That filter worked. What it could not fix is the LIMIT, applied by the
 * database *before* the caller sees a row:
 *
 *     ten memories belonging to another agency, one belonging to ours
 *     → recall(scope: organization, limit: 8) returns 8
 *     → seven are theirs, one is ours
 *
 * Measured on a real database, not reasoned about. On a deployment with a
 * second agency the feature G-180 exists for — *the owner corrects the same
 * mistake and the next draft knows* — silently degrades to one decision, and
 * with enough tenants to none, while every test stays green because the demo
 * deployment has one organization in it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260902140000_the_recall_names_its_tenant.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

describe('A. the tenant is a parameter, and the limit comes after it', () => {
  test('the filter is in the same statement as the limit', () => {
    assert.match(MIGRATION, /and \(p_organization_id is null or m\.organization_id = p_organization_id\)/);
    const filterAt = MIGRATION.indexOf('p_organization_id is null or');
    const limitAt = MIGRATION.indexOf('limit greatest(1, least(');
    assert.ok(filterAt > 0 && limitAt > filterAt, 'the tenant must be filtered before the limit applies');
  });

  test('null keeps the behaviour it had — RLS decides', () => {
    // Every signed-in caller, and the two lead-scoped ones, rely on exactly
    // that. A parameter that changed their answers would be a different
    // function wearing the same name.
    assert.match(MIGRATION_RAW, /Null keeps the original behaviour exactly/);
  });

  test('and it is still INVOKER, which is what makes RLS the authorization', () => {
    assert.match(MIGRATION, /security invoker/);
    assert.ok(!/security definer/i.test(MIGRATION));
  });

  test('the old signature is dropped rather than overloaded', () => {
    // A fourth parameter with a default makes every three-argument call
    // ambiguous instead of resolving it.
    assert.match(MIGRATION, /drop function if exists ai\.recall\(text, uuid, int\);/);
    assert.match(MIGRATION_RAW, /Every\n-- caller in this repository passes named arguments/);
  });
});

describe('B. the callers that have no RLS name their tenant', () => {
  test('both organization-scoped readers pass it', () => {
    assert.equal((WORKFLOWS.match(/p_organization_id: organizationId,/g) ?? []).length, 2);
  });

  test('and the TypeScript tenant filter is gone, not doubled', () => {
    // A rule held in two places is a rule whose test can pass while either
    // half is broken — and the half nobody can see failing is the one that
    // rots.
    assert.ok(!WORKFLOWS.includes('m.organization_id === organizationId'));
  });

  test('the kind filter stays, because it is about meaning rather than access', () => {
    assert.match(WORKFLOWS, /m\.kind === 'pricing_decision'/);
    assert.match(WORKFLOWS, /m\.kind === 'revision_decision'/);
  });

  test('the lead-scoped callers are left alone', () => {
    // A lead belongs to one organization, so its scope id already names the
    // tenant. Adding a parameter there would be noise.
    assert.equal((WORKFLOWS.match(/p_scope: 'lead',/g) ?? []).length, 2);
  });

  test('the reason is recorded where the call is, not only in the migration', () => {
    assert.match(read('app/api/jobs/run/workflows.ts'), /the LIMIT was spent on other\s+\/\/ organizations' rows and filtered out here/);
  });
});
