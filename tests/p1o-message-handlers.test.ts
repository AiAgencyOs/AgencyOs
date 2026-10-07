// The two message readers that hand work to a person (subscribers to message.received), proven end to end against a stand-in database and a STUB MODEL:
// they re-read the message for the job's organisation, flag or classify through the p1o_ doors, never accept anything, and fail loudly when a read fails.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reviewQuoteReplyMessage, routeSchedulingMessage } from '../src/modules/crm/p1o-message-handlers.ts';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const MSG = '00000000-0000-4000-8000-0000000000b1';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const LEAD = '00000000-0000-4000-8000-0000000000d1';
const OPP = '00000000-0000-4000-8000-0000000000e1';
const job = { id: 'j1', organization_id: ORG, payload: { subjectId: MSG }, correlation_id: null };

type Rows = Record<string, Array<Record<string, unknown>> | { error: string }>;
function fake(rows: Rows, rpcAnswers: Record<string, unknown> = {}) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rpcs: Array<{ schema: string; fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    schema: (schema: string) => ({
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const result = () => {
          reads.push({ table: `${schema}.${table}`, filters: { ...filters } });
          const r = rows[`${schema}.${table}`] ?? [];
          return Array.isArray(r) ? { data: r, error: null } : { data: null, error: { message: r.error } };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => ((filters[c] = v), q),
          in: (c: string, v: unknown) => ((filters[c] = v), q),
          not: () => q,
          order: () => q,
          maybeSingle: () => Promise.resolve((() => { const r = result(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }; })()),
          then: (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res),
        };
        return q;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        rpcs.push({ schema, fn, args });
        const a = rpcAnswers[fn];
        return Promise.resolve(a && typeof a === 'object' && 'error' in (a as object) ? { data: null, error: a } : { data: a ?? [{ outcome: 'ok' }], error: null });
      },
    }),
  };
  return { admin: admin as never, reads, rpcs };
}

const baseRows = (body: string): Rows => ({
  'crm.conversation_messages': [{ id: MSG, body, conversation_id: CONV, language: 'en', author_type: 'client' }],
  'crm.conversations': [{ lead_id: LEAD }],
});

describe('routeSchedulingMessage', () => {
  test('a reschedule message flags the one live meeting, through the door, for a person', async () => {
    const f = fake({ ...baseRows('Can we reschedule to Thursday?'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: '2026-12-02T05:00:00Z' }] }, { p1o_flag_meeting: [{ outcome: 'flagged' }] });
    const r = await routeSchedulingMessage(f.admin, job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'flagged');
    assert.equal(f.rpcs.length, 1);
    assert.equal(f.rpcs[0]?.fn, 'p1o_flag_meeting');
    assert.equal(f.rpcs[0]?.args.p_kind, 'reschedule_request');
    assert.equal(f.rpcs[0]?.args.p_meeting_id, 'm1');
  });

  test("every read is scoped to the job's own organisation", async () => {
    const f = fake({ ...baseRows('cancel it'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: null }] });
    await routeSchedulingMessage(f.admin, job);
    assert.ok(f.reads.length >= 3);
    assert.ok(f.reads.every((x) => x.filters.organization_id === ORG), JSON.stringify(f.reads));
  });

  test('two live meetings and a cancel: an ambiguity flag naming both', async () => {
    const f = fake({ ...baseRows('please cancel'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: '2026-12-02T05:00:00Z' }, { id: 'm2', status: 'proposed', confirmed_start_at: null }] });
    const r = await routeSchedulingMessage(f.admin, job);
    assert.ok(r.status === 'succeeded');
    assert.equal(f.rpcs[0]?.args.p_kind, 'ambiguous_cancel');
    assert.deepEqual((f.rpcs[0]?.args.p_candidate_meeting_ids as string[]).sort(), ['m1', 'm2']);
  });

  test('a message that is not about scheduling, or an agency message, flags nothing', async () => {
    const quiet = fake({ ...baseRows('thanks!'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: null }] });
    const a = await routeSchedulingMessage(quiet.admin, job);
    assert.ok(a.status === 'succeeded' && a.outcome === 'not_mine');
    assert.equal(quiet.rpcs.length, 0);
    const agency = fake({ 'crm.conversation_messages': [{ id: MSG, body: 'reschedule', conversation_id: CONV, language: 'en', author_type: 'agent' }] });
    const b = await routeSchedulingMessage(agency.admin, job);
    assert.ok(b.status === 'succeeded' && b.outcome === 'not_mine');
  });

  test('a failed read is a retryable failure, a failed flag too, a missing id is permanent', async () => {
    const readFail = await routeSchedulingMessage(fake({ 'crm.conversation_messages': { error: 'down' } }).admin, job);
    assert.ok(readFail.status === 'failed' && !readFail.permanent);
    const meetingsFail = await routeSchedulingMessage(fake({ ...baseRows('reschedule'), 'crm.meetings': { error: 'down' } }).admin, job);
    assert.ok(meetingsFail.status === 'failed' && !meetingsFail.permanent);
    const flagFail = await routeSchedulingMessage(fake({ ...baseRows('reschedule'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: null }] }, { p1o_flag_meeting: { message: 'boom', error: true } }).admin, job);
    assert.ok(flagFail.status === 'failed' && !flagFail.permanent);
    const malformed = await routeSchedulingMessage(fake({}).admin, { ...job, payload: { subjectId: 'nope' } });
    assert.ok(malformed.status === 'failed' && malformed.permanent);
  });

  test('a STUB MODEL replaces the keywords through the same port', async () => {
    const f = fake({ ...baseRows('hmm, anything else around then?'), 'crm.meetings': [{ id: 'm1', status: 'booked', confirmed_start_at: null }] });
    const r = await routeSchedulingMessage(f.admin, job, { classify: async () => ({ intent: 'availability_question', source: 'model' }) });
    assert.ok(r.status === 'succeeded' && r.outcome === 'flagged');
    assert.equal(f.rpcs[0]?.args.p_kind, 'availability_question');
  });
});

describe('reviewQuoteReplyMessage', () => {
  const dealRows = (body: string, versions: number[]): Rows => ({
    ...baseRows(body),
    'sales.opportunities': [{ id: OPP }],
    'sales.proposals': versions.map((v) => ({ id: `p${v}`, version: v })),
  });

  test('an objection is recorded with its class against the latest sent version', async () => {
    const f = fake(dealRows('This is too expensive for us', [2]), { p1o_record_quote_response: [{ outcome: 'recorded' }] });
    const r = await reviewQuoteReplyMessage(f.admin, job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'classified');
    assert.equal(f.rpcs[0]?.fn, 'p1o_record_quote_response');
    assert.equal(f.rpcs[0]?.args.p_class, 'price_objection');
    assert.equal(f.rpcs[0]?.args.p_proposal_id, 'p2');
  });

  test('a bare okay with two versions open: recorded as ambiguous and a clarification is raised for a person; nothing is accepted', async () => {
    const f = fake(dealRows('okay', [1, 2]));
    const r = await reviewQuoteReplyMessage(f.admin, job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'clarification_raised');
    assert.deepEqual(f.rpcs.map((x) => x.fn), ['p1o_record_quote_response', 'p1o_raise_acceptance_clarification']);
    assert.equal(f.rpcs[0]?.args.p_class, 'ambiguous');
    assert.ok(!f.rpcs.some((x) => /accept/.test(x.fn) && x.fn !== 'p1o_raise_acceptance_clarification'));
  });

  test('an explicit yes is handed to a person: no door is called at all', async () => {
    const f = fake(dealRows('yes, version 2 please', [1, 2]));
    const r = await reviewQuoteReplyMessage(f.admin, job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'acceptance_for_a_person');
    assert.equal(f.rpcs.length, 0);
  });

  test("no open quotation or no open deal means it is not this reader's message", async () => {
    const none = await reviewQuoteReplyMessage(fake(dealRows('okay', [])).admin, job);
    assert.ok(none.status === 'succeeded' && none.outcome === 'not_mine');
    const noDeal = await reviewQuoteReplyMessage(fake({ ...baseRows('okay'), 'sales.opportunities': [] }).admin, job);
    assert.ok(noDeal.status === 'succeeded' && noDeal.outcome === 'not_mine');
  });

  test('a failed door is a retryable failure, never a quiet success', async () => {
    const f = fake(dealRows('too expensive', [1]), { p1o_record_quote_response: { message: 'down', error: true } });
    const r = await reviewQuoteReplyMessage(f.admin, job);
    assert.ok(r.status === 'failed' && !r.permanent);
  });
});
