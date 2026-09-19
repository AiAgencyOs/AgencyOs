import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * The loop has two endings, and the gate has a hand — Project Planning §10,
 * §15; Master §5.10.
 *
 * Found by a caller sweep, not by reading a document. G-274 was raised because
 * `planning.ts` had **fourteen exports and one caller**; it wired the plan,
 * the registers and three of §10's four transitions, and left three doors and
 * a reader behind:
 *
 *   `mark_clarification_asked`  — §10's "a person records that the question
 *   has been put to the client". Without it, *waiting on the client* and
 *   *nobody has asked yet* looked identical on the board.
 *
 *   `route_clarification_to_change_request` — §10's SECOND ending. Without it,
 *   a question that turned out to be new work had to be settled as though the
 *   client had answered it, which is the one thing §10 exists to stop.
 *
 *   `gate_plan_milestone` — §15's *"which dependency gates which milestone"*.
 *   The milestone map existed and nothing could make a milestone wait.
 *
 *   `readPreKickoffReadiness` — not a missing surface but a **second reader**
 *   of the same fact, already diverged from the one with a caller on what a
 *   failed read means. Deleted rather than wired.
 *
 * Each door kept its refusals and its tests the whole time. **A tested door
 * with no caller is still a feature nobody has.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ACTIONS = read('src/modules/projects/actions.ts');
const FORMS = read('app/(internal)/projects/[projectId]/plan/plan-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/plan/page.tsx');
const QUERIES = read('src/modules/projects/queries.ts');
const PLANNING = read('src/modules/projects/planning.ts');

const askAction = region(ACTIONS, 'export async function markClarificationAskedAction', '\nexport async function ');
const routeAction = region(ACTIONS, 'export async function routeClarificationAction', '\nexport async function ');
const gateAction = region(ACTIONS, 'export async function gatePlanMilestoneAction', '\nexport async function ');
const row = region(FORMS, 'export function ClarificationRow', '\nexport function ');
const gateForm = region(FORMS, 'export function GateMilestoneForm', '\nexport function ');

describe('A. every door in planning.ts now has a caller', () => {
  test('the three doors are reached through Server Actions', () => {
    assert.match(askAction, /await markClarificationAsked\(String\(formData\.get\('clarificationId'\) \?\? ''\)\)/);
    assert.match(routeAction, /await routeClarificationToChangeRequest\(\{/);
    assert.match(gateAction, /await gatePlanMilestone\(\{/);
  });

  test('and the actions are imported from planning, not reimplemented', () => {
    assert.match(ACTIONS, /^\s+gatePlanMilestone,$/m);
    assert.match(ACTIONS, /^\s+markClarificationAsked,$/m);
    assert.match(ACTIONS, /^\s+routeClarificationToChangeRequest,$/m);
  });

  test('each revalidates the plan path, so the board is not read from a cache', () => {
    for (const [name, block] of [['ask', askAction], ['route', routeAction], ['gate', gateAction]] as const) {
      assert.match(block, /planPath\(projectId\);/, `${name} does not revalidate`);
    }
  });

  test('and a refusal is surfaced rather than swallowed', () => {
    // Every one of these doors answers a policy refusal — `already_asked`,
    // `wrong_project`, `not_draft` — and the message is what the person needs.
    for (const [name, block] of [['ask', askAction], ['route', routeAction], ['gate', gateAction]] as const) {
      assert.match(
        block,
        /if \(!result\.ok\) return \{ status: 'error', message: result\.error\.message \};/,
        `${name} does not surface the refusal`,
      );
    }
  });
});

describe('B. what the buttons claim, and what they do not', () => {
  test('asking records that a PERSON asked — it does not send', () => {
    // There is no channel on this deployment (BLK-003, BLK-007). A button
    // that said "ask the client" would claim a message nobody can produce.
    assert.match(row, /I have put this to the client/);
    assert.doesNotMatch(row, /Ask the client|Send the question/i);
    assert.match(row, /Past tense, and about a person/);
    assert.match(askAction, /Not "sent": there is no channel on this deployment/);
  });

  test('the ask is offered only while the question is still open', () => {
    // `already_asked` is a refusal, not a state to invite somebody into.
    assert.match(row, /\{clarification\.status === 'open' \? \(/);
  });

  test('routing is offered before an answer exists, and that is deliberate', () => {
    // A PM often knows it is new work before the client replies; requiring an
    // answer first would put words in the client's mouth to reach the right
    // outcome — the exact thing §10 exists to stop.
    assert.match(row, /a PM often knows it is new work before the client replies/);
    assert.match(row, /\{settled \|\| changeRequests\.length === 0 \? null : \(/);
  });

  test('and a settled question offers neither', () => {
    assert.match(
      row,
      /const settled = clarification\.status === 'resolved' \|\| clarification\.status === 'routed_to_change_request';/,
    );
  });
});

describe('C. the pickers offer only what the door accepts', () => {
  test('routing offers this project’s change requests and nothing else', () => {
    // `route_clarification_to_change_request` answers `wrong_project`, and
    // that refusal exists because routing onto another project's change
    // request would price one client's new work onto another's.
    assert.match(QUERIES, /\.from\('change_requests'\)\s*\n\s*\.select\('id, requested, status'\)\s*\n\s*\.eq\('project_id', projectId\)/);
    assert.match(QUERIES, /routing a\s*\n\s*\* clarification onto another project's change request would price one\s*\n\s*\* client's new work onto another's/);
  });

  test('gating offers this plan’s dependencies, minus the ones already gated', () => {
    // The door refuses both (`different_plan`, `already_gated`); offering them
    // would make a refusal the normal result of using the control.
    assert.match(gateForm, /const offerable = dependencies\.filter\(\(d\) => !gatedDependencyIds\.includes\(d\.id\)\);/);
    assert.match(gateForm, /offering them anyway would make a refusal the normal\s*\n\s*\/\/ result of using the control/);
  });

  test('and a control with nothing to offer is not rendered', () => {
    assert.match(gateForm, /if \(offerable\.length === 0\) return null;/);
  });

  test('the gates are shown in the dependency’s own words, not as ids', () => {
    assert.match(PAGE, /Waits on: \{gated\.map\(\(d\) => d\.description\)\.join\('; '\)\}/);
  });

  test('and a gate from another plan cannot be rendered on this one', () => {
    assert.match(QUERIES, /\.filter\(\(row\) => \(milestones\.data \?\? \[\]\)\.some\(\(m\) => m\.id === row\.milestone_id\)\)/);
  });

  test('both new reads join the register refusal rather than defaulting to empty', () => {
    // A register that failed to load is not an empty register — a plan
    // missing its gates reads as a plan that waits on nothing.
    assert.match(QUERIES, /\?\? changeRequests\.error \?\? gates\.error;/);
  });
});

describe('D. the gate control respects the plan’s own freeze', () => {
  test('it is offered only on a draft plan', () => {
    // `gate_plan_milestone` answers `not_draft`, and an active plan is frozen
    // by `refuse_write_to_settled_plan` underneath that.
    assert.match(PAGE, /\{mayPlan && plan\.status === 'draft' \? \(\s*\n\s*<GateMilestoneForm/);
  });
});

describe('E. the second reader is gone, not wired', () => {
  test('readPreKickoffReadiness no longer exists', () => {
    assert.doesNotMatch(PLANNING, /export async function readPreKickoffReadiness/);
    assert.doesNotMatch(PLANNING, /export type PreKickoffReadiness/);
  });

  test('and the reader that survived is the one with a caller', () => {
    // The panel's other two reads were already here, and this one raises
    // through `unreadable()` (G-054) rather than returning err('INTERNAL') —
    // the two copies had already diverged on what a failed read means.
    assert.match(QUERIES, /supabase\.schema\('projects'\)\.rpc\('pre_kickoff_readiness', \{ p_project_id: projectId \}\),/);
    assert.match(QUERIES, /if \(gateError\) unreadable\('readPhaseTwo\.readiness', gateError\);/);
  });

  test('the deletion says why, where the next author will look for it', () => {
    assert.match(PLANNING, /\*\*Two readers of one fact is the problem, not the duplication\.\*\*/);
    assert.match(PLANNING, /one copy\s*\n \* would have rendered "not ready" for a dropped connection while the other\s*\n \* refused to answer/);
  });

  test('and the four per-condition booleans went with it', () => {
    // `describeBlockers` reads the `unmet` list, which is the document's own
    // wording; the booleans were a second spelling of the same answer.
    assert.doesNotMatch(PLANNING, /onboardingSettled|groupReady: /);
    assert.match(read('src/modules/projects/kickoff-blockers.ts'), /unmet/);
  });
});
