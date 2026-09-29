import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (p: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', p), 'utf8');

/**
 * finance.verify_payment is SECURITY INVOKER and granted to authenticated;
 * it numbers the receipt through finance.new_receipt_reference(). If the
 * helper is executable only by service_role, the human gate fails for every
 * real admin while every service-role test stays green — which is exactly
 * what happened between 20260928130000 and 20260929120000. This pins the
 * shape so the next redefinition of either function cannot reintroduce it.
 */
describe('the admin who verifies a payment may number its receipt', () => {
  const receipts = read('20260928130000_a_payment_gets_its_own_receipt.sql');
  const fix = read('20260929120000_the_verifier_may_number_the_receipt.sql');

  it('verify_payment runs as the caller and is open to authenticated', () => {
    assert.match(receipts, /grant execute on function finance\.verify_payment\(uuid, uuid\) to authenticated, service_role;/);
    const body = receipts.slice(receipts.indexOf('create or replace function finance.verify_payment('));
    assert.match(body.slice(0, 2000), /security invoker/);
    assert.match(body, /finance\.new_receipt_reference\(\)/);
  });

  it('the helper it calls is therefore granted to authenticated as well', () => {
    assert.match(fix, /grant execute on function finance\.new_receipt_reference\(\) to authenticated;/);
  });

  it('the helper carries no authority of its own — six characters, nothing read, nothing written', () => {
    const helper = receipts.slice(
      receipts.indexOf('create or replace function finance.new_receipt_reference()'),
      receipts.indexOf('$$;', receipts.indexOf('create or replace function finance.new_receipt_reference()')),
    );
    assert.match(helper, /generate_series\(1, 6\)/);
    assert.doesNotMatch(helper, /\b(insert|update|delete|from finance\.|from core\.)\b/i);
  });
});
