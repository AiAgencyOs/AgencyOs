import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The gates have a surface — Master §10, §16; Designer §15; PM §7; G-287.
 *
 * G-280 built the gate order and G-286 rendered the trail it produces.
 * Between them sat three doors nothing called: `submit_internal_design_review`,
 * `submit_admin_design_decision` and `assign_design_reviewer`. The order was
 * enforceable and could not be exercised — the built-and-unreachable defect,
 * one layer above the tables G-286 fixed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/design.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const GATES = read('supabase/migrations/20260919120000_the_order_is_the_control.sql');
const QUERIES = read('src/modules/projects/queries.ts');

const DOORS = ['submit_internal_design_review', 'submit_admin_design_decision', 'assign_design_reviewer'];

/** Every outcome a door can return, read from the door itself. */
function outcomesOf(fn: string): Set<string> {
  const start = GATES.indexOf(`create or replace function projects.${fn}`);
  assert.ok(start > 0, `${fn} does not exist`);
  const body = GATES.slice(start, GATES.indexOf('$$;', start));
  return new Set([...body.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1] ?? ''));
}

describe('A. every outcome the doors can return is handled', () => {
  test('nothing the door says is left to the default branch by accident', () => {
    // The meta-invariant. A door that grows a new refusal would otherwise
    // reach a person as "you do not have permission", which is both wrong and
    // the least actionable thing it could say.
    const mapped = new Set([...SERVICE.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] ?? ''));
    const all = new Set(DOORS.flatMap((d) => [...outcomesOf(d)]));

    // `no_actor` is deliberately the default branch: a caller with no session
    // is the permission case, and this layer is behind requireInternal anyway.
    all.delete('no_actor');

    assert.deepEqual([...all].filter((o) => !mapped.has(o)).sort(), [], 'a door outcome reaches nobody');
  });

  test('and nothing is mapped that no door returns', () => {
    // Dead branches rot: the next reader trusts them as documentation of what
    // can happen.
    const mapped = new Set([...SERVICE.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] ?? ''));
    const all = new Set(DOORS.flatMap((d) => [...outcomesOf(d)]));
    assert.deepEqual([...mapped].filter((o) => !all.has(o)).sort(), [], 'an outcome is handled that cannot happen');
  });

  test('two different problems get two different messages', () => {
    // `no_reviewer_assigned` needs somebody appointed; `not_the_reviewer`
    // needs a different person. One message for both leaves the reader to
    // guess which.
    assert.match(SERVICE, /No internal design reviewer is assigned to this project/);
    assert.match(SERVICE, /Only the assigned internal design reviewer may record this review/);
  });

  test('the sentence §16 exists for is the one a person is shown', () => {
    assert.match(SERVICE, /The order is designer, internal review, then Admin — it cannot be collapsed to move faster/);
  });
});

describe('B. an edit is the rejection, and there is no third word', () => {
  test('the Admin form offers confirm and edit only', () => {
    // §7.8 gives CONFIRM and EDIT and no more. A reject button would invent a
    // state the gate does not have.
    assert.match(FORMS, /name="decision" value="confirm"/);
    assert.match(FORMS, /name="decision"\s+value="edit"/);
    assert.doesNotMatch(FORMS, /value="reject"|value="rejected"/);
  });

  test('and the form says what an edit does, because it does more than it sounds like', () => {
    assert.match(FORMS, /An edit returns the option to the designer and runs\s*\n?\s*internal review again/);
  });

  test('the internal gate has no word for approval', () => {
    // Approving is the Admin's word; that gate does not hold the authority.
    assert.match(FORMS, /name="result" value="passed"/);
    assert.match(FORMS, /name="result"\s+value="changes_required"/);
    assert.doesNotMatch(FORMS, /result" value="approved"/);
  });
});

describe('C. what is offered comes from the stored status', () => {
  test('the internal form appears while the option has not passed', () => {
    assert.match(PAGE, /mayDecide && t\.internalReviewStatus !== 'passed' && t\.adminStatus !== 'approved' \? \(\s*\n\s*<InternalReviewForm/);
  });

  test('the Admin form appears only after it has', () => {
    // Not a re-derivation of the gate: the door refuses `not_internally_passed`
    // regardless. This decides what to render, and the two agree because both
    // read the same stored column.
    assert.match(PAGE, /mayDecide && t\.internalReviewStatus === 'passed' && t\.adminStatus !== 'approved' \? \(\s*\n\s*<AdminDecisionForm/);
  });

  test('and neither form re-implements a rule the door holds', () => {
    // The two rules no capability can express: the assigned reviewer, and the
    // internal pass. Nothing here checks either.
    assert.doesNotMatch(FORMS, /reviewerUserId|internalReviewStatus|adminStatus/);
    assert.match(FORMS, /they do not decide what is submittable/);
  });

  test('an approved option offers nothing further', () => {
    // Both conditions exclude `adminStatus === 'approved'`, so a confirmed
    // option cannot be quietly re-decided from this page.
    assert.equal((PAGE.match(/t\.adminStatus !== 'approved'/g) ?? []).length, 2);
  });
});

describe('D. only these two gates, and deliberately so', () => {
  test('nothing here shares, records a client reply, revises or locks', () => {
    // Those have their own preconditions, and a button for them beside the
    // review gates would let somebody skip forward through the order these
    // gates exist to hold.
    for (const door of ['record_design_share', 'record_client_design_decision',
                        'open_design_revision', 'lock_phase_three_direction']) {
      assert.ok(!FORMS.includes(door) && !PAGE.includes(door), `${door} has a surface it should not`);
    }
    assert.match(PAGE, /\*\*Every other door in this phase is deliberately still absent\.\*\*/);
  });

  test('and the service exposes exactly the three doors this unit is for', () => {
    assert.deepEqual(
      [...SERVICE.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort(),
      ['assignDesignReviewer', 'submitAdminDesignDecision', 'submitInternalDesignReview'],
    );
  });
});

describe('E. the reviewer can actually be appointed', () => {
  test('the picker offers the roster the door will accept', () => {
    // A free-text id field would make `unknown_user` the normal outcome of
    // using it.
    assert.match(QUERIES, /export async function listInternalRoster/);
    assert.match(QUERIES, /\.from\('memberships'\)/);
    assert.match(FORMS, /roster\.map\(\(m\) => \(/);
  });

  test('and that read refuses rather than rendering an empty roster', () => {
    // G-054. An empty picker would say "nobody works here".
    assert.match(QUERIES, /if \(error\) unreadable\('listInternalRoster', error\)/);
  });

  test('an empty roster says so rather than offering an empty dropdown', () => {
    assert.match(FORMS, /Nobody is on this organisation’s roster yet/);
  });

  test('the overview says what an unassigned gate costs', () => {
    assert.match(PAGE, /The internal gate refuses until somebody holds\s*\n?\s*it, and nothing reaches Admin until it passes/);
  });
});

describe('F. the surface is wired and refreshes what it changed', () => {
  test('every action revalidates the page the outcome shows on', () => {
    // A gate that recorded a decision and left the trail reading as it did a
    // moment ago would look like it had not worked.
    const designActions = ACTIONS.slice(ACTIONS.indexOf("Phase 3's gates"));
    assert.equal((designActions.match(/revalidatePath\(`\/projects\/\$\{projectId\}\/design`\)/g) ?? []).length, 3);
  });

  test('the service is behind a capability check', () => {
    assert.match(SERVICE, /async function designActor\(\)[\s\S]{0,300}?if \(!can\(context\.role, 'project\.write'\)\)/);
    assert.equal((SERVICE.match(/const gate = await designActor\(\);/g) ?? []).length, 3);
  });

  test('and the page does not offer a form to somebody who cannot submit it', () => {
    assert.match(PAGE, /const mayDecide = can\(context\.role, 'project\.write'\);/);
  });

  test('the doors are reached by name, not by string building', () => {
    for (const door of DOORS) {
      assert.match(SERVICE, new RegExp(`\\.rpc\\('${door}'`), `${door} is not called`);
    }
  });
});
