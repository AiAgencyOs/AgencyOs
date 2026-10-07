import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Structure of the test-report metadata, regression links, integration observability and agent-draft migrations, and of their reads and actions.
 * The BEHAVIOUR is proved by scripts/verify-phase5-test-integration.sql on a real Postgres (and red-proved by mutating each control); these
 * assertions only keep the shape every org-scoped table here must have, so a later edit cannot quietly drop it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const M1 = read('supabase/migrations/20261102400000_a_test_result_carries_its_evidence_and_a_defect_has_its_regression_test.sql');
const M2 = read('supabase/migrations/20261102410000_an_integration_check_is_logged_and_a_failure_blocks_only_its_dependents.sql');
const M3 = read('supabase/migrations/20261102420000_the_test_and_documentation_agents_leave_drafts_never_evidence.sql');

const NEW_TABLES: [string, string, string[]][] = [
  [M1, 'qa.regression_links', ['project_id', 'defect_id', 'defective_deliverable_id', 'fix_deliverable_id', 'verification_run_id']],
  [M2, 'projects.integration_check_log', ['project_id', 'connection_id']],
  [M2, 'projects.task_integration_dependencies', ['project_id', 'task_id', 'connection_id']],
  [M3, 'projects.test_case_drafts', ['project_id', 'task_id']],
];

describe('every new org-scoped table has the full tenancy shape', () => {
  for (const [sql, table, fks] of NEW_TABLES) {
    test(table, () => {
      const short = table.split('.')[1]!;
      assert.match(sql, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security`));
      assert.match(sql, new RegExp(`create policy ${short}_read on ${table.replace('.', '\\.')} for select to authenticated\\s+using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\)`));
      assert.match(sql, new RegExp(`revoke all on ${table.replace('.', '\\.')} from public, anon`));
      assert.match(sql, new RegExp(`revoke insert, update, delete on ${table.replace('.', '\\.')} from authenticated`));
      assert.match(sql, new RegExp(`grant all on ${table.replace('.', '\\.')} to service_role`));
      assert.match(sql, new RegExp(`freeze_org_${short} before update of organization_id on ${table.replace('.', '\\.')}`));
      for (const fk of fks) assert.ok(sql.includes(`enforce_parent_org('${fk}'`) || sql.includes(`('${fk}', '`), `${table} guards ${fk}`);
    });
  }
  test('the result row gets a tenancy guard on each new reference', () => {
    for (const col of ['task_id', 'feature_id', 'requirement_version_id']) assert.ok(M1.includes(`('${col}',`), col);
  });
});

describe('the doors', () => {
  test('every security definer function pins its search path and revokes from public and anon', () => {
    for (const sql of [M1, M2, M3]) {
      const defs = [...sql.matchAll(/create or replace function ([a-z_.]+)\(([^)]*)\)[\s\S]*?(?=\n(?:create|do|--|notify|alter|drop|revoke)|$)/g)];
      assert.ok(defs.length > 0);
      for (const d of defs) {
        const body = d[0];
        if (!/security definer/.test(body)) continue;
        assert.match(body, /set search_path = ''/, `${d[1]} pins search_path`);
      }
    }
    for (const fn of ['qa.link_regression_test', 'qa.verify_regression_link', 'qa.coverage_gaps', 'projects.log_integration_check', 'projects.sync_integration_dependents', 'projects.depend_task_on_integration', 'projects.release_task_integration_dependency', 'projects.integration_observability', 'projects.record_test_case_draft', 'projects.record_documentation_draft']) {
      assert.match(`${M1}${M2}${M3}`, new RegExp(`revoke all on function ${fn.replace('.', '\\.')}\\([^)]*\\) from public, anon`), fn);
    }
  });
  test('the check log, the sync and both agent doors are not callable by a signed-in person', () => {
    for (const [sql, fn] of [[M2, 'projects.log_integration_check'], [M2, 'projects.sync_integration_dependents'], [M3, 'projects.record_test_case_draft'], [M3, 'projects.record_documentation_draft']] as const) {
      assert.match(sql, new RegExp(`revoke all on function ${fn.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated`), fn);
    }
  });
  test('the ingest patch is made on the live definition and stops if any anchor is missing', () => {
    assert.match(M1, /pg_get_functiondef\('qa\.ingest_test_report\(uuid,text,jsonb,text\)'::regprocedure\)/);
    assert.ok((M1.match(/raise exception 'ingest_test_report: [a-z ]+ anchor not found'/g) ?? []).length >= 6);
  });
  test('every existing ingest outcome name is still reachable and the new ones are named', () => {
    const live = read('supabase/migrations/20261031300000_a_runners_report_is_ingested_and_flaky_is_not_green.sql') + read('supabase/migrations/20261101320000_a_test_report_is_ingested_once_and_for_its_own_commit.sql');
    for (const o of ['no_actor', 'not_authorized', 'bad_suite', 'not_found', 'not_a_build', 'evidence_required', 'empty_report', 'malformed_report', 'duplicate_test_names', 'inconsistent_report', 'ingested', 'already_ingested', 'stale_report']) {
      assert.ok(live.includes(`'${o}'`), `${o} exists in the live definition`);
    }
    for (const o of ['unknown_cannot_pass', 'secret_in_report', 'foreign_reference']) assert.ok(M1.includes(`'${o}'`), o);
  });
  test('the failure classes are the seven of the spec', () => {
    for (const c of ['PRODUCT_DEFECT', 'TEST_DEFECT', 'FIXTURE_DEFECT', 'ENVIRONMENT_FAILURE', 'PROVIDER_FAILURE', 'CONTRACT_MISMATCH', 'UNKNOWN']) assert.ok(M1.includes(`'${c}'`), c);
  });
  test('only a verification re-opens a task, and a task that was in review resumes as in progress', () => {
    assert.match(M2, /elsif v_conn\.health = 'verified' then/);
    assert.match(M2, /when 'in_review' then 'in_progress'/);
  });
});

describe('the verifier and its reads', () => {
  const verifier = read('scripts/verify-phase5-test-integration.sql');
  test('the verifier rolls back, stops on error and ends with its OK line', () => {
    assert.match(verifier, /\\set ON_ERROR_STOP on/);
    assert.match(verifier, /\nrollback;\n/);
    assert.match(verifier, /\\echo ALL PHASE 5 TEST \+ INTEGRATION CHECKS PASSED OK\s*$/);
  });
  test('it runs each control as the person, the service and another organization', () => {
    for (const s of ['set local role authenticated', 'set local role service_role', "pg_temp.as_user(:'UB', :'ORGB', 'owner')"]) assert.ok(verifier.includes(s), s);
  });
  test('the reads fail loudly: every error check is an unreadable() and there is one per read', () => {
    const q = read('src/modules/projects/test-integration-queries.ts');
    assert.equal((q.match(/unreadable\(/g) ?? []).length, 5);
    assert.equal((q.match(/if \([a-z]+\.error\) unreadable\(/g) ?? []).length, 5);
  });
  test('the actions are server actions that export only async functions and queue for the caller\'s organization', () => {
    const a = read('src/modules/projects/test-integration-actions.ts');
    assert.match(a, /^'use server';/);
    assert.equal((a.match(/^export /gm) ?? []).length, (a.match(/^export async function /gm) ?? []).length);
    assert.match(a, /organization_id: g\.organizationId/);
    assert.match(a, /kind: 'documentation\.draft'|'documentation\.draft'/);
  });
});
