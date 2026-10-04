import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ROLES } from '../src/lib/auth/claims.ts';
import { can } from '../src/lib/authz/permissions.ts';

const read = (p: string) => readFileSync(p, 'utf8');

// Owner decision 2026-10-04 (separation of duties): the ops admin issues invoices
// and records and checks claims; confirming that money arrived - the act that opens
// the finance gate - is the owner's alone. Held in three places, because a rule held
// in one is half a check: the capability, the buttons, and the database.

describe('the capability', () => {
  test('only the owner holds payment.verify; every other role is refused', () => {
    assert.equal(can('owner', 'payment.verify'), true);
    for (const role of ROLES.filter((r) => r !== 'owner')) assert.equal(can(role, 'payment.verify'), false, role);
  });

  test('the ops admin keeps everything else money-side - issuing, creating, recording', () => {
    for (const c of ['invoice.read', 'invoice.create', 'invoice.issue'] as const) assert.equal(can('ops_admin', c), true, c);
  });
});

describe('the services', () => {
  const service = read('src/modules/finance/service.ts');
  const body = (name: string) => service.slice(service.indexOf(`export async function ${name}(`), service.indexOf(`export async function ${name}(`) + 1500);

  test('confirming a payment and checking a claim both need payment.verify', () => {
    assert.match(body('verifyPayment'), /can\(context, 'payment\.verify'\)/);
    assert.match(body('verifyPaymentSubmission'), /can\(context, 'payment\.verify'\)/);
  });

  test('recording what a client says they paid still needs only invoice.issue', () => {
    assert.match(body('recordPaymentSubmission'), /can\(context, 'invoice\.issue'\)/);
    assert.doesNotMatch(body('recordPaymentSubmission'), /payment\.verify/);
  });

  test('the database\'s own refusal reaches the person in words', () => {
    assert.match(service, /case 'forbidden':\s*\n\s*return err\('FORBIDDEN', 'Only the owner confirms that money arrived\.'\)/);
    assert.match(service, /case 'forbidden':\s*\n\s*return err\('FORBIDDEN', 'Only the owner verifies a payment claim\.'\)/);
  });
});

describe('the screens do not offer what the database would refuse', () => {
  test('the Confirm button, the claim form and the queue decision are shown to the owner only', () => {
    assert.match(read('app/(internal)/invoices/[invoiceId]/page.tsx'), /mayVerifyPayment && p\.status === 'captured'/);
    assert.match(read('app/(internal)/finance/payments/[paymentId]/page.tsx'), /const mayVerify = can\(context, 'payment\.verify'\)/);
    assert.match(read('app/(internal)/projects/[projectId]/page.tsx'), /can\(context, 'payment\.verify'\) \?[\s\S]{0,80}<VerifyClaimForm/);
    assert.match(read('app/(internal)/invoices/verify/page.tsx'), /can\(context, 'payment\.verify'\) \?[\s\S]{0,80}<ClaimDecision/);
  });

  test('and says who does it, instead of a missing button', () => {
    assert.match(read('app/(internal)/projects/[projectId]/page.tsx'), /The owner verifies this claim\./);
  });
});

describe('the database', () => {
  const sql = read('supabase/migrations/20261011390000_only_the_owner_confirms_that_money_arrived.sql');

  test('both doors refuse a signed-in caller who is not the owner, and leave the runner alone', () => {
    const guards = sql.match(/if \(select auth\.uid\(\)\) is not null and not coalesce\(\(select core\.is_owner\(\)\), false\) then/g) ?? [];
    assert.equal(guards.length, 2);
    assert.match(sql, /return query select 'forbidden'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;/);
    assert.match(sql, /return query select 'forbidden'::text, null::text;/);
  });

  test('the guard comes BEFORE any read or write in each door', () => {
    const vpAt = sql.search(/FUNCTION finance\.verify_payment\(/i);
    const vpsAt = sql.search(/FUNCTION finance\.verify_payment_submission\(/i);
    assert.ok(vpAt >= 0 && vpsAt > vpAt, 'both doors are in the migration');
    const g1 = sql.indexOf("'forbidden'", vpAt);
    assert.ok(g1 > vpAt && g1 < vpsAt && g1 < sql.indexOf('select p.invoice_id', vpAt), 'verify_payment');
    const g2 = sql.indexOf("'forbidden'", vpsAt);
    assert.ok(g2 > vpsAt && g2 < sql.indexOf('select s.* into v_row', vpsAt), 'verify_payment_submission');
  });
});
