import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { bindCommercialBaseline, openBillingClarification, recordReceiptAcknowledgements } from '../src/modules/finance/p4q-doors.ts';
import { handleMatchPaymentSubmission } from '../src/modules/finance/p4q-payment-match.ts';
import { markInvoiceReminder, scheduleReminderStages } from '../src/modules/finance/p4q-reminders.ts';
import { region } from './_region.ts';

/**
 * W-F1..F6: the Phase 4 finance doors are called from the live path. Behaviour is driven with a scripted database; the call sites are pinned as source,
 * function by function, so removing a wiring line turns a test red.
 */
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type Row = Record<string, unknown>;
type Call = { fn: string; args: Record<string, unknown> };
function fake(tables: Record<string, Row[]>, doors: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const admin = {
    schema: (schemaName: string) => ({
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const rows = (): Row[] => (tables[`${schemaName}.${table}`] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push([c, v]), b),
          maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
        };
        return b;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        const door = doors[fn];
        return Promise.resolve(door ? { data: door(args), error: null } : { data: null, error: { message: `no door ${fn}` } });
      },
    }),
  } as never;
  return { admin, calls };
}
const job = (subjectId: string | null) => ({ id: 'j', organization_id: 'org', payload: subjectId ? { subjectId } : {}, correlation_id: null }) as never;

describe('W-F1 / W-F2 the baseline and the billing clarification', () => {
  test('the baseline is bound for the project through the door; a door that is down is reported, not thrown', async () => {
    const ok = fake({}, { p4q_bind_commercial_baseline: () => [{ outcome: 'bound', detail: '4' }] });
    assert.equal(await bindCommercialBaseline(ok.admin, 'proj'), 'bound');
    assert.deepEqual(ok.calls[0], { fn: 'p4q_bind_commercial_baseline', args: { p_project_id: 'proj' } });
    assert.equal(await bindCommercialBaseline(fake({}, {}).admin, 'proj'), 'unavailable');
  });

  test('missing and invalid billing fields become one clarification naming each, once', async () => {
    const { admin, calls } = fake({}, { p4q_open_billing_clarification: () => [{ outcome: 'opened' }] });
    assert.equal(await openBillingClarification(admin, 'proj', { missing: ['gstin', 'billing_address'], invalid: [{ field: 'gstin' }] }), 'opened');
    assert.deepEqual(calls[0]?.args.p_missing, ['gstin', 'billing_address']);
  });

  test('the Phase 2 start binds the baseline after the payment structure; the invoice paths open the clarification before refusing', () => {
    const handlers = read('src/modules/projects/handlers.ts');
    const body = region(handlers, 'export async function handleHandoffBound', 'export async function handlePhaseFourReady');
    assert.ok(body.indexOf('await bindCommercialBaseline(admin, projectId)') > body.indexOf('await installLockedPaymentStructure('));
    const service = read('src/modules/finance/service.ts');
    const hits = [...service.matchAll(/await openBillingClarification\(admin, scope\.projectId, readiness\);\n\s+return err\(\n\s+'CONFLICT',/g)];
    assert.equal(hits.length, 2, 'both CONFLICT refusals (M2 and the later milestones) open the clarification first');
  });
});

describe('W-F4 the payment claim is matched, and the verifier sees the advice', () => {
  test('a claim awaiting verification is matched through the door; the result says nothing was verified', async () => {
    const { admin, calls } = fake({ 'finance.payment_submissions': [{ id: 's1', organization_id: 'org', status: 'pending_verification' }] }, { p4q_match_payment_submission: () => [{ outcome: 'prepared', match_class: 'exact', recommendation: 'MATCH' }] });
    const r = await handleMatchPaymentSubmission(admin, job('s1'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'prepared');
    assert.match(r.status === 'succeeded' ? r.detail : '', /Nothing was verified/);
    assert.deepEqual(calls.map((c) => c.fn), ['p4q_match_payment_submission']);
  });

  test('a claim that is not pending, that is gone or that belongs to another organization is left alone', async () => {
    for (const [tables, expected] of [
      [{ 'finance.payment_submissions': [{ id: 's1', organization_id: 'org', status: 'verified' }] }, 'not_mine'],
      [{}, 'gone'],
      [{ 'finance.payment_submissions': [{ id: 's1', organization_id: 'other', status: 'pending_verification' }] }, 'gone'],
    ] as Array<[Record<string, Row[]>, string]>) {
      const { admin, calls } = fake(tables, {});
      const r = await handleMatchPaymentSubmission(admin, job('s1'));
      assert.equal(r.status === 'succeeded' && r.outcome, expected);
      assert.equal(calls.length, 0);
    }
  });

  test('payment.submitted is subscribed, the handler has a job kind, the runner drains it, and the packet renders the advice', () => {
    assert.ok(HANDLERS.includes('finance:matchPaymentSubmission'));
    assert.equal(HANDLER_JOB_KIND['finance:matchPaymentSubmission'], 'payment.p4q_match');
    assert.deepEqual(SUBSCRIPTIONS['payment.submitted'], ['projects:updateClientOnPayment', 'finance:matchPaymentSubmission']);
    assert.match(read('app/api/jobs/run/route.ts'), /runEventJobs\(admin, PAYMENT_MATCH_JOB_KIND, handleMatchPaymentSubmission, 'runPaymentMatchJobs'\)/);
    const packet = read('app/(internal)/invoices/verify/verification-packet.tsx');
    assert.match(packet, /const match = await readPaymentMatch\(submissionId\);/);
    assert.match(packet, /match\.reasons\.map/);
    assert.match(packet, /This is advice only\. Nothing was verified, rejected or marked paid by it\./);
  });
});

describe('W-F3 the invoice page shows what the client was told at issue', () => {
  test('the page reads the snapshot and shows drift; the snapshot read goes through the door that masks it', () => {
    const page = read('app/(internal)/invoices/[invoiceId]/page.tsx');
    assert.match(page, /readInvoicePaymentSnapshot\(invoiceId\)/);
    assert.match(page, /changed since issue/);
    assert.match(page, /no longer active/);
    assert.match(read('src/modules/finance/p4q-finance-queries.ts'), /rpc\('p4q_invoice_payment_snapshot', \{ p_invoice_id: invoiceId \}\)/);
  });
});

describe('W-F5 a payment acknowledgement is recorded on each receipt', () => {
  test('every receipt of the invoice gets a whatsapp delivery with evidence that names the acknowledgement', async () => {
    const { admin, calls } = fake({ 'finance.receipts': [{ id: 'r1', invoice_id: 'inv', organization_id: 'org' }, { id: 'r2', invoice_id: 'inv', organization_id: 'org' }, { id: 'rX', invoice_id: 'other', organization_id: 'org' }] }, { p4q_record_receipt_delivery: () => [{ outcome: 'recorded' }] });
    const r = await recordReceiptAcknowledgements(admin, { organizationId: 'org', invoiceId: 'inv', messageId: 'm-1' });
    assert.deepEqual(r, { recorded: 2, failed: 0 });
    assert.deepEqual(calls.map((c) => c.args.p_receipt_id), ['r1', 'r2']);
    assert.equal(calls[0]?.args.p_channel, 'whatsapp');
    assert.equal(calls[0]?.args.p_state, 'sent');
    assert.match(String(calls[0]?.args.p_evidence), /acknowledgement message m-1 \(text notice/);
  });

  test('only a verified-payment acknowledgement that actually went out is recorded', () => {
    const src = read('src/modules/projects/pm-client-comms.ts');
    const body = region(src, 'export async function handlePaymentUpdate', 'export async function projectForConversation');
    assert.match(body, /if \(eventType === 'invoice\.paid' && \(sent\.kind === 'sent' \|\| sent\.kind === 'already_sent'\)\) \{\s+await recordReceiptAcknowledgements\(/);
    assert.ok(body.indexOf('recordReceiptAcknowledgements(') > body.indexOf('const sent = await sendSystemText('));
  });
});

describe('W-F6 reminders are scheduled by stage and marked after each settled claim', () => {
  test('scheduling and marking go through the service-role doors', async () => {
    const sched = fake({}, { p4q_schedule_reminders: () => [{ invoice_id: 'i', stage: 'overdue', scheduled: true }] });
    assert.equal(await scheduleReminderStages(sched.admin), 1);
    const marked = fake({ 'finance.p4q_reminders': [{ id: 'rem1', invoice_id: 'inv', stage: 'overdue' }] }, { p4q_invoice_reminder_stage: () => 'overdue', p4q_mark_reminder: () => [{ outcome: 'updated' }] });
    assert.equal(await markInvoiceReminder(marked.admin, 'inv', 'sent'), 'updated');
    assert.deepEqual(marked.calls.map((c) => c.fn), ['p4q_invoice_reminder_stage', 'p4q_mark_reminder']);
    assert.equal(marked.calls[1]?.args.p_reminder_id, 'rem1');
    assert.equal(marked.calls[1]?.args.p_state, 'sent');
  });

  test('an invoice with no stage right now has nothing to mark, and bookkeeping failures never throw', async () => {
    const none = fake({}, { p4q_invoice_reminder_stage: () => null });
    assert.equal(await markInvoiceReminder(none.admin, 'inv', 'failed', 'why'), 'no_reminder');
    assert.equal(await scheduleReminderStages(fake({}, {}).admin), null);
  });

  test('the worker schedules first and marks on all five outcomes (sent, no thread, send error, refused, emit error)', () => {
    const src = read('src/modules/finance/reminder-worker.ts');
    const body = region(src, 'export async function runInvoiceReminders');
    const scheduled = body.indexOf('await scheduleReminderStages(admin)');
    assert.ok(scheduled >= 0 && scheduled < body.indexOf("rpc('observe_invoice_reminder_candidates'"));
    assert.equal(body.match(/await markInvoiceReminder\(admin, row\.invoice_id, 'failed'/g)?.length, 4);
    assert.equal(body.match(/await markInvoiceReminder\(admin, row\.invoice_id, 'sent'\)/g)?.length, 1);
  });
});

// ── W-F3: the documents show the accounts the invoice was issued with ────────────────────────────────────────────────────────────────────────────
import { accountsOnInvoice, readSnapshotAccountIds } from '../src/modules/finance/p4q-snapshot-accounts.ts';

describe('W-F3 the receiving accounts an invoice document prints', () => {
  const acct = (id: string, status = 'active') => ({ id, status });
  const [a, b, c] = [acct('a'), acct('b'), acct('c', 'archived')];

  test('the snapshot’s accounts that are still active; one added after issue is not printed', () => {
    assert.deepEqual(accountsOnInvoice([a, b], ['a']), [a]);
  });

  test('an account that closed since issue is not printed; if none is left the active ones are (a client is never sent nowhere)', () => {
    assert.deepEqual(accountsOnInvoice([a, b, c], ['a', 'c']), [a]);
    assert.deepEqual(accountsOnInvoice([a, b, c], ['c']), [a, b]);
  });

  test('no snapshot (draft, old invoice, or a reader the row security does not admit) prints the active accounts exactly as before', () => {
    assert.deepEqual(accountsOnInvoice([a, b, c], null), [a, b]);
    assert.deepEqual(accountsOnInvoice([a, b, c], []), [a, b]);
  });

  test('the snapshot is read by invoice and an unreadable one is "no snapshot"', async () => {
    const ok = fake({ 'finance.p4q_payment_instruction_snapshots': [{ invoice_id: 'inv', accounts: [{ accountId: 'a' }, { accountId: 'b' }] }] }, {});
    assert.deepEqual(await readSnapshotAccountIds(ok.admin, 'inv'), ['a', 'b']);
    assert.equal(await readSnapshotAccountIds(ok.admin, 'other'), null);
    assert.equal(await readSnapshotAccountIds({}, 'inv'), null);
  });

  test('the PDF, the WhatsApp message, the delivery job and the invoice page all use it', () => {
    assert.match(read('src/modules/finance/pdf-service.ts'), /receivingAccounts: accountsOnInvoice\(accounts, await readSnapshotAccountIds\(supabase, invoice\.id\)\)/);
    assert.match(read('src/modules/finance/whatsapp-send-service.ts'), /receivingAccounts: accountsOnInvoice\(accounts, await readSnapshotAccountIds\(supabase, invoice\.id\)\)/);
    assert.match(read('src/modules/finance/invoice-delivery.ts'), /receivingAccounts: accountsOnInvoice\(accounts, await readSnapshotAccountIds\(admin, invoice\.id\)\)/);
    assert.match(read('app/(internal)/invoices/[invoiceId]/page.tsx'), /const receivingAccounts = accountsOnInvoice\(accounts, issuedAccounts\.length > 0 \? issuedAccounts\.map\(\(a\) => a\.accountId\) : null\);/);
  });
});
