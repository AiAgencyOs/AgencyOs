import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * P4-UID-CLIENT-REVIEW's three doors get a form — `share_ui_version_with_
 * client`, `record_ui_version_client_decision`, `lock_ui_version`
 * (`20260923140000`) were real, tested, callable, and reachable only via
 * API/psql. `phase-four-forms.tsx` is that form, one per state the version
 * is actually in, the same "the form appears when the gate is open"
 * discipline `design-forms.tsx` keeps for Phase 3's identical shape.
 *
 * The point of this unit: nothing here decides whether a share, a decision
 * or a lock is allowed. Every server action is a thin wrapper that calls the
 * door and reports its outcome — the authority check happens once, in the
 * door, under its own row lock.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE_TS = read('src/modules/projects/service.ts');
const ACTIONS_TS = read('src/modules/projects/actions.ts');
const FORMS_TSX = read('app/(internal)/projects/[projectId]/phase-four-forms.tsx');

const shareFn = region(SERVICE_TS, 'export async function shareUiVersionWithClient', TO_END);
const decisionFn = region(SERVICE_TS, 'export async function recordUiVersionClientDecision', TO_END);
const lockFn = region(SERVICE_TS, 'export async function lockUiVersion', TO_END);

describe('A. the service layer is a thin wrapper, not a second opinion', () => {
  test('every write goes through uiVersionActor, the same project.write gate design.ts uses for Phase 3', () => {
    for (const fn of [shareFn, decisionFn, lockFn]) {
      assert.match(fn, /const gate = await uiVersionActor\(\);/);
      assert.match(fn, /if \(!gate\.ok\) return gate;/);
    }
  });

  test('shareUiVersionWithClient calls the real RPC with the exact parameter names the migration declares', () => {
    assert.match(shareFn, /\.rpc\('share_ui_version_with_client', \{/);
    assert.match(shareFn, /p_ui_version_id: input\.uiVersionId,/);
    assert.match(shareFn, /p_evidence_ref: input\.evidenceRef,/);
  });

  test('recordUiVersionClientDecision carries all five parameters, evidence and conversation optional', () => {
    assert.match(decisionFn, /\.rpc\('record_ui_version_client_decision', \{/);
    assert.match(decisionFn, /p_ui_version_id: input\.uiVersionId,/);
    assert.match(decisionFn, /p_decision: input\.decision,/);
    assert.match(decisionFn, /p_client_words: input\.clientWords,/);
    assert.match(decisionFn, /p_evidence_ref: input\.evidenceRef \?\? null,/);
    assert.match(decisionFn, /p_conversation_id: input\.conversationId \?\? null,/);
  });

  test('lockUiVersion calls the door with only the one parameter it takes', () => {
    assert.match(lockFn, /\.rpc\('lock_ui_version', \{/);
    assert.match(lockFn, /p_ui_version_id: uiVersionId,/);
  });
});

describe('B. every outcome the door can answer is a distinct message, not a flattened failure', () => {
  test('share: shared, wrong_state, unknown_version, and a forbidden default', () => {
    for (const outcome of ['shared', 'wrong_state', 'unknown_version']) {
      assert.match(shareFn, new RegExp(`case '${outcome}':`));
    }
  });

  test('decision: recorded, bad_decision, wrong_state, unknown_version, and a forbidden default', () => {
    for (const outcome of ['recorded', 'bad_decision', 'wrong_state', 'unknown_version']) {
      assert.match(decisionFn, new RegExp(`case '${outcome}':`));
    }
  });

  test('lock: locked and already_locked are BOTH success — two people clicking see the same picture', () => {
    assert.match(lockFn, /case 'locked':\s*\n\s*return ok\(\{ uiVersionId: row\?\.ui_version_id \?\? null, alreadyLocked: false \}\);/);
    assert.match(lockFn, /case 'already_locked':\s*\n\s*return ok\(\{ uiVersionId: row\?\.ui_version_id \?\? null, alreadyLocked: true \}\);/);
  });
});

describe('C. the server actions are reachable from the real actions.ts export surface', () => {
  test('all three are exported and imported from ./service', () => {
    assert.match(ACTIONS_TS, /shareUiVersionWithClient,\s*\n\s*recordUiVersionClientDecision,\s*\n\s*lockUiVersion,\s*\n\} from '\.\/service';/);
    assert.match(ACTIONS_TS, /export async function shareUiVersionWithClientAction/);
    assert.match(ACTIONS_TS, /export async function recordUiVersionClientDecisionAction/);
    assert.match(ACTIONS_TS, /export async function lockUiVersionAction/);
  });

  test('each action revalidates the project page it changed', () => {
    const shareAction = region(ACTIONS_TS, 'export async function shareUiVersionWithClientAction', TO_END);
    const decisionAction = region(ACTIONS_TS, 'export async function recordUiVersionClientDecisionAction', TO_END);
    const lockAction = region(ACTIONS_TS, 'export async function lockUiVersionAction', TO_END);
    for (const action of [shareAction, decisionAction, lockAction]) {
      assert.match(action, /revalidatePath\(`\/projects\/\$\{projectId\}`\)/);
    }
  });
});

describe('D. the form the Admin actually sees picks itself from the version\'s own status', () => {
  test('exactly the three writable statuses map to a form; everything else renders nothing', () => {
    assert.match(FORMS_TSX, /case 'admin_approved':\s*\n\s*return <ShareWithClientForm/);
    assert.match(FORMS_TSX, /case 'client_review':\s*\n\s*case 'client_change':\s*\n\s*return <RecordClientDecisionForm/);
    assert.match(FORMS_TSX, /case 'client_approved':\s*\n\s*return <LockUiVersionForm/);
    assert.match(FORMS_TSX, /default:\s*\n\s*return null;/);
  });

  test('the decision form only offers the two decisions Master names for this gate', () => {
    const decisionForm = region(FORMS_TSX, 'function RecordClientDecisionForm', TO_END);
    assert.match(decisionForm, /<option value="change_requested">/);
    assert.match(decisionForm, /<option value="final_confirmed">/);
    assert.doesNotMatch(decisionForm, /possible_scope_change|clarification_required|client_reference/);
  });

  test('no form renders raw markup', () => {
    assert.doesNotMatch(FORMS_TSX, /dangerouslySetInnerHTML/);
  });
});
