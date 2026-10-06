import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AGENT_KINDS,
  FINANCE_AGENTS,
  FINANCE_PROFILES,
  allowedEvidenceRefs,
  checkFinanceProposals,
  doorArgsFor,
  financeProposalsJsonSchema,
  financeProposalsSchema,
  looksLikeAccountNumber,
  renderFinanceFacts,
  type FinanceFacts,
  type FinanceProposal,
} from '../src/modules/finance/phase-nine-proposals.ts';

/**
 * What the three Phase 9 finance agents may propose, and what is refused BEFORE the database door (which refuses the same things again). Pure: no model
 * ran. The point of every case is that a proposal is never a fact - it never says money arrived, never promises a concession, never cites a record it
 * was not shown, and never states that a project is closed.
 */

const INV = '00000000-0000-4000-8000-0000000000a1';
const INV2 = '00000000-0000-4000-8000-0000000000a2';
const SUB = '00000000-0000-4000-8000-0000000000b1';
const PAY = '00000000-0000-4000-8000-0000000000c1';
const EXC = '00000000-0000-4000-8000-0000000000d1';

const facts = (agent: (typeof FINANCE_AGENTS)[number], over: Partial<FinanceFacts> = {}): FinanceFacts => ({
  agent,
  projectName: 'Acme web',
  currency: 'INR',
  position: {
    result: 'blocked',
    totals: { contractMinor: 100000, verifiedNetMinor: 30000, outstandingMinor: 70000 },
    milestones: [{ name: 'M1', plannedMinor: 30000, invoicedMinor: 30000, verifiedNetMinor: 30000, waivedMinor: 0, outstandingMinor: 0, unverifiedMinor: 0 }],
    blockers: [{ code: 'unverified_money', reason: 'Payments are recorded but not verified.', ref: null }],
  },
  invoices: [
    { id: INV, number: 'INV-1', status: 'overdue', totalMinor: 30000, outstandingMinor: 12000, dueAt: '2026-09-01' },
    { id: INV2, number: 'INV-2', status: 'paid', totalMinor: 20000, outstandingMinor: 0, dueAt: null },
  ],
  submissions: [{ id: SUB, invoiceId: INV, status: 'pending_verification', amountMinor: 12000, reference: 'UTR1' }],
  payments: [{ id: PAY, invoiceId: INV, amountMinor: 12000, verified: false }],
  exceptions: [{ id: EXC, kind: 'overdue', blocking: false, reason: 'past due' }],
  milestoneIds: [],
  waivers: [],
  invoice: agent === 'finance_communication' ? { id: INV, number: 'INV-1', status: 'overdue', outstandingMinor: 12000, dueAt: '2026-09-01', daysOverdue: 36 } : null,
  ...over,
});

const base = (over: Partial<FinanceProposal>): FinanceProposal => ({
  kind: 'anomaly_flag', summary: 'a flag', detail: null, evidenceRefs: [`invoice:${INV}`], submissionId: null, draftBody: null, amountMinor: null, exceptionKind: null, ...over,
});
const check = (agent: (typeof FINANCE_AGENTS)[number], p: FinanceProposal, f = facts(agent)) => checkFinanceProposals(agent, { proposals: [p] }, f);
const refusal = (r: ReturnType<typeof checkFinanceProposals>) => (r.ok ? 'ACCEPTED' : r.reason);

describe('the roster and the shape', () => {
  test('three agents, each with its own kinds and no kind in common', () => {
    assert.deepEqual([...FINANCE_AGENTS], ['finance_reconciliation', 'finance_communication', 'finance_close']);
    const all = FINANCE_AGENTS.flatMap((a) => [...AGENT_KINDS[a]]);
    assert.equal(new Set(all).size, all.length);
    for (const a of FINANCE_AGENTS) assert.deepEqual([...FINANCE_PROFILES[a].kinds], [...AGENT_KINDS[a]]);
  });
  test('the answer schema is strict: an unknown field, an empty list and a non-integer amount are refused', () => {
    const ok = { proposals: [base({})] };
    assert.equal(financeProposalsSchema.safeParse(ok).success, true);
    assert.equal(financeProposalsSchema.safeParse({ proposals: [] }).success, false);
    assert.equal(financeProposalsSchema.safeParse({ proposals: [{ ...base({}), verified: true }] }).success, false);
    assert.equal(financeProposalsSchema.safeParse({ proposals: [base({ kind: 'reminder_draft', draftBody: 'x', amountMinor: 1.5 })] }).success, false);
    assert.equal(financeProposalsSchema.safeParse({ proposals: [base({ kind: 'verify_payment' as never })] }).success, false);
  });
  test('the JSON schema lists exactly the five kinds, and there is no field that could carry a verification', () => {
    const js = JSON.stringify(financeProposalsJsonSchema());
    for (const k of ['reconciliation_finding', 'anomaly_flag', 'reminder_draft', 'close_readiness_note', 'exception_classification']) assert.ok(js.includes(k), k);
    assert.ok(!/verified_by|verify|refund_amount|paid_status/.test(js.replace(/verified/g, '')), 'no field names a verification or a refund');
  });
  test('a prompt states the prohibitions: no tax guess, unverified is not received, never a secret', () => {
    for (const a of FINANCE_AGENTS) {
      const p = FINANCE_PROFILES[a].prompt;
      assert.match(p, /never verify a payment/i);
      assert.match(p, /Unverified money is not received money/);
      assert.match(p, /Never guess tax treatment/);
    }
    assert.match(FINANCE_PROFILES.finance_communication.prompt, /Never offer or hint at a discount, waiver/);
  });
});

describe('what each agent may write, and what it must cite', () => {
  test('an agent may not write another agent\'s kind', () => {
    assert.match(refusal(check('finance_reconciliation', base({ kind: 'reminder_draft', draftBody: 'x', amountMinor: 1 }))), /may not propose a reminder_draft/);
    assert.match(refusal(check('finance_communication', base({ kind: 'anomaly_flag' }))), /may not propose a anomaly_flag/);
    assert.match(refusal(check('finance_close', base({ kind: 'reconciliation_finding' }))), /may not propose/);
  });
  test('a flag, a finding and a classification cite evidence; a record not in the facts is refused', () => {
    assert.match(refusal(check('finance_reconciliation', base({ evidenceRefs: [] }))), /cite evidence/);
    assert.match(refusal(check('finance_reconciliation', base({ evidenceRefs: ['invoice:00000000-0000-4000-8000-0000000fffff'] }))), /not in the facts/);
    assert.match(refusal(check('finance_reconciliation', base({ evidenceRefs: ['just my feeling'] }))), /not in the facts/);
    assert.equal(refusal(check('finance_reconciliation', base({ evidenceRefs: [`invoice:${INV}`, `submission:${SUB}`, `payment:${PAY}`, `exception:${EXC}`] }))), 'ACCEPTED');
  });
  test('a submission id that is not in the facts is refused', () => {
    assert.match(refusal(check('finance_close', base({ kind: 'exception_classification', exceptionKind: 'wrong_account', submissionId: '00000000-0000-4000-8000-0000000fffff' }))), /submission was not in the facts/);
  });
  test('allowed evidence is exactly the records the facts hold', () => {
    assert.deepEqual(allowedEvidenceRefs(facts('finance_close')), [`invoice:${INV}`, `invoice:${INV2}`, `submission:${SUB}`, `payment:${PAY}`, `exception:${EXC}`]);
  });
  test('only an exception classification names an exception kind, and a reminder carries a body and an amount together', () => {
    assert.match(refusal(check('finance_close', base({ kind: 'close_readiness_note', exceptionKind: 'other' }))), /exception classification names an exception kind/);
    assert.match(refusal(check('finance_close', base({ kind: 'exception_classification', exceptionKind: null }))), /exception classification names an exception kind/);
    assert.match(refusal(check('finance_communication', base({ kind: 'reminder_draft', draftBody: 'pay', amountMinor: null }))), /carries both/);
  });
  test('a proposal carrying a secret value is refused, and the same proposal twice is refused', () => {
    const token = ['api', 'key'].join('_') + '=' + 'q'.repeat(20);
    assert.match(refusal(check('finance_reconciliation', base({ summary: `look ${token}` }))), /secret/);
    const r = checkFinanceProposals('finance_reconciliation', { proposals: [base({}), base({})] }, facts('finance_reconciliation'));
    assert.match(refusal(r), /proposed twice/);
  });
});

describe('a reminder is the invoice\'s real balance and nothing else', () => {
  const draft = (over: Partial<FinanceProposal> = {}) => base({ kind: 'reminder_draft', evidenceRefs: [], summary: 'Reminder for INV-1', draftBody: 'Dear client, invoice INV-1 of INR 120.00 is past its due date. Please pay the outstanding balance.', amountMinor: 12000, ...over });
  test('the real balance, a polite body: accepted', () => {
    assert.equal(refusal(check('finance_communication', draft())), 'ACCEPTED');
  });
  test('a figure that is not the database\'s balance is refused, however plausible', () => {
    assert.match(refusal(check('finance_communication', draft({ amountMinor: 30000 }))), /real outstanding balance \(12000\)/);
    assert.match(refusal(check('finance_communication', draft({ amountMinor: 11999 }))), /real outstanding balance/);
  });
  test('an invoice with nothing owed, or not collectible, gets no reminder', () => {
    const paid = facts('finance_communication', { invoice: { id: INV2, number: 'INV-2', status: 'paid', outstandingMinor: 0, dueAt: null, daysOverdue: null } });
    assert.match(refusal(check('finance_communication', draft(), paid)), /nothing to collect/);
    const zero = facts('finance_communication', { invoice: { id: INV, number: 'INV-1', status: 'overdue', outstandingMinor: 0, dueAt: null, daysOverdue: null } });
    assert.match(refusal(check('finance_communication', draft(), zero)), /nothing is owed/);
    assert.match(refusal(check('finance_communication', draft(), facts('finance_communication', { invoice: null }))), /no invoice/);
  });
  test('a message that says payment arrived is refused (a client message or screenshot is not a payment)', () => {
    for (const body of ['Thank you for your payment of INR 120.00.', 'We have received your payment.', 'Your payment has been verified.', 'The invoice is marked as paid.']) {
      assert.match(refusal(check('finance_communication', draft({ draftBody: body }))), /never claims a payment was received/, body);
    }
  });
  test('a message that promises a concession nobody authorised is refused', () => {
    for (const body of ['We can waive the late fee.', 'Pay today for a 10% discount.', 'A refund will follow.', 'You may defer to next month.', 'We can set up a payment plan.', 'An extension is fine.', 'We will write off the rest.']) {
      assert.match(refusal(check('finance_communication', draft({ draftBody: body }))), /never promises a discount, waiver, refund, deferral or payment plan/, body);
    }
  });
  test('a message carrying an account number or card shape is refused; an invoice number is not mistaken for one', () => {
    assert.ok(looksLikeAccountNumber('pay to 123456789012'));
    assert.ok(looksLikeAccountNumber('card 4111 1111 1111 1111'));
    assert.ok(!looksLikeAccountNumber('INV-2026-000123 for 12,000.00'));
    assert.match(refusal(check('finance_communication', draft({ draftBody: 'Please pay 12000 to account 123456789012.' }))), /no account number/);
    assert.equal(refusal(check('finance_communication', draft({ draftBody: 'Invoice INV-2026-000123 is past due. Please pay 12,000.00.' }))), 'ACCEPTED');
  });
});

describe('the other two agents never assert what only a person may do', () => {
  test('a finding that says a payment was received or verified is refused', () => {
    assert.match(refusal(check('finance_reconciliation', base({ summary: 'The payment has been verified and matches.' }))), /only a person verifies/);
    assert.match(refusal(check('finance_reconciliation', base({ kind: 'reconciliation_finding', detail: 'We have received the money.' }))), /only a person verifies/);
    assert.equal(refusal(check('finance_reconciliation', base({ summary: 'The submission claims 12000 but no verified payment matches it.' }))), 'ACCEPTED');
  });
  test('a close agent states readiness and never says the project is closed or complete', () => {
    const note = (s: string) => base({ kind: 'close_readiness_note', evidenceRefs: [], summary: s });
    assert.equal(refusal(check('finance_close', note('Not ready: an unverified payment and an overdue balance stand.'))), 'ACCEPTED');
    for (const s of ['The project is now financially closed.', 'I have closed the books.', 'The project is complete.', 'The books are closed.']) {
      assert.match(refusal(check('finance_close', note(s))), /never says the project is closed or complete/, s);
    }
  });
});

describe('what the model is shown and what the door is handed', () => {
  test('the facts carry the database\'s balance and say amountMinor MUST equal it', () => {
    const t = renderFinanceFacts(facts('finance_communication'));
    assert.match(t, /outstanding balance is 12000 minor units/);
    assert.match(t, /amountMinor MUST equal 12000/);
    assert.match(t, /do not recompute them/);
    assert.match(t, /NOT VERIFIED/);
  });
  test('door args carry the proposal and never an organization, an agent or a verification', () => {
    const args = doorArgsFor(base({ kind: 'reminder_draft', evidenceRefs: [], draftBody: 'b', amountMinor: 5 }));
    assert.deepEqual(Object.keys(args).sort(), ['p_amount_minor', 'p_detail', 'p_draft_body', 'p_evidence_refs', 'p_exception_kind', 'p_kind', 'p_submission_id', 'p_summary']);
  });
});
