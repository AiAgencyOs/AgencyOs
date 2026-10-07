import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 8D Admin action: ONE server action over a whitelist of database doors. Run against a stand-in database that records every call: what the action
 * refuses before the database is asked, what it forwards, how it words a refusal, and that the value-report build hands the database the digest of the
 * facts it rendered. The doors themselves are proved in Postgres by scripts/verify-phase-eight-d.sql.
 */

const CLIENT = '11111111-1111-4111-8111-111111111111';
const LEDGER = '22222222-2222-4222-8222-222222222222';
const REPORT = '33333333-3333-4333-8333-333333333333';

type Call = { schema: string; rpc: string; args: Record<string, unknown> };
let calls: Call[] = [];
let revalidated: string[] = [];
let role = 'owner';
/** rpc name -> scripted answer */
let answers: Record<string, { data: unknown; error: { message: string } | null }> = {};

mock.module('next/cache', { exports: { revalidatePath: (p: string) => void revalidated.push(p) } });
mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1', roles: [] }) } });
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: (schema: string) => ({
        rpc: async (rpc: string, args: Record<string, unknown>) => {
          calls.push({ schema, rpc, args });
          return answers[rpc] ?? { data: [{ outcome: 'no answer' }], error: null };
        },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Acme Ltd' }, error: null }) }) }) }),
      }),
    }),
  },
});

const { phaseEightDDoorAction } = await import('../src/modules/projects/phase-eight-d-actions.ts');

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};
const run = (entries: Record<string, string>) => phaseEightDDoorAction({ status: 'idle' }, form({ clientId: CLIENT, ...entries }));

beforeEach(() => {
  calls = [];
  revalidated = [];
  role = 'owner';
  answers = {};
});

const FACT = { type: 'ticket_resolved', label: 'TKT-AAAA1111 Export button', value: 1, unit: 'ticket', on: '2026-10-02', projectId: null, evidence: null, sources: [{ table: 'projects.support_tickets', id: '44444444-4444-4444-8444-444444444444' }] };

describe('what the action refuses before the database is asked', () => {
  test('an unknown door, a malformed client id and a role without write permission are all refused with no database call', async () => {
    assert.deepEqual(await run({ door: 'send_message' }), { status: 'error', message: 'Unknown action.' });
    assert.equal((await phaseEightDDoorAction({ status: 'idle' }, form({ door: 'set_cap', clientId: 'not-a-uuid' }))).message, 'That record was not found.');
    role = 'member';
    assert.match((await run({ door: 'set_cap', channel: 'all', maxContacts: '2', windowDays: '30' })).message ?? '', /do not have permission/);
    assert.equal(calls.length, 0);
  });

  test('a cap needs whole numbers inside the allowed range, and a quiet period needs two real times', async () => {
    assert.equal((await run({ door: 'set_cap', channel: 'all', maxContacts: '0', windowDays: '30' })).message, 'That number is outside the allowed range.');
    assert.equal((await run({ door: 'set_cap', channel: 'all', maxContacts: '2', windowDays: '366' })).message, 'That number is outside the allowed range.');
    assert.equal((await run({ door: 'set_cap', channel: 'all', maxContacts: 'two', windowDays: '30' })).message, 'That number is outside the allowed range.');
    assert.equal((await run({ door: 'add_quiet', startsAt: 'tomorrow', endsAt: '2026-10-09T10:00', reason: 'the client asked' })).message, 'The end must come after the start.');
    assert.equal((await run({ door: 'record_contact', channel: 'call', purpose: 'relationship', summary: 'Called the owner', occurredAt: 'yesterday' })).message, 'The time is not valid.');
    assert.equal((await run({ door: 'record_contact', channel: 'call', purpose: 'relationship', summary: 'Called the owner', projectId: 'nope' })).message, 'A selected record is not valid.');
    assert.equal(calls.length, 0, 'none of those reached the database');
  });
});

describe('what the action forwards', () => {
  test('a cap on every channel sends a null channel; a quiet period is read as UTC', async () => {
    answers.set_client_communication_cap = { data: [{ outcome: 'set' }], error: null };
    answers.add_client_quiet_period = { data: [{ outcome: 'added', quiet_period_id: LEDGER }], error: null };
    assert.equal((await run({ door: 'set_cap', channel: 'all', maxContacts: '2', windowDays: '30' })).status, 'success');
    assert.deepEqual(calls[0], { schema: 'projects', rpc: 'set_client_communication_cap', args: { p_client_account_id: CLIENT, p_channel: null, p_max_contacts: 2, p_window_days: 30 } });
    assert.equal((await run({ door: 'add_quiet', startsAt: '2026-10-08T09:00', endsAt: '2026-10-09T09:00', reason: 'the client asked for quiet' })).status, 'success');
    assert.deepEqual(calls[1]!.args, { p_client_account_id: CLIENT, p_starts_at: '2026-10-08T09:00:00Z', p_ends_at: '2026-10-09T09:00:00Z', p_reason: 'the client asked for quiet' });
    assert.deepEqual(revalidated, [`/clients/${CLIENT}/customer-360`, `/clients/${CLIENT}/customer-360`]);
  });

  test('recording a contact passes what the person said and links no platform message: the action cannot claim a send it did not see', async () => {
    answers.record_client_communication = { data: [{ outcome: 'recorded', ledger_id: LEDGER }], error: null };
    const result = await run({ door: 'record_contact', channel: 'whatsapp', purpose: 'relationship', summary: 'Sent a check-in to the owner', contactId: '', externalRef: 'wa-1' });
    assert.equal(result.status, 'success');
    assert.match(result.message ?? '', /Nothing was sent by this/);
    assert.deepEqual(calls[0]!.args, {
      p_client_account_id: CLIENT, p_channel: 'whatsapp', p_purpose: 'relationship', p_summary: 'Sent a check-in to the owner', p_project_id: null, p_contact_id: null, p_occurred_at: null, p_message_id: null, p_external_ref: 'wa-1',
    });
  });

  test('a duplicate provider reference is reported as already recorded, not as a failure', async () => {
    answers.record_client_communication = { data: [{ outcome: 'duplicate', ledger_id: LEDGER }], error: null };
    const result = await run({ door: 'record_contact', channel: 'whatsapp', purpose: 'relationship', summary: 'Sent a check-in to the owner', externalRef: 'wa-1' });
    assert.equal(result.status, 'success');
    assert.match(result.message ?? '', /already recorded/);
  });
});

describe('how the database answer is worded', () => {
  test('a refusal is shown as the database gave it, in plain words, and revalidates nothing', async () => {
    answers.set_client_communication_cap = { data: [{ outcome: 'not_authorized' }], error: null };
    assert.deepEqual(await run({ door: 'set_cap', channel: 'call', maxContacts: '2', windowDays: '30' }), { status: 'error', message: 'You do not have permission to do this.' });
    answers.cancel_client_quiet_period = { data: [{ outcome: 'something_new' }], error: null };
    assert.deepEqual(await run({ door: 'cancel_quiet', quietPeriodId: LEDGER, reason: 'finished early' }), { status: 'error', message: 'Refused: something new.' });
    assert.equal(revalidated.length, 0);
  });

  test('a database that does not answer is never reported as recorded', async () => {
    answers.approve_value_report_draft = { data: null, error: { message: 'connection refused' } };
    assert.deepEqual(await run({ door: 'report_approve', reportId: REPORT }), { status: 'error', message: 'The database did not answer; nothing was recorded.' });
    assert.equal(revalidated.length, 0);
  });

  test('approving says nothing was sent', async () => {
    answers.approve_value_report_draft = { data: [{ outcome: 'approved' }], error: null };
    const result = await run({ door: 'report_approve', reportId: REPORT });
    assert.equal(result.status, 'success');
    assert.match(result.message ?? '', /Nothing was sent/);
  });
});

describe('building a value report draft', () => {
  test('the facts come from the database, the words from the versioned template, and the database gets the digest of the facts that were rendered', async () => {
    answers.value_report_facts = { data: [{ facts: [FACT], digest: 'a'.repeat(32) }], error: null };
    answers.store_value_report_draft = { data: [{ outcome: 'drafted', report_id: REPORT }], error: null };
    const result = await run({ door: 'report_store', periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    assert.equal(result.status, 'success');
    assert.deepEqual(calls.map((c) => c.rpc), ['value_report_facts', 'store_value_report_draft']);
    const store = calls[1]!.args;
    assert.equal(store.p_facts_digest, 'a'.repeat(32));
    assert.equal(store.p_template_version, 1);
    assert.equal(store.p_client_account_id, CLIENT);
    assert.match(String(store.p_body), /Report for Acme Ltd, covering 2026-10-01 to 2026-10-07\./);
    assert.match(String(store.p_body), /1 support ticket was resolved: TKT-AAAA1111 Export button\./);
    assert.match(String(store.p_body), /projects\.support_tickets 44444444-4444-4444-8444-444444444444/);
  });

  test('an empty period is refused here: nothing to report, and nothing is stored', async () => {
    answers.value_report_facts = { data: [{ facts: [], digest: 'b'.repeat(32) }], error: null };
    const result = await run({ door: 'report_store', periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    assert.equal(result.status, 'error');
    assert.match(result.message ?? '', /nothing to report/);
    assert.deepEqual(calls.map((c) => c.rpc), ['value_report_facts']);
  });

  test('a bad period is refused before any read; a stale-facts refusal from the database is worded', async () => {
    assert.match((await run({ door: 'report_store', periodStart: '2026-10-08', periodEnd: '2026-10-01' })).message ?? '', /period of at most 400 days/);
    assert.match((await run({ door: 'report_store', periodStart: 'soon', periodEnd: '2026-10-01' })).message ?? '', /period of at most 400 days/);
    assert.equal(calls.length, 0);
    answers.value_report_facts = { data: [{ facts: [FACT], digest: 'c'.repeat(32) }], error: null };
    answers.store_value_report_draft = { data: [{ outcome: 'facts_changed' }], error: null };
    const result = await run({ door: 'report_store', periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    assert.equal(result.status, 'error');
    assert.match(result.message ?? '', /facts changed while the draft was being written/);
  });

  test('a fact the database returned without a source is refused rather than reported', async () => {
    answers.value_report_facts = { data: [{ facts: [{ ...FACT, sources: [] }], digest: 'd'.repeat(32) }], error: null };
    await assert.rejects(() => run({ door: 'report_store', periodStart: '2026-10-01', periodEnd: '2026-10-07' }), /cites no source row/);
    assert.deepEqual(calls.map((c) => c.rpc), ['value_report_facts']);
  });
});

describe('the whitelist holds no way to send', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/modules/projects/phase-eight-d-actions.ts', import.meta.url)), 'utf8');
  test('the doors are exactly these, all in the projects schema, and none sends, quotes or approves on a client\'s behalf', () => {
    const rpcs = [...source.matchAll(/rpc: '([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(rpcs, [
      'add_client_quiet_period', 'approve_value_report_draft', 'cancel_client_quiet_period', 'clear_client_communication_cap', 'discard_value_report_draft', 'edit_value_report_draft',
      'record_client_communication', 'record_client_communication_event', 'set_client_communication_cap',
    ]);
    assert.ok(!/\.schema\('(?!projects')/.test(source), 'only the projects schema is reached');
    assert.ok(!/createAdminClient|service_role|fetch\(|sendClientMessage|record_agent_communication_draft|store_value_report_draft_as_agent/.test(source), 'no service-role door, no network, no agent door');
  });
  test('a "use server" file exports only async functions', () => {
    const exports = [...source.matchAll(/^export (.+)$/gm)].map((m) => m[1]!);
    assert.deepEqual(exports.map((e) => e.startsWith('async function')), exports.map(() => true));
    assert.equal(exports.length, 1);
  });
});
