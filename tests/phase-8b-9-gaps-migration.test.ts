import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Text-level guards on the 8B/9 gaps migration. A regex cannot say it RUNS: scripts/verify-phase-eight-b-smoke-and-events.sql does, on a scratch
 * Postgres, and its controls were red-proved by mutating the live definitions. These pin the shape that must stay.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'supabase/migrations');
const file = readdirSync(dir).filter((f) => /^20261122100000_/.test(f));
const sql = readFileSync(join(dir, file[0] ?? 'missing'), 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

describe('8B/9 gaps migration', () => {
  test('exists exactly once, in the reserved range', () => {
    assert.equal(file.length, 1);
  });
  test('the smoke failure table is tenancy-guarded, RLS-on, internal-read-only, with no end-user write', () => {
    assert.match(code, /create table if not exists projects\.maintenance_smoke_failures/);
    assert.match(code, /enforce_parent_org\('work_item_id', 'projects\.maintenance_work_items'\)/);
    assert.match(code, /freeze_organization_id\(\)/);
    assert.match(code, /alter table projects\.maintenance_smoke_failures enable row level security/);
    assert.match(code, /revoke insert, update, delete on projects\.maintenance_smoke_failures from authenticated/);
    assert.match(code, /core\.is_internal\(\)/);
  });
  test('a decision is independent of the reporter in the door AND the table check', () => {
    assert.match(code, /decided_by <> reported_by/);
    assert.match(code, /v_f\.reported_by = v_actor then return query select 'self_decision'/);
  });
  test('only an Admin decides, and only a released change can have a failure', () => {
    assert.match(code, /not coalesce\(\(select core\.is_admin\(\)\), false\) then return query select 'not_authorized'/);
    assert.match(code, /v_i\.status <> 'released' then return query select 'not_released'/);
  });
  test('every door is revoked from public and granted to authenticated only', () => {
    for (const sig of ['report_maintenance_smoke_failure\\(uuid, text, text, text\\)', 'decide_maintenance_smoke_failure\\(uuid, text, text\\)']) {
      assert.match(code, new RegExp(`revoke all on function projects\\.${sig} from public, anon`));
      assert.match(code, new RegExp(`grant execute on function projects\\.${sig} to authenticated;`));
    }
  });
  test('the event types are registered and each has a trigger that emits it', () => {
    for (const t of ['project.maintenance_qa_handoff_created', 'project.maintenance_test_run_completed', 'project.maintenance_qa_passed', 'project.maintenance_smoke_failed', 'project.maintenance_smoke_failure_decided', 'finance.exception_created']) {
      assert.ok(code.includes(`('${t}'`), `registered ${t}`);
      assert.ok(code.includes(`core.emit_event(`) && code.split(`'${t}'`).length >= 3, `emitted ${t}`);
    }
    assert.match(code, /create trigger finance_exceptions_created_event after insert on finance\.finance_exceptions/);
  });
  test('the trigger functions are not callable by end users', () => {
    for (const fn of ['projects.maintenance_emit_status_events', 'projects.maintenance_emit_test_run_completed', 'finance.emit_finance_exception_created']) {
      assert.ok(code.includes(`revoke all on function ${fn}() from public, anon, authenticated`), fn);
    }
  });

  test('the build record migration binds a record to the exact commit, is append-only, tenancy-guarded and door-only', () => {
    const f = readdirSync(dir).filter((n) => /^20261122300000_/.test(n));
    assert.equal(f.length, 1);
    const b = readFileSync(join(dir, f[0] ?? 'missing'), 'utf8').replace(/^\s*--.*$/gm, '');
    assert.match(b, /p_commit_ref is distinct from v_i\.commit_ref then return query select 'commit_mismatch'/);
    assert.match(b, /v_i\.status in \('open', 'released', 'cancelled'\) then return query select 'not_in_progress'/);
    assert.match(b, /enforce_parent_org\('work_item_id', 'projects\.maintenance_work_items'\)/);
    assert.match(b, /freeze_organization_id\(\)/);
    assert.match(b, /create trigger maintenance_build_records_append_only before update or delete/);
    assert.match(b, /revoke insert, update, delete on projects\.maintenance_build_records from authenticated/);
    assert.match(b, /revoke all on function projects\.record_maintenance_build\(uuid, text, text, text, text\) from public, anon/);
    assert.ok(b.includes("('project.maintenance_build_created'") && b.includes("('project.maintenance_migration_prepared'"));
  });
  test('the payment-overdue migration emits only for an overdue exception and is not callable by users', () => {
    const f = readdirSync(dir).filter((n) => /^20261122200000_/.test(n));
    assert.equal(f.length, 1);
    const b = readFileSync(join(dir, f[0] ?? 'missing'), 'utf8').replace(/^\s*--.*$/gm, '');
    assert.match(b, /new\.kind = 'overdue' and new\.invoice_id is not null/);
    assert.match(b, /revoke all on function finance\.emit_payment_overdue\(\) from public, anon, authenticated/);
    assert.match(b, /after insert on finance\.finance_exceptions/);
  });
});
