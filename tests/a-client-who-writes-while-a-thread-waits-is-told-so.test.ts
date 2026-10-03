import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { handoverAcknowledgementFor, handoverAcknowledgementRef } from '../src/modules/crm/handover-acknowledgement.ts';
import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Owner decision 2026-10-03: a client who writes while their thread waits for a
// person is told so ONCE per pause, and staff are alerted every time. Found
// live: the first version sent the acknowledgement three times when three
// messages arrived together — each job saw "recorded, not yet delivered".

let language: 'en' | 'hinglish' | 'hindi' = 'hinglish';
const delivered: unknown[] = [];
mock.module('../src/modules/crm/deliver-text.ts', {
  namedExports: {
    deliverQueuedText: async (_db: unknown, args: unknown) => {
      delivered.push(args);
      return { ok: true, data: { messageId: 'm', seq: 1, delivered: true } };
    },
  },
});
mock.module('../src/modules/sales/quotation-language.ts', {
  namedExports: { quotationLanguageForLead: async () => language, quotationLanguageForConversation: async () => language, translateStandardsOn: () => false, documentLanguageFrom: () => language, writesInDevanagari: () => false },
});

const { handleClientWaiting } = await import('../src/modules/crm/handlers.ts');

const PAUSED_AT = '2026-10-03T10:00:00.000Z';
const CONV = '11111111-1111-4111-8111-111111111111';
let conversation: Record<string, unknown> | null;
let sendAnswer: Record<string, unknown>;
let messageCreatedAt: string;
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

function fakeAdmin() {
  return {
    schema: (schema: string) => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'is']) chain[m] = () => chain;
        chain.maybeSingle = async () =>
          table === 'conversations'
            ? { data: conversation, error: null }
            : { data: { created_at: messageCreatedAt }, error: null };
        return chain;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn: `${schema}.${fn}`, args });
        return fn === 'send_outbound_message' ? { data: [sendAnswer], error: null } : { data: null, error: null };
      },
    }),
  };
}
const job = () => ({
  id: 'j', organization_id: 'org', kind: 'handover.acknowledge',
  payload: { event: { conversation_id: CONV, seq: 4, pausedAt: PAUSED_AT } },
}) as never;
const run = () => handleClientWaiting(fakeAdmin() as never, job());
const alerts = () => rpcCalls.filter((c) => c.fn === 'core.raise_alert');

beforeEach(() => {
  delivered.length = 0;
  rpcCalls.length = 0;
  language = 'hinglish';
  conversation = { id: CONV, lead_id: 'lead', agent_paused_at: PAUSED_AT, contacts: { full_name: 'Ravi' } };
  sendAnswer = { outcome: 'created', message_id: 'msg', seq: 9, to_phone: '+919800000000', from_phone_number_id: 'pn', recipient_type: 'individual', delivery: 'pending' };
  messageCreatedAt = new Date().toISOString();
});

describe('A. the first message of a pause', () => {
  test('is acknowledged in the client\'s own language and staff are alerted', async () => {
    const r = await run();
    assert.equal(r.status === 'succeeded' && r.outcome, 'acknowledged');
    assert.equal(delivered.length, 1);
    const send = rpcCalls.find((c) => c.fn === 'crm.send_outbound_message')!;
    assert.equal(send.args.p_body, handoverAcknowledgementFor('hinglish'));
    assert.equal(send.args.p_external_ref, handoverAcknowledgementRef(CONV, PAUSED_AT));
    assert.equal(alerts().length, 1);
    assert.match(String(alerts()[0]!.args.p_summary), /Ravi wrote again/);
    assert.equal(alerts()[0]!.args.p_fingerprint, `client-waiting:${CONV}`);
  });

  test('the language and script are the client\'s: Devanagari for a Devanagari writer, English for English', async () => {
    language = 'hindi';
    await run();
    assert.match(String(rpcCalls.find((c) => c.fn === 'crm.send_outbound_message')!.args.p_body), /[ऀ-ॿ]/);
    rpcCalls.length = 0;
    language = 'en';
    await run();
    assert.equal(rpcCalls.find((c) => c.fn === 'crm.send_outbound_message')!.args.p_body, handoverAcknowledgementFor('en'));
  });

  test('the acknowledgement promises no time and no answer', () => {
    for (const l of ['en', 'hinglish', 'hindi'] as const) {
      assert.ok(!/\d/.test(handoverAcknowledgementFor(l)), `${l} contains a number`);
    }
  });
});

describe('B. every later message of the same pause', () => {
  test('already acknowledged and delivered: staff are alerted again, the client is not messaged again', async () => {
    sendAnswer = { ...sendAnswer, outcome: 'already_sent', delivery: 'sent' };
    const r = await run();
    assert.equal(r.status === 'succeeded' && r.outcome, 'already_acknowledged');
    assert.equal(delivered.length, 0);
    assert.equal(alerts().length, 1);
  });

  test('REGRESSION: recorded a moment ago by another job and still pending — this job does NOT deliver it too', async () => {
    sendAnswer = { ...sendAnswer, outcome: 'already_sent', delivery: 'pending' };
    const r = await run();
    assert.equal(r.status === 'succeeded' && r.outcome, 'in_flight');
    assert.equal(delivered.length, 0, 'a second job delivered the same acknowledgement');
  });

  test('...but a row that has sat pending for minutes belonged to a job that died, and is delivered', async () => {
    sendAnswer = { ...sendAnswer, outcome: 'already_sent', delivery: 'pending' };
    messageCreatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const r = await run();
    assert.equal(r.status === 'succeeded' && r.outcome, 'acknowledged');
    assert.equal(delivered.length, 1);
  });

  test('a pause that began later (after a person resumed the thread) is a new acknowledgement', () => {
    assert.notEqual(handoverAcknowledgementRef(CONV, PAUSED_AT), handoverAcknowledgementRef(CONV, '2026-10-04T10:00:00.000Z'));
  });
});

describe('C. what it refuses to do', () => {
  test('a thread a person has already resumed needs no acknowledgement and no alert', async () => {
    conversation = { ...conversation!, agent_paused_at: null };
    const r = await run();
    assert.equal(r.status === 'succeeded' && r.outcome, 'resumed');
    assert.equal(rpcCalls.length, 0);
  });

  test('the owner\'s kill switch holds, and a withdrawn contact is not messaged (staff are still told)', async () => {
    sendAnswer = { outcome: 'outbound_paused' };
    const paused = await run();
    assert.equal(paused.status, 'failed');
    assert.equal(paused.status === 'failed' && paused.permanent, false);
    assert.equal(delivered.length, 0);
    rpcCalls.length = 0;
    sendAnswer = { outcome: 'no_consent' };
    const gone = await run();
    assert.equal(gone.status === 'succeeded' && gone.outcome, 'no_consent');
    assert.equal(delivered.length, 0);
    assert.equal(alerts().length, 1);
  });

  test('a malformed event is refused permanently, not retried', async () => {
    const bad = await handleClientWaiting(fakeAdmin() as never, { id: 'j', organization_id: 'org', kind: 'x', payload: { event: { nope: 1 } } } as never);
    assert.equal(bad.status, 'failed');
    assert.equal(bad.status === 'failed' && bad.permanent, true);
  });
});

describe('D. the wiring', () => {
  test('the event reaches the handler, and the thread stays silent for the AGENT', () => {
    assert.deepEqual(SUBSCRIPTIONS['conversation.client_waiting'], ['crm:acknowledgeHandover']);
    assert.equal(HANDLER_JOB_KIND['crm:acknowledgeHandover'], 'handover.acknowledge');
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /CLIENT_WAITING_JOB_KIND,\s*handleClientWaiting,/);
    const m = read('supabase/migrations/20261010200000_a_client_who_writes_while_a_thread_waits_is_told_so.sql');
    assert.match(m, /if v_paused_at is not null then[\s\S]{0,400}'conversation\.client_waiting'[\s\S]{0,300}return new;/);
    // the agent's own reply.due is still NOT emitted while paused
    const paused = m.slice(m.indexOf('if v_paused_at is not null then'), m.indexOf("perform core.emit_event(\n    new.organization_id, 'reply.due'"));
    assert.ok(!paused.includes("'reply.due'"));
    // and the org switch is read before either
    assert.ok(m.indexOf('o.agent_answers_clients') < m.indexOf('if v_paused_at is not null then'));
  });
});
