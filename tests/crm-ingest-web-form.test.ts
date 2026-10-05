import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  inboundWebFormLeadSchema,
  ingestWebFormLead,
} from '../src/modules/crm/ingest-web-form.ts';

/**
 * Inbound web-form ingest — audit step 1.1.
 *
 * Mirrors tests/crm-ingest.test.ts's division exactly: the work is one SQL
 * statement (crm.ingest_web_form_lead, migration 20260929130000), so this
 * file covers what lives in TypeScript — the trusted-payload shape and how
 * each outcome the function can return becomes a Result — against a faked
 * transport. The database behaviour itself (contact/lead dedupe, thread
 * continuation, campaign attribution) is asserted against real Postgres by
 * scripts/verify-web-form-ingest.mjs (npm run db:verify:webform).
 */

const VALID = {
  formKey: 'WFK1',
  fullName: 'Asha',
  email: 'asha@example.com',
  message: 'Need a website',
};

const INGESTED_ROW = {
  status: 'ingested',
  organization_id: 'org-1',
  contact_id: 'contact-1',
  lead_id: 'lead-1',
  conversation_id: 'conversation-1',
  message_id: 'message-1',
  message_seq: 0,
  job_id: 'job-1',
};

type RpcResult = { data: unknown; error: { message: string } | null };

function fakeAdmin(respond: (fn: string, args: Record<string, unknown>) => RpcResult) {
  return {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => Promise.resolve(respond(fn, args)),
    }),
  } as unknown as Parameters<typeof ingestWebFormLead>[0];
}

const okRow = (row: unknown): RpcResult => ({ data: [row], error: null });

describe('A. the inbound payload schema', () => {
  test('accepts a submission with an email and no phone', () => {
    assert.equal(inboundWebFormLeadSchema.safeParse(VALID).success, true);
  });

  test('accepts a submission with a phone and no email', () => {
    const { email: _omitted, ...rest } = VALID;
    assert.equal(
      inboundWebFormLeadSchema.safeParse({ ...rest, phone: '+919900112233' }).success,
      true,
    );
  });

  test('rejects a submission with neither email nor phone — a contact must be reachable', () => {
    const { email: _omitted, ...rest } = VALID;
    assert.equal(inboundWebFormLeadSchema.safeParse(rest).success, false);
  });

  test('message is optional — a pure "contact me" form has no free-text field', () => {
    const { message: _omitted, ...rest } = VALID;
    assert.equal(inboundWebFormLeadSchema.safeParse(rest).success, true);
  });

  test('rejects a missing formKey or fullName', () => {
    assert.equal(inboundWebFormLeadSchema.safeParse({ ...VALID, formKey: '' }).success, false);
    assert.equal(inboundWebFormLeadSchema.safeParse({ ...VALID, fullName: '' }).success, false);
  });

  test('rejects a malformed email or phone', () => {
    assert.equal(inboundWebFormLeadSchema.safeParse({ ...VALID, email: 'not-an-email' }).success, false);
    assert.equal(
      inboundWebFormLeadSchema.safeParse({ ...VALID, email: undefined, phone: 'not-a-number' }).success,
      false,
    );
  });

  test('does not bound the message — a long enquiry is content, not malformed', () => {
    assert.equal(
      inboundWebFormLeadSchema.safeParse({ ...VALID, message: 'x'.repeat(15_000) }).success,
      true,
    );
  });
});

describe('B. outcomes', () => {
  test('a first submission is ingested, with its ids and the queued job', async () => {
    const result = await ingestWebFormLead(fakeAdmin(() => okRow(INGESTED_ROW)), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'ingested');
    assert.equal(result.data.leadId, 'lead-1');
    assert.equal(result.data.jobId, 'job-1');
  });

  test('a resubmission continues the thread and is still "ingested" (not a replay unless externalRef repeats)', async () => {
    const result = await ingestWebFormLead(fakeAdmin(() => okRow({ ...INGESTED_ROW, message_seq: 1 })), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.seq, 1);
  });

  test('a submission with no message field has a null messageId and no job', async () => {
    const noMessage = { ...INGESTED_ROW, message_id: null, message_seq: null, job_id: null };
    const { message: _omitted, ...rest } = VALID;
    const result = await ingestWebFormLead(fakeAdmin(() => okRow(noMessage)), rest);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.messageId, null);
    assert.equal(result.data.jobId, null);
  });

  test('an unknown form key is NOT_FOUND, not a crash', async () => {
    const unknown = {
      status: 'unknown_form_key',
      organization_id: null,
      contact_id: null,
      lead_id: null,
      conversation_id: null,
      message_id: null,
      message_seq: null,
      job_id: null,
    };
    const result = await ingestWebFormLead(fakeAdmin(() => okRow(unknown)), VALID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('not_reachable from the database is surfaced as VALIDATION', async () => {
    const notReachable = {
      status: 'not_reachable',
      organization_id: null,
      contact_id: null,
      lead_id: null,
      conversation_id: null,
      message_id: null,
      message_seq: null,
      job_id: null,
    };
    const result = await ingestWebFormLead(fakeAdmin(() => okRow(notReachable)), VALID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'VALIDATION');
  });

  test('an invalid payload is VALIDATION and never reaches the database', async () => {
    let called = false;
    const admin = fakeAdmin(() => {
      called = true;
      return okRow(INGESTED_ROW);
    });
    const result = await ingestWebFormLead(admin, { ...VALID, formKey: '' });
    assert.equal(result.ok, false);
    assert.equal(called, false, 'the RPC must never be called for an unparseable payload');
  });

  test('a database error is INTERNAL', async () => {
    const result = await ingestWebFormLead(
      fakeAdmin(() => ({ data: null, error: { message: 'connection reset' } })),
      VALID,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /connection reset/, 'the raw database error must not reach the caller');
  });
});
