import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { region } from './_region.ts';

/**
 * Finance Agent spec §14: a Receipt entity — "a unique auditable receipt
 * number, referencing payment/invoice/amount/method/date, generated only
 * after Admin-verified payment."
 *
 * Generated inside finance.verify_payment itself, under the same invoice row
 * lock confirmation already takes, one receipt per verified PAYMENT.
 *
 * Live-verified against a real scratch Postgres before this file was
 * written: a first verification created a receipt and paid the invoice; an
 * idempotent replay answered already_verified with the SAME receipt id and
 * number, not a second row. Caught and fixed a real near-miss along the way —
 * this migration's first draft copied verify_payment from
 * 20260815180000 (found via a lowercase-only grep), missing the
 * finance.sanctioned_write capability line a LATER migration
 * (20260815290000, using UPPERCASE `CREATE OR REPLACE`) had already added.
 * Deploying that draft would have broken every authenticated payment
 * verification in production.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260928130000_a_payment_gets_its_own_receipt.sql');

const verifyPaymentBody = region(MIGRATION, 'create or replace function finance.verify_payment', '$$;\n\ncomment');

describe('A. the receipt entity', () => {
  test('one receipt per payment, ever — a real unique constraint, not caller discipline', () => {
    assert.match(MIGRATION, /payment_id\s+uuid not null unique references finance\.payments/);
  });

  test('a receipt names its invoice, amount and currency', () => {
    assert.match(MIGRATION, /invoice_id\s+uuid not null references finance\.invoices/);
    assert.match(MIGRATION, /amount_minor\s+bigint not null check \(amount_minor > 0\)/);
    assert.match(MIGRATION, /currency\s+char\(3\) not null/);
  });

  test('internal-only for now — a client-facing receipt view is separate work', () => {
    assert.match(MIGRATION, /receipts_select[\s\S]{0,200}core\.is_internal\(\)/);
  });
});

describe('B. generated exactly where money is confirmed, not where it is claimed', () => {
  test('the sanctioned-write capability is declared — the near-miss this file itself found', () => {
    assert.match(
      verifyPaymentBody,
      /perform set_config\('finance\.sanctioned_write', 'on', true\);/,
    );
  });

  test('an invoker-write policy exists for the receipt insert under RLS', () => {
    assert.match(MIGRATION, /create policy receipts_insert on finance\.receipts/);
    assert.match(MIGRATION, /for insert to authenticated/);
  });

  test('the receipt is generated inside verify_payment, under the same lock, not by a separate call', () => {
    assert.match(verifyPaymentBody, /insert into finance\.receipts/);
  });

  test('never generated for a payment that failed or was never captured', () => {
    assert.match(verifyPaymentBody, /'not_captured'::text/);
    // The not_captured branch returns before the receipt-insert block exists at all.
    const notCapturedIdx = verifyPaymentBody.indexOf("'not_captured'::text");
    const receiptInsertIdx = verifyPaymentBody.indexOf('insert into finance.receipts');
    assert.ok(notCapturedIdx > 0 && receiptInsertIdx > notCapturedIdx);
  });

  test('a reference collision retries rather than failing the whole verification', () => {
    assert.match(verifyPaymentBody, /for v_attempt in 1\.\.5 loop/);
    assert.match(verifyPaymentBody, /when unique_violation then/);
  });
});

describe('C. idempotent — a replay answers with the SAME receipt, not a second one', () => {
  test('already_verified branches read the existing receipt rather than creating one', () => {
    const alreadyVerifiedBlocks = verifyPaymentBody.match(
      /select r\.id, r\.number into v_receipt_id, v_receipt_number\s*\n\s*from finance\.receipts r where r\.payment_id = p_payment_id;/g,
    );
    assert.equal(alreadyVerifiedBlocks?.length, 2, 'both already_verified paths (pre-lock and race-losing) must read the existing receipt');
  });
});

describe('D. the TS layer surfaces the receipt, not just the invoice status', () => {
  const service = read('src/modules/finance/service.ts');

  test('VerificationResult carries receiptId and receiptNumber', () => {
    const resultType = region(service, 'export type VerificationResult');
    assert.match(resultType, /receiptId: string \| null;/);
    assert.match(resultType, /receiptNumber: string \| null;/);
  });

  test('the receipt number reaches the Admin-facing confirmation message', () => {
    const actions = read('src/modules/finance/actions.ts');
    assert.match(actions, /result\.data\.receiptNumber/);
  });
});
