import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';
import { lastSeverityChange, resolutionWithoutSeverityLines, severityChanges } from '../src/modules/qa/defect-severity-trail.ts';

/**
 * A bug has a page — SCR-047, bucket G (stream G-1).
 *
 * Three audit rows: "Bug detail" (inline rows only), "Evidence" (one url,
 * listed only in the CSV) and "Linked task/build" (the build not shown).
 * Migration 20261001160000 adds `qa.defect_evidence` (append-only) with
 * `qa.add_defect_evidence`, and `qa.defects.build_id` with
 * `qa.link_defect_build`. The page `qa/bugs/[defectId]` renders every
 * element the PDF lists, every bug row links to it, and the four KPI tiles
 * open the bug list filtered to exactly what they counted.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const MIGRATION = read('supabase/migrations/20261001160000_a_test_case_is_imported_and_linked_and_a_bug_has_a_page.sql');
const SQL = sqlCode(MIGRATION);

function body(fn: string): string {
  const start = MIGRATION.indexOf(`create or replace function ${fn}`);
  assert.ok(start >= 0, `${fn} is in the migration`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$$;', MIGRATION.indexOf('as $$', start)));
}

const PAGE = 'app/(internal)/projects/[projectId]/qa/bugs/[defectId]/page.tsx';

describe('A. the migration: evidence is a list; a defect names its build', () => {
  test('qa.defect_evidence is tenanted, forced, frozen, parent-checked, and never updated or deleted by a person', () => {
    assert.match(SQL, /create table if not exists qa\.defect_evidence \(/);
    assert.match(SQL, /organization_id uuid not null references core\.organizations\(id\) on delete cascade/);
    assert.match(SQL, /kind\s+text not null check \(kind in \('url', 'note'\)\)/);
    assert.match(SQL, /alter table qa\.defect_evidence enable row level security;/);
    assert.match(SQL, /alter table qa\.defect_evidence force row level security;/);
    assert.match(SQL, /create policy defect_evidence_select on qa\.defect_evidence\s+for select to authenticated\s+using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\);/);
    assert.match(SQL, /create policy defect_evidence_insert on qa\.defect_evidence\s+for insert to authenticated\s+with check \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.can_write\(\)\)\);/);
    assert.match(SQL, /core\.enforce_parent_org\('defect_id', 'qa\.defects'\)/);
    assert.match(SQL, /freeze_org_defect_evidence/);
    assert.match(SQL, /grant select, insert on qa\.defect_evidence to authenticated, service_role;/);
    assert.doesNotMatch(SQL, /grant [^;]*(update|delete)[^;]* on qa\.defect_evidence/);
    assert.doesNotMatch(SQL, /create policy defect_evidence_(update|delete)/);
  });

  test('add_defect_evidence: can_write (coalesced), a url must be http(s), a note is bounded, audited', () => {
    const fn = body('qa.add_defect_evidence(');
    assert.match(fn, /if not coalesce\(\(select core\.can_write\(\)\), false\) then/);
    assert.match(fn, /if p_kind not in \('url', 'note'\) then\s*\n\s*return query select 'bad_kind'/);
    assert.match(fn, /p_kind = 'url' and v_value !~\* '\^https\?:\/\/\[\^\[:space:\]\]\+\$'/);
    assert.match(fn, /length\(v_value\) > 2000/);
    assert.match(fn, /'defect\.evidence_added'/);
    assert.match(fn, /perform core\.record_audit\(/);
  });

  test('build_id is a nullable FK to projects.deliverables with the tenancy trigger — there is no separate builds table', () => {
    assert.match(SQL, /alter table qa\.defects\s+add column if not exists build_id uuid references projects\.deliverables\(id\) on delete set null;/);
    assert.match(SQL, /core\.enforce_parent_org\('build_id', 'projects\.deliverables'\)/);
    assert.match(MIGRATION, /Distinct from deliverable_id, which is the version the bug was FOUND on/);
  });

  test('link_defect_build: can_manage_delivery (coalesced), only a build, only on the project, not once settled, audited', () => {
    const fn = body('qa.link_defect_build(');
    assert.match(fn, /if not coalesce\(\(select core\.can_manage_delivery\(\)\), false\) then/);
    assert.match(fn, /if v_defect\.status in \('verified', 'wontfix'\) then\s*\n\s*return query select 'settled'/);
    assert.match(fn, /if v_kind <> 'build' then\s*\n\s*return query select 'not_a_build'/);
    assert.match(fn, /if v_project <> v_defect\.project_id then\s*\n\s*return query select 'wrong_project'/);
    assert.match(fn, /'defect\.build_unlinked' else 'defect\.build_linked'/);
    assert.match(fn, /p_build_id\s+uuid default null/);
  });

  test('both doors are reachable by authenticated and service_role only', () => {
    for (const sig of ['qa.add_defect_evidence(uuid, text, text)', 'qa.link_defect_build(uuid, uuid)']) {
      const esc = sig.replace(/[().]/g, (c) => `\\${c}`);
      assert.match(SQL, new RegExp(`revoke all on function ${esc} from public, anon;`));
      assert.match(SQL, new RegExp(`grant execute on function ${esc} to authenticated, service_role;`));
    }
  });
});

describe('B. the doors, in the service', () => {
  const service = codeOnly(read('src/modules/qa/defect-detail-service.ts'));

  test('evidence is task.write (a member submits the fix); the build link is project.write, like triage', () => {
    const evidence = service.slice(service.indexOf('export async function addDefectEvidence'), service.indexOf('export async function linkDefectBuild'));
    const link = service.slice(service.indexOf('export async function linkDefectBuild'), service.lastIndexOf('}'));
    assert.match(evidence, /can\(context, 'task\.write'\)/);
    assert.match(evidence, /\.rpc\('add_defect_evidence', \{/);
    assert.match(link, /can\(context, 'project\.write'\)/);
    assert.match(link, /\.rpc\('link_defect_build', \{/);
    assert.doesNotMatch(service, /context\.role\b/);
  });

  test('every refusal the doors can give is a sentence', () => {
    for (const outcome of ['bad_kind', 'bad_value', 'not_a_build', 'wrong_project', 'settled']) {
      assert.match(service, new RegExp(`case '${outcome}':`), `${outcome} is handled`);
    }
  });

  test('the detail reader refuses every failed read rather than answering an empty page', () => {
    const queries = read('src/modules/qa/defect-detail-queries.ts');
    const guards = queries.match(/if \([A-Za-z.]*[eE]rror\)/g) ?? [];
    const refusals = queries.match(/unreadable\(/g) ?? [];
    assert.ok(guards.length >= 6, `${guards.length} guards`);
    assert.equal(guards.length, refusals.length);
    assert.match(queries, /^import 'server-only';/);
    // The column the migration added, read, and every FK the page follows.
    assert.match(queries, /task_id, run_id, build_id'/);
    assert.match(queries, /from\('defect_evidence'\)/);
    assert.match(queries, /from\('retest_assignments'\)/);
  });
});

describe('C. the severity trail is read back from where triage writes it', () => {
  test('the last change and its reason; the notes without the severity lines', () => {
    const resolution = 'Severity major → blocker: it corrupts the ledger\nDeployed a fix to staging\nSeverity blocker → major: only on Safari';
    assert.deepEqual(severityChanges(resolution).map((c) => c.to), ['blocker', 'major']);
    assert.deepEqual(lastSeverityChange(resolution), { from: 'blocker', to: 'major', reason: 'only on Safari' });
    assert.equal(resolutionWithoutSeverityLines(resolution), 'Deployed a fix to staging');
    assert.equal(lastSeverityChange(null), null);
    assert.equal(resolutionWithoutSeverityLines('Severity major → minor: cosmetic'), null);
  });
});

describe('D. the page: every element the PDF lists under Bug detail', () => {
  const page = read(PAGE);

  test('it is gated on project.read, answers notFound for a bug not on the project, and reads the detail plus the history', () => {
    assert.match(page, /if \(!can\(context, 'project\.read'\)\) return <PermissionDenied \/>;/);
    assert.match(page, /const detail = await readDefectDetail\(projectId, defectId\);\s*\n\s*if \(!detail\) notFound\(\);/);
    assert.match(page, /readDefectHistory\(\[defectId\]\)/);
    assert.doesNotMatch(page, /@\/modules\/[a-z-]+\/service/);
  });

  test('title, severity with the reason of its last change, status, owner, reproduction, expected vs actual, environment, build, run, task, evidence, history', () => {
    assert.match(page, /title=\{defect\.title\}/);
    assert.match(page, /label="Severity"/);
    assert.match(page, /was \{lastSeverityChange\.from\}: \{lastSeverityChange\.reason\}/);
    assert.match(page, /label="Status"/);
    assert.match(page, /label="Assigned developer"/);
    assert.match(page, /title="Reproduction"/);
    assert.match(page, /<p className="whitespace-pre-line">\{defect\.reproduction\}<\/p>/);
    assert.match(page, /Expected<\/p>/);
    assert.match(page, /Actual<\/p>/);
    assert.match(page, /label="Environment"/);
    assert.match(page, /label="Found on"/);
    assert.match(page, /label="Found by run"/);
    assert.match(page, /label="Linked task"/);
    assert.match(page, /label="Linked build"/);
    assert.match(page, /title=\{`Evidence \(\$\{evidence\.length \+ \(defect\.evidence_url \? 1 : 0\)\}\)`\}/);
    assert.match(page, /title="Fix \/ retest history"/);
    assert.match(page, /retest asked of/);
  });

  test('the links open the Development page, the Builds page and the run', () => {
    assert.match(page, /href=\{`\/projects\/\$\{projectId\}\/development\/tasks\/\$\{task\.id\}`\}/);
    assert.match(page, /href=\{`\/projects\/\$\{projectId\}\/builds`\}/);
    assert.match(page, /href=\{`\/projects\/\$\{projectId\}\/qa#run-\$\{run\.id\}`\}/);
  });

  test('the doors are the QA tab’s own components plus attach-evidence and link-build; the empty evidence state offers the form', () => {
    assert.match(page, /import \{ DefectTriageForm, SettleDefectForm \} from '\.\.\/\.\.\/\.\.\/qa-panel';/);
    assert.match(page, /<DefectTriageForm projectId=\{projectId\} defect=\{defect\}/);
    assert.match(page, /<SettleDefectForm projectId=\{projectId\} defect=\{defect\} \/>/);
    assert.match(page, /<AttachEvidenceForm projectId=\{projectId\} defectId=\{defectId\} \/>/);
    assert.match(page, /<LinkBuildForm projectId=\{projectId\} defectId=\{defectId\} currentBuildId=\{defect\.build_id\} builds=\{builds\} \/>/);
    // The element spans several lines and its icon prop closes with `/>` too, so the slice ends at the branch that follows it.
    const start = page.indexOf('<EmptyState');
    const empty = page.slice(start, page.indexOf(') : (', start));
    assert.match(empty, /action=\{/);
    const forms = read('app/(internal)/projects/[projectId]/qa/bugs/[defectId]/bug-detail-forms.tsx');
    assert.match(forms, /^'use client';/);
    assert.match(forms, /useActionState\(addDefectEvidenceAction/);
    assert.match(forms, /useActionState\(linkDefectBuildAction/);
  });
});

describe('E. every bug row links to the page, and every tile opens the list it counted', () => {
  const insights = read('app/(internal)/projects/[projectId]/qa/qa-insights.tsx');
  const dashboard = read('app/(internal)/qa/page.tsx');
  const tab = read('app/(internal)/projects/[projectId]/qa/page.tsx');

  test('the project QA tab and the org dashboard both link each bug to qa/bugs/[defectId]', () => {
    assert.match(insights, /href=\{`\/projects\/\$\{projectId\}\/qa\/bugs\/\$\{d\.id\}`\}/);
    assert.match(dashboard, /href=\{\(d\) => `\/projects\/\$\{d\.projectId\}\/qa\/bugs\/\$\{d\.id\}`\}/);
    assert.match(dashboard, /href=\{`\/projects\/\$\{d\.projectId\}\/qa\/bugs\/\$\{d\.id\}`\}/);
    assert.match(dashboard, /href=\{`\/projects\/\$\{defects\[0\]\.projectId\}\/qa\/bugs\/\$\{defects\[0\]\.id\}`\}/);
  });

  test('the row shows the linked build beside the linked task', () => {
    assert.match(insights, /\{d\.build_id \? \(/);
    assert.match(insights, /buildLabel\.get\(d\.build_id\)/);
    assert.match(read('src/modules/qa/types.ts'), /\| 'build_id'/);
    assert.match(read('src/modules/qa/queries.ts'), /task_id, run_id, build_id';/);
  });

  test('the four tiles carry hrefs to ?defects= filters, and the list honours them', () => {
    for (const [label, filter] of [
      ['Open by severity', 'open'],
      ['Awaiting a developer', 'open'],
      ['Awaiting retest', 'fixed'],
      ['Reopened', 'reopened'],
    ] as const) {
      const at = insights.indexOf(`label="${label}"`);
      assert.ok(at >= 0, `tile "${label}"`);
      const tag = insights.slice(at, insights.indexOf('/>', at));
      assert.match(tag, new RegExp(`href=\\{listHref\\(\\{ defects: '${filter}' \\}\\)\\}`), `"${label}" opens ?defects=${filter}`);
    }
    assert.match(insights, /if \(defectsFilter === 'open' && d\.status !== 'open'\) return false;/);
    assert.match(insights, /if \(defectsFilter === 'fixed' && d\.status !== 'fixed'\) return false;/);
    assert.match(insights, /if \(defectsFilter === 'reopened' && !isReopened\(d\)\) return false;/);
    assert.match(insights, /if \(severityFilter && d\.severity !== severityFilter\) return false;/);
    assert.match(insights, /\{visibleDefects\.map\(\(d\) => \{/);
    assert.match(insights, /<FilterChips/);
    assert.match(tab, /defects\?: string; severity\?: string \}>/);
    assert.match(tab, /filter=\{\{ defects: defectsFilter, severity: severityFilter \}\}/);
  });
});
