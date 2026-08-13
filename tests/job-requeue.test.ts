import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can, capabilitiesFor } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * Gap G-099 — a dead job can be sent back to the queue.
 *
 * `/operations` has shown what the system gave up on since G-053, and nothing
 * could bring any of it back. The page said so in its own header, and the gap
 * said why: reviving dead work is a write with real consequences, so it wanted
 * a design rather than a button.
 *
 * That design turned out to be mostly an argument, and the argument is what
 * section A pins, because if it is wrong the whole feature is wrong:
 *
 *   **A dead job is one the runner already attempted `max_attempts` times.**
 *   Requeuing is a sixth attempt of something the queue already makes five of,
 *   unattended. A handler that cannot survive a replay is already broken, and
 *   was broken before this existed.
 *
 * So what needs protecting is not the handler — it is the queue's own
 * bookkeeping, and that is sections B and C:
 *
 *   A. the two handlers really are replay-safe, in the database rather than by
 *      the queue being careful
 *   B. the function refuses anything that is not dead, under a lock, and
 *      reuses the row rather than inserting one
 *   C. the caller turns three outcomes into three different sentences, and a
 *      failed read into a failure
 *   D. who may do it
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const MIGRATION = '../supabase/migrations/20260813120012_requeue_a_dead_job.sql';

/** The SQL with comment lines removed, so a comment cannot satisfy an assertion. */
const executable = read(MIGRATION)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// A. The premise — replay is already safe, and not because of this change
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the handlers survive a replay on their own', () => {
  test('milestone.unlock refuses to act twice, in the UPDATE predicate', () => {
    // Not in a guard the handler could forget to run: the predicate is part of
    // the write. A milestone already in_progress, submitted or met matches no
    // row. If this ever becomes an unconditional update, requeueing a dead
    // unlock starts reopening stages that were finished.
    const handlers = read('../src/modules/projects/handlers.ts');
    const update = handlers.indexOf('.update(');
    assert.ok(update > 0, 'the unlock handler no longer updates anything');
    assert.match(
      handlers.slice(update, update + 600),
      /\.eq\('status', 'pending'\)/,
      'the unlock is no longer conditional on the milestone still being pending',
    );
  });

  test('requirement.extract cannot produce two proposals for one transcript', () => {
    // C2's index, still doing the work. Two runners over the same transcript
    // produce one proposal; so do two attempts, whoever asked for the second.
    const uniqueness = read('../supabase/migrations/20260810120004_requirement_version_uniqueness.sql');
    assert.match(
      uniqueness,
      /create unique index if not exists requirement_versions_transcript_state_key\s*\n\s*on crm\.requirement_versions \(conversation_id, source_message_count\)/,
    );
  });

  test('and the queue retries every job several times before it dies', () => {
    // The whole premise in one line: `dead` is what happens *after* the
    // attempts are spent. If jobs stopped retrying, requeueing would be a new
    // capability rather than a manual sixth attempt, and it would need the
    // idempotency argument the gap asked for.
    const core = read('../supabase/migrations/20260807120002_core.sql');
    assert.match(
      core,
      /set status\s*= case when attempts >= max_attempts then 'dead' else 'queued' end/,
    );
    assert.match(core, /max_attempts\s+int not null default 5/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. What the function protects — the queue's bookkeeping
// ═══════════════════════════════════════════════════════════════════════════

describe('B. core.requeue_job', () => {
  const fn = executable.slice(
    executable.indexOf('create or replace function core.requeue_job'),
    executable.indexOf('$$;'),
  );

  test('reads the row under a lock, so the status it acts on is the status it writes', () => {
    // The check-then-write shape is what D1, D2, D4 and D20 all were. A status
    // read before the lock could be true when read and false when used.
    assert.match(fn, /from core\.jobs j\s*\n\s*where j\.id = p_job_id\s*\n\s*for update/);
  });

  test('refuses anything that is not dead', () => {
    assert.match(fn, /if v_status <> 'dead' then/);
    assert.match(fn, /return query select 'not_dead'::text, v_status/);
  });

  test('and the refusal quotes the status the lock saw, not one the caller guessed', () => {
    const refusal = fn.indexOf("'not_dead'");
    assert.match(fn.slice(refusal, refusal + 80), /v_status/);
  });

  test('reuses the row rather than inserting a second job', () => {
    // `jobs_dedupe_key_key` is unique across the whole table. A new row with
    // the same key is refused; a new row with a fresh key defeats the
    // deduplication that makes redelivery free. Neither is a queue.
    assert.match(fn, /update core\.jobs/);
    assert.doesNotMatch(fn, /insert into core\.jobs/);
  });

  test('clears the claim it died holding', () => {
    // A row left with locked_at set looks stalled to the reaper.
    assert.match(fn, /locked_at\s*= null/);
    assert.match(fn, /locked_by\s*= null/);
  });

  test('keeps last_error, which is the only record of why the work stopped', () => {
    // The operator read it in order to decide. Clearing it erases the reason
    // at the moment somebody acted on it.
    assert.doesNotMatch(fn, /last_error\s*=/);
  });

  test('audits inside its own transaction, per G-079', () => {
    assert.match(fn, /perform core\.record_audit\(/);
    assert.match(fn, /'job\.requeued'/);
  });

  test('and the audit records what it was before, not only what it became', () => {
    const audit = fn.indexOf('core.record_audit(');
    const call = fn.slice(audit, audit + 500);
    assert.match(call, /'status', 'dead'/);
    assert.match(call, /'attempts', v_attempts/);
  });

  test('is SECURITY INVOKER, so core.jobs RLS still decides whose queue this is', () => {
    assert.match(executable, /security invoker/);
    assert.doesNotMatch(executable, /security definer/);
  });

  test('and is not reachable by anon or the public role', () => {
    assert.match(executable, /revoke all on function core\.requeue_job\(uuid\) from public, anon;/);
    assert.match(
      executable,
      /grant execute on function core\.requeue_job\(uuid\) to authenticated, service_role;/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The caller — executed, with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

const JOB_ID = '77777777-7777-4777-8777-777777777777';

let role: Role = 'owner';
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, unknown][] };

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc(fn: string, args: unknown) {
            seen.rpcs.push([fn, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { requeueJob } = await import('../src/lib/observability/requeue.ts');

beforeEach(() => {
  role = 'owner';
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
});

describe('C. requeueJob answers each outcome differently', () => {
  test('a requeued job succeeds, carrying how many attempts it had spent', async () => {
    rpcOutcome = { data: [{ outcome: 'requeued', job_status: 'queued', attempts: 5 }], error: null };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.attempts, 5);
    assert.deepEqual(seen.rpcs, [['requeue_job', { p_job_id: JOB_ID }]]);
  });

  test('a job that is not dead is a conflict, and says what it actually is', async () => {
    // Almost always a colleague who got there first. Telling the operator
    // "something went wrong" would invite a retry that cannot work.
    rpcOutcome = { data: [{ outcome: 'not_dead', job_status: 'queued', attempts: 5 }], error: null };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /queued/);
  });

  test('a job that is not there is NOT_FOUND, which is different news', async () => {
    rpcOutcome = { data: [{ outcome: 'not_found', job_status: null, attempts: null }], error: null };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('a failed call is an error, not a job left quietly dead', async () => {
    rpcOutcome = { data: null, error: { message: 'could not connect to server' } };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    // The driver's own words stay out of it.
    assert.doesNotMatch(result.error.message, /could not connect|relation|server/);
  });

  test('an empty response is a failed read, not a silent success — G-054', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('an outcome nobody recognises is an error, not a requeue', async () => {
    rpcOutcome = { data: [{ outcome: 'banana', job_status: null, attempts: null }], error: null };

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('a malformed id is refused before the database is asked', async () => {
    const result = await requeueJob('not-a-job');

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'VALIDATION');
    assert.deepEqual(seen.rpcs, [], 'a malformed id still reached the database');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Who may do it
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the capability', () => {
  test('owner and ops_admin may requeue; nobody else may', () => {
    assert.equal(can('owner', 'job.requeue'), true);
    assert.equal(can('ops_admin', 'job.requeue'), true);

    for (const role of ['delivery_lead', 'member', 'contractor', 'client_admin', 'client_member'] as const) {
      assert.equal(can(role, 'job.requeue'), false, `${role} may requeue jobs`);
    }
  });

  test('a role without it is refused by the caller, before the database', async () => {
    role = 'delivery_lead';

    const result = await requeueJob(JOB_ID);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.deepEqual(seen.rpcs, [], 'a forbidden caller still reached the database');
  });

  test('it is a capability of its own rather than audit.read reused', () => {
    // Reading the failures and reviving them resolve to the same two roles
    // today, and finance's rule argues for reuse when the role set is
    // identical. It is not reused here because the identical set belongs to a
    // *read*: gating a write on `audit.read` would be right about who and
    // wrong about what.
    assert.ok(capabilitiesFor('ops_admin').includes('job.requeue'));
    assert.ok(capabilitiesFor('ops_admin').includes('audit.read'));
    assert.equal(can('delivery_lead', 'audit.read'), false);
  });
});
