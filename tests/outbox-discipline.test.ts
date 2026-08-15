import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

/**
 * The outbox gives up, and says so — queue item 15 of the runway sweep.
 *
 * The dispatcher turns committed events into queued jobs. A permanently-failing
 * event used to be retried every tick forever, and — scanned oldest-first —
 * could sit at the front of every batch and starve fresh events behind it.
 * This proves the discipline that closes both: fewest-attempts-first ordering,
 * and a ceiling past which the event is parked dead rather than spun on.
 *
 * Driven against a mock admin so a real enqueue failure can be induced (a real
 * one needs a persistent DB fault, which is exactly what should not be in a
 * test). The mock records the calls and answers them; the assertions are on
 * what the dispatcher DID.
 */

const routeSource = readFileSync(
  fileURLToPath(new URL('../src/lib/events/dispatch.ts', import.meta.url)),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

// One subscribed event type, so planJobsForEvent returns exactly one job whose
// insert the mock can fail on demand. invoice.paid is a real catalog entry.
const EVENT = {
  id: 7,
  organization_id: '00000000-0000-4000-8000-000000000001',
  type: 'invoice.paid',
  subject_type: 'invoice',
  subject_id: '11111111-1111-4111-8111-111111111111',
  payload: { invoiceId: '11111111-1111-4111-8111-111111111111' },
  attempts: 0,
};

const seen = { updates: [] as Record<string, unknown>[], logs: [] as string[] };
let jobsInsertFails = false;
let batchRows: Array<Record<string, unknown>> = [];

// A chainable mock: every filter/order method returns the same object, and the
// object is awaitable — resolving to the configured result for the table and
// operation it was built for.
function makeAdmin() {
  return {
    schema() {
      return {
        from(table: string) {
          const state: { op: 'select' | 'insert' | 'update'; patch?: unknown } = { op: 'select' };
          const chain: Record<string, unknown> = {
            select: () => chain,
            is: () => chain,
            eq: () => chain,
            order: () => chain,
            limit: () => chain,
            insert: () => {
              state.op = 'insert';
              return Promise.resolve(
                table === 'jobs' && jobsInsertFails
                  ? { error: { code: 'XX000', message: 'persistent enqueue failure' } }
                  : { error: null },
              );
            },
            update: (patch: unknown) => {
              state.op = 'update';
              state.patch = patch;
              if (table === 'outbox_events') seen.updates.push(patch as Record<string, unknown>);
              return chain;
            },
            then: (resolve: (v: unknown) => unknown) => {
              if (state.op === 'select') return resolve({ data: batchRows, error: null });
              return resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };
}

const { dispatchOutbox } = await import('../src/lib/events/dispatch.ts');

describe('outbox discipline', () => {
  beforeEach(() => {
    seen.updates = [];
    seen.logs = [];
    jobsInsertFails = false;
    batchRows = [{ ...EVENT }];
    mock.method(console, 'error', (line: string) => seen.logs.push(line));
  });
  afterEach(() => mock.restoreAll());

  test('a failed enqueue below the ceiling bumps attempts and leaves the event live', async () => {
    jobsInsertFails = true;
    batchRows = [{ ...EVENT, attempts: 3 }];

    const summary = await dispatchOutbox(makeAdmin() as never);

    assert.equal(summary.parkedDead, 0);
    assert.equal(seen.updates.length, 1);
    assert.equal(seen.updates[0]!.attempts, 4, 'attempts is bumped');
    assert.equal(seen.updates[0]!.dead_at, undefined, 'and the event is not parked dead');
  });

  test('a failed enqueue that crosses the ceiling parks the event dead and names it', async () => {
    jobsInsertFails = true;
    batchRows = [{ ...EVENT, attempts: 9 }]; // one more failure reaches 10

    const summary = await dispatchOutbox(makeAdmin() as never);

    assert.equal(summary.parkedDead, 1);
    assert.equal(seen.updates[0]!.attempts, 10);
    assert.ok(seen.updates[0]!.dead_at, 'dead_at is stamped at the ceiling');
    const line = seen.logs.find((l) => l.includes('outbox/dead'));
    assert.ok(line, 'the dead event is named in a structured line');
    assert.match(line!, /"eventId":7/);
  });

  test('a successful enqueue publishes and never parks', async () => {
    const summary = await dispatchOutbox(makeAdmin() as never);

    assert.equal(summary.parkedDead, 0);
    assert.equal(summary.published, 1);
    // The only outbox update on the happy path is the publish stamp.
    assert.ok(seen.updates.every((u) => u.published_at !== undefined || u.dead_at === undefined));
  });
});

describe('outbox discipline — the ordering that prevents starvation', () => {
  test('the scan is fewest-attempts-first, then oldest, and skips dead and published', () => {
    // A stuck event (high attempts) must not sit at the front of every batch.
    assert.match(routeSource, /\.is\('published_at', null\)/);
    assert.match(routeSource, /\.is\('dead_at', null\)/);
    const byAttempts = routeSource.indexOf(".order('attempts'");
    const byId = routeSource.indexOf(".order('id'");
    assert.ok(byAttempts > 0 && byId > byAttempts, 'attempts must be the primary sort, id the tiebreak');
  });
});
