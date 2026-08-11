import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  inboundWhatsAppMessageSchema,
  ingestInboundMessage,
} from '../src/modules/crm/ingest.ts';

/**
 * Inbound WhatsApp ingest.
 *
 * The work is one SQL statement, so this file covers the two things that live
 * in TypeScript — what counts as a trusted payload, and how each outcome the
 * function can return becomes a Result — plus the properties of the SQL that
 * would be silently lost if someone edited the migration.
 *
 * The database behaviours themselves (a first message, a replay, two messages
 * on one thread, an unknown number, and the resolution of organization →
 * contact → lead → conversation) are asserted against real Postgres by
 * scripts/verify-whatsapp-ingest.mjs — `npm run db:verify:ingest`. They are
 * deliberately not simulated here: a fake that reimplements ON CONFLICT and
 * row locking would prove only that the fake agrees with itself.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260810120001_crm_inbound_ingest.sql', import.meta.url),
  ),
  'utf8',
);

const ingestSource = readFileSync(
  fileURLToPath(new URL('../src/modules/crm/ingest.ts', import.meta.url)),
  'utf8',
);

/** C6. The function is replaced wholesale here, so this is the live definition. */
const terminalLeadMigration = readFileSync(
  fileURLToPath(
    new URL(
      '../supabase/migrations/20260811120002_whatsapp_terminal_lead_extraction.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** A payload shaped the way the route will hand it over. */
const VALID = {
  phoneNumberId: 'PN_1',
  from: '919900112233',
  externalRef: 'wamid.AAA',
  body: 'I need a storefront rebuild',
  profileName: 'Asha',
};

/** The row the SQL returns for a successful first ingest. */
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

/**
 * A stand-in for the service-role client.
 *
 * It fakes the transport and nothing else — every assertion below is about
 * code in ingest.ts, never about database semantics.
 */
function fakeAdmin(
  respond: (fn: string, args: Record<string, unknown>) => RpcResult,
  seen?: { fn?: string; args?: Record<string, unknown> },
) {
  return {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        if (seen) {
          seen.fn = fn;
          seen.args = args;
        }
        return Promise.resolve(respond(fn, args));
      },
    }),
  } as unknown as Parameters<typeof ingestInboundMessage>[0];
}

const okRow = (row: unknown): RpcResult => ({ data: [row], error: null });

// ═══════════════════════════════════════════════════════════════════════════
// A. What counts as a trusted payload
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the inbound payload schema', () => {
  test('accepts a well-formed message', () => {
    assert.equal(inboundWhatsAppMessageSchema.safeParse(VALID).success, true);
  });

  test('accepts a sender with or without a leading +', () => {
    for (const from of ['919900112233', '+919900112233']) {
      assert.equal(inboundWhatsAppMessageSchema.safeParse({ ...VALID, from }).success, true, from);
    }
  });

  test('profileName is optional — a sender need not have one set', () => {
    const { profileName: _omitted, ...withoutName } = VALID;
    assert.equal(inboundWhatsAppMessageSchema.safeParse(withoutName).success, true);
  });

  test('rejects an empty or whitespace-only body — the column rejects it too', () => {
    for (const body of ['', '   ', '\n']) {
      assert.equal(
        inboundWhatsAppMessageSchema.safeParse({ ...VALID, body }).success,
        false,
        JSON.stringify(body),
      );
    }
  });

  test('rejects a sender that is not a phone number', () => {
    for (const from of ['not-a-number', '+', '12', 'DROP TABLE', '']) {
      assert.equal(
        inboundWhatsAppMessageSchema.safeParse({ ...VALID, from }).success,
        false,
        from,
      );
    }
  });

  test('rejects a missing provider message id — that is the replay guard', () => {
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, externalRef: '' }).success,
      false,
    );
  });

  test('does NOT bound the body — a long message is content, not malformed', () => {
    // It capped at 10,000, copied from crm/schema.ts appendMessageSchema — a
    // bound on a *form*, where a staff member is typing and a limit is a UX
    // affordance. The column that stores these is `text` with only a non-empty
    // check, so the cap did nothing but discard somebody's message whole.
    for (const length of [10_001, 50_000]) {
      assert.equal(
        inboundWhatsAppMessageSchema.safeParse({ ...VALID, body: 'x'.repeat(length) }).success,
        true,
        `a ${length}-character message must be accepted`,
      );
    }
  });

  test('a long body survives parsing intact — nothing is truncated', () => {
    const body = `${'x'.repeat(12_000)}END`;
    const parsed = inboundWhatsAppMessageSchema.safeParse({ ...VALID, body });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(parsed.data.body.length, body.length);
    assert.ok(parsed.data.body.endsWith('END'), 'the tail was clipped');
  });

  test('identifiers are still bounded — over-length there is malformed, not long', () => {
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, externalRef: 'w'.repeat(201) }).success,
      false,
    );
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, phoneNumberId: 'p'.repeat(65) }).success,
      false,
    );
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, profileName: 'n'.repeat(201) }).success,
      false,
    );
  });

  test('occurredAt, when given, must be a real timestamp', () => {
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, occurredAt: '2026-08-10T12:00:00Z' })
        .success,
      true,
    );
    assert.equal(
      inboundWhatsAppMessageSchema.safeParse({ ...VALID, occurredAt: 'yesterday' }).success,
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Every outcome the SQL can return becomes the right Result
// ═══════════════════════════════════════════════════════════════════════════

describe('B. outcomes', () => {
  test('a first message is ingested, with its ids and the queued job', async () => {
    const result = await ingestInboundMessage(fakeAdmin(() => okRow(INGESTED_ROW)), VALID);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'ingested');
    assert.equal(result.data.seq, 0);
    assert.equal(result.data.jobId, 'job-1');
    assert.equal(result.data.leadId, 'lead-1');
    assert.equal(result.data.conversationId, 'conversation-1');
  });

  test('a replay succeeds, returns the existing ids, and queues nothing', async () => {
    const replay = { ...INGESTED_ROW, status: 'replayed', job_id: null };
    const result = await ingestInboundMessage(fakeAdmin(() => okRow(replay)), VALID);

    // Success, not a conflict: a webhook that answers anything else is retried
    // by the provider forever.
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.status, 'replayed');
    assert.equal(result.data.jobId, null);
    assert.equal(result.data.messageId, 'message-1');
  });

  test('an unknown phone_number_id is NOT_FOUND, not a crash', async () => {
    const unknown = {
      status: 'unknown_phone_number_id',
      organization_id: null,
      contact_id: null,
      lead_id: null,
      conversation_id: null,
      message_id: null,
      message_seq: null,
      job_id: null,
    };
    const result = await ingestInboundMessage(fakeAdmin(() => okRow(unknown)), VALID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.doesNotMatch(result.error.message, /PN_1/, 'the message must not echo request input');
  });

  test('an invalid payload is VALIDATION and never reaches the database', async () => {
    let called = false;
    const admin = fakeAdmin(() => {
      called = true;
      return okRow(INGESTED_ROW);
    });

    const result = await ingestInboundMessage(admin, { ...VALID, body: '' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'VALIDATION');
    assert.equal(called, false, 'a rejected payload must not be sent to the function');
  });

  test('a transport error is INTERNAL and does not leak the driver message', async () => {
    const result = await ingestInboundMessage(
      fakeAdmin(() => ({ data: null, error: { message: 'connection reset by peer' } })),
      VALID,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /connection reset/);
  });

  test('an empty result is INTERNAL rather than a false success', async () => {
    const result = await ingestInboundMessage(
      fakeAdmin(() => ({ data: [], error: null })),
      VALID,
    );
    assert.equal(result.ok, false);
  });

  test('a status this file does not know is INTERNAL, not passed through', async () => {
    const result = await ingestInboundMessage(
      fakeAdmin(() => okRow({ ...INGESTED_ROW, status: 'something_new' })),
      VALID,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('a success missing an id is INTERNAL — SQL and TypeScript disagreeing', async () => {
    const result = await ingestInboundMessage(
      fakeAdmin(() => okRow({ ...INGESTED_ROW, lead_id: null })),
      VALID,
    );
    assert.equal(result.ok, false);
  });

  test('seq 0 survives — the first message must not be read as missing', async () => {
    const result = await ingestInboundMessage(
      fakeAdmin(() => okRow({ ...INGESTED_ROW, message_seq: 0 })),
      VALID,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.seq, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. What is actually sent to the function
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the call', () => {
  test('every field is forwarded under the name the function declares', async () => {
    const seen: { fn?: string; args?: Record<string, unknown> } = {};
    await ingestInboundMessage(fakeAdmin(() => okRow(INGESTED_ROW), seen), VALID);

    assert.equal(seen.fn, 'ingest_whatsapp_message');
    assert.equal(seen.args?.p_phone_number_id, 'PN_1');
    assert.equal(seen.args?.p_from, '919900112233');
    assert.equal(seen.args?.p_external_ref, 'wamid.AAA');
    assert.equal(seen.args?.p_body, 'I need a storefront rebuild');
    assert.equal(seen.args?.p_profile_name, 'Asha');
  });

  test('an absent profile name is omitted, not sent as null', async () => {
    const seen: { fn?: string; args?: Record<string, unknown> } = {};
    const { profileName: _omitted, ...withoutName } = VALID;
    await ingestInboundMessage(fakeAdmin(() => okRow(INGESTED_ROW), seen), withoutName);

    assert.equal('p_profile_name' in (seen.args ?? {}), false);
  });

  test('occurredAt defaults to now rather than being left to chance', async () => {
    const seen: { fn?: string; args?: Record<string, unknown> } = {};
    await ingestInboundMessage(fakeAdmin(() => okRow(INGESTED_ROW), seen), VALID);

    assert.ok(typeof seen.args?.p_occurred_at === 'string');
    assert.ok(!Number.isNaN(Date.parse(seen.args.p_occurred_at as string)));
  });

  test('a provided occurredAt is passed through unchanged', async () => {
    const seen: { fn?: string; args?: Record<string, unknown> } = {};
    await ingestInboundMessage(fakeAdmin(() => okRow(INGESTED_ROW), seen), {
      ...VALID,
      occurredAt: '2026-08-10T12:00:00Z',
    });
    assert.equal(seen.args?.p_occurred_at, '2026-08-10T12:00:00Z');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The properties of the SQL that must not be edited away
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the migration', () => {
  test('the replay guard is a unique index, not a jsonb convention', () => {
    assert.match(
      migration,
      /create unique index[\s\S]{0,120}conversation_messages[\s\S]{0,120}\(organization_id, external_ref\)/,
    );
  });

  test('the guard is partial, so app-composed messages do not collide on null', () => {
    const at = migration.indexOf('conversation_messages_external_ref_key');
    assert.match(migration.slice(at, at + 300), /where external_ref is not null/);
  });

  test('seq is assigned inside the insert, never read-then-inserted', () => {
    // The whole point of the migration. A `select max(seq)` into a variable
    // followed by a separate insert would reintroduce the race.
    assert.match(migration, /coalesce\(max\(m\.seq\), -1\) \+ 1/);
    assert.doesNotMatch(migration, /select\s+coalesce\(max\([^)]*seq[^)]*\)[^;]*into\s+v_seq/i);
  });

  test('concurrent arrivals are serialised by a row lock on the conversation', () => {
    assert.match(migration, /from crm\.conversations c where c\.id = v_conversation for update/);
  });

  test('tenancy is resolved from organization settings, never defaulted', () => {
    assert.match(migration, /settings->>'whatsapp_phone_number_id' = p_phone_number_id/);
    // An unmatched number returns a status; it must not fall back to "the"
    // organization, which is what would make V1's single tenant permanent.
    assert.match(migration, /unknown_phone_number_id/);
    assert.doesNotMatch(migration, /order by[\s\S]{0,40}created_at[\s\S]{0,40}limit 1\s*;?\s*--?\s*org/i);
  });

  test('the lead is created as whatsapp-sourced and keyed for idempotency', () => {
    assert.match(migration, /'whatsapp', v_thread, 'new'/);
    assert.match(migration, /on conflict \(organization_id, source, source_ref\)/);
  });

  test('the conversation is keyed by external_ref', () => {
    assert.match(migration, /on conflict \(organization_id, channel, external_ref\)/);
  });

  test('the extraction is queued under the kind the runner claims', () => {
    assert.match(migration, /'requirement\.extract'/);
    // Same dedupe shape as crm/service.ts requestExtraction, so a human click
    // and an arriving message cannot both queue the same transcript.
    assert.match(migration, /'requirement\.extract:' \|\| v_conversation::text \|\| ':' \|\| v_count::text/);
  });

  test('a replay queues no second extraction', () => {
    const at = migration.indexOf("'replayed'::text");
    assert.ok(at > 0, 'the replayed branch is gone');
    // The replayed branch returns before the job insert, and returns no job id.
    assert.match(migration.slice(at, at + 120), /null::uuid/);
    assert.ok(migration.indexOf('into core.jobs') > at, 'the job insert must come after');
  });

  test('the function is service-role only', () => {
    assert.match(migration, /revoke all on function crm\.ingest_whatsapp_message/);
    assert.match(migration, /from public, anon, authenticated/);
    assert.match(migration, /grant execute on function crm\.ingest_whatsapp_message[\s\S]{0,120}to service_role/);
  });

  test('it runs security definer with an empty search_path', () => {
    assert.match(migration, /security definer/);
    assert.match(migration, /set search_path = ''/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D2. C6 — a settled lead stops commissioning extractions
//
// The extraction was queued without ever reading the lead's status, so a
// converted or disqualified lead ordered a model run per message against a
// deal already decided.
//
// The behaviour is proved against real Postgres by
// scripts/verify-whatsapp-ingest.mjs §7b — `npm run db:verify:ingest` — where
// five of its checks fail without this migration. What is pinned here are the
// properties of the SQL that would be silently lost if someone edited it: that
// the guard covers both terminal states, that it sits *after* the message is
// written, and that it changes nothing else about the lead.
// ═══════════════════════════════════════════════════════════════════════════

describe('D2. the terminal-lead guard', () => {
  test('it covers both terminal states, and only those', () => {
    assert.match(terminalLeadMigration, /v_lead_status in \('converted', 'disqualified'\)/);
    // 'new', 'qualifying' and 'qualified' are live leads: extraction is the
    // whole point for them, so none may appear in the guard.
    const at = terminalLeadMigration.indexOf("v_lead_status in (");
    const guard = terminalLeadMigration.slice(at, at + 200);
    for (const live of ['new', 'qualifying', 'qualified']) {
      assert.doesNotMatch(guard, new RegExp(`'${live}'`), `${live} is not a terminal state`);
    }
  });

  test('the status is read where the lead is resolved, not in a second query', () => {
    // Both the insert and the fallback lookup must yield it, or a lead that
    // already existed would be guarded on a null status.
    assert.match(terminalLeadMigration, /returning id, status into v_lead, v_lead_status/);
    assert.match(terminalLeadMigration, /select l\.id, l\.status into v_lead, v_lead_status/);
  });

  test('the message is written before the guard can return', () => {
    // C6 must not become C5. The guard stops the extraction, never the record,
    // so it has to sit after the insert into conversation_messages.
    const insertAt = terminalLeadMigration.indexOf('insert into crm.conversation_messages');
    const guardAt = terminalLeadMigration.indexOf("v_lead_status in (");
    assert.ok(insertAt > 0 && guardAt > 0, 'the migration lost one of the two');
    assert.ok(insertAt < guardAt, 'the guard would return before the message was stored');
  });

  test('it returns ingested, so the caller still counts the message as landed', () => {
    const at = terminalLeadMigration.indexOf("v_lead_status in (");
    const branch = terminalLeadMigration.slice(at, at + 400);
    assert.match(branch, /'ingested'::text/);
    assert.match(branch, /null::uuid/); // no job
  });

  test('it never reopens, closes or otherwise writes the lead', () => {
    // Option A: one lead per number, untouched. A terminal lead stays terminal.
    assert.doesNotMatch(terminalLeadMigration, /update crm\.leads/);
    assert.doesNotMatch(terminalLeadMigration, /update crm\.conversations/);
  });

  test('it invents no second lead, conversation or thread key', () => {
    // The one-lead-per-wa:<phone> invariant is the thing C6 must not break:
    // the key is still the bare thread, with nothing appended to make it a
    // second one, and no schema was touched to allow one.
    assert.match(terminalLeadMigration, /v_thread\s+:= 'wa:' \|\| v_phone;/);
    assert.doesNotMatch(terminalLeadMigration, /'wa:' \|\| v_phone \|\|/);
    assert.doesNotMatch(terminalLeadMigration, /drop index|alter table|create table/);
  });

  test('a live lead still reaches the unchanged queueing path', () => {
    const guardAt = terminalLeadMigration.indexOf("v_lead_status in (");
    const after = terminalLeadMigration.slice(guardAt);
    assert.match(after, /insert into core\.jobs/);
    assert.match(after, /'requirement\.extract:' \|\| v_conversation::text/);
  });

  test('the signature and grants are unchanged', () => {
    assert.match(terminalLeadMigration, /create or replace function crm\.ingest_whatsapp_message/);
    assert.match(terminalLeadMigration, /grant execute on function[\s\S]*to service_role/);
    assert.match(terminalLeadMigration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Ingest proposes; it never sends
// ═══════════════════════════════════════════════════════════════════════════

describe('E. the ingest path sends nothing', () => {
  test('the migration writes no outbound message and calls no provider', () => {
    // ARCHITECTURE.md §6.1: no agent commits client communication without a
    // recorded human approval, and requirement_collector is L1.
    for (const forbidden of [/notify\./i, /graph\.facebook/i, /messages\/send/i, /http/i]) {
      assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ''), forbidden);
    }
  });

  test('the service performs exactly one database call and no fetch', () => {
    assert.doesNotMatch(ingestSource, /\bfetch\(/);
    assert.equal((ingestSource.match(/\.rpc\(/g) ?? []).length, 1);
  });

  test('it never writes an outbound-authored message', () => {
    // Everything ingest records is authored by the client. 'agent' or 'user'
    // authorship arriving from this path would mean something replied.
    assert.match(migration, /'client',\s*\n?\s*p_body/);
    assert.doesNotMatch(migration, /author_type[\s\S]{0,40}'agent'/);
  });
});
