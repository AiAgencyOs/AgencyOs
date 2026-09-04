import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Sending something back — gap G-014, decision ADM-09.
 *
 * The first thing in AgencyOS that reaches a client rather than describing
 * one, so the tests are about the two ways that goes wrong:
 *
 *   A message sent and not recorded. Invisible: nobody knows it went, a retry
 *   sends it twice, and the transcript the extractor reads has a hole in it.
 *   The row is therefore written *before* the provider is called, and these
 *   tests prove the ordering rather than assuming it.
 *
 *   A message recorded and reported as sent when it was not. That is worse
 *   than a failure, because a person reads the transcript and believes the
 *   client was told. Every provider outcome is written back.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260812120013_outbound_messages.sql', import.meta.url)),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

type Rpc = { data: unknown; error: { message: string } | null };

const seen = {
  calls: [] as [string, Record<string, unknown>][],
  sent: [] as Record<string, unknown>[],
  uploads: [] as Record<string, unknown>[],
  docs: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  templates: [] as Record<string, unknown>[],
};

let queueResult: Rpc = {
  data: [
    {
      outcome: 'created',
      message_id: '11111111-1111-4111-8111-111111111111',
      seq: 3,
      to_phone: '919000000000',
      from_phone_number_id: '5550001',
      recipient_type: 'individual',
    },
  ],
  error: null,
};

let sendResult: { ok: boolean; providerRef?: string; permanent?: boolean; message?: string } = {
  ok: true,
  providerRef: 'wamid.OUT1',
};
let uploadResult: { ok: boolean; mediaId?: string; permanent?: boolean; message?: string } = {
  ok: true,
  mediaId: 'MEDIA.1',
};
let docSendResult: { ok: boolean; providerRef?: string; permanent?: boolean; message?: string } = {
  ok: true,
  providerRef: 'wamid.DOC1',
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role: 'owner',
      userId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
    }),
  },
});
mock.module('@/lib/whatsapp/send', {
  exports: {
    sendWhatsAppText: async (input: Record<string, unknown>) => {
      seen.sent.push(input);
      return sendResult;
    },
    sendWhatsAppTemplate: async (input: Record<string, unknown>) => {
      seen.templates.push(input);
      return { ok: true, providerRef: 'wamid.TEMPLATE' };
    },
    uploadWhatsAppMedia: async (input: Record<string, unknown>) => {
      seen.uploads.push(input);
      return uploadResult;
    },
    sendWhatsAppDocument: async (input: Record<string, unknown>) => {
      seen.docs.push(input);
      return docSendResult;
    },
  },
});
mock.module('@/lib/audit', {
  exports: {
    recordAudit: async (entry: Record<string, unknown>) => {
      seen.audits.push(entry);
    },
  },
});
/** The window, and what is registered for it — G-214. */
let windowState = 'open';
let templates: { template_name: string; language_code: string; parameters: string[] }[] = [];

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            seen.calls.push([fn, args]);
            if (fn === 'send_outbound_message') return queueResult;
            // G-214: a person pressing send is still a business-initiated
            // message, so the service asks whether WhatsApp will carry it.
            // 'open' is what these tests have always described.
            if (fn === 'window_state') return { data: windowState, error: null };
            return { data: true, error: null };
          },
          from(table: string) {
            const chain: Record<string, unknown> = {
              select: () => chain,
              eq: () => chain,
              limit: () => chain,
              maybeSingle: async () => ({ data: null, error: null }),
              then: (resolve: (value: unknown) => void) =>
                resolve({ data: table === 'whatsapp_templates' ? templates : [], error: null }),
            };
            return chain;
          },
        };
      },
    }),
  },
});

const { sendClientDocument, sendClientMessage } = await import('../src/modules/crm/service.ts');

const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const key = () => 'out-11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  windowState = 'open';
  templates = [];
  seen.calls = [];
  seen.sent = [];
  seen.templates = [];
  seen.audits = [];
  queueResult = {
    data: [
      {
        outcome: 'created',
        message_id: '11111111-1111-4111-8111-111111111111',
        seq: 3,
        to_phone: '919000000000',
        from_phone_number_id: '5550001',
        recipient_type: 'individual',
      },
    ],
    error: null,
  };
  sendResult = { ok: true, providerRef: 'wamid.OUT1' };
  seen.uploads = [];
  seen.docs = [];
  uploadResult = { ok: true, mediaId: 'MEDIA.1' };
  docSendResult = { ok: true, providerRef: 'wamid.DOC1' };
});

describe('A. the row comes first', () => {
  test('the message is recorded before the provider is called', async () => {
    await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(seen.calls[0]![0], 'send_outbound_message');
    assert.equal(seen.sent.length, 1);
    assert.ok(
      seen.calls.findIndex(([fn]) => fn === 'send_outbound_message') === 0,
      'recording after sending would make a lost message invisible',
    );
  });

  test('the number, the account and how to address it all come from the database', async () => {
    // `recipientType` joined this set when groups did. Meta's Groups API takes
    // a different envelope — `recipient_type: 'group'` with a group id in `to`
    // — and a caller that paired them itself would eventually pair them wrong.
    // Sending a group id as an individual is refused by the provider, which is
    // how the announcement path was found to be unable to send at all.
    await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.deepEqual(seen.sent[0], {
      phoneNumberId: '5550001',
      to: '919000000000',
      body: 'Hello',
      recipientType: 'individual',
    });
  });

  test('a group conversation is addressed as a group, from the same read', async () => {
    queueResult = {
      data: [
        {
          outcome: 'created',
          message_id: '11111111-1111-4111-8111-111111111111',
          seq: 3,
          to_phone: 'capi_group:12345',
          from_phone_number_id: '5550001',
          recipient_type: 'group',
        },
      ],
      error: null,
    };

    await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(seen.sent[0]!.recipientType, 'group');
    assert.equal(seen.sent[0]!.to, 'capi_group:12345');
  });

  test('a successful send is written back and audited', async () => {
    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(result.ok);
    const mark = seen.calls.find(([fn]) => fn === 'mark_outbound_delivery')!;
    assert.equal(mark[1].p_status, 'sent');
    assert.equal(mark[1].p_provider_ref, 'wamid.OUT1');
    assert.equal(
      seen.audits.length,
      0,
      'the audit row is written by mark_outbound_delivery, inside its own transaction (G-079)',
    );
  });
});

describe('B. when it does not go', () => {
  test('a provider failure is written back as failed, with the reason', async () => {
    sendResult = { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };

    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(!result.ok);
    const mark = seen.calls.find(([fn]) => fn === 'mark_outbound_delivery')!;
    assert.equal(mark[1].p_status, 'failed');
    assert.equal(mark[1].p_error, 'WhatsApp could not be reached.');
  });

  test('a failed send is never audited as sent', async () => {
    sendResult = { ok: false, permanent: false, message: 'refused' };

    await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(seen.audits.length, 0, 'nothing in TypeScript audits this path at all');
    assert.equal(
      seen.calls.find(([fn]) => fn === 'mark_outbound_delivery')![1].p_status,
      'failed',
      'and what the database records is the failure, not a send',
    );
  });

  test('a contact with no number fails before the provider is called at all', async () => {
    queueResult = {
      data: [
        {
          outcome: 'created',
          message_id: '11111111-1111-4111-8111-111111111111',
          seq: 3,
          to_phone: null,
          from_phone_number_id: '5550001',
        },
      ],
      error: null,
    };

    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(!result.ok);
    assert.equal(seen.sent.length, 0);
    assert.equal(seen.calls.find(([fn]) => fn === 'mark_outbound_delivery')![1].p_status, 'failed');
  });

  test('a conversation that does not exist sends nothing', async () => {
    queueResult = {
      data: [{ outcome: 'not_found', message_id: null, seq: null, to_phone: null, from_phone_number_id: null }],
      error: null,
    };

    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'NOT_FOUND');
    assert.equal(seen.sent.length, 0);
  });

  test('a database that cannot record the message never reaches the client', async () => {
    queueResult = { data: null, error: { message: 'connection reset by peer' } };

    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(!result.ok);
    assert.equal(seen.sent.length, 0, 'sending without a record is the one outcome that cannot be repaired');
    assert.doesNotMatch(result.error.message, /connection reset/);
  });
});

describe('C. sending the same thing twice', () => {
  test('a retry finds the first message and does not send again', async () => {
    queueResult = {
      data: [
        {
          outcome: 'already_sent',
          message_id: '11111111-1111-4111-8111-111111111111',
          seq: 3,
          to_phone: null,
          from_phone_number_id: null,
        },
      ],
      error: null,
    };

    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: key(),
    });

    assert.ok(result.ok, 'reported as success, because the message the caller asked for is gone');
    assert.equal(seen.sent.length, 0);
  });

  test('an empty body never reaches the database', async () => {
    const result = await sendClientMessage({ conversationId: CONVERSATION, body: '   ', idempotencyKey: key() });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.equal(seen.calls.length, 0);
  });

  test('an idempotency key is required — there is no default', async () => {
    const result = await sendClientMessage({
      conversationId: CONVERSATION,
      body: 'Hello',
      idempotencyKey: '',
    });

    assert.ok(!result.ok);
    assert.equal(seen.calls.length, 0, 'at-least-once delivery to a paying client is not a default');
  });
});

describe('D. what the database holds', () => {
  test('seq is allocated under the conversation’s lock', () => {
    assert.match(migration, /from crm\.conversations c[\s\S]*?for update/);
  });

  test('the row is inserted pending, before anything is sent', () => {
    assert.match(migration, /'delivery', 'pending'/);
  });

  test('a delivery report can only settle a message that is still pending', () => {
    assert.match(migration, /metadata->>'delivery' = 'pending'/);
  });

  test('a delivery report cannot rewrite the body, the author or the position', () => {
    const fn = migration.slice(migration.indexOf('function crm.mark_outbound_delivery'));
    assert.doesNotMatch(fn.slice(0, 1500), /set (body|author_type|seq)/);
  });

  test('the account sent from is read from the organization, not from an argument', () => {
    assert.match(migration, /select o\.settings into v_settings/);
    assert.match(migration, /whatsapp_phone_number_id/);
  });
});

/**
 * A document to a client — G-156, the crm half.
 *
 * The shape under test is the deviation `sendClientDocument` documents: a
 * provider failure is DATA (delivered:false plus whether a retry could fix
 * it), because its one caller must stamp or not stamp a quotation by that
 * difference; and `already_sent` re-attempts when the row is not `sent`,
 * which is the resend behavior the text path lacks and PR #300 paid for.
 */
describe('H. a document travels row-first too', () => {
  const DOC = {
    conversationId: '44444444-4444-4444-8444-444444444444',
    filename: 'Quotation-v2-Delivery-app.pdf',
    idempotencyKey: 'proposal:11111111-1111-4111-8111-111111111111:v2:pdf',
    bytes: new TextEncoder().encode('%PDF-1.7 pretend'),
  };

  test('the row is recorded as a document with an empty body, authored by the sender', async () => {
    await sendClientDocument(DOC);
    const call = seen.calls.find(([fn]) => fn === 'send_outbound_message');
    assert.ok(call);
    assert.equal(call![1].p_body, '');
    assert.equal(call![1].p_media_type, 'document');
    assert.equal(call![1].p_media_filename, DOC.filename);
    assert.equal(call![1].p_author_id, '22222222-2222-4222-8222-222222222222');
  });

  test('upload first, then a document message naming the upload’s id', async () => {
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.delivered, true);
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.docs.length, 1);
    assert.equal(seen.docs[0]!.mediaId, 'MEDIA.1');
    assert.equal(seen.docs[0]!.filename, DOC.filename);
    const settle = seen.calls.find(([fn]) => fn === 'mark_outbound_delivery');
    assert.equal(settle![1].p_status, 'sent');
    assert.equal(settle![1].p_provider_ref, 'wamid.DOC1');
  });

  test('a transient provider failure answers ok-but-undelivered, retryable — not an err', async () => {
    uploadResult = { ok: false, permanent: false, message: 'WhatsApp could not be reached.' };
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.delivered, false);
      assert.equal(result.data.retryable, true);
    }
    assert.equal(seen.docs.length, 0, 'no document message without an upload');
    const settle = seen.calls.find(([fn]) => fn === 'mark_outbound_delivery');
    assert.equal(settle![1].p_status, 'failed');
  });

  test('a permanent refusal says a retry cannot fix it', async () => {
    uploadResult = { ok: true, mediaId: 'MEDIA.1' };
    docSendResult = { ok: false, permanent: true, message: 'WhatsApp refused the document (400).' };
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.delivered, false);
      assert.equal(result.data.retryable, false);
      assert.match(result.data.reason ?? '', /refused/);
    }
  });

  test('already_sent with a settled row skips the provider entirely', async () => {
    queueResult = {
      data: [{ outcome: 'already_sent', message_id: '11111111-1111-4111-8111-111111111111', seq: 3, to_phone: '919000000000', from_phone_number_id: '5550001', recipient_type: 'individual', delivery: 'sent' }],
      error: null,
    };
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.delivered, true);
    assert.equal(seen.uploads.length, 0);
    assert.equal(seen.docs.length, 0);
  });

  test('already_sent with a FAILED row tries the provider again — the resend PR #300 was about', async () => {
    queueResult = {
      data: [{ outcome: 'already_sent', message_id: '11111111-1111-4111-8111-111111111111', seq: 3, to_phone: '919000000000', from_phone_number_id: '5550001', recipient_type: 'individual', delivery: 'failed' }],
      error: null,
    };
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.delivered, true);
    assert.equal(seen.uploads.length, 1, 'the failed row must be retried');
    assert.equal(seen.docs.length, 1);
  });

  test('no consent, no document — the same refusal as the words', async () => {
    queueResult = { data: [{ outcome: 'no_consent', message_id: null, seq: null, to_phone: null, from_phone_number_id: null, recipient_type: null, delivery: null }], error: null };
    const result = await sendClientDocument(DOC);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'FORBIDDEN');
    assert.equal(seen.uploads.length, 0);
  });

  test('empty bytes are refused before anything is recorded', async () => {
    const result = await sendClientDocument({ ...DOC, bytes: new Uint8Array(0) });
    assert.equal(result.ok, false);
    assert.equal(seen.calls.length, 0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A person pressing send is still a business-initiated message — G-214
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no job to park here, so the two honest answers outside the window
 * are an approved template or a refusal that says exactly what to do. Never a
 * send the provider will reject and a failure nobody can interpret.
 */
describe('the 24-hour window, from the Inbox', () => {
  test('outside it, nothing is handed to the provider', async () => {
    windowState = 'closed';
    const result = await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(seen.sent.length, 0);
    assert.equal(result.ok, false);
  });

  test('and the refusal says what to do about it', async () => {
    windowState = 'closed';
    const result = await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /24 hours|approved template/);
  });

  test('a contact who has never written is told apart from one who went quiet', async () => {
    windowState = 'never';
    const result = await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /never messaged you/);
  });

  test('with an approved template registered, that goes instead', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'agent_check_in', language_code: 'en', parameters: [] }];

    await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(seen.sent.length, 0, 'free text went out past the window');
    assert.equal(seen.templates.length, 1);
    assert.equal(seen.templates[0]?.templateName, 'agent_check_in');
  });

  test('inside it the wording goes, exactly as before — the positive twin', async () => {
    windowState = 'open';
    const result = await sendClientMessage({ conversationId: CONVERSATION, body: 'Hello', idempotencyKey: key() });

    assert.equal(result.ok, true);
    assert.equal(seen.sent.length, 1);
    assert.equal(seen.templates.length, 0);
  });

  test('a file has no template route at all, so it is refused rather than uploaded', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'agent_check_in', language_code: 'en', parameters: [] }];

    const result = await sendClientDocument({
      conversationId: CONVERSATION,
      filename: 'Quotation-v2-Delivery-app.pdf',
      idempotencyKey: 'proposal:22222222-2222-4222-8222-222222222222:v2:pdf',
      bytes: new TextEncoder().encode('%PDF-1.7 pretend'),
    });

    assert.equal(result.ok, false);
    assert.equal(seen.uploads.length, 0, 'a file was uploaded that could never be delivered');
    assert.equal(seen.docs.length, 0);
  });
});
