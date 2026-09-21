import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { region, TO_END } from './_region.ts';

/**
 * A default is not a decision — Designer §4; G-300.
 *
 * G-280 made the internal design gate refuse until a **named person** holds
 * it, which is right and has a cost: on a fresh project nobody does, so
 * nothing reaches Admin review until an Admin remembers to appoint somebody.
 *
 * So an organisation may name a default. The whole unit is one line about
 * what that default is **not**:
 *
 *   **A default seeds; it does not govern.**
 *
 * It is copied when a phase starts. Changing it later does not reach into
 * phases that already name somebody — one edit in Settings would otherwise
 * move a gate on every live project at once, overwriting decisions people
 * made deliberately.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920040000_a_default_is_not_a_decision.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const SETTINGS = read('src/lib/admin/settings.ts');
const ACTIONS = read('app/(internal)/settings/actions.ts');
const FORMS = read('app/(internal)/settings/forms.tsx');
const PAGE = read('app/(internal)/settings/team/page.tsx');

const door = region(SQL, 'create or replace function core.set_default_design_reviewer', '$$;');
const start = region(SQL, 'create or replace function projects.start_phase_three', '$$;');

describe('A. it seeds where nobody decided, and nowhere else', () => {
  test('only phases with a null reviewer are seeded', () => {
    // A null is an absence, not a choice. A phase that already names somebody
    // keeps them, because a preference must not overwrite a decision.
    assert.match(door, /update projects\.phase_three p3\s*\n\s*set reviewer_user_id = p_user_id\s*\n\s*where p3\.organization_id = v_org\s*\n\s*and p3\.reviewer_user_id is null/);
  });

  test('and the reason is recorded where the next reader will find it', () => {
    assert.match(PROSE, /A default \*\*seeds\*\*; it does not \*\*govern\*\*/);
    assert.match(PROSE, /overwritten by a preference/);
  });

  test('a completed phase is left alone too', () => {
    // Assigning a reviewer to a phase that has already finished would put a
    // name against a gate nobody will ever open.
    assert.match(door, /and p3\.state not in \('completed', 'blocked_requirement'\)/);
  });

  test('the seeded count is returned, not swallowed', () => {
    // Seeding writes rows the caller was not looking at. Telling them is the
    // difference between a setting and action at a distance.
    assert.match(SQL, /seeded\s+int/);
    assert.match(door, /select count\(\*\)::int into v_count from seeded;/);
    assert.match(PROSE, /because seeding is a write to rows the caller was not looking at/);
  });

  test('and clearing it seeds nothing', () => {
    assert.match(door, /if p_user_id is not null then\s*\n\s*with seeded as \(/);
  });
});

describe('B. a new phase starts with it, copied once', () => {
  test('the phase reads the default at start', () => {
    assert.match(start, /select o\.default_design_reviewer_id into v_reviewer/);
    assert.match(start, /values \(v_project\.organization_id, v_project\.id, v_phase_two\.id, 'context_loading', v_reviewer\)/);
  });

  test('copied, never looked up live', () => {
    // A phase that read the setting live would change reviewer whenever
    // Settings changed — the governing behaviour this design refuses.
    assert.match(PROSE, /a phase that looked the value up live would change reviewer whenever\s+Settings changed/);
  });

  test('and a reviewer who has left is not copied onto a new phase', () => {
    // The membership can disappear after the default was named, so it is
    // re-checked at the moment it is used rather than trusted from before.
    assert.match(start, /and exists \(\s*\n\s*select 1 from core\.memberships m\s*\n\s*where m\.user_id = o\.default_design_reviewer_id/);
  });
});

describe('C. only somebody on this roster may hold it', () => {
  test('the row refuses an outsider', () => {
    assert.match(SQL, /if not exists \(\s*\n\s*select 1 from core\.memberships m\s*\n\s*where m\.user_id = new\.default_design_reviewer_id\s*\n\s*and m\.organization_id = new\.id\s*\n\s*\) then\s*\n\s*raise exception/);
    assert.match(SQL, /create trigger enforce_default_reviewer_membership\s*\n\s*before insert or update of default_design_reviewer_id on core\.organizations/);
  });

  test('and the door answers it rather than raising', () => {
    assert.match(door, /return query select 'not_a_member'::text, 0; return;/);
  });

  test('the reason enforce_parent_org cannot express this is recorded', () => {
    // `core.users` has no organization_id — membership is the org-scoped fact.
    assert.match(PROSE, /`core\.users` has no `organization_id`/);
  });

  test('naming who holds a gate is an Admin act', () => {
    assert.match(door, /if not coalesce\(\(select core\.is_admin\(\)\), false\) then\s*\n\s*return query select 'not_admin'::text/);
  });
});

describe('D. G-281 fixed in the function this unit replaces', () => {
  test('start_phase_three no longer fails open on a NULL role', () => {
    // `not NULL` is NULL and plpgsql's `if` does not execute it.
    assert.match(start, /or not coalesce\(\(select core\.can_write\(\)\), false\)\)/);
    assert.doesNotMatch(start, /or not \(select core\.can_write\(\)\)\)/);
  });

  test('and the fix says why it was made here rather than left for G-281', () => {
    assert.match(PROSE, /rewriting a function and leaving a known fail-open inside it\s+would be worse than the scope creep of fixing it/);
  });
});

describe('E. the surface says what a default does and does not do', () => {
  test('the picker offers the roster the door accepts', () => {
    // A free-text id would make `not_a_member` the normal outcome of using it.
    assert.match(FORMS, /roster\.map\(\(m\) => \(/);
    assert.match(PAGE, /const roster = await listInternalRoster\(\);/);
  });

  test('and the wording tells somebody it will not move a decided gate', () => {
    assert.match(FORMS, /Projects where somebody is already named keep that person —\s*\n?\s*changing this does not move a gate a person decided\./);
  });

  test('the seeded count reaches the person, with a number', () => {
    assert.match(ACTIONS, /assigned to \$\{result\.data\.seeded\} project/);
    assert.match(ACTIONS, /Projects that already named somebody were left alone\./);
  });

  test('and zero seeded says so rather than implying an assignment', () => {
    assert.match(ACTIONS, /nothing already assigned was changed\./);
  });

  test('an empty roster says so rather than offering an empty picker', () => {
    assert.match(FORMS, /Nobody is on the roster yet, so there is nobody to name\./);
  });

  test('the service maps every outcome the door can give', () => {
    const svc = region(SETTINGS, 'export async function setDefaultDesignReviewer', TO_END);
    const outcomes = new Set([...door.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1] ?? ''));
    outcomes.delete('no_actor');
    const mapped = new Set([...svc.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] ?? ''));
    assert.deepEqual([...outcomes].filter((o) => !mapped.has(o)).sort(), []);
  });
});
