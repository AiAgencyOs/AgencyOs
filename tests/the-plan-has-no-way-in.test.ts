import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLAN_MILESTONE_KINDS, PLAN_PHASES } from '../src/modules/projects/plan-vocabulary.ts';
import { region } from './_region.ts';

/**
 * The plan had no way in — Project Planning §7; G-274.
 *
 * G-256 built the operational blueprint, G-257 the clarification loop, G-262
 * the milestone map, G-265 the validator. **Nothing called any of them.** A
 * repository-wide search for a caller of `src/modules/projects/planning.ts`
 * returned one function — `recordKickoff`, reached by G-263's panel — and
 * fourteen exports nobody could run.
 *
 * So G-263's Phase 2 panel read plan *counts* off a plan only somebody with
 * database access could have made, and the mandate's *"build the Project
 * Planning Agent"* had produced a blueprint the product could not produce.
 *
 * Fourth time this shape has been found in this sweep, after G-263, G-268 and
 * G-270 — and the one where the unreachable thing was a whole module.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const PAGE = read('app/(internal)/projects/[projectId]/plan/page.tsx');
const FORMS = read('app/(internal)/projects/[projectId]/plan/plan-forms.tsx');
const ACTIONS = read('src/modules/projects/actions.ts');
const PLAN_ACTIONS = region(ACTIONS, 'The operational plan — Project Planning §7', "Phase 3's gates");
const QUERIES = read('src/modules/projects/queries.ts');
const BOARD = region(QUERIES, 'The operational plan, in full', "What is still worth asking this client");
const PLANNING = read('src/modules/projects/planning.ts');

describe('A. every door the blueprint has is now reachable', () => {
  test('each planning write has an action, and each action has a form', () => {
    const wired: [string, string][] = [
      ['draftProjectPlan', 'DraftPlanForm'],
      ['addPlanDeliverable', 'AddDeliverableForm'],
      ['addPlanMilestone', 'AddMilestoneForm'],
      ['addPlanDependency', 'AddDependencyForm'],
      ['addPlanNote', 'AddNoteForm'],
      ['raiseClarification', 'RaiseClarificationForm'],
      ['activateProjectPlan', 'ActivatePlanForm'],
    ];
    for (const [fn, form] of wired) {
      assert.match(PLAN_ACTIONS, new RegExp(`await ${fn}\\(`), `${fn} has no action`);
      assert.match(FORMS, new RegExp(`export function ${form}`), `${form} does not exist`);
      assert.match(PAGE, new RegExp(`<${form}`), `${form} is never rendered`);
    }
  });

  test('the answer and settle halves of §10 are reachable too', () => {
    // A question that can be raised and never answered is a plan that can
    // never activate — G-257's two honest endings, both needed.
    assert.match(PLAN_ACTIONS, /await recordClarificationAnswer\(/);
    assert.match(PLAN_ACTIONS, /await resolveClarification\(/);
    assert.match(FORMS, /export function ClarificationRow/);
    assert.match(PAGE, /<ClarificationRow/);
  });

  test('and planning.ts is no longer a module with no callers', () => {
    // The assertion the gap was found by. It walks the repository rather than
    // naming a file, so deleting the plan page fails this test.
    const files: string[] = [];
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const next = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(next);
        else if (/\.tsx?$/.test(entry.name)) files.push(next);
      }
    };
    visit(root('src'));
    visit(root('app'));

    const callers = files.filter(
      (file) =>
        !file.endsWith('projects/planning.ts') &&
        /from '\.\/planning'|from '@\/modules\/projects\/planning'/.test(readFileSync(file, 'utf8')),
    );
    assert.ok(callers.length > 0, 'nothing imports planning.ts — the blueprint is unreachable again');
  });
});

describe('B. the vocabularies stay closed at the surface', () => {
  test('phases and kinds come from plan-vocabulary, not from the form', () => {
    // An eighth phase typed into a text box is a lifecycle invented in a
    // browser. The door would refuse it, but only after somebody wrote it.
    assert.match(FORMS, /import \{ PLAN_MILESTONE_KINDS, PLAN_PHASES \} from '@\/modules\/projects\/plan-vocabulary'/);
    assert.match(FORMS, /PLAN_PHASES\.map/);
    assert.match(FORMS, /PLAN_MILESTONE_KINDS\.map/);
    // The positive twin: those lists are non-empty, so a select built from
    // them is a real constraint rather than an empty dropdown.
    assert.equal(PLAN_PHASES.length, 6);
    assert.equal(PLAN_MILESTONE_KINDS.length, 3);
  });

  test('there is no free-text phase input anywhere in the forms', () => {
    assert.doesNotMatch(FORMS, /name="applicablePhase"\s+[^>]*type="text"/);
    assert.doesNotMatch(FORMS, /<input\s+name="phase"/);
  });

  test('approved scope is CHOSEN, never typed', () => {
    // §8 requires a deliverable to reference approved scope. A text box
    // invites the wrong UUID and G-256's foreign key then refuses it with a
    // message about a constraint.
    assert.doesNotMatch(FORMS, /<input\s+name="scopeItemId"/);
    assert.match(FORMS, /<select name="scopeItemId"/);
  });

  test('and only INCLUDED scope is offered', () => {
    // Excluded scope is not work, and G-265 does not expect a deliverable for
    // it. Offering it would invite a plan that fails its own validation.
    assert.match(FORMS, /scopeItems\.filter\(\(item\) => item\.inclusion === 'included'\)/);
  });
});

describe('C. nothing on the page decides what the database decides', () => {
  test('activation shows the validator’s findings rather than pre-judging', () => {
    assert.doesNotMatch(FORMS, /deliverables\.length === 0 \? 'disabled'/);
    assert.match(
      FORMS.replace(/\n\s*/g, ' '),
      /The validator runs in the database \(G-265\) and the findings come back as the refusal/,
    );
  });

  test('the `invalid` outcome is finally handled, with its findings', () => {
    // Found while wiring this up: G-265 added the outcome and a `findings`
    // column, and the TypeScript wrapper NEVER HANDLED IT — an invalid plan
    // fell through to the default branch and was refused with "you do not have
    // permission", which is wrong and unactionable.
    assert.match(PLANNING, /case 'invalid':/);
    assert.match(PLANNING, /row!\.findings \?\? \[\]/);
    assert.match(
      PLANNING.replace(/\n\s*\/\/ ?/g, ' '),
      /THIS WRAPPER NEVER HANDLED IT/,
    );
  });

  test('the page does not re-derive which questions are open', () => {
    // It filters what the database returned; it does not decide what "open"
    // means. `activate_project_plan` owns that.
    assert.match(PAGE, /c\.status !== 'resolved' && c\.status !== 'routed_to_change_request'/);
    assert.doesNotMatch(PAGE, /canActivate|isReady|readyToActivate/);
  });
});

describe('D. the read refuses rather than showing half a plan', () => {
  test('every register that fails to load refuses the whole read', () => {
    // A plan missing its risks reads as a plan with no risks, and somebody
    // activates it.
    assert.match(BOARD, /if \(planError\) unreadable\('readPlanBoard\.plan', planError\)/);
    assert.match(BOARD, /if \(scopeError\) unreadable\('readPlanBoard\.scope', scopeError\)/);
    assert.match(BOARD, /if \(boardError\) unreadable\('readPlanBoard\.registers', boardError\)/);
    assert.match(
      BOARD.replace(/\n\s*\/\/ ?/g, ' '),
      /A register that failed to load is not an empty register/,
    );
  });

  test('but NO plan is an answer, not a failure', () => {
    // Most projects have never had one drafted, and the page's whole job in
    // that case is to offer to start one.
    assert.match(BOARD, /if \(!planRow\) return empty;/);
    assert.match(BOARD.replace(/\n\s*\/\/ ?/g, ' '), /No plan is not a failed read/);
    assert.match(PAGE, /No plan yet/);
  });

  test('the registers are read in one pass, not eighteen round trips', () => {
    assert.match(BOARD, /await Promise\.all\(\[/);
  });
});

describe('E. the boundary §6 draws survives the new surface', () => {
  test('the page says what belongs to Phase 5, where somebody is working', () => {
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /Tables, APIs, coding tasks and UI belong to the Phase 5 Development Planning Agent/,
    );
  });

  test('and no form offers a field for any of it', () => {
    for (const forbidden of ['schema', 'endpoint', 'api_contract', 'framework', 'wireframe', 'codingTask']) {
      assert.doesNotMatch(FORMS, new RegExp(`name="${forbidden}`), `a form collects ${forbidden}`);
    }
  });

  test('planning is gated on project.write, and the doors check again', () => {
    assert.match(PAGE, /const mayPlan = can\(context\.role, 'project\.write'\)/);
    assert.match(
      PAGE.replace(/\n\s*\/\/ ?/g, ' '),
      /The doors check it again — this only decides what to render/,
    );
  });
});
