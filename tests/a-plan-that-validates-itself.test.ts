import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A plan that validates itself — Project Planning §18, PLAN-I09.
 *
 * §18 lists ten validation rules. **Six are already structural**, and the
 * interesting assertion is that this unit does *not* re-check them: a second
 * opinion that can only ever agree reads as protection and is not.
 *
 * The four that are not structural include the one this unit exists for.
 * G-256 made it impossible to **invent** a deliverable; it did nothing to stop
 * a plan **leaving one out**. A plan referencing three of a client's five
 * approved scope items looked perfectly valid until now.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917210000_a_plan_that_validates_itself.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const CLARIFICATION = read('supabase/migrations/20260917150000_the_clarification_loop.sql');
const BLUEPRINT = read('supabase/migrations/20260917140000_the_operational_blueprint.sql');

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the six structural rules are deliberately not re-checked', () => {
  test('the validator tests none of them', () => {
    const fn = door('validate_project_plan');
    // Each of these is already a constraint or an existing gate. Re-checking
    // them here would be a second opinion that can only ever agree.
    assert.doesNotMatch(fn, /scope_item_id is not null or proposal_item_id/); // G-256's CHECK
    assert.doesNotMatch(fn, /owner_role is null/); // NOT NULL
    assert.doesNotMatch(fn, /plan_clarifications/); // G-257's gate owns it
  });

  test('and the migration names all six, so the omission is a decision', () => {
    for (const rule of [
      'every deliverable has a source reference',
      'dependencies have owners',
      'no unresolved ambiguity is silently converted into scope',
      'no development-level technical implementation plan is present',
      'plan schema validates',
      'plan is versioned and auditable',
    ]) {
      assert.ok(PROSE.includes(rule), `§18's "${rule}" is not accounted for`);
    }
    assert.match(PROSE, /a second opinion that can only ever agree, and would read as protection/);
  });
});

describe('B. coverage — the rule this unit exists for', () => {
  test('every INCLUDED scope item must be represented', () => {
    const fn = door('validate_project_plan');
    assert.match(fn, /from projects\.scope_items si/);
    assert.match(fn, /si\.scope_version_id = v_plan\.scope_version_id/);
    assert.match(fn, /and si\.inclusion = 'included'/);
    assert.match(fn, /uncovered_scope_items/);
  });

  test('an EXCLUDED item is not expected in the plan', () => {
    // Excluded scope is not work. Demanding a deliverable for it would fail
    // every plan that correctly leaves out what the client did not buy.
    assert.match(door('validate_project_plan'), /and si\.inclusion = 'included'/);
  });

  test('and the reason this was missing is stated against what G-256 did cover', () => {
    assert.match(PROSE, /G-256 made it impossible to invent a deliverable; it did\s+\*\*not\*\* make it impossible to LEAVE ONE OUT/);
  });

  test('"or explicitly N/A with reason" is checked too', () => {
    const fn = door('validate_project_plan');
    assert.match(fn, /d\.status = 'not_applicable'/);
    assert.match(fn, /coalesce\(btrim\(coalesce\(d\.ambiguity_note, ''\)\), ''\) = ''/);
    assert.match(fn, /not_applicable_without_reason/);
  });
});

describe('C. the other two rules, and what "where applicable" means', () => {
  test('a phase carrying work needs a milestone', () => {
    const fn = door('validate_project_plan');
    assert.match(fn, /phases_without_a_milestone/);
    assert.match(fn, /m\.phase = d\.applicable_phase/);
  });

  test('but a phase that produces nothing does not', () => {
    // `not_applicable` deliverables are exempt on both axes.
    const fn = door('validate_project_plan');
    assert.match(fn, /and d\.applicable_phase <> 'not_applicable'/);
    assert.match(fn, /and d\.status <> 'not_applicable'/);
  });

  test('"finance gates where applicable" means where a payment plan exists', () => {
    // A project with no priced milestones needs no finance gate, and demanding
    // one would fail every project billed outside the milestone model.
    const fn = door('validate_project_plan');
    assert.match(fn, /pm\.payment_percent is not null/);
    assert.match(fn, /m\.payment_milestone_id = pm\.id/);
    assert.match(fn, /payment_milestones_not_mapped/);
  });

  test('every finding carries its count, not just its name', () => {
    // §18 is a checklist. "invalid" on its own is a refusal somebody has to go
    // and investigate.
    const fn = door('validate_project_plan');
    assert.equal((fn.match(/format\('[a-z_]+:%s'/g) ?? []).length, 4);
  });

  test('an unknown plan is a finding, not a crash', () => {
    assert.match(door('validate_project_plan'), /return query select false, array\['unknown_plan'\]::text\[\]/);
  });
});

describe('D. ProjectPlanReady is the activation, not a second event', () => {
  test('no new event type is declared', () => {
    // `project.plan_activated` already exists and already means this. A second
    // event meaning the same thing is noise in a closed registry.
    assert.doesNotMatch(SQL, /into core\.event_types/);
    assert.match(PROSE, /Rather than\s+add a second event meaning the same thing, the \*\*activation is gated\*\*/);
  });

  test('activation refuses an invalid plan and carries the findings', () => {
    const fn = door('activate_project_plan');
    assert.match(fn, /select \* into v_check from projects\.validate_project_plan\(v_plan\.id\)/);
    assert.match(fn, /if not v_check\.valid then/);
    assert.match(fn, /return query select 'invalid'::text, v_check\.findings, v_plan\.version/);
  });

  test('the door was carried forward with THREE marked edits, the third being the signature', () => {
    const rawStart = MIGRATION.indexOf('create or replace function projects.activate_project_plan');
    const v3 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$$;', rawStart));
    assert.equal((v3.match(/\[G-265 edit \d of 3\]/g) ?? []).length, 3);
    // The third edit is honest about touching every return: two marks over a
    // diff that changes nine lines would claim less change than there is.
    assert.match(v3, /adding that column changes EVERY/);

    // G-257's two marks survive: a carry-forward keeps the previous author's
    // marks rather than quietly absorbing them.
    assert.equal((v3.match(/\[G-257 edit \d of 2\]/g) ?? []).length, 2);
  });

  test('every line of the previous definition survives except the signature propagation', () => {
    const rawStart = MIGRATION.indexOf('create or replace function projects.activate_project_plan');
    const v3 = MIGRATION.slice(rawStart, MIGRATION.indexOf('$$;', rawStart));
    const prevStart = CLARIFICATION.indexOf('create or replace function projects.activate_project_plan');
    const v2 = CLARIFICATION.slice(prevStart, CLARIFICATION.indexOf('$$;', prevStart));

    const carried = v3.split('\n').map((l) => l.trim());
    const missing = v2
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'))
      // Every `return query select` gained a column — edit 3 of 3, mechanical
      // and identical on each. Excluded by SHAPE rather than by listing them,
      // so a semantic change hiding among them still fails.
      .filter((l) => !l.startsWith('return query select'))
      .filter((l) => !carried.includes(l));
    assert.deepEqual(missing, [], 'lines dropped in the carry-forward');
  });
});

describe('E. a changed return type needs an explicit drop', () => {
  test('the old function is dropped before the new one is created', () => {
    // `create or replace` cannot add a column to a RETURNS TABLE: those are
    // OUT parameters, so the signature changes and Postgres refuses. The first
    // draft did exactly that and the apply FAILED.
    assert.match(SQL, /drop function if exists projects\.activate_project_plan\(uuid\);/);
    assert.ok(
      SQL.indexOf('drop function if exists projects.activate_project_plan') <
        SQL.indexOf('create or replace function projects.activate_project_plan'),
    );
  });

  test('and the grant the drop removed is put back', () => {
    // G-256 granted this to `authenticated`. A drop takes that with it, and a
    // door nobody may call is a door that does not exist.
    assert.match(BLUEPRINT, /grant execute on function projects\.activate_project_plan\(uuid\) to authenticated;/);
    assert.match(SQL, /grant execute on function projects\.activate_project_plan\(uuid\) to authenticated;/);
    assert.match(SQL, /revoke all on function projects\.activate_project_plan\(uuid\) from public;/);
  });

  test('the lesson is recorded beside the drop, not just in a commit message', () => {
    assert.match(PROSE, /This is the same class as G-260's overload/);
    assert.match(PROSE, /caught because\s+`apply-migrations-locally\.sh` exits non-zero and prints the hint/);
  });

  test('the validator itself reads and writes nothing', () => {
    assert.match(SQL, /language plpgsql\s*\n\s*stable\s*\n\s*security invoker/);
    assert.doesNotMatch(door('validate_project_plan'), /insert into|update |delete from/i);
  });
});
