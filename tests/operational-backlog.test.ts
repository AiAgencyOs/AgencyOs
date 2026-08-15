import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import {
  alertPayload,
  describeBacklog,
  isHealthy,
  severityOf,
  signatureOf,
  type BacklogRow,
} from '../src/lib/observability/backlog.ts';

/**
 * Monitoring — gap G-053, and with it G-058 and the open half of G-080.
 *
 * The system has always known when a job was dead. What it did with that
 * knowledge was write `console.error` into a log nobody reads at two in the
 * morning, which is indistinguishable from knowing nothing.
 *
 * Three things are worth testing and they are different in kind:
 *
 *   The severity split, which is the only judgement call in the whole feature
 *   — everything else is a count of a state the system already set.
 *
 *   The suppression logic, because an alert that fires every minute is worse
 *   than no alert: it trains the reader to ignore the channel, and the next
 *   real one arrives there.
 *
 *   That a failed alert cannot fail the tick, which is asserted by driving it,
 *   not by reading it. A dead webhook stopping the job runner would turn
 *   monitoring into an outage.
 */

const clear: BacklogRow = {
  dead_jobs: 0,
  stalled_jobs: 0,
  stuck_queued_jobs: 0,
  unpublished_events: 0,
  overdue_approvals: 0,
  oldest_dead_at: null,
  oldest_unpublished_at: null,
  oldest_overdue_due_at: null,
};

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260812120012_operational_backlog.sql', import.meta.url)),
  'utf8',
);

describe('A. severity — the one judgement call', () => {
  test('nothing wrong is clear, and clear is healthy', () => {
    assert.equal(severityOf(clear), 'clear');
    assert.equal(isHealthy(clear), true);
    assert.deepEqual(describeBacklog(clear), []);
  });

  test('a dead job is failing — the system said nothing will retry it', () => {
    assert.equal(severityOf({ ...clear, dead_jobs: 1 }), 'failing');
    assert.equal(isHealthy({ ...clear, dead_jobs: 1 }), false);
  });

  test('an unpublished event is failing — a state change nobody acted on', () => {
    assert.equal(severityOf({ ...clear, unpublished_events: 1 }), 'failing');
  });

  test('late but moving is degraded, not failing', () => {
    assert.equal(severityOf({ ...clear, stalled_jobs: 3 }), 'degraded');
    assert.equal(severityOf({ ...clear, stuck_queued_jobs: 9 }), 'degraded');
    assert.equal(
      severityOf({ ...clear, overdue_approvals: 4 }),
      'degraded',
      'an unanswered approval is a person not answering, not the system failing',
    );
  });

  test('failing outranks degraded when both are true', () => {
    assert.equal(severityOf({ ...clear, dead_jobs: 1, overdue_approvals: 20 }), 'failing');
  });
});

describe('B. the fingerprint decides when to speak again', () => {
  test('the same counts are the same situation', () => {
    const a = { ...clear, dead_jobs: 2 };
    const b = { ...clear, dead_jobs: 2, oldest_dead_at: '2026-08-12T01:00:00.000Z' };

    assert.equal(
      signatureOf(a),
      signatureOf(b),
      'timestamps must not enter the signature — they move on their own and every tick would look new',
    );
  });

  test('a changed count is a changed situation, and is said immediately', () => {
    assert.notEqual(signatureOf({ ...clear, dead_jobs: 2 }), signatureOf({ ...clear, dead_jobs: 3 }));
  });

  test('getting better also changes it — recovery is worth hearing about', () => {
    assert.notEqual(signatureOf({ ...clear, dead_jobs: 1 }), signatureOf(clear));
  });
});

describe('C. what a human is handed', () => {
  test('the worst thing is said first', () => {
    const lines = describeBacklog({ ...clear, dead_jobs: 1, overdue_approvals: 2, stuck_queued_jobs: 5 });

    assert.match(lines[0]!, /dead/);
    assert.equal(lines.length, 3);
  });

  test('a dead job says that nothing will retry it', () => {
    assert.match(describeBacklog({ ...clear, dead_jobs: 1 })[0]!, /nothing will retry/);
  });

  test('the payload carries the severity, the fingerprint and the raw counts', () => {
    const payload = alertPayload({ ...clear, dead_jobs: 1 }, 'https://agencyos.example');

    assert.equal(payload.severity, 'failing');
    assert.equal(payload.deployment, 'https://agencyos.example');
    assert.equal(payload.detail.dead_jobs, 1);
    assert.match(payload.summary, /dead/);
  });
});

describe('D. the rules the database holds', () => {
  test('no threshold is invented — every one is a state or the existing constant', () => {
    // 15 minutes is STALE_AFTER from src/lib/jobs/staleness.ts, reused rather
    // than re-chosen. If this ever needs a second number it is a business
    // rule and belongs to the Admin, not to a migration.
    const intervals = migration.match(/interval '(\d+ \w+)'/g) ?? [];
    assert.ok(intervals.length > 0, 'the function should bound staleness somehow');
    assert.deepEqual(
      [...new Set(intervals)],
      ["interval '15 minutes'"],
      'a second threshold appeared — that is a business rule, and ADM territory',
    );
  });

  test('the claim is one statement, so two ticks cannot both send', () => {
    assert.match(migration, /insert into core\.alert_state[\s\S]*?on conflict \(key\) do update/);
    assert.match(migration, /returning true into v_claimed/);
  });

  test('the backlog function is SECURITY INVOKER, so tenancy is not re-implemented', () => {
    const fn = migration.slice(migration.indexOf('function core.operational_backlog'));
    assert.match(fn.slice(0, 600), /security invoker/);
  });

  test('alert state is readable by nobody through the API', () => {
    assert.match(migration, /alter table core\.alert_state enable row level security/);
    assert.ok(
      !/create policy \w+ on core\.alert_state/.test(migration),
      'a policy here would publish operator state to a tenant that has no use for it',
    );
  });
});

/**
 * Section E's fixtures, hoisted.
 *
 * `describe` takes a synchronous callback, so the dynamic import that section
 * needs cannot live inside it. The environment is set before the import
 * because `serverEnv()` reads and caches it on first call.
 */
const seen = { logs: [] as string[], posted: 0 };

let backlogResult: { data: unknown; error: { message: string } | null } = {
  data: [{ ...clear, dead_jobs: 1 }],
  error: null,
};
// claim_alert now returns the instant it stamped (a timestamp), or null when
// suppressed — not a boolean.
let claimResult: { data: unknown; error: { message: string } | null } = {
  data: '2026-08-15T00:00:00.000Z',
  error: null,
};
let fetchBehaviour: 'ok' | 'throw' | 'status' = 'ok';

const rpcCalls: string[] = [];
const admin = {
  schema() {
    return {
      rpc: async (fn: string) => {
        rpcCalls.push(fn);
        if (fn === 'operational_backlog') return backlogResult;
        if (fn === 'claim_alert') return claimResult;
        // release_alert / clear_alert return a boolean; the tests assert on
        // whether they were called, not on the value.
        return { data: true, error: null };
      },
    };
  },
};

mock.method(console, 'error', (line: string) => {
  seen.logs.push(line);
});

globalThis.fetch = (async () => {
  seen.posted += 1;
  if (fetchBehaviour === 'throw') throw new Error('connect ECONNREFUSED');
  if (fetchBehaviour === 'status') return { ok: false, status: 500 } as Response;
  return { ok: true, status: 200 } as Response;
}) as typeof fetch;

// env.ts validates the public variables when it is first imported, and the
// test process has none. Placeholders, not credentials — the scan checks that.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';
process.env.ALERT_WEBHOOK_URL = 'https://alerts.example/hook';

const { alertOnBacklog } = await import('../src/lib/observability/alert.ts');

describe('E. alerting cannot break the tick', () => {
  beforeEach(() => {
    seen.logs = [];
    seen.posted = 0;
    rpcCalls.length = 0;
    backlogResult = { data: [{ ...clear, dead_jobs: 1 }], error: null };
    claimResult = { data: '2026-08-15T00:00:00.000Z', error: null };
    fetchBehaviour = 'ok';
  });

  test('a healthy backlog sends nothing, posts nothing, and clears the alert state', async () => {
    backlogResult = { data: [clear], error: null };

    const outcome = await alertOnBacklog(admin as never);

    assert.deepEqual(outcome, { sent: false, reason: 'healthy' });
    assert.equal(seen.posted, 0);
    assert.ok(rpcCalls.includes('clear_alert'), 'recovery must clear the state so a returning problem is heard again');
  });

  test('a delivered alert releases nothing — the cooldown stands', async () => {
    const outcome = await alertOnBacklog(admin as never);

    assert.equal(outcome.sent, true);
    assert.ok(!rpcCalls.includes('release_alert'), 'a successful send keeps its cooldown');
  });

  test('a failed webhook releases the claim, so the next tick retries', async () => {
    fetchBehaviour = 'throw';

    await alertOnBacklog(admin as never);

    assert.ok(rpcCalls.includes('release_alert'), 'a claim whose delivery failed must be released');
  });

  test('a rejecting webhook also releases the claim', async () => {
    fetchBehaviour = 'status';

    await alertOnBacklog(admin as never);

    assert.ok(rpcCalls.includes('release_alert'));
  });

  test('an unhealthy backlog that the database suppresses posts nothing', async () => {
    claimResult = { data: null, error: null };

    const outcome = await alertOnBacklog(admin as never);

    assert.deepEqual(outcome, { sent: false, reason: 'suppressed' });
    assert.equal(seen.posted, 0, 'the cooldown is the database’s answer, and it is obeyed');
  });

  test('an unreachable endpoint is reported, not thrown', async () => {
    fetchBehaviour = 'throw';

    const outcome = await alertOnBacklog(admin as never);

    assert.deepEqual(outcome, { sent: false, reason: 'failed' });
    assert.ok(seen.logs.some((l) => l.includes('unreachable')));
  });

  test('a rejecting endpoint is reported, not thrown', async () => {
    fetchBehaviour = 'status';

    const outcome = await alertOnBacklog(admin as never);

    assert.deepEqual(outcome, { sent: false, reason: 'failed' });
    assert.ok(seen.logs.some((l) => l.includes('answered 500')));
  });

  test('a backlog that cannot be read is loud, because a silent monitor looks healthy', async () => {
    backlogResult = { data: null, error: { message: 'connection reset by peer' } };

    const outcome = await alertOnBacklog(admin as never);

    assert.deepEqual(outcome, { sent: false, reason: 'failed' });
    assert.ok(seen.logs.some((l) => l.includes('could not read the backlog')));
  });

  test('the situation is logged before the webhook, so the record does not depend on delivery', async () => {
    fetchBehaviour = 'throw';

    await alertOnBacklog(admin as never);

    const summary = seen.logs.find((l) => l.includes('"severity"'));
    assert.ok(summary, 'the failure was logged with its severity even though delivery failed');
  });
});

describe('F. the tick calls it, and after the work rather than before', () => {
  const route = readFileSync(
    fileURLToPath(new URL('../app/api/jobs/run/route.ts', import.meta.url)),
    'utf8',
  );

  test('the cron tick alerts on every invocation', () => {
    assert.match(route, /await alertOnBacklog\(admin\)/);
  });

  test('it runs after the reaper and the dispatcher, so the counts are what could not be fixed', () => {
    assert.ok(
      route.indexOf('reapStalledJobs(admin)') < route.indexOf('alertOnBacklog(admin)'),
      'alerting before reaping would report jobs this tick was about to rescue',
    );
    assert.ok(route.indexOf('dispatchOutbox(admin)') < route.indexOf('alertOnBacklog(admin)'));
  });
});
