import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  billingProposalSchema,
  checkBillingProposal,
  checkMaintenancePlan,
  maintenancePlanSchema,
  outcomeWords,
  planDoorArgs,
  type BillingFacts,
  type MaintenanceFacts,
} from '../src/modules/projects/maintenance-engineering.ts';

const facts = (over: Partial<MaintenanceFacts> = {}): MaintenanceFacts => ({
  agent: 'bug_fix', kind: 'patch', area: 'backend', title: 't', description: null, status: 'open', sensitive: false, commitRef: null, fixSummary: null,
  defect: { title: 'prod bug', reproduction: 'steps', expected: null, actual: null }, changeRequest: null, ticket: null, evidence: [{ ref: 'defect:d1', detail: 'prod bug' }], ...over,
});
const plan = (over: Record<string, unknown> = {}) => maintenancePlanSchema.parse({ summary: 'Guard the null cart', steps: ['reproduce', 'add a guard'], risks: [], needsScopeChange: false, recommendsSecurityReview: false, evidenceRefs: ['defect:d1'], ...over });
// fake secret fixtures are assembled at runtime
const fakeKey = () => `api_key=${'x'.repeat(20)}`;

describe('a maintenance plan is a draft with no results in it', () => {
  test('a good plan passes; strict shape refuses extra keys', () => {
    assert.deepEqual(checkMaintenancePlan('bug_fix', plan(), facts()), { ok: true });
    assert.throws(() => maintenancePlanSchema.parse({ ...plan(), approved: true }));
  });
  test('a plan that claims a result, a verification or a release is refused', () => {
    for (const s of ['all tests passed', 'the defect is fixed and verified', 'deploy the fix to production', 'ready to ship']) {
      const r = checkMaintenancePlan('bug_fix', plan({ steps: ['reproduce', s] }), facts());
      assert.equal(r.ok, false, s);
    }
  });
  test('a secret is refused; a reference it was not given is refused', () => {
    assert.equal(checkMaintenancePlan('bug_fix', plan({ summary: fakeKey() }), facts()).ok, false);
    assert.equal(checkMaintenancePlan('bug_fix', plan({ evidenceRefs: ['defect:other'] }), facts()).ok, false);
  });
  test('a regression plan needs a commit; the Bug Fix agent does not plan an enhancement', () => {
    assert.equal(checkMaintenancePlan('regression_test', plan(), facts({ agent: 'regression_test' })).ok, false);
    assert.equal(checkMaintenancePlan('regression_test', plan(), facts({ agent: 'regression_test', commitRef: 'a'.repeat(40) })).ok, true);
    assert.equal(checkMaintenancePlan('bug_fix', plan(), facts({ kind: 'enhancement' })).ok, false);
  });
  test('the door args carry no result, no verdict and no commit that is not the item\'s', () => {
    const args = planDoorArgs('bug_fix', plan(), null);
    assert.deepEqual(Object.keys(args).sort(), ['p_commit_ref', 'p_evidence_refs', 'p_kind', 'p_needs_scope_change', 'p_recommends_security_review', 'p_risks', 'p_steps', 'p_summary']);
    assert.equal(args.p_kind, 'fix_plan');
  });
});

const bfacts = (over: Partial<BillingFacts> = {}): BillingFacts => ({ kind: 'payment_reminder', clientName: 'Acme', invoiceNumber: 'INV-2026-0042', balanceMinor: 118000, currency: 'INR', planName: null, changeRequestText: null, quotedLines: [], ...over });

describe('a billing proposal never states an amount or claims a payment', () => {
  const ok = (n: string, r: string | null) => billingProposalSchema.parse({ narrative: n, reminderText: r });
  test('a reminder that names its invoice passes', () => {
    assert.deepEqual(checkBillingProposal(ok('Gentle reminder', 'Hello, a reminder about INV-2026-0042. Thank you.'), bfacts()), { ok: true });
  });
  test('an amount anywhere is refused (amounts come from the quote and the records)', () => {
    for (const t of ['please pay ₹1,180', 'Rs. 1180 is due', 'pay 1180 INR', 'pay $20']) {
      assert.equal(checkBillingProposal(ok('n', `INV-2026-0042 ${t}`), bfacts()).ok, false, t);
    }
    assert.equal(checkBillingProposal(ok('Total ₹5,000', null), bfacts({ kind: 'maintenance_invoice' })).ok, false);
  });
  test('a claim that a payment was received or verified is refused', () => {
    assert.equal(checkBillingProposal(ok('n', 'INV-2026-0042: we have received your payment, thanks'), bfacts()).ok, false);
    assert.equal(checkBillingProposal(ok('payment verified', null), bfacts({ kind: 'maintenance_invoice' })).ok, false);
  });
  test('a reminder must name its invoice, must exist, and may not pressure; an invoice proposal carries no reminder', () => {
    assert.equal(checkBillingProposal(ok('n', 'Please pay soon'), bfacts()).ok, false);
    assert.equal(checkBillingProposal(ok('n', null), bfacts()).ok, false);
    assert.equal(checkBillingProposal(ok('n', 'INV-2026-0042 final notice: legal action follows'), bfacts()).ok, false);
    assert.equal(checkBillingProposal(ok('n', 'a reminder'), bfacts({ kind: 'change_request_invoice' })).ok, false);
    assert.equal(checkBillingProposal(ok('Annual plan, first cycle', null), bfacts({ kind: 'maintenance_invoice' })).ok, true);
  });
  test('a secret is refused', () => {
    assert.equal(checkBillingProposal(ok(fakeKey(), null), bfacts({ kind: 'maintenance_invoice' })).ok, false);
  });
});

describe('door outcomes read as words', () => {
  test('known outcomes have words; unknown ones are shown as written', () => {
    assert.match(outcomeWords('self_review'), /cannot be its QA/);
    assert.equal(outcomeWords('some_new_outcome'), 'Refused: some new outcome.');
  });
});
