import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { gstLine, lastPaymentAt, methodLabel, methodsUsed, receivedPayments, transactionStatus, type ProjectPayment } from '../src/modules/finance/project-finance.ts';

const pay = (over: Partial<ProjectPayment>): ProjectPayment => ({ id: 'p', invoiceId: 'i', invoiceNumber: 'INV-1', amountMinor: 100, currency: 'INR', status: 'captured', provider: 'manual', method: null, capturedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', ...over });

describe('only money that arrived is a transaction', () => {
  test('captured and refunded count; created, authorized and failed do not', () => {
    const all = [pay({ id: 'a' }), pay({ id: 'b', status: 'failed' }), pay({ id: 'c', status: 'created' }), pay({ id: 'd', status: 'refunded' })];
    assert.deepEqual(receivedPayments(all).map((p) => p.id), ['a', 'd']);
  });
  test('the last payment date is the newest capture, and a project with none says nothing', () => {
    assert.equal(lastPaymentAt([pay({ capturedAt: '2026-09-01T00:00:00Z' }), pay({ capturedAt: '2026-09-09T00:00:00Z' }), pay({ capturedAt: '2026-10-01T00:00:00Z', status: 'failed' })]), '2026-09-09T00:00:00Z');
    assert.equal(lastPaymentAt([]), null);
    assert.equal(lastPaymentAt([pay({ status: 'created' })]), null);
  });
});

describe('the payment method is what the payer named, else how it was recorded', () => {
  test('a claim\'s method is worded; a manual entry says so; a provider is capitalised', () => {
    assert.equal(methodLabel({ method: 'bank_transfer', provider: 'manual' }), 'Bank transfer');
    assert.equal(methodLabel({ method: 'upi', provider: 'manual' }), 'UPI');
    assert.equal(methodLabel({ method: null, provider: 'manual' }), 'Recorded manually');
    assert.equal(methodLabel({ method: null, provider: 'razorpay' }), 'Razorpay');
  });
  test('methods used are distinct, in the order first paid, and a dash when nothing was paid', () => {
    const ps = [pay({ id: 'b', method: 'upi', capturedAt: '2026-09-05T00:00:00Z' }), pay({ id: 'a', method: 'bank_transfer', capturedAt: '2026-09-01T00:00:00Z' }), pay({ id: 'c', method: 'upi', capturedAt: '2026-09-07T00:00:00Z' })];
    assert.equal(methodsUsed(ps), 'Bank transfer / UPI');
    assert.equal(methodsUsed([]), '—');
  });
});

describe('the GST line states what the invoices carry', () => {
  test('tax is a figure; no tax is a plain sentence, not "not applicable"', () => {
    assert.equal(gstLine(8100, (m) => `₹${m / 100}`), '₹81 charged on invoices');
    assert.equal(gstLine(0, () => ''), 'No tax on these invoices');
  });
  test('a transaction status maps to a chip', () => {
    assert.deepEqual(transactionStatus('captured'), { label: 'Completed', tone: 'success' });
    assert.equal(transactionStatus('authorized').label, 'Pending');
  });
});
