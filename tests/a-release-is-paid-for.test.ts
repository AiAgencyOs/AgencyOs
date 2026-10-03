import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A release is paid for — decision F1 of 2026-09-30 (bucket F, stream F-E).
 *
 * "Launch is gated on the verified final payment (owner override with
 * reason)." The gate lives in `projects.mark_production_ready`, the door
 * this repository signs a release off with (the plan named it
 * `sign_off_release`; the code's door is ADM-19's), and it reads
 * `projects.final_payment_state` before ADM-19's three conditions. The
 * override is owner-only, needs a reason, is its own table, and is audited
 * `release.payment_overridden`.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20261001140000_a_release_is_paid_for_and_a_run_has_a_life.sql');
const SERVICE = read('src/modules/qa/service.ts');
const OVERRIDE_SERVICE = read('src/modules/projects/release-payment-service.ts');
const RELEASE_PAGE = read('app/(internal)/projects/[projectId]/release/page.tsx');

function body(fn: string, source = MIGRATION): string {
  const start = source.indexOf(`create or replace function ${fn}`);
  assert.ok(start >= 0, `${fn} is in the migration`);
  const end = source.indexOf('$$;', source.indexOf('as $$', start));
  return source.slice(start, end);
}

describe('the decision is written where the door is', () => {
  test('the migration header carries both decisions of 2026-09-30', () => {
    assert.match(MIGRATION, /Decision 2026-09-30: launch is gated on the verified final payment \(owner override with reason\)/);
    assert.match(MIGRATION, /Decision 2026-09-30: budget vs actual reopened/);
  });

  test('mark_production_ready refuses payment_unverified after the hold and before ADM-19', () => {
    const fn = body('projects.mark_production_ready(p_project_id uuid)');
    const held = fn.indexOf("'held'::text");
    const payment = fn.indexOf("'payment_unverified'::text");
    const readiness = fn.indexOf('projects.production_readiness(p_project_id)');
    assert.ok(held > 0 && payment > held, 'the hold is checked first, then the payment');
    assert.ok(readiness > payment, 'ADM-19 is measured only once the payment gate is open');
    // The refusal returns; it does not fall through to the write.
    assert.match(fn, /'payment_unverified'::text,\s*\n\s*array\[[^\]]+\];\s*\n\s*return;/);
  });

  test('the fact behind the gate: the FINAL priced milestone, its live invoice, paid or net-verified or a verified claim', () => {
    const fn = body('projects.final_payment_state(p_project_id uuid)');
    assert.match(fn, /m\.payment_percent is not null/);
    assert.match(fn, /order by m\.position desc\s*\n\s*limit 1/);
    assert.match(fn, /i\.status <> 'void'/);
    assert.match(fn, /v_inv\.status = 'paid'/);
    assert.match(fn, /finance\.net_verified_minor\(v_inv\.id\) >= v_inv\.total_minor/);
    assert.match(fn, /s\.status = 'verified'/);
    // No priced milestone means no gate — not a refusal.
    assert.match(fn, /'no_priced_milestone'::text/);
  });
});

describe('the override is the owner\'s, with a reason, audited', () => {
  test('the table is owner-insert only and never updated or deleted by a policy', () => {
    assert.match(MIGRATION, /create table if not exists projects\.release_payment_overrides/);
    assert.match(MIGRATION, /reason\s+text not null check \(length\(btrim\(reason\)\) between 10 and 2000\)/);
    assert.match(MIGRATION, /alter table projects\.release_payment_overrides enable row level security;/);
    assert.match(MIGRATION, /alter table projects\.release_payment_overrides force row level security;/);
    assert.match(MIGRATION, /create policy release_payment_overrides_insert[\s\S]*?core\.is_owner\(\)/);
    assert.doesNotMatch(MIGRATION, /create policy release_payment_overrides_(update|delete)/);
    assert.match(MIGRATION, /grant select, insert on projects\.release_payment_overrides to authenticated, service_role;/);
    assert.match(MIGRATION, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(MIGRATION, /freeze_org_release_payment_overrides/);
  });

  test('the door refuses a non-owner, a short reason, and an override of a verified payment; it audits release.payment_overridden', () => {
    const fn = body('projects.override_release_payment(p_project_id uuid, p_reason text)');
    assert.match(fn, /not coalesce\(\(select core\.is_owner\(\)\), false\)/);
    assert.match(fn, /'forbidden'::text/);
    assert.match(fn, /length\(btrim\(coalesce\(p_reason, ''\)\)\) < 10/);
    assert.match(fn, /'nothing_to_override'::text/);
    assert.match(fn, /'release\.payment_overridden'/);
    // The audit row is written inside the same function, after the insert.
    assert.ok(fn.indexOf('insert into projects.release_payment_overrides') < fn.indexOf("'release.payment_overridden'"));
    // Only a session may call it — no service-role shortcut around the owner.
    assert.match(MIGRATION, /grant execute on function projects\.override_release_payment\(uuid, text\) to authenticated;/);
    assert.doesNotMatch(MIGRATION, /grant execute on function projects\.override_release_payment\(uuid, text\) to authenticated, service_role/);
  });

  test('the override reads as overridden to the gate', () => {
    const fn = body('projects.final_payment_state(p_project_id uuid)');
    assert.match(fn, /exists \(select 1 from projects\.release_payment_overrides o where o\.project_id = p_project_id\)/);
    assert.match(fn, /'overridden'::text/);
  });
});

describe('the application says the refusal in words and draws the override for the owner only', () => {
  test('the sign-off service names the invoice and the milestone in the refusal', () => {
    assert.match(SERVICE, /case 'payment_unverified':/);
    assert.match(SERVICE, /final payment/i);
  });

  test('the override service asks the owner capability before the database asks again', () => {
    assert.match(OVERRIDE_SERVICE, /can\(context, 'organization\.settings'\)/);
    assert.match(OVERRIDE_SERVICE, /rpc\('override_release_payment'/);
    assert.match(OVERRIDE_SERVICE, /case 'nothing_to_override':/);
  });

  test('the Release tab marks the payment line as a hard gate and mounts the override for the owner', () => {
    assert.match(RELEASE_PAGE, /readFinalPaymentState\(projectId\)/);
    assert.match(RELEASE_PAGE, /key: 'payment',[\s\S]*?hardGate: true/);
    assert.match(RELEASE_PAGE, /OverrideReleasePaymentForm/);
    assert.match(RELEASE_PAGE, /hasRole\(context, 'owner'\)/);
  });
});
