import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The order is the control — Master §7.7, §7.8, §16, §21; PM §7, §8; G-280.
 *
 * Master §16 and PM §7 state one rule twice:
 *
 *   FIGMA DESIGNER → INTERNAL REVIEW → ADMIN REVIEW → PM → CLIENT
 *
 * and PM §7 adds the sentence that makes it non-negotiable: *"PM is not
 * allowed to collapse or skip gates merely to speed up communication."*
 *
 * The whole unit is one refusal with supporting cast: **an option whose
 * internal review has not passed cannot be Admin-decided.** Without that
 * single line the order is advice.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919120000_the_order_is_the_control.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const PERMISSIONS = read('src/lib/authz/permissions.ts');

const fn = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the refusal that makes the order real', () => {
  test('Admin cannot decide an option internal review has not passed', () => {
    // Not a warning, not a flag. Proven on a scratch Postgres: the call
    // answers not_internally_passed and nothing changes.
    assert.match(fn('submit_admin_design_decision'), /if v_theme\.internal_review_status <> 'passed' then/);
    assert.match(fn('submit_admin_design_decision'), /'not_internally_passed'::text/);
    assert.match(PROSE, /Without this single refusal the order is advice/);
  });

  test('and it is checked BEFORE anything is written', () => {
    const body = fn('submit_admin_design_decision');
    assert.ok(body.indexOf("'not_internally_passed'") < body.indexOf('insert into projects.admin_design_decisions'));
  });

  test('Admin EDIT returns the INTERNAL gate too, not just its own', () => {
    // §16: "Admin EDIT always returns to Designer and then internal review
    // before Admin again." PM §8: "never skip internal re-review." Leaving it
    // `passed` would let the next Admin call straight through.
    const body = fn('submit_admin_design_decision');
    assert.match(body, /set admin_status = 'edit_requested',\s*\n\s*internal_review_status = 'changes_required'/);
    assert.match(PROSE, /an option that has been revised has not\s+been reviewed/);
  });

  test('an edit names why, and a review that returns work says what', () => {
    // The PREDICATE, not the name. A red-proof replacing the body with
    // `check (true)` left the name in place and this test green — the same
    // class as asserting the sentence beside a guard rather than the guard.
    assert.match(SQL, /constraint admin_design_decisions_edit_says_why\s*\n\s*check \(decision <> 'edit'\s*\n\s*or \(reason is not null and length\(btrim\(reason\)\) > 0\)\)/);
    assert.match(SQL, /constraint design_reviews_changes_say_what\s*\n\s*check \(result <> 'changes_required'\s*\n\s*or \(comments is not null and length\(btrim\(comments\)\) > 0\)\)/);
    assert.match(fn('submit_admin_design_decision'), /'needs_reason'::text/);
    assert.match(fn('submit_internal_design_review'), /'needs_comments'::text/);
    assert.match(PROSE, /a correction nobody described is a correction nobody can make/);
  });
});

describe('B. who may run each gate', () => {
  test('the internal reviewer is the ASSIGNED person, not a capability', () => {
    // Master §4 names the Internal Design Reviewer as an actor. A capability
    // check would let any delivery lead stand in for that person.
    assert.match(fn('submit_internal_design_review'), /if v_phase3\.reviewer_user_id is distinct from v_actor then/);
    assert.match(fn('submit_internal_design_review'), /'not_the_reviewer'::text/);
    assert.match(PROSE, /a capability check would let any delivery lead\s+stand in for the person §4 names/);
  });

  test('a project with no reviewer refuses rather than letting the first caller through', () => {
    // G-277 left the column nullable so an unassigned gate would be visible.
    // This is where that becomes load-bearing rather than decorative.
    assert.match(fn('submit_internal_design_review'), /if v_phase3\.reviewer_user_id is null then/);
    assert.match(fn('submit_internal_design_review'), /'no_reviewer_assigned'::text/);
  });

  test('the Admin gate reuses the role set project.sign_off was created for', () => {
    // And that capability's own comment explains why delivery_lead is out:
    // "a delivery lead declaring their own work production ready is the review
    // signing its own homework." The same sentence is true here.
    assert.match(fn('submit_admin_design_decision'), /core\.is_admin\(\)/);
    assert.match(PERMISSIONS, /the review signing its\s*\n\s*\/\/ own homework/);
    assert.match(PROSE, /The capability was written for this shape\s+before this phase existed/);
  });

  test('naming the reviewer is itself an Admin act', () => {
    // Choosing who holds a gate is an authority decision, not routine work.
    assert.match(fn('assign_design_reviewer'), /core\.is_admin\(\)/);
    assert.match(fn('assign_design_reviewer'), /from core\.memberships m/);
    assert.match(fn('assign_design_reviewer'), /'unknown_user'::text/);
    assert.match(PROSE, /somebody outside the agency cannot hold an internal gate/i);
  });
});

describe('C. the authority guards do not fail open', () => {
  test('every authority check is coalesced against a NULL role', () => {
    // `core.current_user_role()` reads the role from the token. A token
    // without one makes `is_admin()` NULL — and `not NULL` is NULL, which an
    // `if` does not execute. The guard would fail OPEN.
    //
    // Found by driving it: a hand-made token with an organization but no role
    // walked straight through the Admin gate. Not exploitable in production —
    // the auth hook writes both claims together or neither — but a guard
    // should not depend on a distant invariant staying true.
    assert.equal((SQL.match(/coalesce\(\(select core\.is_admin\(\)\), false\)/g) ?? []).length, 2);
    assert.equal((SQL.match(/coalesce\(\(select core\.can_write\(\)\), false\)/g) ?? []).length, 1);
    assert.doesNotMatch(SQL, /not \(select core\.(is_admin|can_write)\(\)\)/);
  });

  test('and the reason is recorded where the next reader will be', () => {
    assert.match(PROSE, /The guard would\s+fail OPEN/);
    assert.match(PROSE, /Raised for the other\s+52 call sites as G-281/);
  });

  test('the auth hook is what makes it safe today, and that is asserted', () => {
    // The positive twin: if the hook ever stopped writing them together, the
    // org check would stop masking a missing role.
    const hook = read('supabase/migrations/20260807120011_auth_hook.sql');
    assert.match(hook, /'organization_id', v_membership\.organization_id,\s*\n\s*'role', v_membership\.role/);
  });
});

describe('D. two gates, two tables, two vocabularies', () => {
  test('internal review has no word for approval', () => {
    // Approving is the Admin's word and this gate does not hold that
    // authority. A third value here would let the quality gate grant it.
    assert.match(SQL, /result\s+text not null check \(result in \('passed', 'changes_required'\)\)/);
  });

  test('the Admin decision has no word for rejection', () => {
    // EDIT is not a rejection: the option comes back.
    assert.match(SQL, /decision\s+text not null check \(decision in \('confirm', 'edit'\)\)/);
    assert.match(PROSE, /EDIT is not a rejection: the option comes back/);
  });

  test('each review and decision names the exact version it judged', () => {
    // Designer §14: "reviewer receives exact artifact/version." A review of
    // "the theme" is a review of whatever the theme happens to be later.
    assert.equal((SQL.match(/option_version\s+int not null check \(option_version > 0\)/g) ?? []).length, 2);
  });

  test('the Admin decision names the review it followed', () => {
    // §16 requires Admin to see the review evidence, so the decision records
    // which one it saw. Proven on a scratch Postgres for both confirm and edit.
    assert.match(SQL, /design_review_id uuid references projects\.design_reviews\(id\)/);
    assert.match(fn('submit_admin_design_decision'), /and r\.result = 'passed'\s*\n\s*order by r\.created_at desc/);
  });

  test('the reviewer is a person, with no agent column beside them', () => {
    assert.match(SQL, /reviewer_user_id uuid not null references core\.users\(id\)/);
    assert.doesNotMatch(SQL, /reviewer_agent|reviewed_by_agent/);
  });
});

describe('E. neither gate touches the client', () => {
  test('the internal review never writes client_status', () => {
    assert.doesNotMatch(fn('submit_internal_design_review'), /client_status/);
  });

  test('and neither does the Admin decision', () => {
    // Admin approval makes an option ELIGIBLE to be shared; the sharing is
    // PM's act and its own unit.
    assert.doesNotMatch(fn('submit_admin_design_decision'), /client_status\s*=/);
  });

  test('nothing here messages anybody', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp/i);
  });

  test('and the client-share gate is named as a sequence, not forgotten', () => {
    assert.match(PROSE, /It is named here so its absence reads as a sequence\s+rather than an omission/);
  });
});

describe('F. the phase follows the artifact', () => {
  test('a passed review moves to Admin review; a returned one to the designer', () => {
    assert.match(fn('submit_internal_design_review'), /case when p_result = 'passed' then 'admin_review' else 'waiting_designer' end/);
  });

  test('a confirm opens client review; an edit goes back to the designer', () => {
    assert.match(fn('submit_admin_design_decision'), /case when p_decision = 'confirm' then 'client_review' else 'waiting_designer' end/);
  });

  test('an Admin who changes their mind BEFORE the client saw anything can', () => {
    // Found by driving it: without `client_review` in the guard the phase
    // stayed at client_review while the option had gone back to the designer —
    // a screen telling somebody the wrong thing. §16's "final selection cannot
    // be overwritten" is about the CLIENT's choice, and there is none yet.
    assert.match(fn('submit_admin_design_decision'), /'waiting_designer', 'client_review'\)/);
    assert.match(PROSE, /the client has not made one/);
  });

  test('an option Admin already approved cannot be quietly re-reviewed', () => {
    // Re-reviewing it would silently un-approve it.
    assert.match(fn('submit_internal_design_review'), /if v_theme\.admin_status = 'approved' then/);
    assert.match(fn('submit_internal_design_review'), /'already_approved'::text/);
  });
});

describe('G. the guards every table and door here carries', () => {
  test('both tables are tenancy-guarded on every org-scoped key', () => {
    assert.match(SQL, /core\.enforce_parent_org\('theme_option_id', 'projects\.theme_options'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('design_review_id', 'projects\.design_reviews'\)/);
    assert.equal((SQL.match(/core\.freeze_organization_id\(\)/g) ?? []).length, 2);
  });

  test('RLS on both, forced, internal-only, no write policy', () => {
    for (const t of ['design_reviews', 'admin_design_decisions']) {
      assert.match(SQL, new RegExp(`alter table projects\\.${t} enable row level security`));
      assert.match(SQL, new RegExp(`alter table projects\\.${t} force row level security`));
    }
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  for (const name of ['submit_internal_design_review', 'submit_admin_design_decision', 'assign_design_reviewer']) {
    test(`${name} refuses a null actor and is security definer`, () => {
      const body = fn(name);
      assert.match(body, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
      assert.match(body, /'no_actor'::text/);
      assert.match(body, /security definer\s*\nset search_path = ''/);
      assert.match(body, /for update/);
    });
  }

  test('bad vocabulary is refused on the ARGUMENT, before the row', () => {
    const review = fn('submit_internal_design_review');
    const admin = fn('submit_admin_design_decision');
    assert.ok(review.indexOf("'bad_result'") < review.indexOf('for update'));
    assert.ok(admin.indexOf("'bad_decision'") < admin.indexOf('for update'));
  });

  test('all four events are declared, and none of them reaches a client', () => {
    for (const e of ['internal_design_passed', 'internal_design_changes_required',
                     'admin_design_approved', 'admin_design_edit_requested']) {
      assert.match(SQL, new RegExp(`'project\\.${e}'`), `${e} is not declared`);
    }
    assert.match(SQL, /Nothing reaches a client on this event/);
  });

  test('none of the three doors is callable by the world', () => {
    assert.equal((SQL.match(/revoke all on function projects\.(submit_internal_design_review|submit_admin_design_decision|assign_design_reviewer)/g) ?? []).length, 3);
  });
});
