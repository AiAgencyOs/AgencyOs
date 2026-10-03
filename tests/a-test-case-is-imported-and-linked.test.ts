import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import { IMPORT_COLUMN_ALIASES, IMPORT_LIMITS, parseCsv, parseTestCaseImport } from '../src/modules/qa/test-case-import.ts';

/**
 * A test case is imported and linked — SCR-045, bucket G (stream G-1).
 *
 * Two audit rows: "Linked requirement/task" (a planned case named a scope
 * item and nothing else) and "Create/import test case" (one form per case).
 * Migration 20261001160000 adds `qa.test_plan_items.task_id` with
 * `qa.link_test_case_task`, and `qa.import_test_cases` — a batch in ONE
 * transaction that refuses the whole batch on the first bad row with its
 * row number. The parser behind the preview is pure and pinned here; the
 * preview writes nothing and the commit is the door.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = read('supabase/migrations/20261001160000_a_test_case_is_imported_and_linked_and_a_bug_has_a_page.sql');
const SQL = sqlCode(MIGRATION);

function body(fn: string): string {
  const start = MIGRATION.indexOf(`create or replace function ${fn}`);
  assert.ok(start >= 0, `${fn} is in the migration`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$$;', MIGRATION.indexOf('as $$', start)));
}

describe('A. the migration: a case names a task, and a batch lands or does not', () => {
  test('task_id is a nullable FK to projects.tasks with the tenancy trigger', () => {
    assert.match(SQL, /alter table qa\.test_plan_items\s+add column if not exists task_id uuid references projects\.tasks\(id\) on delete set null;/);
    assert.match(SQL, /core\.enforce_parent_org\('task_id', 'projects\.tasks'\)/);
    assert.match(SQL, /create index if not exists test_plan_items_task_idx/);
  });

  test('link_test_case_task: can_manage_delivery (coalesced), the task must be on the plan’s project, null unlinks, audited', () => {
    const fn = body('qa.link_test_case_task(');
    assert.match(fn, /if not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
    assert.match(fn, /join qa\.test_plans tp on tp\.id = i\.plan_id/);
    assert.match(fn, /t\.project_id = v_project/);
    assert.match(fn, /'task_not_on_project'/);
    assert.match(fn, /p_task_id\s+uuid default null/);
    assert.match(fn, /'test_case\.task_unlinked' else 'test_case\.task_linked'/);
    assert.match(fn, /perform core\.record_audit\(/);
    // No plan_approved refusal: linking who builds it is not changing what is tested.
    assert.doesNotMatch(codeOnly(fn), /plan_approved/);
  });

  test('import_test_cases: one transaction — the loop is inside an exception block, so a bad row rolls every insert back', () => {
    const fn = body('qa.import_test_cases(');
    assert.match(fn, /if not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
    assert.match(fn, /if v_plan_status = 'approved' then\s*\n\s*return query select 'plan_approved'/);
    assert.match(fn, /jsonb_typeof\(p_cases\) <> 'array'/);
    assert.match(fn, /begin\s*\n\s*for v_case in select value from jsonb_array_elements\(p_cases\) loop/);
    assert.match(fn, /exception\s*\n\s*when others then/);
    assert.match(fn, /get stacked diagnostics v_message = message_text;/);
    assert.match(fn, /return query select 'invalid_row'::text, 0, v_row, v_message;/);
    // The requirement is a scope item of THIS plan's baseline, by id or exact title.
    assert.match(fn, /si\.scope_version_id = v_scope_version/);
    assert.match(fn, /si\.id::text = v_ref or lower\(btrim\(si\.title\)\) = lower\(v_ref\)/);
    assert.match(fn, /is not in the plan''s baseline/);
    // One case per requirement and category — the table's own unique index, refused by row.
    assert.match(fn, /on conflict \(plan_id, scope_item_id, category\) do nothing/);
    assert.match(fn, /if v_new is null then\s*\n\s*raise exception/);
    assert.match(fn, /'test_case\.imported'/);
    assert.match(fn, /jsonb_build_object\('count', v_count/);
  });

  test('both doors are reachable by authenticated and service_role only', () => {
    for (const sig of ['qa.link_test_case_task(uuid, uuid)', 'qa.import_test_cases(uuid, jsonb)']) {
      const esc = sig.replace(/[().]/g, (c) => `\\${c}`);
      assert.match(SQL, new RegExp(`revoke all on function ${esc} from public, anon;`));
      assert.match(SQL, new RegExp(`grant execute on function ${esc} to authenticated, service_role;`));
    }
  });

  test('the migration closes every dollar-quoted body it opens', () => {
    assert.equal((MIGRATION.match(/\$\$/g) ?? []).length % 2, 0);
  });
});

describe('B. the parser is pure and honest', () => {
  test('CSV: quoted commas, quoted newlines, doubled quotes, CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","line1\nline2"\r\n"say ""hi""",z\r\n');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['x, y', 'line1\nline2'],
      ['say "hi"', 'z'],
    ]);
  });

  test('header aliases: title is the reason, suite is the category, "Expected Result" is expected_result', () => {
    const out = parseTestCaseImport('Title,Suite,Requirement,Expected Result,Critical\nMoves money,Functional,Checkout,Paid,yes\n');
    assert.equal(out.format, 'csv');
    assert.deepEqual(out.issues, []);
    assert.deepEqual(out.rows, [{ requirement: 'Checkout', category: 'functional', reason: 'Moves money', criticalPath: true, expectedResult: 'Paid' }]);
    assert.ok(IMPORT_COLUMN_ALIASES.reason.includes('title'));
    assert.ok(IMPORT_COLUMN_ALIASES.category.includes('suite'));
  });

  test('JSON: an array, or an object with a cases array', () => {
    const a = parseTestCaseImport('[{"requirement":"Checkout","category":"api","reason":"r"}]');
    const b = parseTestCaseImport('{"cases":[{"requirement":"Checkout","category":"api","reason":"r","steps":"1. go"}]}');
    assert.equal(a.format, 'json');
    assert.deepEqual(a.issues, []);
    assert.equal(a.rows.length, 1);
    assert.equal(b.rows[0]?.steps, '1. go');
    assert.match(parseTestCaseImport('{"nope":1}').issues[0]?.message ?? '', /array of cases/);
    assert.match(parseTestCaseImport('[1]').issues[0]?.message ?? '', /must be an object/);
  });

  test('every problem carries its data row number; a good row beside a bad one is still parsed', () => {
    const out = parseTestCaseImport('requirement,category,reason\nCheckout,functional,ok\n,functional,no requirement\nCheckout,fuzz,bad category\n');
    assert.equal(out.rows.length, 1);
    assert.deepEqual(
      out.issues.map((i) => i.row),
      [2, 3],
    );
    assert.match(out.issues[0]!.message, /requirement is missing/);
    assert.match(out.issues[1]!.message, /category "fuzz"/);
  });

  test('a missing required header, an empty input, a duplicate in the batch, too many rows', () => {
    assert.match(parseTestCaseImport('title,steps\nx,y').issues[0]!.message, /no "requirement" column/);
    assert.equal(parseTestCaseImport('   ').format, 'empty');
    const dup = parseTestCaseImport('requirement,category,reason\nCheckout,ui,a\ncheckout,ui,b\n');
    assert.equal(dup.rows.length, 2);
    assert.match(dup.issues[0]!.message, /duplicates row 1/);
    const many = `requirement,category,reason\n${Array.from({ length: IMPORT_LIMITS.rows + 1 }, (_, i) => `R${i},ui,r`).join('\n')}`;
    assert.match(parseTestCaseImport(many).issues[0]!.message, new RegExp(`more than the ${IMPORT_LIMITS.rows}`));
  });

  test('the parser imports nothing that touches the database', () => {
    const src = read('src/modules/qa/test-case-import.ts');
    assert.doesNotMatch(src, /server-only|@\/lib\/db|createClient|requireInternal/);
  });
});

describe('C. the doors, in the service', () => {
  const service = codeOnly(read('src/modules/qa/test-case-import-service.ts'));

  test('both check project.write on the role union, then call the rpc', () => {
    assert.equal((service.match(/can\(context, 'project\.write'\)/g) ?? []).length, 2);
    assert.doesNotMatch(service, /context\.role\b/);
    assert.match(service, /\.rpc\('import_test_cases', \{/);
    assert.match(service, /\.rpc\('link_test_case_task', \{/);
  });

  test('a refused row is a VALIDATION error naming the row, and nothing was imported', () => {
    assert.match(service, /case 'invalid_row':\s*\n\s*return err\('VALIDATION', `Row \$\{row\.row_number \?\? '\?'\}: \$\{row\.detail \?\? 'invalid'\}\. Nothing was imported\.`\)/);
    assert.match(service, /case 'plan_approved':\s*\n\s*return err\('CONFLICT'/);
    assert.match(service, /case 'task_not_on_project':\s*\n\s*return err\('VALIDATION'/);
  });

  test('the actions: preview parses and writes nothing; commit is the door; the file is capped', () => {
    const actions = codeOnly(read('src/modules/qa/test-case-import-actions.ts'));
    assert.match(actions, /^'use server';/);
    const preview = actions.slice(actions.indexOf('export async function previewTestCaseImportAction'), actions.indexOf('export async function commitTestCaseImportAction'));
    assert.match(preview, /parseTestCaseImport\(text\)/);
    assert.doesNotMatch(preview, /importTestCases\(|\.rpc\(|createClient/);
    assert.match(preview, /upload\.size > IMPORT_LIMITS\.bytes/);
    assert.match(actions, /await importTestCases\(\{ planId: String\(formData\.get\('planId'\) \?\? ''\), cases \}\)/);
    assert.equal(IMPORT_LIMITS.bytes, 200 * 1024);
  });

  test('the client-safe types file has no server-only import, and the panel is a client component', () => {
    assert.doesNotMatch(codeOnly(read('src/modules/qa/test-case-import-types.ts')), /server-only/);
    assert.match(read('app/(internal)/projects/[projectId]/qa/test-case-import-panel.tsx'), /^'use client';/);
  });
});

describe('D. the screen: SCR-045 shows the linked task and offers the import', () => {
  const panel = read('app/(internal)/projects/[projectId]/qa/test-case-import-panel.tsx');
  const plan = read('app/(internal)/projects/[projectId]/test-plan-panel.tsx');
  const page = read('app/(internal)/projects/[projectId]/qa/page.tsx');

  test('preview then commit: two forms, the commit carries the previewed rows, no commit while there is an issue', () => {
    assert.match(panel, /useActionState\(previewTestCaseImportAction/);
    assert.match(panel, /useActionState\(commitTestCaseImportAction/);
    assert.match(panel, /name="file" type="file"/);
    assert.match(panel, /name="cases" value=\{JSON\.stringify\(parsed\.rows\)\}/);
    assert.match(panel, /const canCommit = parsed !== undefined && parsed\.issues\.length === 0 && parsed\.rows\.length > 0/);
    assert.match(panel, /Commit \$\{parsed\.rows\.length\} case/);
  });

  test('the case row shows its task (title, status, a link to the Development page) and a Link task control', () => {
    assert.match(panel, /href=\{`\/projects\/\$\{projectId\}\/development\/tasks\/\$\{task\.id\}`\}/);
    assert.match(panel, /<Badge tone=\{statusTone\(task\.status\)\}>\{humanize\(task\.status\)\}<\/Badge>/);
    assert.match(panel, /useActionState\(linkTestCaseTaskAction/);
    assert.match(plan, /<LinkedTask projectId=\{projectId\} task=\{tasks\?\.find\(\(t\) => t\.id === item\.taskId\)\} \/>/);
    assert.match(plan, /<LinkTaskForm projectId=\{projectId\} itemId=\{item\.id\} currentTaskId=\{item\.taskId\} tasks=\{tasks\} \/>/);
    assert.match(plan, /<ImportTestCasesForm projectId=\{projectId\} planId=\{plan\.id\} \/>/);
  });

  test('the QA tab hands the plan card the project’s tasks, and the reader carries task_id', () => {
    assert.match(page, /<TestPlanCard[^>]*tasks=\{tasks\.map/);
    const queries = read('src/modules/qa/queries.ts');
    assert.match(queries, /taskId: string \| null;/);
    assert.match(queries, /taskId: i\.task_id,/);
    assert.match(queries, /preconditions, steps, expected_result, task_id'\)/);
  });

  test('types.ts knows the column and the two functions', () => {
    const types = read('src/lib/db/types.ts');
    const qa = types.slice(types.indexOf('\n  qa: {\n    Tables: {'), types.indexOf('\n  sales: {'));
    assert.match(qa, /import_test_cases: \{\s*\n\s*Args: \{ p_cases: Json; p_plan_id: string \}/);
    assert.match(qa, /link_test_case_task: \{\s*\n\s*Args: \{ p_task_id\?: string \| null; p_test_case_id: string \}/);
    const items = qa.slice(qa.indexOf('      test_plan_items: {'), qa.indexOf('      test_plans: {'));
    assert.equal((items.match(/task_id\??: string \| null/g) ?? []).length, 3);
  });
});
