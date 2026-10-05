import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { inboundEmailMessageSchema, ingestEmailLead } from '../src/modules/crm/ingest-email.ts';

/**
 * Inbound email ingest — audit step 1.1.
 *
 * Same division as tests/crm-ingest.test.ts: the work is one SQL statement
 * (crm.ingest_email_lead, migration 20260929130000). This covers the
 * TypeScript half against a faked transport; the real database behaviour is
 * asserted by scripts/verify-email-ingest.mjs (npm run db:verify:emailingest).
 */

const VALID = {
  mailbox: 'leads@agency.example',
  fromEmail: 'client@example.com',
  fromName: 'Client Co',
  subject: 'Website enquiry',
  body: 'I need a quote',
  externalRef: '<msg-1@mail.example.com>',
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
  } as unknown as Parameters<typeof ingestEmailLead>[0];
}

const okRow = (row: unknown): RpcResult => ({ data: [row], error: null });

describe('A. the inbound payload schema', () => {
  test('accepts a well-formed message', () => {
    assert.equal(inboundEmailMessageSchema.safeParse(VALID).success, true);
  });

  test('fromName and subject are optional', () => {
    const { fromName: _n, subject: _s, ...rest } = VALID;
    assert.equal(inboundEmailMessageSchema.safeParse(rest).success, true);
  });

  test('rejects a malformed mailbox or sender address', () => {
    assert.equal(inboundEmailMessageSchema.safeParse({ ...VALID, mailbox: 'not-an-email' }).success, false);
    assert.equal(inboundEmailMessageSchema.safeParse({ ...VALID, fromEmail: 'not-an-email' }).success, false);
  });

  test('rejects a missing provider Message-Id — that is the replay guard', () => {
    assert.equal(inboundEmailMessageSchema.safeParse({ ...VALID, externalRef: '' }).success, false);
  });

  test('does not bound the body — a long email is content, not malformed', () => {
    assert.equal(inboundEmailMessageSchema.safeParse({ ...VALID, body: 'x'.repeat(50_000) }).success, true);
  });

  test('occurredAt, when given, must be a real timestamp', () => {
    assert.equal(
      inboundEmailMessageSchema.safeParse({ ...VALID, occurredAt: '2026-08-10T12:00:00Z' }).success,
      true,
    );
    assert.equal(inboundEmailMessageSchema.safeParse({ ...VALID, occurredAt: 'yesterday' }).success, false);
  });
});

describe('B. outcomes', () => {
  test('a first message is ingested, with its ids and the queued job', async () => {
    const result = await ingestEmailLead(fakeAdmin(() => okRow(INGESTED_ROW)), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'ingested');
    assert.equal(result.data.jobId, 'job-1');
  });

  test('a redelivered Message-Id is a replay, and queues nothing', async () => {
    const replay = { ...INGESTED_ROW, status: 'replayed', job_id: null };
    const result = await ingestEmailLead(fakeAdmin(() => okRow(replay)), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'replayed');
    assert.equal(result.data.jobId, null);
  });

  test('an unknown mailbox is NOT_FOUND, not a crash', async () => {
    const unknown = {
      status: 'unknown_mailbox',
      organization_id: null,
      contact_id: null,
      lead_id: null,
      conversation_id: null,
      message_id: null,
      message_seq: null,
      job_id: null,
    };
    const result = await ingestEmailLead(fakeAdmin(() => okRow(unknown)), VALID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('an invalid payload is VALIDATION and never reaches the database', async () => {
    let called = false;
    const admin = fakeAdmin(() => {
      called = true;
      return okRow(INGESTED_ROW);
    });
    const result = await ingestEmailLead(admin, { ...VALID, externalRef: '' });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  test('a database error is INTERNAL and never echoes the message body', async () => {
    const result = await ingestEmailLead(
      fakeAdmin(() => ({ data: null, error: { message: 'connection reset' } })),
      VALID,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /quote/, 'the customer\'s email body must never reach the caller');
  });
});
