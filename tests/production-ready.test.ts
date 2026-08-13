import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * G-031 — what "production ready" is allowed to mean.
 *
 * ADM-19, and the answer is narrower than directive §20 sketches: **zero open
 * blockers, zero open majors, and a client-approved build.** Payment state and
 * an owner sign-off were offered and deliberately left out — so a project can
 * be production ready and unpaid, and nobody countersigns.
 *
 * Four of §20's conditions (the client's build, its deployment, its security
 * checks, its documentation) are facts this system has never held. Inventing a
 * column for each would have produced a gate that lies.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const executable = read('../supabase/migrations/20260813120018_production_ready.sql')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('A. the two conditions, and the ones left out', () => {
  test('open blockers and open majors are counted separately', () => {
    // Separately, because "there are open blockers" and "there are open
    // majors" are different conversations with different people.
    assert.match(executable, /d\.severity = 'blocker'/);
    assert.match(executable, /d\.severity = 'major'/);
  });

  test('only open defects count — a fixed blocker is not a blocker', () => {
    const matches = executable.match(/d\.status = 'open'/g) ?? [];
    assert.ok(matches.length >= 2, 'both severity checks must filter on open');
  });

  test('a client-approved build is required', () => {
    assert.match(executable, /dl\.kind = 'build'/);
    assert.match(executable, /dl\.status = 'approved'/);
  });

  test('payment is deliberately NOT a condition', () => {
    // ADM-19 offered it and the Admin left it out. A project may be production
    // ready and unpaid.
    assert.doesNotMatch(executable, /paid_minor|verified_minor|invoices/);
  });

  test('and neither is an owner sign-off', () => {
    assert.doesNotMatch(executable, /approval_requests/);
  });

  test('minor and trivial defects do not block anything', () => {
    const readiness = executable.slice(
      executable.indexOf('create or replace function projects.production_readiness'),
    );
    assert.doesNotMatch(readiness, /'minor'|'trivial'/);
  });
});

describe('B. the marking', () => {
  test('decides under the project row lock', () => {
    assert.match(executable, /where p\.id = p_project_id\s*\n\s*for update/);
  });

  test('marking twice is answered and does not move the date', () => {
    // The moment it became ready is the moment it first did.
    assert.match(executable, /if v_ready_at is not null then/);
    assert.match(executable, /'already_ready'/);
    const already = executable.indexOf("'already_ready'");
    const update = executable.indexOf('set production_ready_at = now()');
    assert.ok(already < update, 'a second marking reaches the write');
  });

  test('there is no override, and the reason is written down', () => {
    // Unlike a project start, where a client is waiting and the owner may
    // force it, nothing downstream waits on production readiness.
    // The mechanism, not the word: the function comment says there is no
    // override, which is exactly the sentence a reader should find.
    assert.doesNotMatch(executable, /p_override/);
    assert.doesNotMatch(executable, /override_reason/);
    assert.match(executable, /No override, because ADM-19 offered none/);
  });

  test('the refusal names which condition is in the way', () => {
    for (const key of ['open_blockers', 'open_majors', 'no_approved_build']) {
      assert.match(executable, new RegExp(`'${key}'`));
    }
  });

  test('and nothing writes an audit row by hand — G-093 chose one mechanism', () => {
    assert.doesNotMatch(executable, /record_audit/);
  });

  test('readiness is stable, so a screen can ask without writing', () => {
    const readiness = executable.slice(
      executable.indexOf('create or replace function projects.production_readiness'),
      executable.indexOf('$$;', executable.indexOf('create or replace function projects.production_readiness')),
    );
    assert.match(readiness, /stable/);
  });
});

describe('C. the vocabulary needed no migration', () => {
  test('qa.defects already used the words ADM-17 chose', () => {
    // Blocker / Major / Minor / Trivial. The decision confirmed the schema
    // rather than changing it, which is worth asserting: a reader comparing
    // the two would otherwise hunt for the migration that renamed them.
    const qa = read('../supabase/migrations/20260813120002_qa_defects.sql');
    assert.match(qa, /check \(severity in \('blocker', 'major', 'minor', 'trivial'\)\)/);
  });
});

// ── the caller ─────────────────────────────────────────────────────────────

const PROJECT = '66666666-6666-4666-8666-666666666666';

let role: Role = 'ops_admin';
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
          rpc(name: string, args: unknown) {
            seen.rpcs.push([name, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { markProductionReady } = await import('../src/modules/qa/service.ts');

beforeEach(() => {
  role = 'ops_admin';
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
});

describe('D. markProductionReady', () => {
  test('a ready project is signed off', async () => {
    rpcOutcome = { data: [{ outcome: 'ready', unmet: [] }], error: null };

    const result = await markProductionReady(PROJECT);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.ready, true);
  });

  test('an unready one is told exactly what is in the way', async () => {
    rpcOutcome = {
      data: [{ outcome: 'not_ready', unmet: ['open_blockers', 'no_approved_build'] }],
      error: null,
    };

    const result = await markProductionReady(PROJECT);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /open blocker defects/);
    assert.match(result.error.message, /has not approved a build/);
    assert.doesNotMatch(result.error.message, /major/, 'it named a condition that was met');
  });

  test('signing off twice is the answer, not an error', async () => {
    rpcOutcome = { data: [{ outcome: 'already_ready', unmet: [] }], error: null };

    const result = await markProductionReady(PROJECT);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.ready, false);
  });

  test('an empty response is a failed read, not a sign-off — G-054', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await markProductionReady(PROJECT);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('a malformed id never reaches the database', async () => {
    const result = await markProductionReady('not-a-project');

    assert.equal(result.ok, false);
    assert.deepEqual(seen.rpcs, []);
  });
});

describe('E. who may sign a project off', () => {
  test('owner and ops admin — and NOT the delivery lead', async () => {
    // project.write would have been the obvious reuse and is wrong by exactly
    // one role: a delivery lead declaring their own work production ready is
    // the review signing its own homework.
    assert.equal(can('owner', 'project.sign_off'), true);
    assert.equal(can('ops_admin', 'project.sign_off'), true);
    assert.equal(can('delivery_lead', 'project.sign_off'), false);
    assert.equal(can('delivery_lead', 'project.write'), true, 'the near-miss this avoids');
  });

  test('and a delivery lead is refused before the database', async () => {
    role = 'delivery_lead';

    const result = await markProductionReady(PROJECT);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.deepEqual(seen.rpcs, []);
  });
});
