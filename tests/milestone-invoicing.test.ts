import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyPayment,
  displayPaymentReference,
  formatInvoiceNumber,
  generateMilestoneInvoiceSchema,
  invoiceNumberPrefix,
  invoiceTotals,
  manualPaymentKey,
  milestoneInvoiceability,
  milestoneInvoiceLines,
  nextInvoiceNumber,
  nextUnlockedMilestone,
  paidThrough,
  parseInvoiceSequence,
  parseMinorUnits,
  recordManualPaymentSchema,
  voidInvoiceSchema,
  CLIENT_VISIBLE_INVOICE_STATUSES,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  PAYABLE_INVOICE_STATUSES,
  type InvoiceStatus,
  type MilestoneBillingEntry,
} from '../src/modules/finance/schema.ts';
import { splitBudget } from '../src/modules/projects/schema.ts';

const UUID = '00000000-0000-4000-8000-000000000001';

// ── Amounts ────────────────────────────────────────────────────────────────

describe('milestone → invoice amounts', () => {
  test('one milestone produces exactly one line, at the milestone amount', () => {
    const lines = milestoneInvoiceLines({
      name: 'Design sign-off',
      amountMinor: 30_000_00,
      paymentPercent: 30,
      position: 0,
      projectName: 'Northwind Storefront',
    });

    assert.equal(lines.length, 1, 'a milestone bills as a single line');
    assert.equal(lines[0]?.amountMinor, 30_000_00);
    assert.equal(lines[0]?.unitPriceMinor, 30_000_00);
    assert.equal(lines[0]?.quantity, 1);
    assert.equal(lines[0]?.position, 0);
  });

  test('the description carries the milestone, its number and its share', () => {
    const [line] = milestoneInvoiceLines({
      name: 'Design sign-off',
      amountMinor: 30_000_00,
      paymentPercent: 30,
      position: 0,
      projectName: 'Northwind Storefront',
    });

    assert.match(line?.description ?? '', /Northwind Storefront/);
    assert.match(line?.description ?? '', /Design sign-off/);
    assert.match(line?.description ?? '', /milestone 1/);
    assert.match(line?.description ?? '', /30%/);
  });

  test('a fractional share reads exactly, without trailing zeros', () => {
    const [line] = milestoneInvoiceLines({
      name: 'Build',
      amountMinor: 3_333_33,
      paymentPercent: 33.33,
      position: 1,
      projectName: null,
    });
    assert.match(line?.description ?? '', /33\.33%/);
    assert.match(line?.description ?? '', /milestone 2/);
  });

  test('a milestone with no share still bills its amount', () => {
    const [line] = milestoneInvoiceLines({
      name: 'Extra scope',
      amountMinor: 5_000_00,
      paymentPercent: null,
      position: 4,
      projectName: null,
    });
    assert.equal(line?.amountMinor, 5_000_00);
    assert.doesNotMatch(line?.description ?? '', /%/);
  });

  test('totals equal the milestone amount exactly, with no tax configured', () => {
    const lines = milestoneInvoiceLines({
      name: 'Advance',
      amountMinor: 123_456_78,
      paymentPercent: 20,
      position: 0,
      projectName: null,
    });
    const totals = invoiceTotals(lines);

    assert.deepEqual(totals, {
      subtotalMinor: 123_456_78,
      taxMinor: 0,
      totalMinor: 123_456_78,
    });
  });

  test('tax is integer basis points and never introduces a fraction', () => {
    // 18% GST on ₹1,234.57 is ₹222.2226 — floored to whole paise, once.
    const totals = invoiceTotals([
      {
        position: 0,
        description: 'x',
        quantity: 1,
        unitPriceMinor: 1_234_57,
        amountMinor: 1_234_57,
        taxRateBp: 1800,
      },
    ]);

    assert.equal(totals.taxMinor, Math.floor((1_234_57 * 1800) / 10_000));
    assert.ok(Number.isInteger(totals.taxMinor));
    assert.equal(totals.totalMinor, totals.subtotalMinor + totals.taxMinor);
  });

  /**
   * The property that ties the two halves of the system together: whatever the
   * plan, invoicing every milestone bills the project budget exactly once.
   * This is what "the configured percentage is the source of truth" means in
   * arithmetic.
   */
  for (const [name, percents] of Object.entries({
    '30/20/30/20': [30, 20, 30, 20],
    '5/10/30/20/35': [5, 10, 30, 20, 35],
    '50/50': [50, 50],
    '33.33/33.33/33.34': [33.33, 33.33, 33.34],
  })) {
    test(`invoicing every milestone of ${name} bills the budget exactly`, () => {
      const budget = 999_999;
      const amounts = splitBudget(budget, percents);

      const billed = amounts
        .map((amountMinor, position) =>
          invoiceTotals(
            milestoneInvoiceLines({
              name: `Milestone ${position + 1}`,
              amountMinor,
              paymentPercent: percents[position] ?? null,
              position,
              projectName: null,
            }),
          ).totalMinor,
        )
        .reduce((sum, total) => sum + total, 0);

      assert.equal(billed, budget);
    });
  }
});

// ── Numbering ──────────────────────────────────────────────────────────────

describe('invoice numbering', () => {
  test('formats as INV-YEAR-NNNN, zero padded so it sorts', () => {
    assert.equal(formatInvoiceNumber(2026, 1), 'INV-2026-0001');
    assert.equal(formatInvoiceNumber(2026, 42), 'INV-2026-0042');
    assert.ok('INV-2026-0009' < 'INV-2026-0010', 'padding keeps text order numeric');
  });

  test('round-trips through the parser', () => {
    assert.equal(parseInvoiceSequence(formatInvoiceNumber(2026, 137), 2026), 137);
  });

  test('a number from another year does not advance this year', () => {
    assert.equal(parseInvoiceSequence('INV-2025-0099', 2026), 0);
    assert.equal(nextInvoiceNumber(2026, parseInvoiceSequence('INV-2025-0099', 2026)), 'INV-2026-0001');
  });

  test('a hand-typed or imported number is tolerated, not fatal', () => {
    for (const odd of [null, undefined, '', 'LEGACY/7', 'INV-2026-', 'INV-2026-abc']) {
      assert.equal(parseInvoiceSequence(odd, 2026), 0);
    }
  });

  test('a losing writer advances instead of retrying the same number', () => {
    assert.equal(nextInvoiceNumber(2026, 7, 0), 'INV-2026-0008');
    assert.equal(nextInvoiceNumber(2026, 7, 1), 'INV-2026-0009');
    assert.equal(nextInvoiceNumber(2026, 7, 2), 'INV-2026-0010');
  });

  test('the like-prefix matches its own year and nothing else', () => {
    assert.equal(invoiceNumberPrefix(2026), 'INV-2026-');
    assert.ok(formatInvoiceNumber(2026, 3).startsWith(invoiceNumberPrefix(2026)));
    assert.ok(!formatInvoiceNumber(2027, 3).startsWith(invoiceNumberPrefix(2026)));
  });
});

// ── Status flow ────────────────────────────────────────────────────────────

describe('invoice status flow', () => {
  test('every transition target is a real status', () => {
    for (const [from, targets] of Object.entries(INVOICE_TRANSITIONS)) {
      assert.ok(INVOICE_STATUSES.includes(from as InvoiceStatus), `${from} is a known status`);
      for (const to of targets) {
        assert.ok(INVOICE_STATUSES.includes(to), `${from} → ${to} targets a known status`);
      }
    }
  });

  test('a draft can be issued or voided, but never jump to paid', () => {
    assert.ok(INVOICE_TRANSITIONS.draft.includes('issued'));
    assert.ok(INVOICE_TRANSITIONS.draft.includes('void'));
    assert.ok(!INVOICE_TRANSITIONS.draft.includes('paid'));
    assert.ok(!INVOICE_TRANSITIONS.draft.includes('partially_paid'));
  });

  test('paid and void are terminal', () => {
    assert.deepEqual(INVOICE_TRANSITIONS.paid, []);
    assert.deepEqual(INVOICE_TRANSITIONS.void, []);
  });

  test('a draft is never payable, and never visible to the client', () => {
    assert.ok(!PAYABLE_INVOICE_STATUSES.includes('draft'));
    assert.ok(!PAYABLE_INVOICE_STATUSES.includes('pending_approval'));
    assert.ok(!CLIENT_VISIBLE_INVOICE_STATUSES.includes('draft'));
    assert.ok(!CLIENT_VISIBLE_INVOICE_STATUSES.includes('pending_approval'));
  });

  test('everything payable is something the client can already see', () => {
    for (const status of PAYABLE_INVOICE_STATUSES) {
      assert.ok(
        CLIENT_VISIBLE_INVOICE_STATUSES.includes(status),
        `a client cannot pay a ${status} invoice they cannot see`,
      );
    }
  });
});

// ── Invoiceability ─────────────────────────────────────────────────────────

describe('milestoneInvoiceability', () => {
  test('a priced, pending milestone is billable', () => {
    assert.deepEqual(
      milestoneInvoiceability({ status: 'pending', amountMinor: 100, paymentPercent: 30 }),
      { ok: true },
    );
  });

  test('a delivery-only checkpoint is not billable', () => {
    const result = milestoneInvoiceability({
      status: 'pending',
      amountMinor: 0,
      paymentPercent: null,
    });
    assert.equal(result.ok, false);
  });

  test('a rejected milestone is not billable', () => {
    const result = milestoneInvoiceability({
      status: 'rejected',
      amountMinor: 100,
      paymentPercent: 30,
    });
    assert.equal(result.ok, false);
  });

  test('a priced milestone with no amount is not billable', () => {
    const result = milestoneInvoiceability({
      status: 'pending',
      amountMinor: 0,
      paymentPercent: 30,
    });
    assert.equal(result.ok, false);
  });

  test('a met milestone is still billable — delivery and billing are separate', () => {
    assert.deepEqual(
      milestoneInvoiceability({ status: 'met', amountMinor: 100, paymentPercent: 30 }),
      { ok: true },
    );
  });
});

// ── Payments ───────────────────────────────────────────────────────────────

describe('applyPayment', () => {
  const issued = { status: 'issued' as InvoiceStatus, totalMinor: 100_000, paidSoFarMinor: 0 };

  test('a payment for the full amount pays the invoice', () => {
    const outcome = applyPayment({ ...issued, amountMinor: 100_000 });
    assert.deepEqual(outcome, { ok: true, paidMinor: 100_000, status: 'paid', fullyPaid: true });
  });

  test('a part payment leaves the invoice partially paid', () => {
    const outcome = applyPayment({ ...issued, amountMinor: 40_000 });
    assert.deepEqual(outcome, {
      ok: true,
      paidMinor: 40_000,
      status: 'partially_paid',
      fullyPaid: false,
    });
  });

  test('the balance of a part-paid invoice completes it', () => {
    const outcome = applyPayment({
      ...issued,
      status: 'partially_paid',
      paidSoFarMinor: 40_000,
      amountMinor: 60_000,
    });
    assert.equal(outcome.ok && outcome.fullyPaid, true);
  });

  test('overpayment is refused, not clamped', () => {
    const outcome = applyPayment({ ...issued, amountMinor: 100_001 });
    assert.deepEqual(outcome, { ok: false, reason: 'overpayment' });
  });

  test('a draft cannot take a payment — creation and payment are separate', () => {
    assert.deepEqual(applyPayment({ ...issued, status: 'draft', amountMinor: 1 }), {
      ok: false,
      reason: 'not_payable',
    });
  });

  test('a paid or voided invoice takes no further payment', () => {
    for (const status of ['paid', 'void'] as InvoiceStatus[]) {
      assert.deepEqual(applyPayment({ ...issued, status, amountMinor: 1 }), {
        ok: false,
        reason: 'not_payable',
      });
    }
  });

  test('an overdue invoice can still be paid', () => {
    assert.equal(applyPayment({ ...issued, status: 'overdue', amountMinor: 100_000 }).ok, true);
  });

  test('zero, negative and fractional amounts are refused', () => {
    for (const amountMinor of [0, -1, 10.5]) {
      assert.deepEqual(applyPayment({ ...issued, amountMinor }), {
        ok: false,
        reason: 'non_positive',
      });
    }
  });
});

describe('manual payment references', () => {
  test('the reference is scoped to its invoice, so one UTR can settle two', () => {
    assert.notEqual(manualPaymentKey('invoice-a', 'UTR123'), manualPaymentKey('invoice-b', 'UTR123'));
  });

  test('the same reference on the same invoice is the same key — a duplicate', () => {
    assert.equal(manualPaymentKey('invoice-a', 'UTR123'), manualPaymentKey('invoice-a', ' UTR123 '));
  });

  test('the human reference survives the round trip for display', () => {
    assert.equal(displayPaymentReference(manualPaymentKey(UUID, 'UTR-2026/08/09')), 'UTR-2026/08/09');
  });
});

describe('parseMinorUnits', () => {
  test('whole and fractional amounts convert exactly', () => {
    assert.equal(parseMinorUnits('45000'), 4_500_000);
    assert.equal(parseMinorUnits('45000.50'), 4_500_050);
    assert.equal(parseMinorUnits('0.01'), 1);
    assert.equal(parseMinorUnits('0'), 0);
  });

  test('values that float arithmetic gets wrong convert exactly', () => {
    // Number('0.29') * 100 is 28.999999999999996 — the naive conversion needs
    // a rounding step to survive it, and rounding is what hides the next one.
    assert.notEqual(Number('0.29') * 100, 29);
    assert.notEqual(Number('0.07') * 100, 7);
    assert.equal(parseMinorUnits('0.29'), 29);
    assert.equal(parseMinorUnits('0.07'), 7);
    assert.equal(parseMinorUnits('8.07'), 807);
    assert.equal(parseMinorUnits('123456789.99'), 12_345_678_999);
  });

  test('more precision than the currency has is refused, not silently dropped', () => {
    assert.equal(parseMinorUnits('1.005'), null);
    assert.equal(parseMinorUnits('99.999'), null);
  });

  test('separators and currency symbols pasted from a bank statement are accepted', () => {
    assert.equal(parseMinorUnits('₹1,20,000.00'), 12_000_000);
    assert.equal(parseMinorUnits(' 1,234.56 '), 123_456);
  });

  test('a single trailing decimal is padded, not truncated', () => {
    assert.equal(parseMinorUnits('10.5'), 1050);
    assert.equal(parseMinorUnits('10.'), 1000);
  });

  test('anything that is not money is rejected rather than guessed at', () => {
    for (const input of ['', '   ', 'abc', '1.2.3', '--5', '1e3', '.']) {
      assert.equal(parseMinorUnits(input), null, `${JSON.stringify(input)} is not an amount`);
    }
  });
});

// ── The unlock signal ──────────────────────────────────────────────────────

describe('milestone unlocking', () => {
  const plan = (statuses: (InvoiceStatus | null)[]): MilestoneBillingEntry[] =>
    statuses.map((invoiceStatus, position) => ({
      milestoneId: `m${position + 1}`,
      position,
      paymentPercent: 25,
      invoiceStatus,
    }));

  test('nothing paid unlocks the first milestone', () => {
    const entries = plan([null, null, null, null]);
    assert.equal(paidThrough(entries), 0);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm1');
  });

  test('paying the first unlocks the second', () => {
    const entries = plan(['paid', null, null, null]);
    assert.equal(paidThrough(entries), 1);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm2');
  });

  test('an issued but unpaid invoice unlocks nothing further', () => {
    const entries = plan(['issued', null, null, null]);
    assert.equal(paidThrough(entries), 0);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm1');
  });

  test('a partially paid invoice is not a paid one', () => {
    const entries = plan(['partially_paid', null, null, null]);
    assert.equal(paidThrough(entries), 0);
  });

  test('paying out of order does not skip an outstanding earlier milestone', () => {
    const entries = plan([null, 'paid', 'paid', null]);
    assert.equal(paidThrough(entries), 0);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm1');
  });

  test('a fully paid plan unlocks nothing more', () => {
    const entries = plan(['paid', 'paid', 'paid', 'paid']);
    assert.equal(paidThrough(entries), 4);
    assert.equal(nextUnlockedMilestone(entries), null);
  });

  test('delivery-only checkpoints never gate a payment', () => {
    const entries: MilestoneBillingEntry[] = [
      { milestoneId: 'advance', position: 0, paymentPercent: 50, invoiceStatus: 'paid' },
      { milestoneId: 'kickoff-call', position: 1, paymentPercent: null, invoiceStatus: null },
      { milestoneId: 'final', position: 2, paymentPercent: 50, invoiceStatus: null },
    ];
    assert.equal(paidThrough(entries), 1);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'final');
  });

  test('order comes from position, not from however the rows arrived', () => {
    const entries: MilestoneBillingEntry[] = [
      { milestoneId: 'm3', position: 2, paymentPercent: 30, invoiceStatus: null },
      { milestoneId: 'm1', position: 0, paymentPercent: 30, invoiceStatus: 'paid' },
      { milestoneId: 'm2', position: 1, paymentPercent: 40, invoiceStatus: null },
    ];
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm2');
  });

  test('a project with no payment plan unlocks nothing', () => {
    assert.equal(nextUnlockedMilestone([]), null);
    assert.equal(paidThrough([]), 0);
  });

  test('a voided invoice is absent, not a status — the caller filters it out', () => {
    // The service and the project page both drop void invoices before building
    // entries, so a voided milestone looks uninvoiced here. Asserting the
    // convention keeps the two callers honest.
    const entries = plan([null, null]);
    assert.equal(nextUnlockedMilestone(entries)?.milestoneId, 'm1');
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe('server-side validation', () => {
  test('generation needs a real milestone id', () => {
    assert.equal(generateMilestoneInvoiceSchema.safeParse({ milestoneId: 'nope' }).success, false);
    assert.equal(generateMilestoneInvoiceSchema.safeParse({ milestoneId: UUID }).success, true);
  });

  test('payment terms are bounded and whole', () => {
    assert.equal(
      generateMilestoneInvoiceSchema.safeParse({ milestoneId: UUID, dueInDays: 14 }).success,
      true,
    );
    for (const dueInDays of [-1, 366, 1.5]) {
      assert.equal(
        generateMilestoneInvoiceSchema.safeParse({ milestoneId: UUID, dueInDays }).success,
        false,
      );
    }
  });

  test('a payment needs an amount, a method and a reference', () => {
    const valid = {
      invoiceId: UUID,
      amountMinor: 100,
      method: 'bank_transfer',
      reference: 'UTR1',
    };
    assert.equal(recordManualPaymentSchema.safeParse(valid).success, true);

    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, reference: '' }).success, false);
    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, reference: '  ' }).success, false);
    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, amountMinor: 0 }).success, false);
    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, amountMinor: -5 }).success, false);
    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, amountMinor: 1.5 }).success, false);
    assert.equal(recordManualPaymentSchema.safeParse({ ...valid, method: 'stripe' }).success, false);
  });

  test('voiding needs a stated reason', () => {
    assert.equal(voidInvoiceSchema.safeParse({ invoiceId: UUID, reason: '' }).success, false);
    assert.equal(voidInvoiceSchema.safeParse({ invoiceId: UUID, reason: 'wrong plan' }).success, true);
  });
});
