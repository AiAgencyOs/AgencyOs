import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { computeMargin, MARGIN_LABEL } from '../src/modules/finance/margin.ts';
import { createFileShareSchema, SHARE_EXPIRY_DAYS, uploadProjectFileSchema } from '../src/modules/projects/files-storage-schema.ts';
import { milestonePercentTotal, templateItemsSchema } from '../src/modules/projects/project-template-schema.ts';
import { addTimeLogSchema } from '../src/modules/projects/time-log-schema.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20260930110000_a_file_has_a_body_time_is_written_down_and_a_project_becomes_a_pattern.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');

/**
 * Stream D2 of the owner's decisions of 2026-09-29: files in storage
 * (decision 5), time logs (decision 4), project templates and the report
 * margin (both reversals). The migration is asserted for the conventions
 * every table here must carry, and the two pure functions the screens
 * lean on — the margin arithmetic and the template's milestone total — are
 * pinned so a screen can never print a figure the rule does not produce.
 */

describe('the migration carries every convention', () => {
  it('names the reversal, once per reversed decision', () => {
    const hits = MIGRATION.match(/Decision: reversed by the owner on 2026-09-29/g) ?? [];
    assert.ok(hits.length >= 2, `expected the reversal sentence for templates and margin, found ${hits.length}`);
  });

  for (const table of ['project_file_shares', 'time_logs', 'project_templates']) {
    it(`projects.${table} has RLS enabled and forced, a tenant column, and grants`, () => {
      assert.match(SQL, new RegExp(`create table if not exists projects\\.${table} \\([\\s\\S]{0,400}organization_id\\s+uuid not null references core\\.organizations\\(id\\) on delete cascade`));
      assert.match(SQL, new RegExp(`alter table projects\\.${table} enable row level security`));
      assert.match(SQL, new RegExp(`alter table projects\\.${table} force row level security`));
      assert.match(SQL, new RegExp(`create policy ${table}_select on projects\\.${table}[\\s\\S]{0,200}core\\.is_internal\\(\\)`));
      assert.match(SQL, new RegExp(`grant select, insert[a-z, ]* on projects\\.${table} to authenticated, service_role`));
      assert.match(SQL, new RegExp(`create trigger freeze_org_${table}[\\s\\S]{0,120}core\\.freeze_organization_id\\(\\)`));
      assert.match(SQL, new RegExp(`create trigger audit_row_change after insert or update[a-z ]* on projects\\.${table}`));
      assert.match(SQL, new RegExp(`comment on table projects\\.${table} is`));
    });
  }

  it('every org-scoped foreign key has its tenancy trigger', () => {
    for (const [table, fk, parent] of [
      ['project_files', 'parent_file_id', 'projects.project_files'],
      ['project_file_shares', 'project_id', 'projects.projects'],
      ['project_file_shares', 'file_id', 'projects.project_files'],
      ['time_logs', 'project_id', 'projects.projects'],
      ['time_logs', 'task_id', 'projects.tasks'],
      ['project_templates', 'source_project_id', 'projects.projects'],
    ] as const) {
      assert.match(SQL, new RegExp(`on projects\\.${table}\\s*\\n\\s*for each row execute function core\\.enforce_parent_org\\('${fk}', '${parent}'\\)`), `${table}.${fk}`);
    }
  });

  it('a file is a link OR an object, never neither, and versions chain one level deep', () => {
    assert.match(SQL, /alter table projects\.project_files alter column url drop not null/);
    assert.match(SQL, /constraint project_files_link_or_object/);
    assert.match(SQL, /constraint project_files_version_shape/);
    assert.match(SQL, /constraint project_files_deleted_pair\s*\n?\s*check \(\(deleted_at is null\) = \(deleted_by is null\)\)/);
    assert.match(SQL, /raise exception 'a version must point at the first version of its file/);
  });

  it('the share resolver is service_role only and answers nothing for an expired, revoked or trashed file', () => {
    assert.match(SQL, /create or replace function projects\.resolve_file_share\(p_token text\)[\s\S]{0,300}security definer/);
    assert.match(SQL, /revoke all on function projects\.resolve_file_share\(text\) from public, anon, authenticated;/);
    assert.match(SQL, /grant execute on function projects\.resolve_file_share\(text\) to service_role;/);
    const body = SQL.slice(SQL.indexOf('function projects.resolve_file_share'), SQL.indexOf('revoke all on function projects.resolve_file_share'));
    assert.match(body, /if v_share\.revoked_at is not null then return; end if;/);
    assert.match(body, /if v_share\.expires_at <= now\(\) then return; end if;/);
    assert.match(body, /if v_file\.deleted_at is not null then return; end if;/);
  });

  it('the bucket is created only where a storage service exists', () => {
    assert.match(SQL, /if to_regclass\('storage\.objects'\) is null or to_regclass\('storage\.buckets'\) is null then/);
    assert.match(SQL, /insert into storage\.buckets \(id, name, public\)\s*\n\s*values \('project-files', 'project-files', false\)/);
    assert.match(SQL, /\(storage\.foldername\(name\)\)\[1\] = \(select core\.current_organization_id\(\)\)::text/);
  });

  it('time logs are the caller’s own, and only a delivery manager deletes another’s', () => {
    assert.match(SQL, /create policy time_logs_insert on projects\.time_logs[\s\S]{0,300}person_id = \(select auth\.uid\(\)\)/);
    assert.match(SQL, /create policy time_logs_update on projects\.time_logs[\s\S]{0,300}person_id = \(select auth\.uid\(\)\)/);
    assert.match(SQL, /create policy time_logs_delete on projects\.time_logs[\s\S]{0,400}\(person_id = \(select auth\.uid\(\)\) or \(select core\.can_manage_delivery\(\)\)\)/);
    assert.match(SQL, /create trigger audit_row_change after insert or update or delete on projects\.time_logs/);
    assert.doesNotMatch(SQL.slice(SQL.indexOf('projects.time_logs ('), SQL.indexOf('projects.project_templates')), /finance\./, 'time logs touch nothing in finance');
  });

  it('the totals are security_invoker views, so the base table’s RLS decides', () => {
    for (const view of ['time_log_totals_by_task', 'time_log_totals_by_project', 'time_log_totals_by_person']) {
      assert.match(SQL, new RegExp(`create or replace view projects\\.${view}\\s*\\n\\s*with \\(security_invoker = true\\)`), view);
      assert.match(SQL, new RegExp(`grant select on projects\\.${view} to authenticated, service_role`), view);
    }
  });

  it('no fail-open guard shape appears', () => {
    assert.doesNotMatch(SQL, /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal|can_manage_delivery)\s*\(/);
  });
});

describe('the margin is cash-basis and says so', () => {
  // Time cost joined the sum by decision E2 of 2026-09-30; its own rules
  // (day-of-log rate, uncosted hours reported not zeroed) are pinned in
  // tests/a-log-is-priced-on-its-day.test.ts. With no time cost the figure
  // is what it was.
  it('paid minus (expenses plus AI cost plus time cost), with the share of paid', () => {
    const m = computeMargin({ paidMinor: 100_000, expensesMinor: 30_000, aiCostMinor: 5_000, timeCostMinor: 0, uncostedHours: 0 });
    assert.equal(m.costMinor, 35_000);
    assert.equal(m.marginMinor, 65_000);
    assert.equal(m.marginPercent, 65);
    assert.equal(m.label, MARGIN_LABEL);
    assert.equal(m.label, 'cash-basis estimate');
  });

  it('nothing paid means no percentage, not a division by zero', () => {
    const m = computeMargin({ paidMinor: 0, expensesMinor: 1_000, aiCostMinor: 0, timeCostMinor: 0, uncostedHours: 0 });
    assert.equal(m.marginMinor, -1_000);
    assert.equal(m.marginPercent, null);
  });

  it('time is costed only through the day-of-log view: the reader never applies a rate itself, and the screen says so', () => {
    // Code only: the reader reads the costed totals view and no rate table.
    const reader = read('src/modules/finance/margin-queries.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(reader, /time_log_totals_by_project/);
    assert.match(reader, /cost_minor, uncosted_hours/);
    assert.doesNotMatch(reader, /member_cost_rates|hourly_cost_minor|\* *hours|hours *\*/);
    const page = read('app/(internal)/projects/[projectId]/reports/page.tsx');
    assert.match(page, /cash-basis estimate/);
    assert.match(page, /h uncosted — no rate on those days/);
    const csv = read('app/api/projects/[projectId]/report/route.ts');
    assert.match(csv, /'time_cost', margin\.timeCostMinor/);
    assert.match(csv, /'uncosted_hours', margin\.uncostedHours/);
  });
});

describe('a template is a validated snapshot', () => {
  it('an empty blob parses to empty lists, and a payment plan needs exactly 100%', () => {
    const empty = templateItemsSchema.parse({});
    assert.deepEqual(empty.modules, []);
    assert.equal(milestonePercentTotal(empty), 0);
    const half = templateItemsSchema.parse({ milestones: [{ name: 'Kickoff', percent: 40 }, { name: 'Launch', percent: 60 }] });
    assert.equal(milestonePercentTotal(half), 100);
    const short = templateItemsSchema.parse({ milestones: [{ name: 'Kickoff', percent: 40 }] });
    assert.equal(milestonePercentTotal(short), 40);
  });

  it('a percent outside 0–100 or a blank name is refused', () => {
    assert.equal(templateItemsSchema.safeParse({ milestones: [{ name: 'X', percent: 120 }] }).success, false);
    assert.equal(templateItemsSchema.safeParse({ modules: [{ name: '  ' }] }).success, false);
  });

  it('the create door writes through the existing doors, never straight into a governed table', () => {
    const service = read('src/modules/projects/project-template-service.ts');
    assert.match(service, /createProjectManually\(/);
    assert.match(service, /configurePaymentPlan\(/);
    assert.match(service, /openScopeVersion\(/);
    assert.doesNotMatch(service, /from\('milestones'\)\s*\n?\s*\.insert/);
    assert.doesNotMatch(service, /from\('scope_items'\)\s*\n?\s*\.insert/);
    assert.doesNotMatch(service, /from\('onboarding_items'\)\s*\n?\s*\.insert/);
  });
});

describe('the doors validate what a person types', () => {
  it('hours must be more than zero and at most a day, to two decimals', () => {
    const base = { projectId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002', loggedOn: '2026-09-29' };
    assert.equal(addTimeLogSchema.safeParse({ ...base, hours: '0' }).success, false);
    assert.equal(addTimeLogSchema.safeParse({ ...base, hours: '25' }).success, false);
    const ok = addTimeLogSchema.safeParse({ ...base, hours: '1.333' });
    assert.ok(ok.success);
    assert.equal(ok.data.hours, 1.33);
    assert.equal(ok.data.note, '');
  });

  it('a share link expiry is one of the offered choices, never open-ended', () => {
    const fileId = '00000000-0000-4000-8000-000000000003';
    for (const d of SHARE_EXPIRY_DAYS) assert.ok(createFileShareSchema.safeParse({ fileId, expiresInDays: String(d) }).success, String(d));
    assert.equal(createFileShareSchema.safeParse({ fileId, expiresInDays: '3650' }).success, false);
    assert.equal(createFileShareSchema.safeParse({ fileId, expiresInDays: '0' }).success, false);
  });

  it('an upload defaults its category and accepts a parent for a new version', () => {
    const p = uploadProjectFileSchema.parse({ projectId: '00000000-0000-4000-8000-000000000004' });
    assert.equal(p.category, 'documents');
    assert.equal(p.title, '');
    assert.equal(uploadProjectFileSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000004', parentFileId: 'nope' }).success, false);
  });

  it('the upload door refuses when storage cannot be reached, and undoes the row when the object does not land', () => {
    const service = read('src/modules/projects/files-storage-service.ts');
    assert.match(service, /if \(!storage\.reachable\) return err\('PROVIDER_ERROR', `Storage is not reachable, so nothing was uploaded/);
    assert.match(service, /from\('project_files'\)\.delete\(\)\.eq\('id', fileId\)/);
    const route = read('app/api/files/share/[token]/route.ts');
    assert.match(route, /rpc\('resolve_file_share', \{ p_token: token \}\)/);
    assert.doesNotMatch(route, /from\('project_file_shares'\)/, 'the public route never reads the shares table directly');
  });
});
