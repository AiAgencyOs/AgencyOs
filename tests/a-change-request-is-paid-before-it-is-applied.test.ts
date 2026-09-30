import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { changeRequestInvoiceLines, invoiceChangeRequestSchema, invoiceTotals } from '../src/modules/finance/change-request-invoice-schema.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20261001120000_a_project_has_a_phase_a_team_and_an_archive.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const APPLY = SQL.slice(SQL.indexOf('create or replace function projects.apply_change_request'), SQL.indexOf('comment on function projects.apply_change_request'));
const INVOICE_FN = SQL.slice(SQL.indexOf('create or replace function finance.create_change_request_invoice'), SQL.indexOf('comment on function finance.create_change_request_invoice'));
const SERVICE = read('src/modules/finance/change-request-invoice-service.ts');
const CR_SERVICE = read('src/modules/projects/change-requests.ts');
const PANEL = read('app/(internal)/projects/[projectId]/change-request-panel.tsx');

/**
 * SCR-031 (bucket F, stream F-C): a paid change request is billed through
 * the finance door and applied to the baseline only once that invoice is
 * paid. The rule lives in `projects.apply_change_request`; the service
 * translates its two new outcomes; the panel says it before the button is
 * pressed. The one line the invoice carries is a pure function, pinned.
 */

describe('the database is the gate', () => {
  it('apply_change_request refuses a paid change with no invoice (not_invoiced) or an unpaid one (unpaid), after the approval check', () => {
    assert.match(APPLY, /if v_status <> 'approved' then\s*\n\s*return query select 'not_approved'::text/);
    assert.match(APPLY, /if v_classification = 'paid_change' then/);
    assert.match(APPLY, /if v_invoice is null then\s*\n\s*return query select 'not_invoiced'::text/);
    assert.match(APPLY, /if v_invoice_status is null or v_invoice_status = 'void' then\s*\n\s*return query select 'not_invoiced'::text/);
    assert.match(APPLY, /if v_invoice_status <> 'paid' then\s*\n\s*return query select 'unpaid'::text/);
    // The gate sits BEFORE the baseline is opened.
    assert.ok(APPLY.indexOf("'unpaid'") < APPLY.indexOf('projects.open_scope_version('));
  });

  it('the rest of apply_change_request is unchanged: it copies the active baseline and marks the request implemented', () => {
    assert.match(APPLY, /can_manage_delivery\(\)/);
    assert.match(APPLY, /projects\.open_scope_version\(v_project, 'change_request', null, p_change_request_id\)/);
    assert.match(APPLY, /status\s+= 'implemented'/);
  });

  it('create_change_request_invoice goes through the existing milestone-invoice door with no milestone, links the invoice and audits', () => {
    assert.match(INVOICE_FN, /if not coalesce\(\(select core\.is_admin\(\)\), false\) then/);
    assert.match(INVOICE_FN, /if v_cr\.classification is distinct from 'paid_change' then\s*\n\s*return query select 'not_billable'::text/);
    assert.match(INVOICE_FN, /if v_cr\.proposal_id is null then\s*\n\s*return query select 'no_proposal'::text/);
    assert.match(INVOICE_FN, /from finance\.create_milestone_invoice\(/);
    assert.match(INVOICE_FN, /null,\s+-- no milestone/);
    assert.match(INVOICE_FN, /set invoice_id = v_created\.invoice_id/);
    assert.match(INVOICE_FN, /'change_request\.invoiced'/);
    assert.match(SQL, /alter table projects\.change_requests add column if not exists invoice_id uuid references finance\.invoices\(id\) on delete set null;/);
  });
});

describe('the service and the screen say what the door decides', () => {
  it('applyChangeRequest translates not_invoiced and unpaid into sentences a person can act on', () => {
    // The two outcomes are named nowhere else in the file, so the whole file is the region.
    const applyFn = CR_SERVICE;
    assert.match(applyFn, /case 'not_invoiced':/);
    assert.match(applyFn, /case 'unpaid':/);
    assert.match(applyFn, /applied to the baseline once the invoice is paid/);
  });

  it('invoiceChangeRequest checks invoice.create, the billing mode and the proposal before a number is issued, and computes lines and number itself', () => {
    assert.match(SERVICE, /can\(context, 'invoice\.create'\)/);
    assert.match(SERVICE, /readBillingReadiness\(cr\.project_id, supabase\)/);
    assert.match(SERVICE, /Confirm whether this project is billed with GST or without it/);
    assert.match(SERVICE, /if \(!cr\.proposal_id\) return err\('CONFLICT'/);
    assert.match(SERVICE, /nextInvoiceNumber\(year, highest, attempt/);
    assert.match(SERVICE, /rpc\('create_change_request_invoice', \{/);
    assert.ok(SERVICE.indexOf('readBillingReadiness(') < SERVICE.indexOf("rpc('create_change_request_invoice'"));
  });

  it('the panel gates Apply on the request\'s OWN invoice and offers Trigger finance and Send quotation through their own doors', () => {
    assert.match(PANEL, /import \{ invoiceChangeRequestAction \} from '@\/modules\/finance\/change-request-invoice-actions';/);
    assert.match(PANEL, /import \{ sendProposalAction \} from '@\/modules\/sales\/actions';/);
    assert.match(PANEL, /A paid change is applied after its invoice is paid/);
    assert.match(PANEL, /disabled=\{pending \|\| gate\.blocked\}/);
    assert.match(PANEL, /label="Paid"/);
    assert.match(PANEL, /label="In progress"/);
  });
});

describe('the one line a change-request invoice carries', () => {
  it('prices the change at the proposal total and taxes it at the project\'s rate', () => {
    const lines = changeRequestInvoiceLines({ requested: 'Add a dark mode  to the app', proposalTitle: 'Dark mode', proposalVersion: 2, totalMinor: 250_000, projectName: 'Acme app' }, 1800);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.amountMinor, 250_000);
    assert.equal(lines[0]!.unitPriceMinor, 250_000);
    assert.equal(lines[0]!.quantity, 1);
    assert.equal(lines[0]!.taxRateBp, 1800);
    assert.match(lines[0]!.description, /Acme app — change request: “Add a dark mode to the app” \(Dark mode v2\)/);
    assert.deepEqual(invoiceTotals(lines), { subtotalMinor: 250_000, taxMinor: 45_000, totalMinor: 295_000 });
  });

  it('a long request is excerpted, never dropped', () => {
    const long = 'x'.repeat(300);
    const [line] = changeRequestInvoiceLines({ requested: long, proposalTitle: 'T', proposalVersion: 1, totalMinor: 100, projectName: 'P' }, 0);
    assert.ok(line!.description.includes('…'));
    assert.ok(line!.description.length < 200);
  });

  it('the schema bounds the due window and the note', () => {
    assert.equal(invoiceChangeRequestSchema.safeParse({ changeRequestId: 'nope' }).success, false);
    assert.equal(invoiceChangeRequestSchema.safeParse({ changeRequestId: '11111111-1111-4111-8111-111111111111', dueInDays: 400 }).success, false);
    assert.equal(invoiceChangeRequestSchema.safeParse({ changeRequestId: '11111111-1111-4111-8111-111111111111', dueInDays: 14 }).success, true);
  });
});
