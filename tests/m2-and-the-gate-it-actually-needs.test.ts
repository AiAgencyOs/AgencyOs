import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * M2, and the gate it actually needs — Finance §2, §5, §12-17; Impl §7.4.
 * docs/phase-4-gap-analysis.md step 6.
 *
 * The two assertions that matter most: `generateM2Invoice` never marks
 * anything paid or verified (only `finance.verify_payment_submission`,
 * reached exclusively through a real Admin session, may do that), and the
 * two shared deliverable functions' bodies are otherwise byte-identical to
 * what is actually installed — only one new `emit_event` line each.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923160000_m2_and_the_gate_it_actually_needs.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const SERVICE_TS = read('src/modules/finance/service.ts');
const HANDLERS_FIN_TS = read('src/modules/finance/handlers.ts');
const HANDLERS_PROJ_TS = read('src/modules/projects/handlers.ts');
const RUNNER = read('app/api/jobs/run/route.ts');

const doorFor = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} not found`);
  return SQL.slice(start, SQL.indexOf(name.includes('gate_status') ? '$$;' : '$$;', start));
};

const completeDoor = doorFor('complete_phase_four');
const gateFn = doorFor('phase_five_gate_status');

describe('A. M2 issues an invoice; it never verifies a payment', () => {
  test('generateM2Invoice never writes finance.invoices.status directly', () => {
    const fn = region(
      SERVICE_TS,
      'export async function generateM2Invoice',
      '// ── issue ──────────────────────────────────────────────────────────────────',
    );
    assert.doesNotMatch(fn, /\.update\(\s*\{\s*status:\s*'paid'/);
    assert.doesNotMatch(fn, /verify_payment_submission/);
  });

  test('and the migration states the hard rule explicitly', () => {
    const prose = MIGRATION.replace(/\n\s*--\s?/g, ' ');
    assert.match(prose, /must NOT open Phase 5/);
    assert.match(prose, /Only `finance\.verify_payment_submission`/);
  });

  test('the gate status function only calls something \'verified\' when the invoice is paid', () => {
    assert.match(gateFn, /when i\.status = 'paid' then 'verified'/);
    assert.doesNotMatch(gateFn, /'issued'.*then 'verified'|'pending'.*then 'verified'/);
  });
});

describe('B. the two shared deliverable functions gained exactly one line each', () => {
  test('submit_deliverable still has every original guard, plus one new event', () => {
    const fn = SQL.slice(
      SQL.indexOf('create or replace function projects.submit_deliverable'),
      SQL.indexOf('-- ── sync_deliverable_decision'),
    );
    assert.match(fn, /if v_row\.status in \('approved', 'superseded'\) then/);
    assert.match(fn, /select count\(\*\) into v_blocking from qa\.blocking_defects/);
    assert.match(fn, /perform core\.emit_event\(\s*\n\s*v_row\.organization_id, 'project\.deliverable_submitted'/);
  });

  test('sync_deliverable_decision still supersedes old approved versions, plus one new event', () => {
    const fn = SQL.slice(
      SQL.indexOf('create or replace function projects.sync_deliverable_decision'),
      SQL.indexOf('-- ── the door that closes Task 2'),
    );
    assert.match(fn, /set status = 'superseded'/);
    assert.match(fn, /perform core\.emit_event\(\s*\n\s*v_row\.organization_id, 'project\.deliverable_decided'/);
  });
});

describe('C. Task 2 closes only on the PROTOTYPE\'s approval, filtered in TypeScript', () => {
  test('the SQL event is generic across every deliverable kind', () => {
    assert.match(SQL, /'project\.deliverable_decided',\s*\n\s*'A deliverable of any kind/);
  });

  test('the handler filters to kind=prototype and status=approved before calling the door', () => {
    const fn = region(HANDLERS_PROJ_TS, 'export async function handleDeliverableDecided', TO_END);
    assert.match(fn, /if \(deliverable\.kind !== 'prototype'\)/);
    assert.match(fn, /if \(deliverable\.status !== 'approved'\)/);
    assert.match(fn, /rpc\('complete_phase_four'/);
  });

  test('the deliverable row is re-read, not trusted from the payload', () => {
    const fn = region(HANDLERS_PROJ_TS, 'export async function handleDeliverableDecided', TO_END);
    assert.match(fn, /\.from\('deliverables'\)/);
    assert.match(fn, /\.eq\('id', deliverableId\)/);
  });
});

describe('D. completion is idempotent and respects a stopped workspace', () => {
  test('a duplicate completion answers already_completed, not an error', () => {
    assert.match(completeDoor, /if v_phase_four\.state = 'completed' then/);
    assert.match(completeDoor, /'already_completed'::text, v_phase_four\.id/);
  });

  test('a stopped workspace does not complete itself', () => {
    assert.match(completeDoor, /if v_phase_four\.state in \('scope_escalation', 'revision_limit_escalation'\) then/);
    assert.match(completeDoor, /'stopped'::text/);
  });
});

describe('E. the guards every table and door in this repository carries', () => {
  test('complete_phase_four is security definer, coalesced can_write, no fail-open', () => {
    assert.match(completeDoor, /security definer/);
    assert.match(completeDoor, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(completeDoor, /not\s+\(\s*select\s+core\.can_write\s*\(/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.complete_phase_four\(uuid\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.phase_five_gate_status\(uuid\) from public, anon/);
  });

  test('it audits and announces inside the same transaction', () => {
    assert.match(completeDoor, /perform core\.record_audit\(/);
    assert.match(completeDoor, /perform core\.emit_event\(/);
  });
});

describe('F. it is reachable — the defect this repository has found repeatedly', () => {
  test('the catalog wires deliverable_decided and phase_four_completed', () => {
    // Fans out further once there is a second independent thing worth doing
    // with the same fact — PM4-M06/M07 announcements added alongside these.
    assert.deepEqual(SUBSCRIPTIONS['project.deliverable_decided'], [
      'projects:completePhaseFourOnPrototypeApproval',
      'crm:announcePrototypeChangeRequested',
    ]);
    assert.deepEqual(SUBSCRIPTIONS['project.phase_four_completed'], [
      'finance:generateM2Invoice',
      'crm:announceTask2Complete',
    ]);
    assert.ok(HANDLERS.includes('finance:generateM2Invoice'));
    assert.equal(HANDLER_JOB_KIND['finance:generateM2Invoice'], 'invoice.generate_m2');
  });

  test('the runner drains both new job kinds', () => {
    assert.match(RUNNER, /const PHASE_FOUR_COMPLETE_JOB_KIND = HANDLER_JOB_KIND\['projects:completePhaseFourOnPrototypeApproval'\]/);
    assert.match(RUNNER, /const M2_INVOICE_JOB_KIND = HANDLER_JOB_KIND\['finance:generateM2Invoice'\]/);
    assert.match(RUNNER, /handlePhaseFourCompletedForFinance/);
  });

  test('generateM2Invoice reuses the same reusable helpers as M1, not a reimplementation', () => {
    for (const helper of ['milestoneInvoiceability', 'billingReadiness', 'taxRateBpForMode', 'milestoneInvoiceLines', 'invoiceTotals', 'nextInvoiceNumber']) {
      const count = (HANDLERS_FIN_TS + SERVICE_TS).split(helper).length - 1;
      assert.ok(count >= 2, `${helper} should be used by both M1 and M2 paths`);
    }
  });
});
