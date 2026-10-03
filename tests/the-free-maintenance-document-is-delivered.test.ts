import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { freeMaintenanceMessage } from '../src/modules/finance/whatsapp-send-schema.ts';

const read = (p: string) => readFileSync(p, 'utf8');

// Phase 2 Finance §9 and Master §9: the ₹0 free-maintenance document is raised
// when Phase 7 completes and delivered like any invoice with nothing to
// collect; and Phase 2's state follows the facts. Proved against the running
// app in scripts/verify-free-maintenance.mjs and verify-planning-agent.mjs §7.

describe('the free-maintenance document', () => {
  test('Phase 7 complete (the handover accepted) raises it, and raising it delivers it', () => {
    assert.ok(SUBSCRIPTIONS['handover.accepted']?.includes('finance:raiseFreeMaintenance'));
    assert.equal(HANDLER_JOB_KIND['finance:raiseFreeMaintenance'], 'invoice.free_maintenance');
    assert.ok(SUBSCRIPTIONS['maintenance.free_invoice_issued']?.includes('finance:deliverIssuedInvoice'));
  });

  test('the handler reads the project from the handover ROW and never raises an amount', () => {
    const src = read('src/modules/finance/handlers.ts');
    const at = src.indexOf('export async function handleHandoverAcceptedForFinance');
    const body = src.slice(at).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(body, /\.from\('handovers'\)[\s\S]*\.eq\('organization_id', job\.organization_id\)/);
    assert.doesNotMatch(body, /amount|total_minor|verify_payment|payment_submissions/);
  });

  test('the number comes from the one invoice sequence, and only the database door decides', () => {
    const src = read('src/modules/finance/service.ts');
    const at = src.indexOf('export async function generateFreeMaintenanceInvoices');
    const body = src.slice(at, at + 3200);
    assert.match(body, /nextInvoiceNumber\(/);
    assert.match(body, /rpc\('issue_free_maintenance_invoice', \{ p_plan_id: plan\.id, p_number: number \}\)/);
    assert.match(body, /case 'number_taken':\s*\n\s*continue;/);
  });

  test('the delivery door recognises it by the plan it records - a stray zero-rupee invoice is still refused', () => {
    const sql = read('supabase/migrations/20261011320000_the_free_maintenance_document_is_delivered.sql');
    assert.match(sql, /if v_invoice\.total_minor <= 0 and v_invoice\.maintenance_plan_id is null then/);
    assert.match(sql, /'nothing_payable'/);
  });

  test('the words: nothing is owed, no amount, and the period is the plan\'s own', () => {
    const text = freeMaintenanceMessage({ agencyName: 'Demo Agency', invoiceNumber: 'INV-9', endsOn: '2027-10-31', projectName: 'Pharmacy app' });
    assert.match(text, /free maintenance included with "Pharmacy app" is active until 2027-10-31/);
    assert.match(text, /No payment is needed/);
    assert.doesNotMatch(text, /[₹$]|\brupees?\b|\brs\b/i);
    assert.doesNotMatch(freeMaintenanceMessage({ agencyName: 'A', invoiceNumber: 'X', endsOn: null, projectName: null }), /until/, 'a date it was not given is not invented');
  });
});

describe('Phase 2\'s state follows the facts', () => {
  const sql = read('supabase/migrations/20261011330000_phase_two_states_follow_the_facts.sql');

  test('the order the flow needs: client, admin, finance, planning, then ready - derived, never invented', () => {
    const order = ['waiting_client', 'waiting_admin', 'waiting_finance', 'waiting_planning'].map((s) => sql.indexOf(`then '${s}'`));
    assert.ok(order.every((n) => n > 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'the cases are in flow order');
    assert.match(sql, /else v_row\.state/);
  });

  test('it never moves a phase that is kicked off, finished or blocked, and audits every change', () => {
    assert.match(sql, /t\.state not in \('kickoff_sent', 'completed', 'blocked'\)/);
    assert.match(sql, /'project\.phase_two_state_changed'/);
  });

  test('it reads the kickoff gate\'s own facts rather than a second opinion', () => {
    assert.match(sql, /projects\.pre_kickoff_readiness\(v_row\.project_id\)/);
  });

  test('the runner calls it each tick and a failure never stops the queue', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /rpc\('refresh_phase_two_states', \{ p_limit: 200 \}\)/);
    assert.match(route, /a stale label must never stop the queue behind it/);
  });
});

describe('an invalid handoff is blocked and TOLD (Master §13)', () => {
  test('no packet means no invention, a permanent failure, and an alert where staff look', () => {
    const src = read('src/modules/projects/handlers.ts');
    const at = src.indexOf("case 'no_handoff':");
    const block = src.slice(at, at + 900);
    assert.match(block, /raise_alert/);
    assert.match(block, /permanent: true/);
  });
});
