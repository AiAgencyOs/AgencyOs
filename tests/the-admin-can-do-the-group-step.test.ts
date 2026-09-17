import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Admin can do the group step — Master §6, G-254.
 *
 * G-253 built every door and named what it had not built: *"until the surface
 * exists, the card is raised and only an internal reader of the table can see
 * it."* This is that surface, and the thing most worth asserting about it is a
 * negative: §6 asks for *"open/create assistance ... without falsely claiming
 * unsupported API automation"*, on a deployment where Meta has explicitly
 * refused this WABA the Groups API (#131215, ADM-95).
 *
 * So the test that matters is that there is no button here which pretends to
 * make a group, and that the honest alternative — the exact name, the exact
 * members, one click to copy them — is actually present.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const CARD = read('app/(internal)/projects/[projectId]/group-setup-card.tsx');
/** The card's CODE alone: prose explaining what it must not do is not it doing so. */
const CARD_CODE = CARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/**
 * The RENDERED part — everything after `setupText`, which is the instruction
 * text the Admin copies. That text says "create the group in WhatsApp", and it
 * says so on purpose: telling somebody to do it themselves is the opposite of
 * claiming the system will. A check that read it as a false claim would forbid
 * the honest sentence.
 */
const CARD_UI = CARD_CODE.slice(CARD_CODE.indexOf('function CopySetupData'));
const PANEL = read('app/(internal)/projects/[projectId]/group-panel.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');
const OPERATIONS = read('app/(internal)/operations/page.tsx');
const ACTIONS = read('src/modules/projects/actions.ts');
const QUERIES = read('src/modules/projects/queries.ts');

describe('A. it does not pretend it can make a group', () => {
  test('there is no control that claims to create one', () => {
    // A button labelled "Create group" would have nothing to call, and would
    // be read by an Admin as a thing they need not do by hand.
    assert.doesNotMatch(CARD_UI, /Create group|Create the group|Make group|createGroup|groups_api/i);
    // The instruction text DOES say "create the group in WhatsApp" — that is
    // the honest half, and its absence would be the defect.
    assert.match(CARD, /create the group in WhatsApp with exactly this name/);
    // The one word that must appear is the refusal.
    assert.match(CARD, /WhatsApp gives no API for creating a group or adding people to one/);
  });

  test('the assistance §6 asks for is a copy button and nothing else', () => {
    assert.match(CARD, /Copy name and members/);
    assert.match(CARD, /navigator\.clipboard\.writeText\(setupText\(card\)\)/);
    // No deep link that would look like automation, and no provider call.
    assert.doesNotMatch(CARD_CODE, /fetch\(|graph\.facebook|api\.whatsapp/i);
  });

  test('the copied text carries the name, the members AND the instructions', () => {
    // §6: "copy setup data — copy group name + member list + instructions."
    // All three, or the person has to assemble it themselves anyway.
    const fn = CARD.slice(CARD.indexOf('function setupText'), CARD.indexOf('function CopySetupData'));
    assert.match(fn, /Group name:/);
    assert.match(fn, /Members:/);
    assert.match(fn, /create the group in WhatsApp with exactly this name/);
    assert.match(fn, /m\.phone/);
  });

  test('a clipboard the browser refuses does not report success', () => {
    const copy = CARD.slice(CARD.indexOf('function CopySetupData'), CARD.indexOf('function StepForm'));
    assert.match(copy, /catch \{[\s\S]{0,300}setCopied\(false\)/);
  });
});

describe('B. the four states drive what is offered', () => {
  test('each state has a label and a tone, and there are exactly four', () => {
    for (const state of ['pending', 'created', 'mapped', 'verified']) {
      assert.match(CARD, new RegExp(`${state}: '`), `${state} has no tone`);
    }
    const labels = CARD.slice(CARD.indexOf('STATE_LABEL'), CARD.indexOf('/** §6'));
    assert.equal((labels.match(/^\s{2}[a-z]+:/gm) ?? []).length, 4);
  });

  test('the editor appears only while the card is pending', () => {
    // PM §8: after confirmation the member list is a record of who was
    // actually added. Offering an editor that the door would refuse is a
    // worse answer than not offering one.
    assert.match(CARD, /\{card\.state === 'pending' \? \([\s\S]{0,400}<ReviseForm/);
    assert.match(CARD, /this list becomes a record and stops being editable/);
  });

  test('each step is offered only from the state before it', () => {
    assert.match(CARD, /\{card\.state === 'created' \? \(\s*\n\s*<StepForm action=\{mapGroupAction\}/);
    assert.match(CARD, /\{card\.state === 'mapped' \? \(\s*\n\s*<StepForm\s*\n\s*action=\{verifyGroupAction\}/);
  });

  test('§6’s audit line is shown, not only stored', () => {
    for (const field of ['createdAtWhatsapp', 'mappedAt', 'verifiedAt']) {
      assert.match(CARD, new RegExp(`card\\.${field}`), `${field} is recorded and never shown`);
    }
  });
});

describe('C. refusals come from the door, not from a guess here', () => {
  test('every step form surfaces the error it gets back', () => {
    const step = CARD.slice(CARD.indexOf('function StepForm'), CARD.indexOf('function ReviseForm'));
    assert.match(step, /useActionState\(action, IDLE_STATE\)/);
    assert.match(step, /state\.status === 'error' \?/);
    assert.match(step, /\{state\.message\}/);
  });

  test('and so does the member editor', () => {
    const revise = CARD.slice(CARD.indexOf('function ReviseForm'), CARD.indexOf('export function GroupSetupCardPanel'));
    assert.match(revise, /useActionState\(reviseGroupSetupAction, IDLE_STATE\)/);
    assert.match(revise, /state\.status === 'error' \?/);
  });

  test('the card does not re-implement a single rule the door owns', () => {
    // No client-side copy of "you cannot map before confirming", no phone
    // validation, no state-machine check. Those live in the migration, where
    // a stale copy cannot exist.
    assert.doesNotMatch(CARD_CODE, /\^\\\+\?\[0-9\]|not_draft|wrong_project|needs_person/);
  });
});

describe('D. the actions are thin, and a cleared row means removed', () => {
  test('all four actions exist and revalidate the project', () => {
    for (const name of ['reviseGroupSetupAction', 'confirmGroupCreatedAction', 'mapGroupAction', 'verifyGroupAction']) {
      assert.match(ACTIONS, new RegExp(`export async function ${name}\\(`), `${name} is missing`);
    }
    const block = ACTIONS.slice(ACTIONS.indexOf('export async function confirmGroupCreatedAction'));
    assert.match(block, /revalidatePath\(`\/projects\/\$\{projectId\}`\)/);
    assert.match(block, /revalidatePath\('\/operations'\)/);
  });

  test('an emptied row is a removal, not a member with no name', () => {
    const revise = ACTIONS.slice(
      ACTIONS.indexOf('export async function reviseGroupSetupAction'),
      ACTIONS.indexOf('export async function confirmGroupCreatedAction'),
    );
    assert.match(revise, /\.filter\(\(m\) => m\.name\.length > 0 \|\| m\.phone\.length > 0\)/);
    // And an untouched form sends nothing rather than an empty list, which the
    // door would read as "remove everybody".
    assert.match(revise, /\.\.\.\(members\.length > 0 \? \{ members \} : \{\}\)/);
    assert.match(revise, /\.\.\.\(suggestedName \? \{ suggestedName \} : \{\}\)/);
  });
});

describe('E. the cross-project view lives where operators already look', () => {
  test('§6’s operational surface is /operations, not a new page', () => {
    assert.match(OPERATIONS, /listPendingGroupSetups/);
    assert.match(OPERATIONS, /WhatsApp groups waiting on a person/);
    assert.match(OPERATIONS, /a general Admin operational\/manual-actions surface/);
  });

  test('it links to the project rather than repeating the controls', () => {
    const section = OPERATIONS.slice(
      OPERATIONS.indexOf('WhatsApp groups waiting on a person'),
      OPERATIONS.indexOf('Dead letters'),
    );
    assert.match(section, /href=\{`\/projects\/\$\{setup\.projectId\}`\}/);
    assert.doesNotMatch(section, /confirmGroupCreatedAction|mapGroupAction|verifyGroupAction/);
  });

  test('and it says why these are manual, where the person reading it is', () => {
    assert.match(OPERATIONS, /AgencyOS cannot create these — WhatsApp gives no API for it \(ADM-95\)/);
  });

  test('verified cards drop off the list', () => {
    const q = QUERIES.slice(QUERIES.indexOf('export async function listPendingGroupSetups'));
    assert.match(q, /\.neq\('state', 'verified'\)/);
  });
});

describe('F. the reads keep the discipline every reader here keeps', () => {
  test('a failed read is not an absent card', () => {
    assert.match(QUERIES, /if \(error\) unreadable\('readGroupSetup', error\)/);
    assert.match(QUERIES, /if \(error\) unreadable\('listPendingGroupSetups', error\)/);
    // And the absent-row answer is deliberately not written as an early
    // `return null` beside the error guard — the two mean opposite things.
    const fn = QUERIES.slice(QUERIES.indexOf('export async function readGroupSetup'));
    assert.match(fn, /return data === null\s*\n\s*\? null/);
  });

  test('the snapshot is shown as stored, never re-derived from the roster', () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf('export async function readGroupSetup'),
      QUERIES.indexOf('export async function listPendingGroupSetups'),
    );
    assert.doesNotMatch(fn, /group_team_defaults/);
    assert.match(QUERIES, /a card confirmed in\n \* March must keep showing the people who were actually added in March/);
  });

  test('the panel that existed first still works for a project with no card', () => {
    // Every project whose Phase 2 started before G-253 has no card. The name
    // and link panel answered a question before this unit and still does.
    assert.match(PANEL, /card \? <GroupSetupCardPanel card=\{card\} projectId=\{projectId\} \/> : null/);
    assert.match(PANEL, /card: GroupSetupCard \| null;/);
    assert.match(PAGE, /const groupCard = await readGroupSetup\(projectId\)/);
  });
});
