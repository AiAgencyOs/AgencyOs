import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Phase 8A gaps log 1 actions: ONE staff action and ONE client action over whitelists of database doors, run against a stand-in database that records every call.
 * What is proved: what is refused BEFORE the database is asked, what is forwarded (and as which door), and that a door answer other than the success word is an
 * ERROR and never reported as done. The doors themselves are proved in Postgres by scripts/verify-phase-eight-a-gaps-1.sql.
 */

const CLIENT = '11111111-1111-4111-8111-111111111111';
const ARTICLE = '22222222-2222-4222-8222-222222222222';
const TICKET = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

type Call = { rpc: string; args: Record<string, unknown> };
let calls: Call[] = [];
let revalidated: string[] = [];
let role = 'owner';
let answers: Record<string, { data: unknown; error: { message: string } | null }> = {};

mock.module('next/cache', { exports: { revalidatePath: (p: string) => void revalidated.push(p) } });
mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1', roles: [] }),
    requireClient: async () => ({ role: 'client_member', userId: 'c1', organizationId: 'o1', roles: [] }),
  },
});
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: () => ({
        rpc: async (rpc: string, args: Record<string, unknown>) => {
          calls.push({ rpc, args });
          return answers[rpc] ?? { data: [{ outcome: 'no answer' }], error: null };
        },
      }),
    }),
  },
});

const { phaseEightG1Action, phaseEightG1PortalAction } = await import('../src/modules/projects/phase-eight-g1-actions.ts');

const form = (entries: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  return fd;
};
const run = (entries: Record<string, string | string[]>) => phaseEightG1Action({ status: 'idle' }, form(entries));
const portal = (entries: Record<string, string | string[]>) => phaseEightG1PortalAction({ status: 'idle' }, form(entries));
const ok = (outcome: string, rpc: string) => { answers[rpc] = { data: [{ outcome }], error: null }; };

beforeEach(() => {
  calls = [];
  revalidated = [];
  role = 'owner';
  answers = {};
});

describe('what is refused before the database is asked', () => {
  test('an unknown door is refused, and so is a role without write permission', async () => {
    assert.deepEqual(await run({ door: 'send_message' }), { status: 'error', message: 'Unknown action.' });
    assert.deepEqual(await run({ door: 'constructor' }), { status: 'error', message: 'Unknown action.' });
    role = 'member';
    assert.match((await run({ door: 'feedback_ack', clientId: CLIENT, feedbackId: ARTICLE, note: 'I phoned them' })).message ?? '', /do not have permission/);
    assert.equal(calls.length, 0);
  });
  test('feedback: a goal with a score, feedback with no sentiment, a short body and a bad id are all refused', async () => {
    const base = { door: 'feedback_record', clientId: CLIENT, source: 'call', body: 'The client said the reports are slow' };
    assert.match((await run({ ...base, kind: 'goal', sentiment: 'negative' })).message ?? '', /goal is a wish/);
    assert.match((await run({ ...base, kind: 'feedback' })).message ?? '', /sentiment|how it felt/i);
    assert.match((await run({ ...base, kind: 'feedback', sentiment: 'negative', body: 'short' })).message ?? '', /at least 10/);
    assert.match((await run({ ...base, clientId: 'nope', kind: 'feedback', sentiment: 'negative' })).message ?? '', /not valid/);
    assert.match((await run({ ...base, kind: 'feedback', sentiment: 'negative', source: 'client_portal' })).message ?? '', /where this came from/);
    assert.match((await run({ ...base, kind: 'feedback', sentiment: 'negative', rating: '6' })).message ?? '', /1 to 5/);
    assert.equal(calls.length, 0);
  });
  test('a scope reference must name its item, or none for outside scope; a settle needs a note to complete', async () => {
    assert.match((await run({ door: 'scope_record', ticketId: TICKET, relation: 'inside_scope', note: 'The checkout is inside the scope' })).message ?? '', /must name the scope item/);
    assert.match((await run({ door: 'scope_record', ticketId: TICKET, relation: 'outside_scope', scopeItemId: ITEM, note: 'Nothing covers this request' })).message ?? '', /names no scope item/);
    assert.match((await run({ door: 'handoff_settle', requestId: ARTICLE, decision: 'completed' })).message ?? '', /needs a note/);
    assert.equal(calls.length, 0);
  });
  test('a cadence needs a whole number of days from 1 to 365; preferences cannot prefer and avoid one channel; a key is a slug', async () => {
    assert.match((await run({ door: 'cadence_set', purpose: 'relationship', channel: 'all', minGapDays: '0' })).message ?? '', /1 to 365/);
    assert.match((await run({ door: 'cadence_set', purpose: 'relationship', channel: 'all', minGapDays: '400' })).message ?? '', /1 to 365/);
    assert.match((await run({ door: 'preferences_set', clientId: CLIENT, preferredChannel: 'email', avoidChannels: ['email'] })).message ?? '', /both preferred and avoided/);
    assert.match((await run({ door: 'knowledge_propose', key: 'Bad Key!', title: 'Exporting', body: 'Open Settings and press Export to download it.' })).message ?? '', /lower-case/);
    assert.equal(calls.length, 0);
  });
});

describe('what is forwarded', () => {
  test('feedback is forwarded to its door with the form mapped to the door arguments, and the client page is revalidated', async () => {
    ok('recorded', 'record_client_feedback');
    const r = await run({ door: 'feedback_record', clientId: CLIENT, kind: 'feedback', source: 'call', sentiment: 'negative', rating: '2', body: 'The client said the reports are slow' });
    assert.equal(r.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.rpc, 'record_client_feedback');
    assert.deepEqual(calls[0]!.args, {
      p_client_account_id: CLIENT, p_kind: 'feedback', p_source: 'call', p_sentiment: 'negative', p_rating: 2, p_body: 'The client said the reports are slow', p_project_id: null, p_occurred_on: null,
    });
    assert.ok(revalidated.includes(`/clients/${CLIENT}/customer-360`));
  });
  test('"all" channels is sent to the database as a null channel', async () => {
    ok('set', 'set_communication_cadence_rule');
    await run({ door: 'cadence_set', purpose: 'relationship', channel: 'all', minGapDays: '7' });
    assert.deepEqual(calls[0]!.args, { p_purpose: 'relationship', p_channel: null, p_min_gap_days: 7 });
  });
  test('knowledge: propose, approve and retire go to their own doors', async () => {
    ok('proposed', 'propose_knowledge_article');
    ok('approved', 'approve_knowledge_article');
    ok('retired', 'retire_knowledge_article');
    assert.equal((await run({ door: 'knowledge_propose', key: 'export-data', title: 'Exporting your data', body: 'Open Settings and press Export to download it.', clientSafe: 'true' })).status, 'success');
    assert.equal(calls[0]!.args.p_client_safe, true);
    assert.equal((await run({ door: 'knowledge_approve', articleId: ARTICLE })).status, 'success');
    assert.equal((await run({ door: 'knowledge_retire', articleId: ARTICLE, reason: 'Replaced by a better guide' })).status, 'success');
    assert.deepEqual(calls.map((c) => c.rpc), ['propose_knowledge_article', 'approve_knowledge_article', 'retire_knowledge_article']);
  });
  test('the staff action can reach NO agent door and no door outside its whitelist', async () => {
    ok('drafted', 'record_discovery_brief_draft');
    for (const door of ['record_discovery_brief_draft', 'propose_knowledge_article_as_agent', 'request_ticket_handoff_as_agent', 'guard_phase_eight_project']) {
      assert.equal((await run({ door })).message, 'Unknown action.');
    }
    assert.equal(calls.length, 0);
  });
});

describe('what a door answer means', () => {
  test('a refusal is an ERROR in the door\'s own words, never "done"', async () => {
    ok('author_cannot_approve', 'approve_knowledge_article');
    const r = await run({ door: 'knowledge_approve', articleId: ARTICLE });
    assert.equal(r.status, 'error');
    assert.match(r.message ?? '', /author cannot approve/i);
    ok('not_authorized', 'set_client_designation');
    const d = await run({ door: 'designation_set', clientId: CLIENT, designation: 'vip', criteria: 'Top five by revenue', reason: 'Decided at the review' });
    assert.equal(d.status, 'error');
    assert.match(d.message ?? '', /permission/);
    assert.equal(revalidated.length, 0, 'nothing is revalidated for a refusal');
  });
  test('an unknown outcome and a database error are both errors', async () => {
    assert.equal((await run({ door: 'scope_confirm', referenceId: ARTICLE })).status, 'error');
    answers.confirm_ticket_scope_reference = { data: null, error: { message: 'boom' } };
    const r = await run({ door: 'scope_confirm', referenceId: ARTICLE });
    assert.equal(r.status, 'error');
    assert.match(r.message ?? '', /did not answer/);
  });
  test('a hand-off settles with any of its three words, and only those', async () => {
    ok('acknowledged', 'settle_ticket_handoff');
    assert.equal((await run({ door: 'handoff_settle', requestId: ARTICLE, decision: 'acknowledged' })).status, 'success');
    ok('requested', 'settle_ticket_handoff');
    assert.equal((await run({ door: 'handoff_settle', requestId: ARTICLE, decision: 'acknowledged' })).status, 'error');
  });
});

describe('the client action', () => {
  test('a client submits feedback through its own door only; a staff door name is unknown to it', async () => {
    ok('submitted', 'submit_client_feedback');
    const r = await portal({ door: 'feedback_submit', projectId: ARTICLE, kind: 'feedback', sentiment: 'negative', body: 'Nobody answered my email for three days' });
    assert.equal(r.status, 'success');
    assert.equal(calls[0]!.rpc, 'submit_client_feedback');
    assert.deepEqual(calls[0]!.args, { p_kind: 'feedback', p_sentiment: 'negative', p_rating: null, p_body: 'Nobody answered my email for three days', p_project_id: ARTICLE });
    assert.ok(revalidated.includes(`/portal/${ARTICLE}/feedback`));
    assert.equal((await portal({ door: 'feedback_record', clientId: CLIENT })).message, 'Unknown action.');
    assert.equal((await portal({ door: 'designation_set' })).message, 'Unknown action.');
    assert.equal(calls.length, 1);
  });
  test('a client\'s preferences go to its own door and carry no client id of the client\'s choosing', async () => {
    ok('set', 'set_my_contact_preferences');
    const r = await portal({ door: 'preferences_set', projectId: ARTICLE, preferredChannel: 'portal', language: 'en', avoidChannels: ['call'] });
    assert.equal(r.status, 'success');
    assert.deepEqual(calls[0]!.args, { p_preferred_channel: 'portal', p_language: 'en', p_avoid_channels: ['call'], p_note: null });
  });
});
