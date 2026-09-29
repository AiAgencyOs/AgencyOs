import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { region } from './_region.ts';
import {
  INVOICE_REMINDER_SITUATION_KEY,
  pickReminderThread,
  reminderMessage,
  reminderPolicySchema,
  type ReminderThreadCandidate,
} from '../src/modules/finance/reminder-schema.ts';
import { invoiceMessage } from '../src/modules/finance/whatsapp-send-schema.ts';
import { describeTemplateSend } from '../src/modules/crm/template-send-schema.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// Read as source rather than imported: `src/lib/admin/settings.ts` is a
// server module that pulls in next/navigation, which plain Node cannot load.
const TEMPLATE_SITUATIONS: readonly string[] = (() => {
  const source = read('src/lib/admin/settings.ts');
  const block = /export const TEMPLATE_SITUATIONS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
})();

/**
 * Owner decision 2026-09-29: invoices and their reminders go over WhatsApp
 * through the governed door, and past-due reminders go automatically. The
 * rules a person would ask about, pinned: which thread a bill is chased on,
 * that a reminder never carries a guessed name, that the policy is bounded,
 * and that every send still passes the consent chokepoint.
 */
const thread = (over: Partial<ReminderThreadCandidate>): ReminderThreadCandidate => ({
  conversationId: 'c',
  kind: 'direct',
  status: 'active',
  clientAccountId: null,
  projectId: null,
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

describe('which thread a reminder goes on', () => {
  const invoice = { clientAccountId: 'acc', projectId: 'proj' };

  it("the client account's own thread first, newest of them", () => {
    const picked = pickReminderThread(invoice, [
      thread({ conversationId: 'group', kind: 'project_group', projectId: 'proj', updatedAt: '2026-09-09T00:00:00Z' }),
      thread({ conversationId: 'acc-old', kind: 'client_account', clientAccountId: 'acc', updatedAt: '2026-09-01T00:00:00Z' }),
      thread({ conversationId: 'acc-new', kind: 'client_account', clientAccountId: 'acc', updatedAt: '2026-09-05T00:00:00Z' }),
    ]);
    assert.equal(picked?.conversationId, 'acc-new');
  });

  it('then the project group', () => {
    const picked = pickReminderThread(invoice, [thread({ conversationId: 'group', kind: 'project_group', projectId: 'proj' })]);
    assert.equal(picked?.conversationId, 'group');
  });

  it("never a lead's sales thread, another client's thread, or an abandoned one", () => {
    const picked = pickReminderThread(invoice, [
      thread({ conversationId: 'lead', kind: 'direct' }),
      thread({ conversationId: 'other', kind: 'client_account', clientAccountId: 'someone-else' }),
      thread({ conversationId: 'gone', kind: 'client_account', clientAccountId: 'acc', status: 'abandoned' }),
      thread({ conversationId: 'other-proj', kind: 'project_group', projectId: 'not-this-one' }),
    ]);
    assert.equal(picked, null);
  });

  it('an invoice with no project has only the account thread to go on', () => {
    const picked = pickReminderThread({ clientAccountId: 'acc', projectId: null }, [
      thread({ conversationId: 'group', kind: 'project_group', projectId: 'proj' }),
    ]);
    assert.equal(picked, null);
  });
});

describe('the words', () => {
  it('a reminder states the number, the outstanding sum and the due date, and greets nobody by name', () => {
    const body = reminderMessage({
      agencyName: 'Studio',
      invoiceNumber: 'INV-0007',
      currency: 'INR',
      totalMinor: 4_500_000,
      paidMinor: 500_000,
      dueAt: '2026-09-01T00:00:00Z',
      timeZone: 'Asia/Kolkata',
    });
    assert.match(body, /invoice INV-0007 was due on/);
    assert.match(body, /Outstanding: ₹40,000\.00/);
    assert.match(body, /₹5,000\.00 received/);
    assert.doesNotMatch(body, /Hi |Dear /);
  });

  it('an invoice message carries the total, where to pay, and says the PDF follows', () => {
    const body = invoiceMessage({
      agencyName: 'Studio',
      invoiceNumber: 'INV-0007',
      currency: 'INR',
      totalMinor: 4_500_000,
      paidMinor: 0,
      dueAt: '2026-09-30T00:00:00Z',
      timeZone: 'Asia/Kolkata',
      projectName: 'Website',
      receivingAccounts: [{ label: 'HDFC current', fields: [{ label: 'Account', value: '1234' }, { label: 'IFSC', value: 'HDFC0001' }] }],
    });
    assert.match(body, /Invoice INV-0007 from Studio for Website/);
    assert.match(body, /Total: ₹45,000\.00 · due/);
    assert.match(body, /HDFC current — Account 1234, IFSC HDFC0001/);
    assert.match(body, /The PDF follows/);
  });

  it('a template send is recorded as the template and its filled values, never as invented copy', () => {
    assert.equal(
      describeTemplateSend({ templateName: 'payment_nudge', languageCode: 'en', parameters: ['contact_first_name', 'agency_name'], values: ['Priya', 'Studio'] }),
      '[Template payment_nudge · en] contact_first_name: Priya · agency_name: Studio',
    );
    assert.equal(describeTemplateSend({ templateName: 'hello', languageCode: 'hi', parameters: [], values: [] }), '[Template hello · hi]');
  });
});

describe('the policy', () => {
  it('is bounded to whole days between 1 and 90', () => {
    assert.ok(reminderPolicySchema.safeParse({ enabled: true, intervalDays: 7 }).success);
    assert.ok(!reminderPolicySchema.safeParse({ enabled: true, intervalDays: 0 }).success);
    assert.ok(!reminderPolicySchema.safeParse({ enabled: true, intervalDays: 91 }).success);
    assert.ok(!reminderPolicySchema.safeParse({ enabled: true, intervalDays: 2.5 }).success);
  });

  it('the reminder situation is one an Admin can register a template for', () => {
    assert.ok((TEMPLATE_SITUATIONS as readonly string[]).includes(INVOICE_REMINDER_SITUATION_KEY));
    const migration = read('supabase/migrations/20260930100000_the_bill_is_sent_and_chased_and_the_bank_is_read.sql');
    assert.match(migration, /'invoice_reminder'/);
  });
});

describe('every send still passes the chokepoint', () => {
  const worker = read('src/modules/finance/reminder-worker.ts');
  const invoiceDoor = read('src/modules/finance/whatsapp-send-service.ts');
  const templateDoor = read('src/modules/crm/template-send-service.ts');
  const migration = read('supabase/migrations/20260930100000_the_bill_is_sent_and_chased_and_the_bank_is_read.sql');

  it('the reminder worker queues through send_outbound_message and the followup handler, never the provider', () => {
    assert.match(worker, /rpc\('send_outbound_message'/);
    assert.match(worker, /p_type: 'followup\.queued'/);
    assert.doesNotMatch(worker, /@\/lib\/whatsapp\/send/);
  });

  it('the invoice send goes through the quotation doors, and records only after the text went', () => {
    assert.match(invoiceDoor, /import \{ sendClientDocument, sendClientMessage \} from '@\/modules\/crm\/service'/);
    assert.ok(invoiceDoor.indexOf('await sendClientMessage(') < invoiceDoor.indexOf("rpc('record_invoice_send'"));
    assert.match(invoiceDoor, /if \(!text\.ok\) return text;/);
  });

  it('the composer template send refuses anything not approved and active, and fills variables from facts', () => {
    assert.match(templateDoor, /template\.status !== 'approved' \|\| !template\.active/);
    assert.match(templateDoor, /resolveTemplateParameters\(/);
    assert.match(templateDoor, /rpc\('send_outbound_message'/);
  });

  it('the policy door is owner/ops_admin in the database too, and audits both ways', () => {
    const body = region(migration, 'create or replace function core.set_invoice_reminder_policy', 'comment on function core.set_invoice_reminder_policy');
    assert.match(body, /not coalesce\(\(select core\.is_admin\(\)\), false\)/);
    assert.match(body, /'invoice_reminders\.enabled' else 'invoice_reminders\.disabled'/);
  });

  it('the claim is one reminder per invoice per interval, re-checked under the lock', () => {
    const body = region(migration, 'create or replace function finance.claim_invoice_reminder', 'comment on function finance.claim_invoice_reminder');
    assert.match(body, /for update/);
    assert.match(body, /'too_soon'/);
    assert.match(body, /'invoice\.reminded'/);
    assert.match(migration, /grant execute on function finance\.claim_invoice_reminder\(uuid, int, uuid\) to service_role;/);
  });
});
