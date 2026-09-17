import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Required is not the same as done — Master §5.4, §5.10; PM §4.3.
 *
 * §5.4 asks for six values: *REQUIRED / OPTIONAL / RECEIVED / VERIFIED /
 * WAITING_CLIENT / NOT_APPLICABLE*. Written as one enum they are nonsense —
 * an item is `required` **and** `verified`, not one or the other — so they are
 * two axes.
 *
 * And the unit exists as much for a **conflict G-258 introduced without
 * noticing**: ADM-06, granted 2026-08-13, says *"the onboarding checklist
 * blocks nothing; every item is a reminder."* G-258's kickoff gate refused a
 * kickoff while any item was pending. Both cannot be true, and the resolution
 * is the nullable column below — raised as ADM-108 rather than decided here.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917180000_required_is_not_the_same_as_done.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const GATE_SOURCE = read('supabase/migrations/20260917160000_the_kickoff_gate.sql');
const SETTER_SOURCE = read('supabase/migrations/20260813120020_a_won_deal_becomes_a_workspace.sql');
const PANEL = read('app/(internal)/projects/[projectId]/onboarding-panel.tsx');
const ACTIONS = read('src/modules/projects/actions.ts');

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not carried forward here`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. two axes, because six values are not one enum', () => {
  test('requirement and status are separate columns', () => {
    for (const table of ['onboarding_items', 'onboarding_baseline']) {
      assert.match(
        SQL,
        new RegExp(`alter table projects\\.${table}\\s*\\n\\s*add column if not exists requirement text`),
        `${table} has no requirement axis`,
      );
    }
    assert.match(PROSE, /an item is `required` \*\*and\*\*\s+`verified`, not one or the other/);
  });

  test('status gains §5.4’s four states and loses `done`', () => {
    assert.match(
      SQL,
      /add constraint onboarding_items_status_check check \(status in \(\s*\n\s*'pending', 'waiting_client', 'received', 'verified', 'not_applicable'\s*\n\s*\)\)/,
    );
    assert.doesNotMatch(SQL.slice(SQL.indexOf('add constraint onboarding_items_status_check')), /'done'/);
  });

  test('existing `done` rows are migrated before the constraint changes', () => {
    // Order matters: adding the constraint first would refuse the very rows the
    // update is there to fix.
    const drop = SQL.indexOf('drop constraint if exists onboarding_items_status_check');
    const update = SQL.indexOf("update projects.onboarding_items set status = 'verified' where status = 'done'");
    const add = SQL.indexOf('add constraint onboarding_items_status_check');
    assert.ok(drop > 0 && update > drop && add > update);
  });

  test('`done` became `verified`, not `received`, and the migration says why', () => {
    assert.match(PROSE, /calling it `received` would claim a distinction they never drew/);
  });
});

describe('B. the conflict, and the column that resolves it', () => {
  test('ADM-06 and Master §5.10 are both quoted, and named as contradicting', () => {
    assert.match(PROSE, /ADM-06, granted 2026-08-13:\*\* \*"The onboarding checklist blocks nothing/);
    assert.match(PROSE, /Master §5\.10, locked 2026-09-16:\*\* the pre-kickoff gate must \*"verify/);
    assert.match(PROSE, /Those contradict, and G-258 shipped the second without noticing the first/);
  });

  test('the defect is attributed to G-258 rather than quietly corrected', () => {
    assert.match(PROSE, /That is a defect of G-258, recorded\s+rather than quietly corrected/);
  });

  test('requirement is NULLABLE with no default — nobody has been asked yet', () => {
    // A default of `required` would block everything; a default of `optional`
    // would assert that nothing matters. Null is the only honest value before
    // the owner answers ADM-108.
    const addColumn = SQL.slice(SQL.indexOf('alter table projects.onboarding_items\n  add column if not exists requirement'), SQL.indexOf('alter table projects.onboarding_baseline'));
    assert.doesNotMatch(addColumn, /not null|default/);
    assert.match(addColumn, /check \(requirement is null or requirement in \('required', 'optional'\)\)/);
  });

  test('and the question is raised, not answered', () => {
    assert.match(PROSE, /ADM-108/);
    assert.match(PROSE, /no business decision is invented/);
  });
});

describe('C. the gate now counts only what the owner marked required', () => {
  test('it filters on requirement = required', () => {
    const fn = door('pre_kickoff_readiness');
    assert.match(fn, /and oi\.requirement = 'required'/);
    assert.match(fn, /and oi\.status not in \('verified', 'not_applicable'\)/);
  });

  test('the existence check is gone, and the migration says why', () => {
    // G-258 required the checklist to exist. With a required-only gate that
    // check would refuse a project whose checklist nobody configured, which is
    // exactly what ADM-06 forbids.
    assert.doesNotMatch(door('pre_kickoff_readiness'), /exists \(select 1 from projects\.onboarding_items oi where oi\.project_id = p_project_id\)/);
    assert.match(PROSE, /The existence check is gone with it/);
  });

  test('it was carried forward from G-258’s definition with one marked edit', () => {
    const rawStart = MIGRATION.indexOf('create or replace function projects.pre_kickoff_readiness');
    const v2 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$$;', rawStart));
    assert.equal((v2.match(/\[G-261 edit \d of 1\]/g) ?? []).length, 1);

    const origStart = GATE_SOURCE.indexOf('create or replace function projects.pre_kickoff_readiness');
    const v1 = GATE_SOURCE.slice(origStart, GATE_SOURCE.indexOf('$$;', origStart));
    const original = v1
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'))
      // The lines the marked edit deliberately replaced.
      .filter((l) => !['select', "and oi.status = 'pending'", 'and not exists (', 'select 1', 'from projects.onboarding_items oi', 'where oi.project_id = p_project_id', ')', 'exists (select 1 from projects.onboarding_items oi where oi.project_id = p_project_id)'].includes(l));
    const carried = v2.split('\n').map((l) => l.trim());
    assert.deepEqual(original.filter((l) => !carried.includes(l)), [], 'lines dropped in the carry-forward');
  });
});

describe('D. waiting on a client is not progress', () => {
  test('it stamps no completion moment', () => {
    const fn = door('set_onboarding_item');
    assert.match(fn, /completed_by = case when p_status in \('pending', 'waiting_client'\) then null else p_actor end/);
    assert.match(fn, /completed_at = case when p_status in \('pending', 'waiting_client'\) then null else clock_timestamp\(\) end/);
    // And the table constraint agrees, so a direct write cannot stamp one.
    assert.match(SQL, /when status in \('pending', 'waiting_client'\) then completed_at is null and completed_by is null/);
  });

  test('and it does not count toward the done total', () => {
    assert.match(door('set_onboarding_item'), /count\(\*\) filter \(where i\.status not in \('pending', 'waiting_client'\)\)/);
    assert.match(PROSE, /a progress bar measuring how much has been ASKED rather than how much is settled/);
  });

  test('the setter refuses `done` outright', () => {
    const fn = door('set_onboarding_item');
    assert.match(fn, /if p_status not in \('pending', 'waiting_client', 'received', 'verified', 'not_applicable'\) then/);
    assert.doesNotMatch(fn, /'done'/);
  });

  test('it was carried forward with three marked edits', () => {
    const rawStart = MIGRATION.indexOf('create or replace function projects.set_onboarding_item');
    const v2 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$$;', rawStart));
    assert.equal((v2.match(/\[G-261 edit \d of 3\]/g) ?? []).length, 3);

    const origStart = SETTER_SOURCE.indexOf('create or replace function projects.set_onboarding_item');
    const v1 = SETTER_SOURCE.slice(origStart, SETTER_SOURCE.indexOf('$$;', origStart));
    const original = v1
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'))
      .filter((l) => !l.startsWith("if p_status not in") && !l.startsWith('completed_by = case') && !l.startsWith('completed_at = case') && !l.startsWith('select count(*) filter'));
    const carried = v2.split('\n').map((l) => l.trim());
    assert.deepEqual(original.filter((l) => !carried.includes(l)), [], 'lines dropped in the carry-forward');
  });
});

describe('E. the surface offers the states, and the tick means verified', () => {
  test('all five states have a mark, and they are distinct', () => {
    const marks = ['pending', 'waiting_client', 'received', 'verified', 'not_applicable'].map((s) => {
      const m = new RegExp(`${s}: '(.+?)'`).exec(PANEL);
      assert.ok(m, `${s} has no mark`);
      return m![1];
    });
    assert.equal(new Set(marks).size, marks.length, 'two states share a mark, so the checklist cannot be read');
  });

  test('the tick writes `verified`, which is what `done` always meant', () => {
    assert.match(PANEL, /const next = SETTLED\.has\(status\) \? 'pending' : 'verified'/);
    assert.doesNotMatch(PANEL.replace(/\/\*[\s\S]*?\*\//g, ''), /'done'/);
  });

  test('only verified and not_applicable strike the item through', () => {
    // `waiting_client` and `received` are open items. Striking them through
    // would let a checklist read as settled while two thirds of it is not.
    assert.match(PANEL, /const SETTLED = new Set\(\['verified', 'not_applicable'\]\)/);
  });

  test('asked and received are offered as their own controls', () => {
    assert.match(PANEL, /value="waiting_client"[\s\S]{0,200}Asked/);
    assert.match(PANEL, /value="received"[\s\S]{0,200}Received/);
  });

  test('the action narrows with a predicate rather than a cast', () => {
    // A cast would let a sixth state added to the door through untyped.
    assert.match(ACTIONS, /value is OnboardingStatus/);
    assert.match(ACTIONS, /if \(!isOnboardingStatus\(status\)\)/);
  });
});
