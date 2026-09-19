import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * The offer that is a choice — Master Quotation System Part H, ADM-97; G-305.
 *
 * G-166 built the whole ladder: `sales.proposal_plan_sets` above proposals,
 * eight doors, seven service wrappers and three schemas, all tested. **Nothing
 * called any of them.** The only references outside `service.ts` were its own
 * log scope strings, so a 2–3 plan offer was reachable by somebody with
 * database access and by nobody else. Found by a caller sweep, not by reading
 * Part H.
 *
 * ── and the sweep found a second defect inside the first ──────────────
 *
 * A plan-set raises ONE approval, on its recommended plan, with
 * `subject_type = 'proposal'` and `subject_id` that plan's own id — ADM-97's
 * choice, so the existing forge guard and money-floor policy hold unchanged.
 * The consequence is that the owner's decision arrives at
 * `carryDecisionToSubject` looking exactly like an ordinary quotation's, and
 * syncing it as one moves the member and leaves the SET in
 * `pending_approval` for ever.
 *
 * **Driven on a scratch Postgres 16.14, both ways:** with the member-level
 * sync the set stayed `pending_approval` and `send_plan_set` answered
 * `not_approved`; with the set-level sync the set went `approved` and the send
 * returned `sent`. So an approved offer could never have been sent — G-112's
 * defect one level up, found the same way.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ACTIONS = read('src/modules/sales/actions.ts');
const PANEL = read('app/(internal)/leads/[leadId]/plan-set-panel.tsx');
const PAGE = read('app/(internal)/leads/[leadId]/page.tsx');
const QUERIES = read('src/modules/sales/queries.ts');
const DISPATCH = read('src/modules/approvals/actions.ts');

const draft = region(ACTIONS, 'export async function draftPlanSetAction', '\nexport async function ');
const submit = region(ACTIONS, 'export async function submitPlanSetAction', '\nexport async function ');
const choice = region(ACTIONS, 'export async function recordPlanSetChoiceAction', '\nexport async function ');
const decline = region(ACTIONS, 'export async function recordPlanSetResponseAction', TO_END);
const plansFrom = region(ACTIONS, 'function plansFrom(formData: FormData)', '\nexport async function ');
const carry = region(DISPATCH, 'async function carryDecisionToSubject', '\n/**');
const answerForm = region(PANEL, 'export function PlanSetAnswerForm', TO_END);
const draftForm = region(PANEL, 'export function DraftPlanSetForm', '\nexport function ');

describe('A. every plan-set door now has a caller', () => {
  test('the five the person drives are reached through Server Actions', () => {
    assert.match(draft, /await draftPlanSet\(\{/);
    assert.match(submit, /await submitPlanSet\(\{/);
    assert.match(region(ACTIONS, 'export async function sendPlanSetAction', '\nexport async function '), /await sendPlanSet\(\{/);
    assert.match(choice, /await recordPlanSetChoice\(\{/);
    assert.match(decline, /await recordPlanSetResponse\(\{/);
  });

  test('and the sixth is reached by the decision dispatch, not by a person', () => {
    // Nobody presses "sync". The owner answers the approval and the offer has
    // to follow, which is what `carryDecisionToSubject` is for.
    assert.match(carry, /const synced = await syncPlanSetDecision\(planSetId\);/);
  });

  test('the dispatch tells a member from a standalone quotation', () => {
    assert.match(carry, /const planSetId = await planSetIdForProposal\(request\.subject_id\);\s*\n\s*if \(planSetId\) \{/);
    // Through `service.ts`, not into the module's reads: ARCHITECTURE.md §3.2.
    assert.match(read('src/modules/sales/service.ts'), /export async function planSetIdForProposal/);
    assert.match(
      read('src/modules/sales/service.ts'),
      /the\s*\n \* dispatch may know that a proposal can belong to a set; it may not reach into\s*\n \* this module's reads to find out/,
    );
    // And the member-level sync is REPLACED, not run beside it: the set's own
    // sync moves the set and every member in lockstep.
    assert.match(carry, /this replaces the member-level sync rather than running beside it/);
  });

  test('and it says what the defect was, where the next reader is', () => {
    assert.match(carry, /leave the SET in `pending_approval` for ever/);
    assert.match(carry, /G-112's defect, one level up/);
  });
});

describe('B. it is the same process, not a second vocabulary', () => {
  test('the members are priced through the ordinary quotation forms', () => {
    // A member is an ordinary draft proposal. A second pricing path would be a
    // second place for the arithmetic to drift.
    assert.match(PAGE, /<QuotationLineForm leadId=\{leadId\} proposalId=\{m\.id\} \/>/);
    assert.match(PAGE, /<QuotationPricingForm\s*\n\s*leadId=\{leadId\}\s*\n\s*proposalId=\{m\.id\}/);
  });

  test('the set moves and its members move with it — never one alone', () => {
    // `liveProposal` means the live STANDALONE quotation. Without this filter
    // every single-quotation control would fire on one of the rungs:
    // submitting it alone, sending it alone, answering for it alone.
    assert.match(
      PAGE,
      /proposals\.find\(\(p\) => isLiveProposal\(p\.status as ProposalStatus\) && p\.plan_set_id === null\) \?\? null;/,
    );
    assert.match(PAGE, /every single-quotation control below would fire on one/);
  });

  test('and drafting a set is offered only when nothing is in flight', () => {
    // `draft_plan_set` supersedes whatever offer is live. A control that
    // quietly retires a quotation somebody is waiting on an answer to should
    // not sit beside one that does not.
    assert.match(PAGE, /\{planSet === null && liveProposal === null \? \(/);
    assert.match(PAGE, /drafting a set SUPERSEDES whatever is live/);
  });
});

describe('C. ADM-97’s rules are carried, not re-decided', () => {
  test('the recommendation is required and says why', () => {
    assert.match(draftForm, /name="recommendedSlot" required/);
    assert.match(draftForm, /the recommendation is REQUIRED, and it is not a nicety/);
    assert.match(draftForm, /a set with no\s*\n\s*recommendation is three questions rather than one offer/);
  });

  test('two or three rungs, from the constants rather than a literal', () => {
    assert.match(PANEL, /import \{ PLAN_SET_MAX_PLANS, PLAN_SET_MIN_PLANS \} from '@\/modules\/sales\/schema';/);
    assert.match(PANEL, /const SLOTS = Array\.from\(\{ length: PLAN_SET_MAX_PLANS \}/);
    // The blank third rung is dropped rather than submitted empty; the 2-3
    // count is then refused by the schema and again by the database CHECK.
    assert.match(plansFrom, /\.filter\(\(plan\) => plan\.title !== '' && plan\.label !== ''\)/);
  });

  test('the plans are posted as fields, not as serialised JSON', () => {
    assert.match(ACTIONS, /an HTML form posts strings and the alternative is a hidden\s*\n \* field holding a serialised array/);
  });

  test('approval is of the SET, at the recommended price', () => {
    assert.match(submit, /at the recommended plan’s price/);
    assert.match(submit, /the money-floor policy resolves an approver from/);
  });
});

describe('D. the client’s answer cannot be typed as a state', () => {
  test('accepting means naming which plan won', () => {
    assert.match(choice, /chosenProposalId: String\(formData\.get\('chosenProposalId'\) \?\? ''\)/);
    assert.match(answerForm, /Which plan did they pick\?/);
  });

  test('and the picker offers this set’s members and nothing else', () => {
    // `record_plan_set_choice` refuses a proposal that is not one of them, and
    // offering the deal's history would make that refusal the normal result.
    assert.match(answerForm, /\{planSet\.members\.map\(\(m\) => \(/);
    assert.match(answerForm, /The members of THIS set and nothing else/);
  });

  test('declining is the whole offer, and the literal is the schema’s', () => {
    // Reading it from the form would invite a caller to post 'accepted' and
    // get a refusal about a union.
    assert.match(decline, /response: 'rejected',/);
    assert.match(decline, /declining is the ONLY\s*\n\s*\/\/ answer this door takes/);
    assert.match(answerForm, /there is no "they said no\s*\n\s*to Growth" state/);
  });
});

describe('E. the read, and what a failed one must not claim', () => {
  test('and a failed plan-set lookup does not send the decision down the wrong path', () => {
    // Null means "not a member". Returning it on a failed read would sync the
    // single quotation and move the wrong row.
    assert.match(read('src/modules/sales/service.ts'), /throw new Error\('planSetIdForProposal: could not read the proposal\.'\);/);
  });

  test('one live set per deal, read as a row rather than a list', () => {
    assert.match(QUERIES, /\.in\('status', LIVE_PLAN_SET_STATUSES\)\s*\n\s*\.maybeSingle\(\);/);
  });

  test('a failed read is not “this deal has no plan offer”', () => {
    // The panel would then offer to draft a second one, and `draft_plan_set`
    // would supersede a live offer somebody is waiting on an answer to.
    assert.match(QUERIES, /if \(error\) unreadable\('readLivePlanSet', error\);/);
    assert.match(QUERIES, /`draft_plan_set` would supersede a\s*\n\s*\/\/ live offer somebody is waiting on an answer to/);
  });

  test('the members come from the list the page already read', () => {
    // A second query for rows it holds would be a chance for the two to
    // disagree about which plans are in the offer.
    assert.match(QUERIES, /members: proposals\s*\n\s*\.filter\(\(p\) => p\.plan_set_id === data\.id\)/);
    // And written as ONE expression, because a guard followed by a bare value
    // return is the shape read-failure-semantics forbids.
    assert.match(QUERIES, /One expression rather than `if \(!data\) return null`/);
    assert.match(QUERIES, /a second\s*\n\s*\/\/ query for rows it holds would be a chance for the two to disagree/);
  });

  test('and the rungs are ordered by slot, not by creation', () => {
    assert.match(QUERIES, /\.sort\(\(a, b\) => \(a\.plan_slot \?\? 0\) - \(b\.plan_slot \?\? 0\)\)/);
  });
});

describe('F. what the panel will not claim', () => {
  test('it names the unpriced rungs instead of letting the door refuse', () => {
    const submitForm = region(PANEL, 'export function SubmitPlanSetForm', '\nexport function ');
    assert.match(submitForm, /const unpriced = planSet\.members\.filter\(\(m\) => m\.total_minor <= 0\);/);
    assert.match(submitForm, /finding out\s*\n\s*\/\/ by pressing the button is a round-trip and a refusal/);
  });

  test('and the recommended rung is marked where the prices are compared', () => {
    assert.match(PAGE, /\{m\.id === planSet\.recommendedProposalId \? \(/);
  });
});
