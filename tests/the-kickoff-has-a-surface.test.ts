import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KICKOFF_BLOCKERS, describeBlockers } from '../src/modules/projects/kickoff-blockers.ts';
import { region } from './_region.ts';

/**
 * The kickoff has a surface — Master §5.10, §5.11; G-263.
 *
 * G-250 through G-262 built the phase, the plan, four registers and a kickoff
 * gate, and left every one of them unreachable: internal-only tables nothing
 * rendered, behind doors nothing called. G-254 was the same shape for the
 * group card, and the same argument applies — a door with no surface is a
 * feature only somebody with database access has.
 *
 * What is asserted here is mostly what the panel refuses to do: predict the
 * gate, and pretend a message was sent.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const PANEL = read('app/(internal)/projects/[projectId]/phase-two-panel.tsx');
/** The panel's CODE alone: prose about what it must not do is not it doing so. */
const PANEL_CODE = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');
const QUERIES = read('src/modules/projects/queries.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
// From the DOC COMMENT, not the function: the reasoning this test checks for
// lives above the signature.
const READ = region(QUERIES, "Phase 2's state, its readiness and its plan", "The internal team roster every WhatsApp group card is prepared from");

describe('A. it does not predict the gate', () => {
  test('the blockers come back from the door, not from a copy here', () => {
    assert.match(PANEL, /describeBlockers\(readiness\?\.unmet \?\? \[\]\)/);
    // No client-side re-derivation of any gate.
    assert.doesNotMatch(PANEL_CODE, /advance_verified|onboarding_settled|group_ready|plan_ready|payment_verified/);
  });

  test('and the reason is written where the next reader will be', () => {
    assert.match(PANEL.replace(/\n\s*\*? ?/g, ' '), /A client-side copy of "the advance is not verified" goes stale the moment an Admin verifies it/);
  });

  test('every name the gate can return has a sentence', () => {
    for (const name of ['onboarding_incomplete', 'whatsapp_group_not_mapped', 'advance_not_verified', 'no_active_plan']) {
      assert.ok(KICKOFF_BLOCKERS[name], `${name} would render as a machine name`);
    }
  });

  test('an unknown blocker is still shown, not dropped', () => {
    assert.deepEqual(describeBlockers(['no_active_plan', 'invented_later']), [
      'There is no live operational plan for this project.',
      'invented_later',
    ]);
  });
});

describe('B. it does not pretend the kickoff was sent', () => {
  test('the form asks for the reference of a message a person sent', () => {
    assert.match(PANEL, /name="evidenceRef"/);
    assert.match(PANEL, /required/);
    assert.match(PANEL, /The reference of the kickoff message you sent/);
  });

  test('the button says who did the sending', () => {
    assert.match(PANEL, /I have sent the kickoff — complete Phase 2/);
    assert.match(PANEL, /AgencyOS cannot send the kickoff message — there is no channel\s*\n?\s*configured/);
  });

  test('nothing here sends anything', () => {
    // Narrowed to send MECHANISMS: the form's own label says "a WhatsApp
    // message id", which is the honest half — it tells the person what to
    // paste after sending it themselves.
    assert.doesNotMatch(PANEL_CODE, /sendMessage|dispatchMessage|fetch\(|graph\.facebook|api\.whatsapp/i);
    assert.match(PANEL, /a WhatsApp message id, an email id/);
    assert.doesNotMatch(region(ACTIONS, 'export async function recordKickoffAction'), /sendMessage|fetch\(/);
  });

  test('the form is offered only when every gate is met', () => {
    // Offering a control the door would refuse is a worse answer than not
    // offering one — the same rule the group card follows.
    assert.match(PANEL, /readiness\?\.ready \?/);
    assert.match(PANEL, /<KickoffForm projectId=\{projectId\} \/>/);
  });

  test('and not at all once Phase 2 is complete', () => {
    assert.match(PANEL, /const done = phase\.state === 'completed'/);
    assert.match(PANEL, /\{done \? \(/);
  });
});

describe('C. a project with no Phase 2 gets no panel', () => {
  test('it renders nothing rather than a panel full of zeroes', () => {
    // Every project converted before G-250 has no phase row. A panel claiming
    // "0 deliverables" would assert a phase that never started.
    assert.match(PANEL, /if \(!phase\) return null;/);
    assert.match(PANEL.replace(/\n\s*\/\/ ?/g, ' '), /gets nothing rather than a panel full of zeroes claiming a phase\s+exists/);
  });

  test('and the registers are counted only when a plan exists', () => {
    assert.match(READ, /if \(plan\) \{/);
    assert.match(READ, /counts = \{/);
  });
});

describe('D. the read keeps the discipline every reader here keeps', () => {
  test('a failed read is not an absent phase — on every query', () => {
    for (const scope of [
      'readPhaseTwo.phase',
      'readPhaseTwo.plan',
      'readPhaseTwo.readiness',
      // The four register counts guard separately rather than in a loop: a
      // `for (const read of …) if (read.error)` is invisible to the meta-test
      // that counts these, which would report this reader as dropping a
      // failure it does not drop.
      'readPhaseTwo.deliverables',
      'readPhaseTwo.dependencies',
      'readPhaseTwo.milestones',
      'readPhaseTwo.questions',
    ]) {
      assert.match(READ, new RegExp(`unreadable\\('${scope.replace('.', '\\.')}'`), `${scope} is unguarded`);
    }
  });

  test('and the reason it matters here is stated', () => {
    assert.match(
      READ.replace(/\n\s*\/\/ ?/g, ' '),
      /a panel that rendered "Phase 2 has not started" on a failed read would state something it does not know, and this one carries a kickoff button/,
    );
  });

  test('it is one read, not seven moments of the same project', () => {
    // Anchored on the THREE-WAY destructuring: the register counts below use
    // `Promise.all` too, so a bare match passes even when the main read has
    // been made sequential — which a red-proof proved by doing exactly that.
    assert.match(
      READ,
      /const \[\{ data: phase[^\]]*\] =\s*\n\s*await Promise\.all\(\[/,
    );
    // And the register counts are parallel as well.
    assert.match(READ, /\] = await Promise\.all\(\[\s*\n\s*supabase\.schema\('projects'\)\.from\('plan_deliverables'\)/);
    assert.match(READ.replace(/\n\s*\*? ?/g, ' '), /a panel that fired seven queries would show seven moments of the same project/);
  });
});

describe('E. it is wired', () => {
  test('the page reads it and renders it', () => {
    assert.match(PAGE, /const phaseTwo = await readPhaseTwo\(projectId\)/);
    assert.match(PAGE, /<PhaseTwoPanel view=\{phaseTwo\} projectId=\{projectId\} \/>/);
  });

  test('the action revalidates both the project and the list', () => {
    const block = region(ACTIONS, 'export async function recordKickoffAction');
    assert.match(block, /revalidatePath\(`\/projects\/\$\{projectId\}`\)/);
    assert.match(block, /revalidatePath\('\/projects'\)/);
  });

  test('and it surfaces the refusal rather than swallowing it', () => {
    const block = region(ACTIONS, 'export async function recordKickoffAction');
    assert.match(block, /if \(!result\.ok\) return \{ status: 'error', message: result\.error\.message \}/);
  });
});
