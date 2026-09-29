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
    const start = receipts.indexOf('create or replace function finance.verify_payment(');
    const body = receipts.slice(start, receipts.length);
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

describe('the board leaves a trace', () => {
  const migration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260929130000_the_board_leaves_a_trace.sql'), 'utf8');

  it('projects.tasks is attached to audit.record_row_change', () => {
    assert.match(migration, /create trigger audit_row_change after insert or update on projects\.tasks/);
  });

  it('with the status as the action name, and every prior branch carried forward', () => {
    assert.match(migration, /when 'tasks' then/);
    assert.match(migration, /'task\.' \|\| new\.status/);
    for (const table of ['leads', 'lead_activities', 'communication_consent', 'onboarding_baseline', 'follow_up_sequences', 'follow_up_sends', 'requirement_versions', 'client_accounts', 'opportunities', 'proposals', 'projects', 'defects', 'project_files', 'repositories', 'deliverables', 'approval_requests', 'environments', 'dependencies']) {
      assert.match(migration, new RegExp(`when '${table}' then`), `${table} branch survived the redefinition`);
    }
  });
});
