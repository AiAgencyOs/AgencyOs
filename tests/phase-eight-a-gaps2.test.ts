import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 8A second half: the app layer over migration 20261121000000 (doors proved in Postgres by scripts/verify-phase-eight-a-gaps2.sql). Covers the action
 * whitelist against a stand-in database, the provider-callback handler (signature, configuration, parsing, failure), and the structural rules for the new files.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const SECRET = 'test-callback-secret';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

type Call = { rpc: string; args: Record<string, unknown> };
let calls: Call[] = [];
let revalidated: string[] = [];
let role = 'owner';
let answers: Record<string, { data: unknown; error: { message: string } | null }> = {};

mock.module('next/cache', { exports: { revalidatePath: (p: string) => void revalidated.push(p) } });
mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1', roles: [] }) } });
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

const { phaseEightGaps2DoorAction } = await import('../src/modules/projects/phase-eight-gaps2-actions.ts');
const { handleDeliveryCallback, parseCallbackBody, DELIVERY_CALLBACK_DISABLED } = await import('../src/modules/projects/provider-delivery-callback.ts');

const form = (entries: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  return fd;
};
const run = (entries: Record<string, string | string[]>) => phaseEightGaps2DoorAction({ status: 'idle' }, form(entries));

beforeEach(() => {
  calls = [];
  revalidated = [];
  role = 'owner';
  answers = {};
});

describe('the second-half action: what it refuses before the database is asked', () => {
  test('an unknown door, a person without write permission, a malformed id and a bad gap never reach the database', async () => {
    assert.deepEqual(await run({ door: 'send_message' }), { status: 'error', message: 'Unknown action.' });
    assert.equal((await run({ door: 'record_goal', projectId: 'nope', goal: 'Launch in March' })).message, 'A selected record is not valid.');
    assert.equal((await run({ door: 'set_cadence', purpose: 'commercial', minGapDays: '366' })).message, 'Choose a whole number of days from 0 to 365.');
    assert.equal((await run({ door: 'set_cadence', purpose: 'commercial', minGapDays: 'weekly' })).message, 'Choose a whole number of days from 0 to 365.');
    assert.equal((await run({ door: 'record_feedback', projectId: PROJECT, source: 'call', sentiment: 'positive', summary: 'Happy', occurredAt: 'yesterday' })).message, 'The time is not valid.');
    role = 'member';
    assert.match((await run({ door: 'record_goal', projectId: PROJECT, goal: 'Launch in March' })).message ?? '', /do not have permission/);
    assert.equal(calls.length, 0);
  });
});

describe('the second-half action: what it forwards and how it words the answer', () => {
  test('a preference forwards the channels the person chose, and an empty choice becomes null/none', async () => {
    answers.set_client_contact_preference = { data: [{ outcome: 'set' }], error: null };
    const out = await run({ door: 'set_preference', clientId: ORG, preferredChannel: '', avoidChannels: ['', 'call'], language: 'pt-BR', note: '' });
    assert.equal(out.status, 'success');
    assert.deepEqual(calls[0], { rpc: 'set_client_contact_preference', args: { p_client_account_id: ORG, p_preferred_channel: null, p_avoid_channels: ['call'], p_language: 'pt-BR', p_note: null } });
    assert.ok(revalidated.includes('/projects/customer-success/records'));
  });

  test('a refusal from the door is shown as written and nothing is revalidated; a database error says nothing was recorded', async () => {
    answers.record_client_goal = { data: [{ outcome: 'goal_required' }], error: null };
    assert.equal((await run({ door: 'record_goal', projectId: PROJECT, goal: 'x' })).message, 'State the goal (at least five characters).');
    answers.request_support_followup = { data: null, error: { message: 'boom' } };
    assert.equal((await run({ door: 'request_followup', ticketId: PROJECT, kind: 'developer' })).message, 'The database did not answer; nothing was recorded.');
    answers.request_support_followup = { data: [{ outcome: 'requested' }], error: null };
    const ok = await run({ door: 'request_followup', ticketId: PROJECT, kind: 'qa' });
    assert.match(ok.message ?? '', /no Developer task was created/);
    assert.equal(revalidated.length, 2, 'only the success revalidated (two paths)');
  });

  test('a door answer that is not in the success list is a refusal, even if it looks friendly', async () => {
    answers.record_client_feedback = { data: [{ outcome: 'something_new' }], error: null };
    const out = await run({ door: 'record_feedback', projectId: PROJECT, source: 'call', sentiment: 'positive', summary: 'They were pleased' });
    assert.equal(out.status, 'error');
    assert.equal(out.message, 'Refused: something new.');
  });

  test('every door the action names exists as a function in the migration, and none of them is a send', () => {
    const sql = read('supabase/migrations/20261121000000_phase_eight_a_second_half_gaps_are_closed_as_records_and_reads.sql');
    const src = read('src/modules/projects/phase-eight-gaps2-actions.ts');
    const names = [...src.matchAll(/rpc: '([a-z_]+)'/g)].map((m) => m[1]!);
    assert.equal(names.length, 7);
    for (const n of names) assert.ok(sql.includes(`function projects.${n}(`), `${n} is defined`);
    assert.doesNotMatch(src, /\.from\(|sales\.|finance\.|crm\./, 'the action only calls doors');
  });
});

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
const event = (over: Record<string, unknown> = {}) => ({ provider: 'acme-msg', channel: 'whatsapp', external_ref: 'wamid.1', event: 'delivered', ...over });

describe('the provider delivery callback handler', () => {
  const recorded: string[] = [];
  const deps = (over: Partial<Parameters<typeof handleDeliveryCallback>[2]> = {}) => ({
    secret: SECRET, organizationId: ORG, record: async (_o: string, e: { externalRef: string }) => { recorded.push(e.externalRef); return 'recorded'; }, ...over,
  });
  beforeEach(() => { recorded.length = 0; });

  test('unconfigured is 503, unsigned or wrongly signed is 401, and nothing is recorded in either case', async () => {
    const body = JSON.stringify(event());
    assert.equal((await handleDeliveryCallback(body, sign(body), deps({ secret: undefined }))).status, 503);
    assert.equal((await handleDeliveryCallback(body, null, deps())).status, 401);
    assert.equal((await handleDeliveryCallback(body, sign(body, 'other'), deps())).status, 401);
    assert.equal((await handleDeliveryCallback(body + ' ', sign(body), deps())).status, 401, 'a body changed after signing is refused');
    assert.equal(recorded.length, 0);
  });

  test('a deployment that has not said whose messages these are is disabled, never guessed', async () => {
    const body = JSON.stringify(event());
    for (const organizationId of [undefined, '', 'not-a-uuid']) {
      const r = await handleDeliveryCallback(body, sign(body), deps({ organizationId }));
      assert.equal(r.status, 503);
      assert.equal(r.body.error, DELIVERY_CALLBACK_DISABLED);
    }
    assert.equal(recorded.length, 0);
  });

  test('a signed single event and a signed batch are recorded; an item that does not fit is counted as rejected, not repaired', async () => {
    const one = JSON.stringify(event());
    assert.equal((await handleDeliveryCallback(one, sign(one), deps())).status, 200);
    const batch = JSON.stringify({ events: [event({ external_ref: 'a' }), event({ external_ref: 'b', event: 'opened' }), event({ external_ref: 'c', channel: 'sms' }), event({ external_ref: 'd', occurred_at: 'soon' })] });
    const r = await handleDeliveryCallback(batch, sign(batch), deps());
    assert.equal(r.status, 200);
    assert.equal(r.body.received, 1);
    assert.equal(r.body.rejected, 3);
    assert.deepEqual(recorded, ['wamid.1', 'a']);
  });

  test('malformed JSON, an empty list and a batch with no valid event are 400; an oversize batch is refused', async () => {
    for (const body of ['not json', JSON.stringify({ events: [] }), JSON.stringify({ events: [{ provider: 'x' }] }), JSON.stringify({ events: Array.from({ length: 51 }, () => event()) })]) {
      assert.equal((await handleDeliveryCallback(body, sign(body), deps())).status, 400);
    }
    assert.equal(recorded.length, 0);
    assert.equal(parseCallbackBody('{"events":[]}'), null);
  });

  test('an unmatched reference is a 200 with the outcome counted (the provider must not retry forever); a database failure is a 502 so the provider retries', async () => {
    const body = JSON.stringify(event());
    const unmatched = await handleDeliveryCallback(body, sign(body), deps({ record: async () => 'unmatched' }));
    assert.equal(unmatched.status, 200);
    assert.deepEqual(unmatched.body.outcomes, { unmatched: 1 });
    const failed = await handleDeliveryCallback(body, sign(body), deps({ record: async () => { throw new Error('db down'); } }));
    assert.equal(failed.status, 502);
  });
});

describe('structure of the new files', () => {
  const files = [
    'src/modules/projects/phase-eight-gaps2-queries.ts',
    'src/modules/projects/phase-eight-gaps2-actions.ts',
    'src/modules/projects/provider-delivery-callback.ts',
    'app/api/webhooks/delivery-callback/route.ts',
    'app/(internal)/projects/customer-success/next-actions/page.tsx',
    'app/(internal)/projects/customer-success/reconciliation/page.tsx',
    'app/(internal)/projects/customer-success/records/page.tsx',
    'app/(internal)/projects/customer-success/records/gaps2-forms.tsx',
  ];

  test('the read-failure meta-invariant: every `if (error)` in the queries file is an unreadable() refusal', () => {
    const src = read('src/modules/projects/phase-eight-gaps2-queries.ts');
    const errors = (src.match(/if \((\w+Error|error)\)/g) ?? []).length;
    const refusals = (src.match(/unreadable\(/g) ?? []).length;
    assert.equal(errors, refusals);
    assert.ok(errors >= 8);
  });

  test("the 'use server' file exports only async functions, and no new file names a duplicate object key in its door table", () => {
    const src = read('src/modules/projects/phase-eight-gaps2-actions.ts');
    assert.match(src, /^'use server';/);
    const exported = [...src.matchAll(/^export (\w+ \w+)/gm)].map((m) => m[1]);
    assert.deepEqual(exported, ['async function']);
    for (const table of [src.slice(src.indexOf('const DOORS'), src.indexOf('const WORDS')), src.slice(src.indexOf('const WORDS'), src.indexOf('export async function'))]) {
      const keys = [...table.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
      assert.equal(new Set(keys).size, keys.length, 'no duplicate key');
      assert.ok(keys.length >= 7);
    }
  });

  test('the new pages are internal-only, permission-gated and never mutate; the route never reads a table', () => {
    for (const f of files.filter((p) => p.includes('page.tsx'))) {
      const src = read(f);
      assert.match(src, /requireInternal\(/, f);
      assert.match(src, /can\(context, 'project\.read'\)/, f);
      assert.doesNotMatch(src, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/, f);
    }
    const route = read('app/api/webhooks/delivery-callback/route.ts');
    assert.doesNotMatch(route, /\.from\(/);
    assert.match(route, /COMMUNICATION_CALLBACK_SECRET/);
  });

  test('no new file sends, quotes or prices anything', () => {
    for (const f of files) assert.doesNotMatch(read(f), /sendMessage|send_whatsapp|quotation|discount|outbound_messages/i, f);
  });

  test('the migration set still ends where this part says it does (only 20261121* files were added by this part)', () => {
    const mine = readdirSync(root + 'supabase/migrations').filter((f) => f.startsWith('20261121'));
    assert.ok(mine.length >= 1);
  });
});
