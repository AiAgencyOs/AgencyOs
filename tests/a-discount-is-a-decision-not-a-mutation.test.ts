import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * A discount is a decision, not a mutation — Business Phase 1-4 audit step
 * 1.27.
 *
 * These pin the structure the live verification in
 * `scripts/verify-discount-and-payment-structure-local.sql` drives against a
 * real Postgres (run via `scripts/apply-migrations-locally.sh`, KEEP=1): the
 * discount audit row, the DDL-level refusal that an agent-requested discount
 * can never be autonomous, and the reuse of the existing approvals engine
 * rather than a parallel mechanism.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20261030100000_a_discount_is_a_decision_not_a_mutation.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const SERVICE = read('src/modules/sales/service.ts');
const SCHEMA = read('src/modules/sales/schema.ts');
const CATALOG = read('src/lib/events/catalog.ts');
const HANDLERS = read('src/modules/sales/handlers.ts');

describe('A. the audit row records what step 1.27 says is missing', () => {
  test('original amount, discount amount and percentage, reason, expiry and final amount all exist', () => {
    assert.match(MIGRATION, /original_amount_minor\s+bigint not null/);
    assert.match(MIGRATION, /discount_minor\s+bigint not null check \(discount_minor > 0\)/);
    assert.match(MIGRATION, /discount_pct\s+numeric\(5, 2\) not null/);
    assert.match(MIGRATION, /reason\s+text not null check/);
    assert.match(MIGRATION, /expiry\s+date/);
    assert.match(MIGRATION, /final_amount_minor\s+bigint/);
  });

  test('the requester is agent or human, and approved_by is human only', () => {
    assert.match(MIGRATION, /requested_by_type\s+text not null check \(requested_by_type in \('agent', 'human'\)\)/);
    assert.match(MIGRATION, /approved_by\s+uuid references core\.users\(id\)/);
  });
});

describe('B. an agent-requested discount can never be autonomous, held in DDL', () => {
  test('the constraint exists and names both conditions', () => {
    assert.match(
      MIGRATION,
      /constraint discount_decisions_no_autonomous_agent check \(\s*not \(requested_by_type = 'agent' and status = 'autonomous'\)\s*\)/,
    );
  });

  test('the door itself never routes an agent request down the autonomous branch', () => {
    assert.match(
      MIGRATION,
      /if p_requested_by_type = 'human' and v_cap is not null and v_pct <= v_cap then\s*v_status := 'autonomous';/,
    );
  });

  test('a signed-in caller cannot pose as an agent request', () => {
    assert.match(MIGRATION, /if p_requested_by_agent is null or v_actor is not null then/);
  });
});

describe('C. the existing approvals engine, not a parallel one', () => {
  test('discount_decision joins the same two CHECK constraints ui_version and handover did', () => {
    assert.match(MIGRATION, /approval_requests_subject_type_check[\s\S]{0,400}'discount_decision'/);
    assert.match(MIGRATION, /approval_policies_subject_type_check[\s\S]{0,400}'discount_decision'/);
  });

  test('a discount above the cap raises a REAL request through approvals.request_approval', () => {
    assert.match(MIGRATION, /approvals\.request_approval\(\s*v_row\.organization_id, 'discount_decision', v_id,/);
  });

  test('no policy is seeded — an owner configures one, the same as every other subject type', () => {
    assert.match(MIGRATION_RAW, /No policy row is seeded here/);
  });

  test('the request success outcome is matched by name, not guessed', () => {
    assert.match(MIGRATION, /if v_approval\.outcome not in \('requested', 'already_pending'\) then/);
  });
});

describe('D. settling a decision carries it back onto the row', () => {
  test('sync_discount_decision exists, is SECURITY DEFINER, and is agent/job-runner only', () => {
    assert.match(
      MIGRATION,
      /create or replace function sales\.sync_discount_decision\(p_decision_id uuid\)[\s\S]{0,80}security definer/,
    );
    assert.match(MIGRATION, /revoke execute on function sales\.sync_discount_decision\(uuid\) from anon, authenticated;/);
    assert.match(MIGRATION, /grant execute on function sales\.sync_discount_decision\(uuid\) to service_role;/);
  });

  test('approved sets approved_by and final_amount_minor', () => {
    assert.match(MIGRATION, /status\s*=\s*'approved',\s*approved_by\s*=\s*v_request\.decided_by,\s*final_amount_minor\s*=\s*v_decision\.original_amount_minor - v_decision\.discount_minor/);
  });

  test('wired into the approval.decided fan-out, filtered to its own subject type', () => {
    assert.match(CATALOG, /'approval\.decided':\s*\[[\s\S]{0,400}'sales:syncDiscountDecision'/);
    assert.match(
      CATALOG,
      /'sales:syncDiscountDecision':\s*\(event\) =>\s*\(event\.payload as \{ subjectType\?: string \} \| null\)\?\.subjectType === 'discount_decision'/,
    );
  });

  test('the handler re-reads the row rather than trusting the event payload', () => {
    assert.match(
      HANDLERS,
      /export async function syncDiscountDecision[\s\S]{0,2000}request\.subject_type !== 'discount_decision'/,
    );
  });
});

describe('E. the existing pricing door now goes through the decision, not around it', () => {
  test('a discount increase calls record_discount_decision before the write', () => {
    assert.match(
      MIGRATION,
      /if v_discount > coalesce\(v_row\.discount_minor, 0\)[\s\S]{0,200}sales\.record_discount_decision\(/,
    );
  });

  test('the old three-argument signature is dropped explicitly, not left to create-or-replace', () => {
    assert.match(MIGRATION, /drop function if exists sales\.set_proposal_pricing\(uuid, bigint, bigint\);/);
  });

  test('the TS service layer surfaces the new refusal outcomes rather than swallowing them', () => {
    assert.match(SERVICE, /case 'no_policy':\s*return err\(\s*'CONFLICT',\s*'No approval policy covers discounts\./);
  });
});

describe('F. the TypeScript surface for recording a discount directly', () => {
  test('recordDiscountDecisionSchema requires a reason and bounds the discount', () => {
    assert.match(SCHEMA, /export const recordDiscountDecisionSchema = z\.object\(\{[\s\S]{0,200}discountMinor: z\.number\(\)\.int\(\)\.positive\(\)/);
  });

  test('recordDiscountDecision is exported from service.ts', () => {
    assert.match(SERVICE, /export async function recordDiscountDecision\(/);
  });
});

describe('the approval a decision raised is a guarded parent too', () => {
  test('enforce_parent_org covers approval_request_id, as db:verify:tenancyguards requires of every org-scoped foreign key', () => {
    const sql = readFileSync('supabase/migrations/20261030100000_a_discount_is_a_decision_not_a_mutation.sql', 'utf8');
    assert.match(sql, /create trigger org_match_discount_decisions_approval\s+before insert or update of approval_request_id, organization_id on sales\.discount_decisions\s+for each row execute function core\.enforce_parent_org\('approval_request_id', 'approvals\.approval_requests'\)/);
  });
});
