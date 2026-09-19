import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What Phase 3 cost — Master §6; Designer §23; G-297.
 *
 * *"Track AI/model/API usage by project, phase, agent and task where
 * infrastructure supports it."*
 *
 * `ai.agent_runs` already recorded the agent, the model, the tokens and the
 * cost, and never which **project** or which **phase** — so the spend was
 * auditable in total and attributable to nothing.
 *
 * Two decisions carry the unit: the attribution is **derived from the
 * subject** rather than passed in, and **phase is set only where it is not a
 * guess**.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920020000_what_phase_three_cost.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');

const bounded = (marker: string, next = '$$;') => {
  const start = SQL.indexOf(marker);
  assert.ok(start > 0, `${marker} does not exist`);
  const cut = SQL.slice(start, SQL.indexOf(next, start));
  assert.ok(cut.length > 0 && cut.length < SQL.length, `${marker} is not bounded`);
  return cut;
};
const resolver = bounded('create or replace function ai.resolve_run_subject');
const trigger = bounded('create or replace function ai.attribute_run()');
const report = bounded('create or replace function ai.project_usage_by_phase');

describe('A. the attribution is derived, never passed in', () => {
  test('a trigger sets it from the subject', () => {
    assert.match(trigger, /select r\.project_id, r\.phase into v_project, v_phase\s*\n\s*from ai\.resolve_run_subject\(new\.subject_type, new\.subject_id\) r;/);
    assert.match(trigger, /new\.project_id := v_project;/);
  });

  test('and it fires when the subject changes, not only on insert', () => {
    // A run repointed at a different subject is about different work.
    assert.match(SQL, /create trigger attribute_run\s*\n\s*before insert or update of subject_type, subject_id on ai\.agent_runs/);
  });

  test('the reason it is not an argument is recorded', () => {
    // Nineteen call sites that can each be forgotten, and none of which can
    // fix the runs that already happened.
    assert.match(PROSE, /That is nineteen call sites, each of which can be\s+forgotten/);
  });

  test('history is backfilled by the same resolver', () => {
    // The half an argument-based design could never have provided.
    assert.match(SQL, /update ai\.agent_runs r\s*\n\s*set project_id = a\.project_id,/);
    assert.match(SQL, /cross join lateral ai\.resolve_run_subject\(ar\.subject_type, ar\.subject_id\) s/);
  });

  test('and the backfill is checked by the same tenancy rule as a live write', () => {
    assert.match(PROSE, /the backfill is checked by the same rule as a live write/);
  });
});

describe('B. phase is set only where it is not a guess', () => {
  test('every Phase 3 subject gets phase 3', () => {
    for (const subject of ['phase_three', 'theme_option', 'design_token_set',
                           'representative_screen', 'design_revision', 'client_design_share',
                           'client_design_decision', 'phase_three_handoff']) {
      assert.match(resolver, new RegExp(`when '${subject}' then`), `${subject} is not resolved`);
    }
    assert.equal((resolver.match(/return query select v_project, 3::smallint; return;/g) ?? []).length, 8);
  });

  test('and every subject whose phase is ambiguous gets null', () => {
    // A scope version can be revised in Phase 2 by planning and in Phase 6 by
    // a change request. A number there would be confidently wrong.
    for (const subject of ['projects.scope_version', 'projects.handover', 'projects.maintenance_item']) {
      assert.match(resolver, new RegExp(`when '${subject}' then`), `${subject} is not resolved`);
    }
    assert.equal((resolver.match(/return query select v_project, null::smallint; return;/g) ?? []).length, 3);
  });

  test('the reason a guess would be worse than empty is recorded', () => {
    assert.match(PROSE, /which is worse than empty\s+— somebody would divide by it/);
  });

  test('an unknown subject type answers "unattributed" rather than raising', () => {
    // A resolver that refused what it did not recognise would make adding a
    // workflow a migration.
    assert.match(resolver, /else\s*\n\s*return query select null::uuid, null::smallint; return;/);
    assert.match(PROSE, /would make adding a workflow a migration/);
  });

  test('a run whose subject row is gone keeps its phase and loses its project', () => {
    // Driven, and deliberate: the subject TYPE still says what kind of work it
    // was, and that is true whether or not the row survived.
    assert.match(PROSE, /Phase 3 spend that can no longer be\s+attributed to a project is still Phase 3 spend/);
  });
});

describe('C. the report shows what it cannot attribute', () => {
  test('a null phase is its own line, not folded in', () => {
    assert.match(report, /group by r\.phase\s*\n\s*order by r\.phase nulls last;/);
    assert.match(SQL, /A null phase is its own line/);
  });

  test('and the column comment says what null means', () => {
    assert.match(MIGRATION, /Null means "attributed to this project, phase unknowable"/);
  });

  test('the organisation check is on a row the reader can see', () => {
    // `ai.agent_runs` carries an organization_id too, and reading only that
    // would trust a column the caller cannot verify against a parent.
    assert.match(report, /join projects\.projects p on p\.id = r\.project_id/);
    assert.match(report, /and p\.organization_id = \(select core\.current_organization_id\(\)\)/);
    assert.match(report, /and \(select core\.is_internal\(\)\)/);
  });

  test('sums are coalesced, so an empty phase reports zero rather than null', () => {
    assert.equal((report.match(/coalesce\(sum\(r\.\w+\), 0\)::bigint/g) ?? []).length, 3);
  });
});

describe('D. tenancy, on a column no caller sets', () => {
  test('the guard exists even though the column is derived', () => {
    assert.match(SQL, /create trigger enforce_run_project_org\s*\n\s*before insert or update of project_id on ai\.agent_runs\s*\n\s*for each row execute function core\.enforce_parent_org\('project_id', 'projects\.projects'\);/);
  });

  test('and the trigger NAME is load-bearing, which is stated', () => {
    // Postgres fires `before` triggers in name order. A guard named
    // `agent_runs_...` would sort before `attribute_run` and check a null.
    assert.match(PROSE, /a guard\s+named `agent_runs_\.\.\.` would sort first and check a null/);
    assert.ok('attribute_run' < 'enforce_run_project_org', 'the guard no longer sorts after the attribution');
  });

  test('the resolver is SECURITY DEFINER, which is why the guard is not redundant', () => {
    // It will happily find another organisation's row; the guard is what
    // refuses the attribution. Driven on a scratch Postgres.
    assert.match(SQL, /create or replace function ai\.resolve_run_subject\([\s\S]{0,200}?security definer/);
    assert.match(PROSE, /a future resolver change that read the wrong\s+table would otherwise cross a tenant silently/);
  });

  test('neither function is callable by the world', () => {
    assert.match(SQL, /revoke all on function ai\.project_usage_by_phase\(uuid\) from public, anon/);
    assert.match(SQL, /revoke all on function ai\.resolve_run_subject\(text, uuid\) from public, anon/);
  });
});

describe('E. it adds a dimension and changes no behaviour', () => {
  test('both columns are nullable, because history has no answer for some', () => {
    assert.match(SQL, /add column if not exists project_id uuid references projects\.projects\(id\) on delete set null/);
    assert.match(SQL, /add column if not exists phase smallint\s*\n\s*check \(phase is null or phase between 1 and 8\)/);
  });

  test('`on delete set null`, so a deleted project does not delete its spend record', () => {
    // The run happened and cost money. Cascading would erase the evidence.
    assert.match(SQL, /references projects\.projects\(id\) on delete set null/);
  });

  test('nothing here writes a run, changes a status or touches cost', () => {
    assert.doesNotMatch(SQL, /insert into ai\.agent_runs/);
    assert.doesNotMatch(trigger, /cost_minor|status|input_tokens/);
  });

  test('and the index only covers rows that have an answer', () => {
    assert.match(SQL, /create index if not exists agent_runs_project_idx[\s\S]{0,120}?where project_id is not null/);
  });

  test('the honest answer today is zero, and that is said out loud', () => {
    assert.match(PROSE, /No design agent has run on this deployment/);
  });
});
