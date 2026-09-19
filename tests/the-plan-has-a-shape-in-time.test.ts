import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLAN_MILESTONE_KINDS, PLAN_PHASES } from '../src/modules/projects/plan-vocabulary.ts';
import { region, TO_END } from './_region.ts';

/**
 * The plan has a shape in time — Project Planning §4.3, §7, §11, §15,
 * PLAN-I05.
 *
 * G-256 built what a project delivers and what it depends on, and said plainly
 * what it had not built: *"G-256 built deliverables and dependencies, NOT an
 * operational milestone object."* This is that object, and the two decisions
 * worth asserting are that §7's three maps are **one register**, and that the
 * finance one **references** the payment milestone instead of copying it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917190000_the_plan_has_a_shape_in_time.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const BLUEPRINT = read('supabase/migrations/20260917140000_the_operational_blueprint.sql');
const SERVICE = read('src/modules/projects/planning.ts');
const SHAPE = region(SERVICE, "The plan's shape in time", TO_END);

const table = (name: string) => {
  const start = SQL.indexOf(`create table if not exists projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf(');', start));
};
const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. §7’s three maps are one register', () => {
  test('three kinds, and no fourth', () => {
    assert.match(table('plan_milestones'), /kind {13}text not null check \(kind in \('operational', 'finance_gate', 'client_approval'\)\)/);
    assert.deepEqual([...PLAN_MILESTONE_KINDS], ['operational', 'finance_gate', 'client_approval']);
  });

  test('and the reason they share a table is written down', () => {
    assert.match(PROSE, /three tables would be three sets of triggers, policies and freeze\s+rules to keep honest for no difference anybody can act on/);
  });

  test('one phase vocabulary, shared by the SQL, the TS and the other register', () => {
    // A deliverable and the milestone that releases it must not be able to
    // disagree about which phase they are in — so the list is asserted
    // IDENTICAL in three places rather than written out three times and
    // trusted. Adding `phase_8` to any one of them fails here.
    const inSql = /phase {12}text not null check \(phase in \(\s*\n\s*([^)]+?)\s*\n\s*\)\)/.exec(SQL);
    assert.ok(inSql, 'the phase check is not where this test expects it');
    const sqlPhases = inSql![1]!.split(',').map((p) => p.trim().replace(/'/g, ''));
    assert.deepEqual(sqlPhases, [...PLAN_PHASES]);

    // And G-256's deliverables register, which has `not_applicable` as a
    // seventh value a milestone deliberately does not get: a milestone that
    // does not apply is simply not in the plan.
    const inBlueprint = /applicable_phase text not null check \(applicable_phase in \(\s*\n\s*([^)]+?)\s*\n\s*\)\)/.exec(BLUEPRINT);
    assert.ok(inBlueprint, 'the deliverables phase check has moved');
    const blueprintPhases = inBlueprint![1]!.split(',').map((p) => p.trim().replace(/'/g, ''));
    assert.deepEqual(blueprintPhases, [...PLAN_PHASES, 'not_applicable']);
  });
});

describe('B. the finance map references; it does not duplicate', () => {
  test('a finance gate names a payment milestone — and only a finance gate does', () => {
    // Both directions in one constraint, so neither half of the claim can be
    // made without the other.
    assert.match(
      table('plan_milestones'),
      /constraint plan_milestones_finance_gate_names_its_milestone check \(\s*\n?\s*\(kind = 'finance_gate'\) = \(payment_milestone_id is not null\)\s*\n?\s*\)/,
    );
    assert.match(table('plan_milestones'), /payment_milestone_id uuid references projects\.milestones\(id\) on delete restrict/);
  });

  test('it carries no money of its own', () => {
    // The payment milestone owns the amount, the percentage and the invoice.
    assert.doesNotMatch(table('plan_milestones'), /amount|percent|minor|invoice/i);
    assert.match(PROSE, /section 7 asks for it to be mapped onto the sequence, not duplicated into it/);
  });

  test('and it cannot map another project’s money', () => {
    assert.match(door('add_plan_milestone'), /if v_pm\.id is null or v_pm\.project_id is distinct from v_plan\.project_id then/);
    assert.match(door('add_plan_milestone'), /return query select 'wrong_project'/);
    assert.match(SHAPE, /That payment milestone belongs to a different project/);
  });

  test('both halves are refused by name at the door too', () => {
    const fn = door('add_plan_milestone');
    assert.match(fn, /return query select 'finance_gate_needs_a_milestone'/);
    assert.match(fn, /return query select 'only_finance_gates_name_a_milestone'/);
    assert.match(SHAPE, /the money lives on the payment plan/);
  });
});

describe('C. §11’s timeline rules, identical to the dependency register’s', () => {
  test('a window is storable only with a stated basis', () => {
    assert.match(
      table('plan_milestones'),
      /constraint plan_milestones_dates_need_a_basis check \(\s*\n?\s*\(target_window_start is null and target_window_end is null\)\s*\n?\s*or \(timing_basis is not null/,
    );
  });

  test('and the rule is deliberately the same one, said so', () => {
    // Two standards for the same kind of claim is how one of them rots.
    assert.match(PROSE, /two\s+different standards for the same kind of claim is how one of them rots/);
    // The dependency register's constraint, for comparison — the same shape.
    assert.match(BLUEPRINT, /constraint plan_dependencies_dates_need_a_basis check \(/);
  });

  test('a window cannot end before it starts', () => {
    assert.match(table('plan_milestones'), /target_window_end >= target_window_start/);
  });

  test('nothing derives lateness from a clock', () => {
    // `at_risk` and `missed` are a person's judgement. A milestone is not late
    // because the date passed; it is late because somebody looked.
    assert.doesNotMatch(door('add_plan_milestone'), /now\(\)|current_date|clock_timestamp/);
    assert.match(PROSE, /it is late\s+because somebody looked and decided/);
  });
});

describe('D. §15’s gate criteria and dependencies', () => {
  test('a milestone cannot exist without the condition that settles it', () => {
    assert.match(table('plan_milestones'), /gate_criteria {4}text not null check \(length\(btrim\(gate_criteria\)\) > 0\)/);
    assert.match(PROSE, /a milestone somebody will declare met\s+because the date passed/);
  });

  test('dependencies are many-to-many, because they are', () => {
    assert.match(SQL, /create table if not exists projects\.plan_milestone_dependencies/);
    assert.match(table('plan_milestone_dependencies'), /unique \(milestone_id, dependency_id\)/);
    assert.match(PROSE, /a single foreign key either way would force one of those to be a lie/);
  });

  test('a milestone cannot wait on another plan’s dependency', () => {
    assert.match(door('gate_plan_milestone'), /if v_dep\.plan_id is distinct from v_ms\.plan_id then/);
    assert.match(SHAPE, /a milestone cannot wait on it/);
  });

  test('linking the same pair twice is not an error', () => {
    assert.match(door('gate_plan_milestone'), /on conflict \(milestone_id, dependency_id\) do nothing/);
    assert.match(SHAPE, /linking the same pair twice is the same picture/);
  });

  test('§11’s "what can proceed" is a read, not a column', () => {
    assert.doesNotMatch(table('plan_milestones'), /can_proceed|blocked\b|independent/);
    assert.match(PROSE, /that is this table read the other way rather than a column somebody has to keep in step/);
  });
});

describe('E. both tables join the plan’s freeze and its tenancy', () => {
  test('the existing freeze function is reused, not copied', () => {
    assert.match(SQL, /create trigger refuse_write_to_settled_plan_milestones[\s\S]{0,200}execute function projects\.refuse_write_to_settled_plan\(\)/);
    assert.match(PROSE, /is reused rather than copied/);
  });

  test('the join table gets its own guard, because it reaches the plan indirectly', () => {
    assert.match(SQL, /create or replace function projects\.refuse_write_to_settled_plan_via_milestone/);
    assert.match(
      SQL,
      /create trigger refuse_write_to_settled_plan_milestone_deps[\s\S]{0,220}execute function projects\.refuse_write_to_settled_plan_via_milestone\(\)/,
    );
  });

  test('RLS, force, internal-only reads and a guard on every org-scoped key', () => {
    for (const t of ['plan_milestones', 'plan_milestone_dependencies']) {
      assert.match(SQL, new RegExp(`alter table projects\\.${t} enable row level security`), `${t}: RLS`);
      assert.match(SQL, new RegExp(`alter table projects\\.${t} force row level security`), `${t}: force`);
      const policy = SQL.indexOf(`create policy ${t}_select on projects.${t}`);
      assert.ok(policy > 0, `${t}: no select policy`);
      assert.match(SQL.slice(policy, policy + 300), /core\.is_internal\(\)/, `${t}: a client can read it`);
      assert.match(SQL, new RegExp(`create trigger freeze_org_${t}`), `${t}: org not frozen`);
    }
    // Every foreign key, not just the obvious parent — the omission CI caught
    // on G-256.
    for (const [col, parent] of [
      ['plan_id', 'projects.project_plans'],
      ['payment_milestone_id', 'projects.milestones'],
      ['milestone_id', 'projects.plan_milestones'],
      ['dependency_id', 'projects.plan_dependencies'],
    ] as const) {
      assert.match(
        SQL,
        new RegExp(`enforce_parent_org\\('${col}', '${parent.replace('.', '\\.')}'\\)`),
        `${col} has no org-consistency guard`,
      );
    }
  });

  test('both doors are revoked from the world', () => {
    for (const sig of ['add_plan_milestone\\(uuid, text, text, text, text, uuid, date, date, text, int\\)', 'gate_plan_milestone\\(uuid, uuid\\)']) {
      assert.match(SQL, new RegExp(`revoke all on function projects\\.${sig} from public`));
    }
  });

  test('nothing here messages anybody or touches a status by clock', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp/i);
  });
});
