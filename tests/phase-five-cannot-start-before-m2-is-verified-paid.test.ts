import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 4 Finance spec, "PHASE 5 GATE": only an Admin-verified M2 payment opens Phase 5, enforced on
 * the server. This is the text-level guard; the behavioural proof is scripts/verify-phase-five-gate.sql
 * (run against a real Postgres, red-proven by mangling the live function).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const migration = read('supabase/migrations/20261031100001_phase_five_cannot_start_before_m2_is_verified_paid.sql');

describe('the Phase 5 start gate', () => {
  test('start_task refuses a development task unless projects.m2_verified_paid', () => {
    assert.match(migration, /module_id is not null or v_task\.feature_id is not null/);
    assert.match(migration, /not projects\.m2_verified_paid\(v_task\.project_id\)/);
    assert.match(migration, /'m2_not_verified'/);
  });

  test('the gate is checked before the ordinary requirement and dependency checks', () => {
    assert.ok(migration.indexOf("'m2_not_verified'") < migration.indexOf('task_start_check'));
  });

  test('the panel reader delegates to the same gate instead of trusting status = paid', () => {
    assert.match(migration, /when projects\.m2_verified_paid\(p_project_id\) then 'verified'/);
    assert.doesNotMatch(migration, /when i\.status = 'paid' then 'verified'/);
  });

  test('the service maps the refusal to a conflict that says why', () => {
    assert.match(read('src/modules/projects/task-doors-service.ts'), /case 'm2_not_verified':/);
  });
});
