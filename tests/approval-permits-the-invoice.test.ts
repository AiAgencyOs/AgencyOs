import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * G-100 — an approved deliverable permits the bill.
 *
 * ADM-13: **client approval makes the milestone invoice raisable, not sent.**
 *
 * Two mechanisms have run side by side since delivery was built and never
 * touched each other. Money flowed on payment; approval flowed on delivery.
 * Directive §18's middle arrow — UI_APPROVED → MILESTONE_PAYMENT_DUE — existed
 * in the document and nowhere else.
 *
 *   A. the gate refuses issuing, not drafting
 *   B. it is read under the same lock as everything else
 *   C. an unlinked milestone is unchanged, which is the stated cost
 *   D. nothing that issue_invoice already refused was lost
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const executable = read('../supabase/migrations/20260813120017_approval_permits_the_invoice.sql')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const issue = executable.slice(
  executable.indexOf('create or replace function finance.issue_invoice'),
  executable.indexOf('$$;', executable.indexOf('create or replace function finance.issue_invoice')),
);

describe('A. approval permits issuing, and only issuing', () => {
  test('the gate lives in issue_invoice, not in invoice creation', () => {
    // Drafting stays free. Issuing is the act that reaches the client, and it
    // is the one that waits — the same shape as the QA gate, which refuses
    // submit_deliverable rather than every write.
    assert.match(issue, /'deliverable_not_approved'/);

    const create = read('../supabase/migrations/20260813120011_invoice_created_in_its_transaction.sql');
    assert.doesNotMatch(create, /requires_deliverable_id/);
  });

  test('and it refuses anything that is not approved', () => {
    // `is distinct from` rather than `<>`: a deliverable row that has vanished
    // leaves v_gate_state null, and null <> 'approved' is null, which is not
    // true — so the gate would let it through.
    assert.match(issue, /if v_gate_state is distinct from 'approved' then/);
  });

  test('the refusal names the status the lock saw', () => {
    assert.match(issue, /return query select 'deliverable_not_approved'::text, v_status;/);
  });
});

describe('B. it is decided under the invoice lock', () => {
  test('after the row is taken for update and before anything is written', () => {
    const lock = issue.indexOf('for update');
    const gate = issue.indexOf("'deliverable_not_approved'");
    const write = issue.indexOf('update finance.invoices');
    assert.ok(lock > 0 && gate > lock, 'the gate is read before the lock is taken');
    assert.ok(write > gate, 'the gate is checked after the write it should prevent');
  });
});

describe('C. an unlinked milestone bills as it always did', () => {
  test('the column is nullable and the gate is skipped when it is null', () => {
    assert.match(executable, /add column if not exists requires_deliverable_id uuid/);
    assert.match(issue, /if v_gate is not null then/);
  });

  test('and losing the deliverable nulls the link rather than cascading', () => {
    // A cascade would delete the milestone. Set null at least leaves the gap
    // visible on the milestone rather than removing the bill entirely.
    assert.match(executable, /references projects\.deliverables\(id\) on delete set null/);
  });

  test('an invoice with no milestone at all is untouched', () => {
    assert.match(issue, /if v_milestone is not null then/);
  });
});

describe('D. nothing issue_invoice already refused was lost', () => {
  test('every earlier outcome survives the carry-forward', () => {
    for (const outcome of ['not_found', 'already_issued', 'not_issuable', 'no_amount', 'no_items']) {
      assert.match(issue, new RegExp(`'${outcome}'`), `${outcome} was lost`);
    }
  });

  test('and so do the lock, the audit row and the event', () => {
    assert.match(issue, /for update/);
    assert.match(issue, /core\.record_audit/);
    assert.match(issue, /core\.emit_event/);
    assert.match(issue, /'invoice\.issued'/);
  });
});
