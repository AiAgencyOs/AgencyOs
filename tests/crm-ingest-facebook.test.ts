import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  inboundFacebookLeadSchema,
  ingestFacebookLead,
} from '../src/modules/crm/ingest-facebook.ts';

/**
 * Inbound Facebook/Instagram Lead Ads ingest — audit step 1.1.
 *
 * Same division as tests/crm-ingest.test.ts: the work is one SQL statement
 * (crm.ingest_facebook_lead, migration 20260929130000). This covers the
 * TypeScript half against a faked transport; the real database behaviour is
 * asserted by scripts/verify-facebook-leads-ingest.mjs
 * (npm run db:verify:fbleads).
 */

const VALID = {
  pageId: 'PG1',
  leadgenId: 'lg-1',
  fullName: 'Rahul',
  email: 'rahul@example.com',
  adId: 'ad-1',
  adName: 'Summer Promo',
  formId: 'form-1',
  formName: 'Contact Us',
  fieldData: { budget: '50k' },
};

const INGESTED_ROW = {
  status: 'ingested',
  organization_id: 'org-1',
  contact_id: 'contact-1',
  lead_id: 'lead-1',
  activity_id: 'activity-1',
};

type RpcResult = { data: unknown; error: { message: string } | null };

function fakeAdmin(respond: (fn: string, args: Record<string, unknown>) => RpcResult) {
  return {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => Promise.resolve(respond(fn, args)),
    }),
  } as unknown as Parameters<typeof ingestFacebookLead>[0];
}

const okRow = (row: unknown): RpcResult => ({ data: [row], error: null });

describe('A. the inbound payload schema', () => {
  test('accepts a well-formed submission with an email and no phone', () => {
    assert.equal(inboundFacebookLeadSchema.safeParse(VALID).success, true);
  });

  test('accepts a submission with a phone and no email', () => {
    const { email: _omitted, ...rest } = VALID;
    assert.equal(inboundFacebookLeadSchema.safeParse({ ...rest, phone: '+919900112233' }).success, true);
  });

  test('rejects a missing pageId or leadgenId', () => {
    assert.equal(inboundFacebookLeadSchema.safeParse({ ...VALID, pageId: '' }).success, false);
    assert.equal(inboundFacebookLeadSchema.safeParse({ ...VALID, leadgenId: '' }).success, false);
  });

  test('fullName, ad and form fields are optional — the webhook may not carry them all', () => {
    assert.equal(
      inboundFacebookLeadSchema.safeParse({ pageId: 'PG1', leadgenId: 'lg-1', email: 'a@b.com' }).success,
      true,
    );
  });
});

describe('B. outcomes', () => {
  test('a first submission is ingested, with its ids', async () => {
    const result = await ingestFacebookLead(fakeAdmin(() => okRow(INGESTED_ROW)), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'ingested');
    assert.equal(result.data.leadId, 'lead-1');
    assert.equal(result.data.activityId, 'activity-1');
  });

  test('a redelivered leadgen_id is a replay, and creates no second activity', async () => {
    const replay = { ...INGESTED_ROW, status: 'replayed', activity_id: null };
    const result = await ingestFacebookLead(fakeAdmin(() => okRow(replay)), VALID);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'replayed');
    assert.equal(result.data.activityId, null);
  });

  test('an unknown page id is NOT_FOUND, not a crash', async () => {
    const unknown = { status: 'unknown_page_id', organization_id: null, contact_id: null, lead_id: null, activity_id: null };
    const result = await ingestFacebookLead(fakeAdmin(() => okRow(unknown)), VALID);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('not_reachable from the database is surfaced as VALIDATION', async () => {
    const notReachable = { status: 'not_reachable', organization_id: null, contact_id: null, lead_id: null, activity_id: null };
    const { email: _omitted, ...rest } = VALID;
    const result = await ingestFacebookLead(fakeAdmin(() => okRow(notReachable)), rest);
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
    const result = await ingestFacebookLead(admin, { ...VALID, pageId: '' });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  test('a database error is INTERNAL', async () => {
    const result = await ingestFacebookLead(
      fakeAdmin(() => ({ data: null, error: { message: 'connection reset' } })),
      VALID,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });
});
