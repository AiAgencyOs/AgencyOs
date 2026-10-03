import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';

import type { EmailDeps, InvoiceRow } from '../src/modules/finance/invoice-delivery.ts';

// invoice-delivery.ts imports server modules (session, the email transport)
// that plain Node cannot load; the leg under test takes its transport and its
// renderer as arguments, so these are only there to let the module load.
mock.module('../src/modules/finance/pdf-service.ts', { namedExports: { renderInvoiceDocument: async () => ({ ok: false, error: { message: 'unused' } }) } });
mock.module('../src/modules/finance/queries.ts', { namedExports: { listPaymentAccounts: async () => [] } });
mock.module('../src/lib/email/transport.ts', { namedExports: { emailTransportState: async () => ({ configured: false, reason: 'unused' }), sendEmail: async () => ({ ok: false, reason: 'unused' }) } });

const { deliverByEmail } = await import('../src/modules/finance/invoice-delivery.ts');

// Phase 2 Finance §4.5: the issued invoice reaches the client by email and on
// WhatsApp without a person pressing Send. The WhatsApp leg and the replay /
// retry behaviour are proved against the running app in
// scripts/verify-invoice-delivery.mjs; this file proves the email leg with a
// transport that is not the network, and pins the rules the migration carries.

const invoice: InvoiceRow = {
  id: 'inv-1', organization_id: 'org-1', number: 'INV-1', status: 'issued', currency: 'INR',
  total_minor: 3000000, verified_minor: 0, due_at: null, client_account_id: 'client-1', project_id: 'proj-1',
};

type Settled = { status: string; error?: string; destination?: string };

/** An admin client that answers just what the email leg asks, and records the settle. */
function fakeAdmin(opts: { claim?: string; email?: string | null }) {
  const settled: Settled[] = [];
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'order', 'neq']) q[m] = () => q;
    q.limit = async () => ({ data: result });
    q.maybeSingle = async () => ({ data: result });
    return q;
  };
  const admin = {
    schema: (schema: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'claim_invoice_delivery') {
          return { data: [{ outcome: opts.claim ?? 'claimed', delivery_id: 'del-1', attempts: 1 }], error: null };
        }
        if (fn === 'settle_invoice_delivery') {
          settled.push({ status: String(args.p_status), error: args.p_error as string | undefined, destination: args.p_destination as string | undefined });
          return { data: 'settled', error: null };
        }
        throw new Error(`unexpected rpc ${schema}.${fn}`);
      },
      from: (table: string) =>
        table === 'contacts' ? chain(opts.email === undefined ? [{ email: 'client@example.com', created_at: 'x' }] : opts.email ? [{ email: opts.email, created_at: 'x' }] : [])
          : chain({ name: 'Demo Agency' }),
    }),
  };
  return { admin: admin as never, settled };
}

const configured: EmailDeps['transportState'] = async () => ({ configured: true, kind: 'smtp', from: 'a@b.c', label: 'stub' });
const pdf: EmailDeps['render'] = async () => ({ ok: true, data: { bytes: new Uint8Array([1, 2, 3]), filename: 'INV-1.pdf' } }) as never;

describe('the email leg of an invoice delivery', () => {
  test('a configured transport, an address on file: the PDF goes to that address and the channel is SENT', async () => {
    const sentMail: Array<{ to: string; subject: string; attachments?: unknown[] }> = [];
    const { admin, settled } = fakeAdmin({});
    const r = await deliverByEmail(admin, invoice, {
      transportState: configured, render: pdf,
      send: async (m) => { sentMail.push(m); return { ok: true, kind: 'smtp', messageRef: '<ref@x>' }; },
    });
    assert.equal(r.result, 'sent');
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0]!.to, 'client@example.com');
    assert.match(sentMail[0]!.subject, /INV-1/);
    assert.equal(sentMail[0]!.attachments?.length, 1, 'the invoice rides as an attachment');
    assert.equal(settled[0]!.status, 'sent');
    assert.equal(settled[0]!.destination, 'client@example.com');
  });

  test('a channel already delivered is not sent again', async () => {
    let sends = 0;
    const { admin, settled } = fakeAdmin({ claim: 'already_delivered' });
    const r = await deliverByEmail(admin, invoice, { transportState: configured, render: pdf, send: async () => { sends += 1; return { ok: true, kind: 'smtp', messageRef: null }; } });
    assert.equal(r.result, 'already_delivered');
    assert.equal(sends, 0);
    assert.equal(settled.length, 0);
  });

  test('no transport: SKIPPED with the words, nothing sent, nothing retried', async () => {
    let sends = 0;
    const { admin, settled } = fakeAdmin({});
    const r = await deliverByEmail(admin, invoice, {
      transportState: async () => ({ configured: false, reason: 'EMAIL_FROM is not set' }), render: pdf,
      send: async () => { sends += 1; return { ok: true, kind: 'smtp', messageRef: null }; },
    });
    assert.equal(r.result, 'skipped');
    assert.equal(sends, 0);
    assert.equal(settled[0]!.status, 'skipped');
    assert.match(settled[0]!.error ?? '', /EMAIL_FROM/);
  });

  test('no address on file: SKIPPED, and the reason says whose address is missing', async () => {
    const { admin, settled } = fakeAdmin({ email: null });
    const r = await deliverByEmail(admin, invoice, { transportState: configured, render: pdf, send: async () => ({ ok: true, kind: 'smtp', messageRef: null }) });
    assert.equal(r.result, 'skipped');
    assert.match(settled[0]!.error ?? '', /No email address/);
  });

  test('a refused send is FAILED with the provider\'s reason, so the runner retries it', async () => {
    const { admin, settled } = fakeAdmin({});
    const r = await deliverByEmail(admin, invoice, { transportState: configured, render: pdf, send: async () => ({ ok: false, reason: 'SMTP 550 mailbox unavailable' }) });
    assert.equal(r.result, 'failed');
    assert.equal(settled[0]!.status, 'failed');
    assert.match(settled[0]!.error ?? '', /550/);
  });
});

describe('what the migration carries', () => {
  const sql = readFileSync('supabase/migrations/20261011200000_an_issued_invoice_is_delivered_without_a_person.sql', 'utf8');

  test('one row per invoice and channel, sent is terminal, and nothing can delete a delivery', () => {
    assert.match(sql, /unique \(invoice_id, channel\)/);
    assert.match(sql, /if v_row\.status = 'sent' then\s+return query select 'already_delivered'/);
    assert.match(sql, /if v_row\.status = 'sent' then return 'already_delivered'; end if;/);
    assert.doesNotMatch(sql, /grant[^;]*delete[^;]*invoice_deliveries/i);
  });

  test('a draft or a void is never claimed', () => {
    assert.match(sql, /status not in \('issued', 'partially_paid', 'overdue', 'paid'\)/);
  });

  test('the tenancy guards are on, so db:verify:tenancyguards stays green', () => {
    assert.match(sql, /enforce_parent_org\('invoice_id', 'finance\.invoices'\)/);
    assert.match(sql, /enforce_parent_org\('conversation_id', 'crm\.conversations'\)/);
    assert.match(sql, /freeze_organization_id/);
  });

  test('only the ledger-derived system messages escape the price rule, by an anchored ref', () => {
    assert.match(sql, /!~ '\^invoice-\(deliver\|reminder\):'/);
  });

  test('the doors are the runner\'s alone', () => {
    assert.match(sql, /revoke all on function finance\.claim_invoice_delivery\(uuid, text\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function finance\.settle_invoice_delivery\(uuid, text, text, uuid, text, text\) to service_role;/);
  });
});
