import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ageInDays, exceptionState } from '../src/modules/projects/phase-six-extra-logic.ts';
import { DOCUMENT_WORDS, DOOR_OUTCOMES, WORDS } from '../src/modules/projects/review-words.ts';

/**
 * The human review doors: structure of the migration, that every outcome a door can return has a sentence (and a refusal is never worded as a
 * success), that the actions and reads keep the shape this codebase requires, and the pure rules of the Phase 6 dashboards. The BEHAVIOUR of the doors is
 * proved on a real Postgres by scripts/verify-phase5-review.sql (and red-proved by mutating each control).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIG = read('supabase/migrations/20261103200000_a_person_decides_what_an_agent_draft_becomes.sql');
const REGRESSION = read('supabase/migrations/20261102400000_a_test_result_carries_its_evidence_and_a_defect_has_its_regression_test.sql');
const DEPENDENCIES = read('supabase/migrations/20261102410000_an_integration_check_is_logged_and_a_failure_blocks_only_its_dependents.sql');
const WORDS_SRC = read('src/modules/projects/review-words.ts');
const ACTIONS = read('src/modules/projects/review-actions.ts');
const QUERIES = read('src/modules/projects/review-queries.ts');
const EXTRA_QUERIES = read('src/modules/projects/phase-six-extra-queries.ts');

/** Every `select 'x'::text` outcome in the body of one SQL function (the body ends at the first `end $$;`). */
function outcomesOf(sql: string, fn: string): string[] {
  const m = sql.match(new RegExp(`create or replace function ${fn.replace('.', '\\.')}\\([\\s\\S]*?\\nend \\$\\$;`));
  assert.ok(m, `${fn} is defined`);
  return [...new Set([...m[0].matchAll(/select '([a-z_]+)'::text/g)].map((x) => x[1]!).concat([...m[0].matchAll(/select p_decision::text/g)].length > 0 ? ['accepted', 'rejected'] : []))];
}

describe('the migration', () => {
  test('a draft status is widened and a decision records who and when', () => {
    assert.match(MIG, /check \(status in \('draft', 'accepted', 'rejected'\)\)/);
    assert.match(MIG, /add column if not exists reviewed_by uuid references core\.users\(id\)/);
    assert.match(MIG, /add column if not exists reviewed_at timestamptz/);
    assert.match(MIG, /check \(status = 'draft' or \(reviewed_by is not null and reviewed_at is not null\)\)/);
    assert.match(MIG, /check \(status <> 'rejected' or \(review_note is not null and length\(btrim\(review_note\)\) > 0\)\)/);
  });
  test('a reviewed draft is final', () => {
    assert.match(MIG, /create trigger test_case_drafts_decision_is_final before update on projects\.test_case_drafts/);
    assert.match(MIG, /if old\.status <> 'draft' then raise exception/);
  });
  test('both doors are definer functions with a pinned search path, closed to anon, open to signed-in people only', () => {
    for (const fn of ['review_test_case_draft', 'review_documentation_draft']) {
      const m = MIG.match(new RegExp(`create or replace function projects\\.${fn}\\([\\s\\S]*?\\nend \\$\\$;`));
      assert.ok(m, fn);
      assert.match(m[0], /security definer set search_path = ''/);
      assert.match(MIG, new RegExp(`revoke all on function projects\\.${fn}\\([^)]*\\) from public, anon;`));
      assert.match(MIG, new RegExp(`grant execute on function projects\\.${fn}\\([^)]*\\) to authenticated;`));
    }
  });
  test('who may decide: delivery managers for a test draft, Admins only for a document', () => {
    assert.match(MIG, /review_test_case_draft[\s\S]*?core\.can_manage_delivery\(\)/);
    assert.match(MIG, /review_documentation_draft[\s\S]*?core\.is_admin\(\)/);
  });
  test('a document is promoted only through the evidence rules and is never auto-promoted', () => {
    assert.match(MIG, /if p_status = 'implemented' and v_evidence is null then return query select 'evidence_required'/);
    assert.match(MIG, /when restrict_violation then return query select 'refused'/);
    assert.match(MIG, /update projects\.technical_documents set status = 'deprecated'/);
    assert.doesNotMatch(MIG, /delete from projects\.(technical_documents|test_case_drafts)/);
    assert.doesNotMatch(MIG, /insert into qa\./);
  });
  test('accepting a test draft creates nothing', () => {
    const m = MIG.match(/create or replace function projects\.review_test_case_draft\([\s\S]*?\nend \$\$;/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /insert into/);
  });
});

describe('every outcome a door can return has a sentence', () => {
  const sources: [keyof typeof DOOR_OUTCOMES, string, string][] = [
    ['link_regression_test', REGRESSION, 'qa.link_regression_test'],
    ['verify_regression_link', REGRESSION, 'qa.verify_regression_link'],
    ['depend_task_on_integration', DEPENDENCIES, 'projects.depend_task_on_integration'],
    ['release_task_integration_dependency', DEPENDENCIES, 'projects.release_task_integration_dependency'],
    ['review_test_case_draft', MIG, 'projects.review_test_case_draft'],
    ['review_documentation_draft', MIG, 'projects.review_documentation_draft'],
  ];
  for (const [door, sql, fn] of sources) {
    test(door, () => {
      const real = outcomesOf(sql, fn).sort();
      const declared = [...DOOR_OUTCOMES[door].ok, ...DOOR_OUTCOMES[door].refused].sort();
      assert.deepEqual(declared, real, `${door}: the declared outcomes are exactly the SQL function's`);
      for (const o of real) assert.ok(WORDS[o], `${door}: ${o} has a message`);
    });
  }
  test('a refusal is never worded as a success, and the document words differ from the test words', () => {
    for (const door of Object.values(DOOR_OUTCOMES)) for (const o of door.refused) assert.doesNotMatch(WORDS[o]!, /^(Linked|Verified|Recorded|Accepted|Rejected)\b/, o);
    assert.notEqual(DOCUMENT_WORDS.accepted, WORDS.accepted);
    assert.notEqual(DOCUMENT_WORDS.rejected, WORDS.rejected);
  });
  test('the accepted message for a test draft says nothing was created', () => {
    assert.match(WORDS.accepted!, /nothing was created/);
    assert.match(WORDS.accepted!, /never evidence/);
  });
  test('no outcome key is written twice in the map', () => {
    const body = WORDS_SRC.slice(WORDS_SRC.indexOf('export const WORDS'), WORDS_SRC.indexOf('/** The two review doors'));
    const keys = [...body.matchAll(/^ {2}([a-z_]+): /gm)].map((m) => m[1]!);
    assert.ok(keys.length > 20);
    assert.equal(new Set(keys).size, keys.length, 'a duplicate key would silently replace a sentence');
  });
});

describe('the actions and reads', () => {
  test('every action goes through the one gate and a door, and the document door needs the Admin capability', () => {
    assert.equal((ACTIONS.match(/^export async function [a-zA-Z]+Action\(/gm) ?? []).length, 6);
    assert.equal((ACTIONS.match(/return door\(/g) ?? []).length, 6);
    assert.match(ACTIONS, /requireInternal\(\)/);
    assert.match(ACTIONS, /'project\.sign_off',\s+text\(formData, 'projectId'\),\s+'projects',\s+'review_documentation_draft'/);
    assert.match(ACTIONS, /'project\.write', text\(formData, 'projectId'\), 'projects', 'review_test_case_draft'/);
  });
  test('an unlisted outcome is a refusal, never a success', () => {
    assert.match(ACTIONS, /if \(!\(DOOR_OUTCOMES\[rpc\]\.ok as readonly string\[\]\)\.includes\(outcome\)\) return \{ status: 'error'/);
  });
  test('every read is guarded: one unreadable() per error check', () => {
    for (const src of [QUERIES, EXTRA_QUERIES]) {
      const checks = (src.match(/if \(\w+\.error\) unreadable\(/g) ?? []).length;
      assert.equal((src.match(/unreadable\(/g) ?? []).length, checks, 'every unreadable( call is an error check, comments included');
      assert.ok(checks >= 4);
    }
  });
  test('the documentation drafts read keeps to unreviewed drafts only', () => {
    assert.match(QUERIES, /\.eq\('status', 'partial'\)\.ilike\('body', `\$\{DOC_DRAFT_MARKER\}%`\)/);
  });
  test('the dashboards write nothing', () => {
    assert.doesNotMatch(EXTRA_QUERIES, /\.(insert|update|delete|upsert|rpc)\(/);
  });
});

describe('the Phase 6 dashboard rules', () => {
  const NOW = Date.parse('2026-10-06T12:00:00Z');
  test('an exception that was never approved was never in force', () => {
    assert.equal(exceptionState('requested', '2027-01-01T00:00:00Z', NOW), 'not_approved');
    assert.equal(exceptionState('rejected', '2020-01-01T00:00:00Z', NOW), 'not_approved');
  });
  test('an approved exception expires on its date, and is flagged in its last 7 days', () => {
    assert.equal(exceptionState('approved', '2026-10-06T11:59:59Z', NOW), 'expired');
    assert.equal(exceptionState('approved', '2026-10-06T12:00:00Z', NOW), 'expired');
    assert.equal(exceptionState('approved', '2026-10-13T12:00:00Z', NOW), 'expiring_soon');
    assert.equal(exceptionState('approved', '2026-10-13T12:00:01Z', NOW), 'current');
    assert.equal(exceptionState('approved', 'not a date', NOW), 'expired');
  });
  test('age counts whole days and is never negative', () => {
    assert.equal(ageInDays('2026-10-06T00:00:00Z', NOW), 0);
    assert.equal(ageInDays('2026-10-04T11:00:00Z', NOW), 2);
    assert.equal(ageInDays('2026-12-01T00:00:00Z', NOW), 0);
    assert.equal(ageInDays('garbage', NOW), 0);
  });
});
