import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * The register has a surface, and the sweep's remainder — G-306.
 *
 * The caller sweep that opened G-304 and G-305 left a list, and each entry on
 * it was a different question. **An unreachable feature is a gap, an unused
 * helper is dead code, and a second reader of a fact something else already
 * reads is a divergence waiting to happen.** Answering them together would
 * have meant guessing at several, so they were recorded and are answered here
 * one at a time.
 *
 * ── the one that was not cosmetic ─────────────────────────────────────
 *
 * **The QA module had no surface at all.** `raiseDefect`, `settleDefect`,
 * `markProductionReady`, `listDefects` and `readProjectQuality` were written
 * and tested, and nothing called any of them.
 *
 * `projects.submit_deliverable` refuses while an open blocker or major exists
 * (§4.8, ADM-19) and `mark_production_ready` reads the same counts. **So the
 * gate was live in the database and the register behind it could not be
 * written to**: a delivery could be blocked by a defect nobody could raise,
 * and a project could not be signed off by anybody using the product.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QA_ACTIONS = read('src/modules/qa/actions.ts');
const QA_PANEL = read('app/(internal)/projects/[projectId]/qa-panel.tsx');
const PROJECT = read('app/(internal)/projects/[projectId]/page.tsx');
const DESIGN = read('app/(internal)/projects/[projectId]/design/page.tsx');
const SETTINGS = read('app/(internal)/settings/communication/page.tsx');
const CRM_QUERIES = read('src/modules/crm/queries.ts');
const CRM_SERVICE = read('src/modules/crm/service.ts');
const PROJECT_SERVICE = read('src/modules/projects/service.ts');
const SALES_ACTIONS = read('src/modules/sales/actions.ts');
const SALES_PANEL = read('app/(internal)/leads/[leadId]/sales-panel.tsx');

describe('A. the QA register can be written to', () => {
  test('every door has an action', () => {
    assert.match(QA_ACTIONS, /await raiseDefect\(\{/);
    assert.match(QA_ACTIONS, /await settleDefect\(\{/);
    assert.match(QA_ACTIONS, /await markProductionReady\(String\(formData\.get\('projectId'\) \?\? ''\)\)/);
  });

  test('and the gate the register feeds is named where it is raised', () => {
    // Somebody raising a blocker should know it stops the next submission
    // before they are asked why a deliverable will not go.
    assert.match(QA_ACTIONS, /A blocker or a major stops the next submission until it is settled\./);
  });

  test('the counts come from the database, not from the page', () => {
    assert.match(PROJECT, /const quality = await readProjectQuality\(projectId\);/);
    assert.match(PROJECT, /nothing here re-derives\s*\n\s*them: a second copy would disagree the moment somebody verified a/);
  });

  test('and `blocksDelivery` decides which rows are marked, once', () => {
    // The module's own rule, not a repeat of it.
    assert.match(PROJECT, /blocksDelivery\(\{ status: d\.status as DefectStatus, severity: d\.severity as DefectSeverity \}\)/);
  });
});

describe('B. the defect controls offer only legal moves', () => {
  const settle = region(QA_PANEL, 'export function SettleDefectForm', '\nexport function ');

  test('the moves come from the transition table the guard enforces', () => {
    assert.match(settle, /const moves = DEFECT_TRANSITIONS\[defect\.status as DefectStatus\] \?\? \[\];/);
  });

  test('a terminal defect gets no control at all', () => {
    // `verified` and `wontfix` have no exits. A control whose only outcome is
    // a refusal is a form built to fail.
    assert.match(settle, /if \(moves\.length === 0\) return null;/);
  });

  test('and nothing can be closed by silence', () => {
    // Every move this control offers leaves `open`, and the schema refuses
    // all of them without a resolution.
    assert.match(settle, /name="resolution" required/);
    assert.match(settle, /What stops a\s*\n\s*bug being closed by silence/);
  });

  test('the sign-off is offered to the role ADM-19 named, not to delivery', () => {
    // A delivery lead declaring their own work production ready is the review
    // signing its own homework.
    assert.match(PROJECT, /const maySignOff = can\(context\.role, 'project\.sign_off'\);/);
    assert.match(PROJECT, /\{maySignOff \? <ProductionReadyForm projectId=\{projectId\} \/> : null\}/);
  });

  test('and nothing on the page predicts that gate', () => {
    const ready = region(QA_PANEL, 'export function ProductionReadyForm', TO_END);
    assert.match(ready, /Nothing here predicts the gate/);
    assert.doesNotMatch(ready, /build_approved|open_blockers/);
  });
});

describe('C. the coverage matrix is rendered, and is still not a gate', () => {
  test('Doc 12 §9’s flags reach a screen', () => {
    assert.match(DESIGN, /const screenCoverage = await readUiCoverage\(projectId\);/);
    assert.match(DESIGN, /<Section\s*\n\s*title="Screen coverage"/);
  });

  test('and adding a threshold here would be inventing the business rule', () => {
    // `refuse_uncovered_design` already refuses the three flags that are
    // mechanically exact; the rest are judgement nobody has configured.
    assert.match(DESIGN, /A REPORT, and deliberately\s*\n\s*not a second gate/);
    assert.match(DESIGN, /\{flag\.blocking \? <Badge tone="danger">refused by the database<\/Badge> : null\}/);
  });
});

describe('D. the internal channels are read once, and a failure is not an absence', () => {
  test('the readers live where a page may call them', () => {
    // ARCHITECTURE.md §3.2: a page calls actions.ts or queries.ts, never
    // service.ts. Both readers were in service.ts, which is why the page had
    // gone around them.
    assert.match(CRM_QUERIES, /export async function readInternalGroup\(\)/);
    assert.match(CRM_QUERIES, /export async function readInternalRecipient\(\)/);
    assert.match(SETTINGS, /readInternalGroup, readInternalRecipient \} from '@\/modules\/crm\/queries'/);
  });

  test('the inline reads that discarded their error are gone', () => {
    // `const { data } = await …` with no check: a failed read rendered
    // "nothing is linked", and the next thing somebody does is link a second
    // group while the first one keeps announcing.
    assert.doesNotMatch(SETTINGS, /\.eq\('kind', 'internal_group'\)/);
    assert.doesNotMatch(SETTINGS, /\.eq\('kind', 'internal_direct'\)/);
    assert.match(CRM_QUERIES, /if \(error\) unreadable\('readInternalGroup', error\);/);
    assert.match(CRM_QUERIES, /if \(error\) unreadable\('readInternalRecipient', error\);/);
  });

  test('and the service copies are deleted rather than left beside them', () => {
    assert.doesNotMatch(CRM_SERVICE, /export async function getInternalGroup/);
    assert.doesNotMatch(CRM_SERVICE, /export async function getInternalRecipient/);
    assert.match(CRM_SERVICE, /they are\n \* deliberately gone — G-306/);
  });
});

describe('E. a deal’s terms can be corrected, on an open deal only', () => {
  test('the door has an action', () => {
    assert.match(SALES_ACTIONS, /await setOpportunityTerms\(\{/);
  });

  test('a blank field is left alone rather than sent as zero', () => {
    // "Clear the value" is not an operation ADM-43 offered, and the schema
    // refuses a call that changes nothing.
    assert.match(SALES_ACTIONS, /\.\.\.\(rupees === '' \? \{\} : \{ valueMinor: Math\.round\(Number\(rupees\) \* 100\) \}\),/);
    assert.match(SALES_ACTIONS, /\.\.\.\(text\('name'\) === '' \? \{\} : \{ name: text\('name'\) \}\),/);
  });

  test('`changed: false` is reported as nothing changed, not as a correction', () => {
    assert.match(SALES_ACTIONS, /result\.data\.changed \? 'Deal terms corrected\.' : 'Nothing changed\.'/);
  });

  test('and a settled deal is not offered the control', () => {
    assert.match(SALES_PANEL, /export function DealTermsForm/);
    assert.match(read('app/(internal)/leads/[leadId]/page.tsx'), /\{isOpenOpportunity\(dealStage\) \? \(/);
  });
});

describe('F. the history the deliverables section already claimed', () => {
  test('every version’s approvals are read', () => {
    assert.match(PROJECT, /await listApprovalsForSubject\('deliverable', d\.id\)/);
  });

  test('and the claim that went unbacked is named', () => {
    // The section has said "the review each one went through" since Phase 12
    // and rendered only the current status.
    assert.match(PROJECT, /rendered only the current status; the reader\s*\n\s*\* that holds the history had no caller at all/);
  });
});

describe('G. what was deleted, and what was deliberately left', () => {
  test('the second milestone reader is gone, with its stale claim', () => {
    // Its comment still said "the one caller that cannot let an exception
    // escape catches it" — a claim that had gone false where a reader would
    // take it as current.
    assert.doesNotMatch(PROJECT_SERVICE, /export async function listMilestonesForBilling/);
    assert.match(PROJECT_SERVICE, /a claim that had gone false where somebody\n \* reading it would take it as current/);
    // The survivor is the one with callers.
    assert.match(read('src/modules/projects/queries.ts'), /export async function listPaymentPlan/);
  });

  test('two one-line helpers nobody ever called are gone', () => {
    assert.doesNotMatch(read('src/modules/approvals/schema.ts'), /export function isSettled/);
    assert.doesNotMatch(read('src/modules/sales/schema.ts'), /export function isLivePlanSet/);
    // And the constant each wrapped is still there, because that is what has
    // the callers.
    assert.match(read('src/modules/sales/schema.ts'), /export const LIVE_PLAN_SET_STATUSES/);
  });

  test('helpers used only inside their own file stop being exported', () => {
    assert.match(read('src/modules/crm/follow-up-rhythms.ts'), /^function addBusinessDaysPublic\(/m);
    assert.match(read('src/modules/crm/scheduling-request.ts'), /^function isDateOnly\(/m);
    assert.match(read('src/ui/patterns/whatsapp.tsx'), /^function Avatar\(/m);
    // Found on a later sweep of the same shape, after G-187 and G-272 added
    // new files to check: sortInstant and listProposalItems were each called
    // only from within their own file.
    assert.match(read('src/modules/crm/meetings-view.ts'), /^function sortInstant\(/m);
    assert.match(read('src/modules/sales/queries.ts'), /^async function listProposalItems\(/m);
  });

  test('and a genuinely unused primitive is not tightened the same way', () => {
    // ChatHeaderButton has no caller anywhere, including its own file — a
    // different shape from the two above, which ARE called, just not from
    // outside. Un-exporting it would still leave it dead; it belongs with the
    // design-system primitives above, kept as documented API rather than
    // deleted, not silently narrowed.
    assert.match(read('src/ui/patterns/whatsapp.tsx'), /^export function ChatHeaderButton\(/m);
  });

  test('and the design-system primitives are deliberately NOT deleted', () => {
    // `Button`, `LinkButton`, `TableFrame`, `Th`, `Td` and `CardFooter` are
    // unused — and they are correct, documented API that the app hand-rolls
    // around. The honest fix is ADOPTION, which is a visual refactor of forty
    // forms with no test that can see a pixel, so it is recorded on G-306
    // rather than done blind. Deleting them would remove the escape hatch the
    // design system offers instead of taking it up.
    const table = read('src/ui/primitives/table.tsx');
    assert.match(table, /export function TableFrame/);
    assert.match(table, /Escape hatch/);
    assert.match(read('src/ui/primitives/button.tsx'), /export function Button/);
  });
});
