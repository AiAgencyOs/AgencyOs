import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The client loop has a surface — Master §7.6, §8; PM §4.4, §4.6, §9; G-288.
 *
 * G-287 gave the two internal gates a surface. These are the three doors on
 * the other side of them, which also had no caller: recording what was sent,
 * recording what came back, and opening the round a change request asks for.
 *
 * The outcome-mapping meta-invariant for all six doors lives in
 * `the-gates-have-a-surface.test.ts` — G-288 extended that list rather than
 * writing a second one here, because two overlapping lists are a place for a
 * door to fall between. What is asserted here is what is particular to the
 * client loop.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/design.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
// The client loop moved to the Final selection route when the decision trail
// split across four pages.
const PAGE = read('app/(internal)/projects/[projectId]/design/final/page.tsx');
const QUERIES = read('src/modules/projects/queries.ts');
const SHARES = read('supabase/migrations/20260919130000_only_what_admin_approved.sql');
const LIMIT = read('supabase/migrations/20260919160000_the_limit_is_a_stop.sql');

describe('A. it records; it does not send', () => {
  test('no form claims to send anything', () => {
    // There is no channel on this deployment (BLK-003, BLK-007). A button
    // labelled "send" over a door that only writes a row would have somebody
    // tick it and walk away believing a client had been written to.
    assert.doesNotMatch(FORMS, />\s*Send to client\s*<|>\s*Send\s*</);
    assert.match(FORMS, />\s*Record what was sent\s*</);
    assert.match(FORMS, />\s*Record what they said\s*</);
  });

  test('and the share form says outright that AgencyOS cannot send it', () => {
    assert.match(FORMS, /AgencyOS cannot send this — there is no channel configured\. Send it yourself, then record\s*\n?\s*what you sent\./);
  });

  test('the door it fronts still refuses to be a sender', () => {
    // The positive twin: if the migration ever grew an outbound call, the
    // wording above would become a lie the tests still passed.
    assert.doesNotMatch(SHARES, /send_outbound_message|dispatchMessage|pg_net/i);
  });

  test('every form asks for the evidence of a message a person sent', () => {
    assert.match(FORMS, /name="evidenceRef"/);
    assert.match(SERVICE, /A record of a client being shown something, that nobody can show them being shown, is a claim/);
  });
});

describe('B. §8’s named findings reach the person who needs them', () => {
  test('the refusal carries which options were the problem', () => {
    // The door names them (`not_approved:%s`) precisely so a PM is not sent
    // hunting. Dropping them here would put the reader back where the door
    // was built to stop them being.
    assert.match(SERVICE, /const named = \(row\?\.findings \?\? \[\]\)/);
    assert.match(SERVICE, /Admin has not approved everything you picked\$\{list\}/);
  });

  test('and the door still names them', () => {
    assert.match(SHARES, /format\('not_approved:%s', t\.name\)/);
  });

  test('`nothing_to_show` says which option, and why that is refused', () => {
    assert.match(SERVICE, /There is nothing to show for\$\{list \|\| ' one of these'\}: no Figma reference and no preview/);
  });
});

describe('C. the reply form offers only what that client was shown', () => {
  test('the pickers come from the round’s frozen snapshot', () => {
    // The same rule the door enforces as `not_shown`. Offering the options as
    // they stand now would build a form whose normal outcome is a refusal —
    // and whose successful outcome would be worse.
    assert.match(PAGE, /shown=\{shownIn\(s\.sharedOptions\)\}/);
    assert.match(PAGE, /const shownIn = \(sharedOptions: unknown\[\]\) =>/);
  });

  test('and only the newest round can be replied to', () => {
    assert.match(PAGE, /s\.id === trail\.shares\[0\]\?\.id/);
  });

  test('all six classifications are offered, and no seventh', () => {
    // The SET, not the presence. A red-proof adding a seventh option
    // (`seems_happy` — the exact thing §4.9 forbids) left this green while it
    // only checked that the six named ones were there.
    const select = FORMS.slice(
      FORMS.indexOf('<select name="decision"'),
      FORMS.indexOf('</select>', FORMS.indexOf('<select name="decision"')),
    );
    assert.ok(select.length > 0, 'the classification picker is gone');
    assert.deepEqual(
      [...select.matchAll(/<option value="([a-z_]*)"/g)].map((m) => m[1] ?? '').sort(),
      ['clarification_required', 'client_reference', 'client_selected',
       'design_change_request', 'final_confirmed', 'possible_scope_change'],
    );
  });

  test('the client’s words are required, and asked for as their words', () => {
    assert.match(FORMS, /name="clientWords"[\s\S]{0,120}?required/);
    assert.match(FORMS, /their words, not a summary/);
  });
});

describe('D. a revision round is offered once, from the decision that asks for it', () => {
  test('only on a design change request that named an option', () => {
    assert.match(PAGE, /c\.decision === 'design_change_request'\s*\n\s*&& c\.selectedThemeOptionId/);
  });

  test('and not on one that already opened a round', () => {
    // The door's idempotency key is the decision itself, so offering it again
    // would only ever return `exists` — true, but it reads as if nothing
    // happened.
    assert.match(PAGE, /&& !revisedDecisions\.has\(c\.id\)/);
    assert.match(PAGE, /const revisedDecisions = new Set\(/);
    assert.match(QUERIES, /clientDecisionId: \(r\.client_decision_id as string \| null\) \?\? null/);
  });

  test('the form carries the decision id, so a double submit cannot spend a round', () => {
    assert.match(FORMS, /<input type="hidden" name="clientDecisionId" value=\{clientDecisionId\} \/>/);
    assert.match(LIMIT, /unique \(client_decision_id\)/);
  });

  test('and `exists` is reported as the no-op it is, not as success', () => {
    assert.match(ACTIONS, /That request already opened a round — this did not spend another one\./);
  });
});

describe('E. an escalation is not an error', () => {
  test('reaching the limit is reported as success, because the stop was the point', () => {
    // Reporting it as a failure would suggest retrying — which is exactly the
    // thing the limit exists to prevent.
    assert.match(SERVICE, /case 'escalated':[\s\S]{0,300}?return ok\(\{ revisionId: null, escalated: true/);
    assert.match(ACTIONS, /if \(outcome\.data\.escalated\) \{\s*\n\s*return \{\s*\n\s*status: 'success',/);
  });

  test('and the message says what now has to happen, by a person', () => {
    assert.match(ACTIONS, /somebody decides on continuation, scope or commercial handling/);
  });

  test('a phase already escalated refuses, and says why nothing more is designed', () => {
    assert.match(SERVICE, /already waiting on a decision about the revision limit\. Nothing more is designed until that is settled/);
  });

  test('a scope question is refused with the reason, not with a shrug', () => {
    assert.match(SERVICE, /New functionality goes to the scope process, not to a design round\./);
  });
});

describe('F. what is offered comes from stored state', () => {
  test('only Admin-approved options can be picked to share', () => {
    // The door refuses anything else as `not_approved`; this only decides what
    // to offer, and both read the same stored column.
    assert.match(PAGE, /\.filter\(\(t\) => t\.adminStatus === 'approved'\)/);
  });

  test('nothing to share says so rather than offering an empty list', () => {
    assert.match(FORMS, /Nothing is approved to send yet/);
  });

  test('and no form re-implements a rule a door holds', () => {
    // No re-derivation of the gate order, the revision ceiling or what the
    // client was shown.
    assert.doesNotMatch(FORMS, /revisionCount|revisionLimit|adminStatus|internalReviewStatus/);
  });

  test('every client-loop action revalidates the page the outcome shows on', () => {
    // BOUNDED at the next section. An open-ended slice counted the lock action
    // G-289 appended after this one — the same defect this suite already found
    // once in G-286's reader slice.
    const start = ACTIONS.indexOf('The client loop');
    const end = ACTIONS.indexOf('The completion gate', start);
    const loop = ACTIONS.slice(start, end > 0 ? end : undefined);
    assert.ok(loop.length > 0 && loop.length < ACTIONS.length, 'the client-loop section is not bounded');
    assert.equal((loop.match(/revalidatePath\(`\/projects\/\$\{projectId\}\/design`\)/g) ?? []).length, 3);
  });

  test('the share action reads every ticked option, not just the first', () => {
    // `get` would silently share one option and report success for all of
    // them.
    assert.match(ACTIONS, /formData\.getAll\('themeOptionIds'\)/);
  });
});
