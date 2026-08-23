import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import {
  HANDLER_JOB_KIND,
  HANDLERS,
  planJobsForEvent,
  subscribersFor,
} from '../src/lib/events/catalog.ts';
import { announcementFor, approvalRequestedEventSchema } from '../src/modules/crm/schema.ts';

/**
 * The agent asking in the internal group — gap G-110, decision ADM-11.
 *
 * G-109 built the channel and nothing flowed through it: the queue the Admin
 * was promised existed only on a web page, which is no use to an owner who is
 * not looking at one.
 *
 * The database half is proved against a real Postgres by
 * `scripts/verify-approval-announcements.mjs` — 16 checks, watched failing
 * first with the reference index dropped and the audience filter removed. What
 * is here is the announcement's wording, the catalog wiring, and the handler's
 * outcome mapping, which no live script exercises because the far end is
 * somebody else's HTTP API.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120021_the_agent_asks_in_the_group.sql', import.meta.url),
  ),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

const seen = {
  rpc: [] as [string, Record<string, unknown>][],
  sent: [] as Record<string, unknown>[],
  uploads: [] as Record<string, unknown>[],
  docs: [] as Record<string, unknown>[],
};

let group: { id: string } | null = { id: GROUP };
let groupError: { message: string } | null = null;
let sendResult: Record<string, unknown> = {
  outcome: 'created',
  // A group id, not a phone number. This is what send_outbound_message
  // actually returns for a group conversation, and the fixture said
  // '+911234567890' until the provider's documentation showed why that was
  // never reachable.
  message_id: MESSAGE,
  to_phone: 'capi_group:12345',
  from_phone_number_id: 'pn-1',
  recipient_type: 'group',
};
let providerOk = true;
let providerPermanent = false;
let markSettled: boolean = true;
let markError = false;
let requestReadError: { message: string } | null = null;

let uploadOk = true;
let uploadPermanent = false;
let docOk = true;
let docPermanent = false;

mock.module('@/lib/whatsapp/send', {
  exports: {
    sendWhatsAppText: async (input: Record<string, unknown>) => {
      seen.sent.push(input);
      return providerOk
        ? { ok: true, providerRef: 'wamid.SENT' }
        : { ok: false, permanent: providerPermanent, message: 'provider down' };
    },
    uploadWhatsAppMedia: async (input: Record<string, unknown>) => {
      seen.uploads.push(input);
      return uploadOk
        ? { ok: true, mediaId: 'MEDIA.1' }
        : { ok: false, permanent: uploadPermanent, message: 'upload refused' };
    },
    sendWhatsAppDocument: async (input: Record<string, unknown>) => {
      seen.docs.push(input);
      return docOk
        ? { ok: true, providerRef: 'wamid.DOC' }
        : { ok: false, permanent: docPermanent, message: 'document refused' };
    },
  },
});

/**
 * Rows by table, so the PDF leg's reads (proposal, items, organization) can
 * be planted per-test. 'conversations' answers the group lookup exactly as
 * the old single-purpose chain did; 'approval_requests' defaults to a
 * system-raised request, which is what every pre-PDF test implicitly had.
 */
const tableRows = new Map<string, unknown>();
const tableLists = new Map<string, unknown[]>();

const admin = {
  schema: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        order: () => chain,
        maybeSingle: async () => {
          if (table === 'conversations') return { data: group, error: groupError };
          if (table === 'approval_requests' && requestReadError) {
            return { data: null, error: requestReadError };
          }
          return { data: tableRows.get(table) ?? null, error: null };
        },
        then: (resolve: (value: unknown) => void) =>
          resolve({ data: tableLists.get(table) ?? [], error: null }),
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      seen.rpc.push([fn, args]);
      if (fn === 'send_outbound_message') return { data: [sendResult], error: null };
      // mark_outbound_delivery returns whether it settled a row. `true` is the
      // ordinary case (a pending row moved); a test that needs the terminal
      // no-op sets markSettled = false.
      if (fn === 'mark_outbound_delivery') {
        return markError
          ? { data: null, error: { message: 'connection reset' } }
          : { data: markSettled, error: null };
      }
      return { data: null, error: null };
    },
  }),
};

const { handleApprovalRequested } = await import('../src/modules/crm/handlers.ts');

const job = (event: Record<string, unknown>) => ({
  id: 'job-1',
  organization_id: 'org-1',
  payload: { subjectId: REQUEST, eventType: 'approval.requested', event },
  correlation_id: null,
});

const EVENT = {
  reference: 'A7C2KM',
  subjectType: 'proposal',
  subjectId: REQUEST,
  summary: 'Quotation v1 — Bakery app',
  amountMinor: 481177,
  requiredRole: 'owner',
  slaDueAt: '2026-08-15T00:00:00.000Z',
};

beforeEach(() => {
  seen.rpc = [];
  seen.sent = [];
  group = { id: GROUP };
  groupError = null;
  providerOk = true;
  providerPermanent = false;
  markSettled = true;
  markError = false;
  seen.uploads = [];
  seen.docs = [];
  uploadOk = true;
  uploadPermanent = false;
  docOk = true;
  docPermanent = false;
  tableRows.clear();
  tableLists.clear();
  requestReadError = null;
  tableRows.set('approval_requests', { requested_by_type: 'system', requested_by_id: null, payload: null });
  sendResult = {
    outcome: 'created',
    message_id: MESSAGE,
    to_phone: 'capi_group:12345',
    from_phone_number_id: 'pn-1',
    recipient_type: 'group',
    delivery: 'pending',
  };
});

describe('A. what the group is told', () => {
  test('the message names what, how much, who, and the code to quote', () => {
    const text = announcementFor(EVENT);
    assert.match(text, /Quotation needs a decision/);
    assert.match(text, /Bakery app/);
    assert.match(text, /4,811.77/);
    assert.match(text, /Needs: owner/);
    assert.match(text, /A7C2KM/);
  });

  test('the code is on its own line, because it is the thing somebody copies', () => {
    const lines = announcementFor(EVENT).split('\n');
    assert.match(lines[lines.length - 1]!, /^Decide it in AgencyOS\. Reference A7C2KM\.$/);
  });

  test('and the message does not invite a reply, because nothing reads one', () => {
    // ADM-74: the reply is advisory and settles nothing. The line used to read
    // "Reply quoting <code>." — an instruction that does nothing, which an
    // approver could follow and believe they had approved something.
    //
    // Asserted as an absence rather than a presence: any future wording that
    // asks for a reply fails here, not only the exact sentence removed.
    const text = announcementFor(EVENT);
    assert.ok(
      !/\breply\b/i.test(text),
      'the announcement asks for a reply, which nothing reads and which cannot settle an approval',
    );
    assert.match(text, /AgencyOS/, 'the approver is not told where the decision is actually made');
  });

  test('a request with no amount does not invent one', () => {
    const text = announcementFor({ reference: 'BBBBBB', subjectType: 'scope_change' });
    assert.ok(!/₹/.test(text), 'a money figure appeared for a request that carries none');
    assert.match(text, /Scope change needs a decision/);
  });

  test('an unknown subject type still produces a sentence', () => {
    // A subject type added later must not render as an empty announcement.
    const text = announcementFor({ reference: 'CCCCCC', subjectType: 'something_new' });
    assert.match(text, /something_new needs a decision/);
    assert.match(text, /CCCCCC/);
  });

  test('the payload is validated, not trusted', () => {
    // It arrives through the outbox and the job queue. A handler that read it
    // optimistically would turn a malformed event into a message an owner gets.
    assert.equal(approvalRequestedEventSchema.safeParse({}).success, false);
    assert.equal(approvalRequestedEventSchema.safeParse({ reference: '' }).success, false);
    assert.equal(
      approvalRequestedEventSchema.safeParse({ reference: 'A7C2KM', subjectType: 'invoice' }).success,
      true,
    );
  });
});

describe('B. the wiring is the catalog, and nothing else', () => {
  test('approval.requested reaches exactly the crm announcer', () => {
    assert.deepEqual(subscribersFor('approval.requested'), ['crm:announceApproval']);
  });

  test('the handler is registered and has a job kind of its own', () => {
    assert.ok(HANDLERS.includes('crm:announceApproval'));
    assert.equal(HANDLER_JOB_KIND['crm:announceApproval'], 'approval.announce');
  });

  test('one event plans one job, with the dedupe key redelivery relies on', () => {
    const jobs = planJobsForEvent({
      id: 7,
      organization_id: 'org-1',
      type: 'approval.requested',
      subject_type: 'approval_request',
      subject_id: REQUEST,
      payload: EVENT,
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.kind, 'approval.announce');
    assert.equal(jobs[0]!.dedupe_key, 'evt:7:crm:announceApproval');
  });

  test('the audience filter is in the emitter, not the catalog', () => {
    // "Which requests are announced" is a rule about approvals, not about
    // wiring — so it is enforced where the event is emitted and the catalog
    // stays a pure routing table.
    assert.match(migration, /if v_audience = 'internal' then/);
    assert.match(migration, /v_audience := coalesce\(p_audience, v_policy\.audience\)/);
  });
});

describe('C. the handler', () => {
  test('announces once, keyed on the request rather than the job', async () => {
    // The key is what makes a re-dispatched event, a retried job and a second
    // event for one request collapse onto one message — which matters most
    // here, because the failure mode is an owner's phone buzzing repeatedly
    // about one decision.
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    const [, args] = seen.rpc.find(([fn]) => fn === 'send_outbound_message')!;
    assert.equal(args.p_external_ref, `approval:${REQUEST}`);
  });

  test('an organization with no group is a success, not a failure', async () => {
    // Not having set one up is an ordinary state. Failing would fill the queue
    // with jobs that can only ever be parked.
    group = null;

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'no_group');
    assert.equal(seen.sent.length, 0, 'nothing was sent');
  });

  test('a read that fails is retryable — it is not an absent group', async () => {
    // D3, D5 and D6, one module along: "could not read" and "is not there" are
    // different facts, and conflating them strands work on a blip.
    groupError = { message: 'connection reset' };

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, false);
  });

  test('a message already SENT is not sent again', async () => {
    // The row reached the provider. Only `delivery: sent` earns the
    // short-circuit — a bare already_sent is not enough.
    sendResult = { outcome: 'already_sent', message_id: MESSAGE, to_phone: 'capi_group:12345', from_phone_number_id: 'pn-1', recipient_type: 'group', delivery: 'sent' };

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'already_announced');
    assert.equal(seen.sent.length, 0);
  });

  test('an already_sent row that never left as PENDING is sent, not falsely reported done', async () => {
    // The bug this fix closes: a prior attempt wrote the row and crashed before
    // the provider was reached. The old code saw already_sent and returned
    // success — an announcement the owner never got. Now a pending row sends.
    sendResult = { outcome: 'already_sent', message_id: MESSAGE, to_phone: 'capi_group:12345', from_phone_number_id: 'pn-1', recipient_type: 'group', delivery: 'pending' };

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'announced');
    assert.equal(seen.sent.length, 1, 'a pending announcement was not actually sent');
  });

  test('an already_sent row that FAILED before is retried', async () => {
    sendResult = { outcome: 'already_sent', message_id: MESSAGE, to_phone: 'capi_group:12345', from_phone_number_id: 'pn-1', recipient_type: 'group', delivery: 'failed' };

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(seen.sent.length, 1, 'a failed announcement was not retried');
  });

  test('a transient provider failure is retryable and leaves the attempt recorded', async () => {
    providerOk = false;
    providerPermanent = false;

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, false);
    const marked = seen.rpc.find(([fn]) => fn === 'mark_outbound_delivery');
    assert.ok(marked, 'the failed attempt is not recorded');
    assert.equal(marked![1].p_status, 'failed');
  });

  test('a permanent provider failure (a 4xx) is not retried forever', async () => {
    providerOk = false;
    providerPermanent = true;

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, true);
  });

  test('a delivery that could not be recorded is retryable, not silently lost', async () => {
    // The provider was reached but mark_outbound_delivery errored — the row
    // may be sent-but-unmarked. Reporting success would strand it; the retry
    // reconciles against the row's own delivery state.
    markError = true;

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, false);
  });

  test('a provider failure whose row was already settled sent is not a failure', async () => {
    // The send lost a race: a concurrent attempt already marked the row sent,
    // so mark_outbound_delivery no-ops (sent is terminal) and this stale
    // failure is reported as the success it actually is.
    providerOk = false;
    markSettled = false;

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'already_announced');
  });

  test('a group addressed as an individual would be refused, so it never is', async () => {
    // The defect this suite missed the first time. Meta's Groups API takes
    // `recipient_type: 'group'` with the group id in `to`; sending that id as
    // an individual is refused by the provider. The pairing comes from
    // send_outbound_message so the handler cannot get it wrong — and this
    // asserts it is passed through rather than defaulted away.
    await handleApprovalRequested(admin as never, job(EVENT) as never);

    const sent = seen.sent[0]!;
    assert.equal(sent.recipientType, 'group');
    assert.equal(sent.to, 'capi_group:12345');
    assert.ok(!/^\+?\d+$/.test(String(sent.to)), 'a group was addressed by phone number');
  });

  test('a 1:1 recipient is still addressed as an individual', async () => {
    sendResult = {
      outcome: 'created',
      message_id: MESSAGE,
      to_phone: '+911234567890',
      from_phone_number_id: 'pn-1',
      recipient_type: 'individual',
    };

    await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(seen.sent[0]!.recipientType, 'individual');
  });

  test('a group with no provider id is permanent — retrying cannot give it one', async () => {
    sendResult = {
      outcome: 'created',
      message_id: MESSAGE,
      to_phone: null,
      from_phone_number_id: null,
      recipient_type: 'group',
    };

    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, true);
  });

  test('a malformed payload is permanent, not retried forever', async () => {
    const result = await handleApprovalRequested(
      admin as never,
      job({ nonsense: true }) as never,
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.permanent, true);
  });

  test('the organization comes from the job row, never from the payload', async () => {
    // The payload is the untrusted part. An event naming another tenant must
    // find nothing rather than reach across.
    const handlers = readFileSync(
      fileURLToPath(new URL('../src/modules/crm/handlers.ts', import.meta.url)),
      'utf8',
    );
    assert.match(handlers, /\.eq\('organization_id', job\.organization_id\)/);
    assert.ok(
      !/event\.organizationId/.test(handlers),
      'the handler reads a tenant out of the payload',
    );
  });
});

describe('D. what is deliberately not built', () => {
  test('nothing in this migration settles an approval', () => {
    const sql = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/comment on [\s\S]*?';/gi, '');

    assert.ok(sql.length > migration.length / 4, 'the strip removed most of the file');
    assert.ok(
      !/decide_approval/.test(sql),
      'a reply path into decide_approval appeared — see ADM-74',
    );
    assert.ok(
      !/state\s*=\s*'approved'/.test(sql),
      'something in here approves a request',
    );
  });

  test('and the reason is written down where the next reader will look', () => {
    assert.match(migration, /ADM-74/);
    assert.match(migration, /G-115/);
    assert.match(migration, /auth\.uid\(\)/);
  });
});

/**
 * The quotation PDF leg — G-156's §27 failure classes, held by unit checks.
 *
 * The live script (§0b of verify-approval-announcements) proves the happy
 * path and the authored gate against the running app; what it cannot cheaply
 * prove is the CLASSIFICATION — that a transient provider failure fails the
 * JOB (so the queue retries it) while a permanent one, or a renderer crash,
 * settles as announced_without_pdf. A mutation flipping the failed branch to
 * succeeded survived the whole suite before these existed.
 */
describe('F. the quotation travels to the group as a document', () => {
  const PROPOSAL_ROW = {
    id: REQUEST,
    version: 2,
    title: 'Delivery app',
    body: 'Covers the apps.',
    status: 'pending_approval',
    currency: 'INR',
    subtotal_minor: 7000000,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: 7000000,
    valid_until: null,
    created_at: '2026-08-23T10:15:00Z',
    opportunity_id: null,
  };

  const personRequest = () =>
    tableRows.set('approval_requests', {
      requested_by_type: 'user',
      requested_by_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      payload: null,
    });

  const plantQuotation = () => {
    personRequest();
    tableRows.set('proposals', PROPOSAL_ROW);
    tableRows.set('organizations', { name: 'Bussen Hancer Agency', timezone: 'Asia/Kolkata' });
    tableLists.set('proposal_items', [{ description: 'Customer app', quantity: 1, amount_minor: 7000000 }]);
  };

  test('a person-raised quotation approval sends the PDF: its own row, an upload, a document', async () => {
    plantQuotation();
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'succeeded');
    if (result.status === 'succeeded') assert.equal(result.outcome, 'announced');
    assert.match((result as { detail?: string }).detail ?? '', /PDF attached/);

    const keys = seen.rpc.filter(([fn]) => fn === 'send_outbound_message').map(([, a]) => a.p_external_ref);
    assert.deepEqual(keys, [`approval:${REQUEST}`, `approval:${REQUEST}:pdf`]);
    const docRow = seen.rpc.find(([fn, a]) => fn === 'send_outbound_message' && a.p_media_type === 'document');
    assert.ok(docRow, 'the document row carries its kind');
    assert.equal(docRow![1].p_author_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.docs.length, 1);
    assert.equal(seen.docs[0]!.mediaId, 'MEDIA.1');
  });

  test('an agent-raised request sends NO document, even though the DDL gives agents an id too', async () => {
    plantQuotation();
    tableRows.set('approval_requests', {
      requested_by_type: 'agent',
      requested_by_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      payload: null,
    });
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'succeeded');
    assert.equal(seen.uploads.length, 0, 'an agent must keep the priceless form');
    assert.ok(!seen.rpc.some(([fn, a]) => fn === 'send_outbound_message' && a.p_media_type === 'document'));
  });

  test('a transient upload failure fails the JOB — the retry finishes the leg', async () => {
    plantQuotation();
    uploadOk = false;
    uploadPermanent = false;
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.permanent, false);
  });

  test('a permanent document refusal settles as announced_without_pdf — retrying a deterministic no tells nobody anything', async () => {
    plantQuotation();
    docOk = false;
    docPermanent = true;
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'succeeded');
    if (result.status === 'succeeded') assert.equal(result.outcome, 'announced_without_pdf');
    assert.match((result as { detail?: string }).detail ?? '', /not attached/);
  });

  test('a renderer crash settles as announced_without_pdf too — the text already told the owner everything', async () => {
    plantQuotation();
    tableRows.set('proposals', { ...PROPOSAL_ROW, title: 123 });
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'succeeded');
    if (result.status === 'succeeded') assert.equal(result.outcome, 'announced_without_pdf');
    assert.equal(seen.uploads.length, 0);
  });

  test('a request the database cannot answer fails the job rather than degrading the announcement', async () => {
    // Before this branch, a failed approval_requests read silently produced
    // an unauthored, priceless, PDF-less announcement — and the job
    // SUCCEEDED, so nothing ever retried it back to the full form.
    plantQuotation();
    requestReadError = { message: 'connection reset' };
    const result = await handleApprovalRequested(admin as never, job(EVENT) as never);
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.permanent, false);
  });
});
