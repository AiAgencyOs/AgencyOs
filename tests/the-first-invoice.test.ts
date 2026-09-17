import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GST_RATE_BP, taxRateBpForMode } from '../src/modules/finance/gstin.ts';
import { invoiceTotals, milestoneInvoiceLines } from '../src/modules/finance/schema.ts';
import { GST_LINE } from '../src/modules/sales/quotation-standards.ts';
import { LOCKED_PAYMENT_STRUCTURE, lockedAmountsFor } from '../src/modules/projects/payment-structure.ts';

/**
 * The first invoice — Finance §3, §4.1–§4.4, §16; Master §5.8.
 *
 * G-255 recorded which way a project is billed and **nothing read it**. Every
 * invoice this system has issued carried `tax_rate_bp = 0` while every
 * quotation it sent promised *"18% GST extra"*. This closes that loop: the
 * rate now comes from the confirmed mode, and an invoice cannot be raised
 * before the mode exists.
 *
 * The rate itself is **not a constant somebody picked**. It is parsed back out
 * of the agency's own printed quotation line, and the test below fails if the
 * two ever disagree — which is the only way a policy change in one file cannot
 * silently leave the other behind.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/finance/service.ts');
const SCHEMA = read('src/modules/finance/schema.ts');
const GATE = SERVICE.slice(SERVICE.indexOf('Finance §16, the first two rows'), SERVICE.indexOf('const lines = milestoneInvoiceLines'));

describe('A. the rate is the agency’s own printed promise', () => {
  test('GST_RATE_BP agrees with the line every quotation carries', () => {
    // `GST_LINE` is what the client reads: "All amounts are exclusive of GST;
    // 18% GST extra." If somebody changes that to 12%, this fails — which is
    // the point. Two places holding one policy must be checked against each
    // other, not maintained in parallel by memory.
    const printed = /(\d+(?:\.\d+)?)\s*%\s*GST/.exec(GST_LINE);
    assert.ok(printed, `the quotation line no longer states a percentage: ${GST_LINE}`);
    assert.equal(GST_RATE_BP, Math.round(Number(printed[1]) * 100));
  });

  test('a GST project bills at that rate and a non-GST one at nothing', () => {
    assert.equal(taxRateBpForMode('gst'), GST_RATE_BP);
    assert.equal(taxRateBpForMode('non_gst'), 0);
  });

  test('no confirmed mode yields NULL, never zero', () => {
    // Zero is a decision — "this client is not charged GST". Returning it for
    // "nobody has told us" is exactly the inference Finance §4.1 forbids, and
    // it is the shape this whole unit exists to remove.
    assert.equal(taxRateBpForMode(null), null);
  });
});

describe('B. the arithmetic, to the paisa', () => {
  test('18% on a ₹1,00,000 M1 is ₹5,400 tax on a ₹30,000 line', () => {
    // ADM-105's M1 against a ₹1,00,000 budget is ₹30,000; 18% of that is
    // ₹5,400, and the invoice total is ₹35,400.
    const [m1] = lockedAmountsFor(10_000_000);
    assert.equal(m1, 3_000_000);

    const lines = milestoneInvoiceLines(
      { name: LOCKED_PAYMENT_STRUCTURE[0]!.name, amountMinor: m1!, paymentPercent: 30, position: 0 },
      GST_RATE_BP,
    );
    const totals = invoiceTotals(lines);
    assert.deepEqual(totals, { subtotalMinor: 3_000_000, taxMinor: 540_000, totalMinor: 3_540_000 });
  });

  test('the same milestone billed Non-GST carries no tax at all', () => {
    const [m1] = lockedAmountsFor(10_000_000);
    const totals = invoiceTotals(
      milestoneInvoiceLines({ name: 'Advance', amountMinor: m1!, paymentPercent: 30, position: 0 }, 0),
    );
    assert.deepEqual(totals, { subtotalMinor: 3_000_000, taxMinor: 0, totalMinor: 3_000_000 });
  });

  test('tax is floored per line, so no invoice bills a fraction of a paisa', () => {
    // The value matters: 7 paise at 18% is 1.26, which floors AND rounds to 1,
    // so it proves nothing — a red-proof swapping floor for round stayed green
    // on it. 3 paise is 0.54: floor 0, round 1. That is the difference between
    // charging nothing and inventing a paisa.
    const half = invoiceTotals(milestoneInvoiceLines({ name: 'X', amountMinor: 3, paymentPercent: null, position: 0 }, GST_RATE_BP));
    assert.deepEqual(half, { subtotalMinor: 3, taxMinor: 0, totalMinor: 3 }, 'rounding up invents a paisa');

    // And one that does carry tax, so the assertion above is not passing
    // because tax is broken altogether.
    const whole = invoiceTotals(milestoneInvoiceLines({ name: 'X', amountMinor: 7, paymentPercent: null, position: 0 }, GST_RATE_BP));
    assert.deepEqual(whole, { subtotalMinor: 7, taxMinor: 1, totalMinor: 8 });
  });

  test('the rate is an argument, not a default', () => {
    // A default of 0 would be indistinguishable from a confirmed Non-GST
    // decision, and every existing caller would have kept billing no tax
    // without anyone noticing the signature had changed.
    assert.doesNotMatch(SCHEMA, /taxRateBp: number = 0|taxRateBp = 0/);
    assert.match(SCHEMA, /taxRateBp: number,\n\): InvoiceLine\[\]/);
  });
});

describe('C. §16’s first two rows, before the invoice exists', () => {
  test('no confirmed mode blocks the invoice', () => {
    assert.match(GATE, /if \(readiness\.data\.mode === null\)/);
    assert.match(GATE, /Confirm whether this project is billed with GST or without it before raising an invoice/);
  });

  test('incomplete billing details block it, and name only what is missing', () => {
    assert.match(GATE, /if \(!readiness\.data\.complete\)/);
    assert.match(GATE, /readiness\.data\.missing\.join\(', '\)/);
    assert.match(GATE, /readiness\.data\.invalid\.map/);
    assert.match(GATE.replace(/\n\s*\/\/ ?/g, ' '), /request ONLY missing fields/);
  });

  test('the gate runs BEFORE the invoice is built', () => {
    // An invoice that exists is a number issued, and undoing it leaves a gap
    // in a sequence somebody's accountant will ask about.
    const gateAt = SERVICE.indexOf('const readiness = await readBillingReadiness');
    const buildAt = SERVICE.indexOf('const lines = milestoneInvoiceLines');
    const writeAt = SERVICE.indexOf("rpc('create_milestone_invoice'");
    assert.ok(gateAt > 0 && buildAt > gateAt && writeAt > buildAt);
  });

  test('but AFTER the idempotency check, so a repeat is still an answer', () => {
    // A milestone already billed returns its existing invoice whatever the
    // billing profile says now — re-asking a settled question would turn a
    // refreshed page into an error.
    const existingAt = SERVICE.indexOf('const existing = await findLiveInvoiceForMilestone');
    const gateAt = SERVICE.indexOf('const readiness = await readBillingReadiness');
    assert.ok(existingAt > 0 && gateAt > existingAt);
  });

  test('an unresolvable rate is refused, never coerced to zero', () => {
    assert.match(GATE, /if \(taxRateBp === null\)/);
    assert.doesNotMatch(GATE, /taxRateBp \?\? 0/);
    assert.match(GATE.replace(/\n\s*\/\/ ?/g, ' '), /a `\?\? 0` here would turn an impossible state into a Non-GST invoice/);
  });

  test('a failed read of the profile is not a project with no mode', () => {
    // G-054 again, and it matters more here than most: one blocks an invoice
    // and sends the PM to ask a client a question they already answered.
    assert.match(GATE, /if \(!readiness\.ok\) return readiness;/);
  });
});

describe('D. what this unit still does not do', () => {
  test('it issues an invoice and delivers nothing', () => {
    // Finance §4.5 wants email (BLK-007, no provider) and Master §5.8 wants
    // the project WhatsApp group (BLK-003, still Meta's test number). An
    // issued-but-undelivered invoice is a state the spec models (§16: "invoice
    // delivery failed → let Finance retry"), not a defect of this change.
    assert.doesNotMatch(GATE, /send|deliver|email|whatsapp/i);
  });
});
