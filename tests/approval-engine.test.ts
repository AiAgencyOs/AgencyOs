import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import {
  APPROVAL_DECISIONS,
  APPROVAL_STATES,
  APPROVAL_SUBJECT_TYPES,
  APPROVAL_TRANSITIONS,
  canSettle,
  isOverdue,
  violatesMoneyFloor,
} from '../src/modules/approvals/schema.ts';

/**
 * The approval engine — gap G-040, decision ADM-08.
 *
 * The engine's real guarantees are held in Postgres and proved against a real
 * database by `scripts/verify-approvals.mjs`: the lock under two simultaneous
 * deciders, the partial unique index behind idempotent raising, the role
 * snapshot, the money floor, tenancy. None of that is restated here, because a
 * mocked version of a concurrency guarantee proves nothing.
 *
 * What is here is what that script cannot reach:
 *
 *   The vocabulary, pinned against the CHECK constraints it mirrors, so
 *   schema.ts and the migration cannot drift apart quietly.
 *
 *   The service's outcome mapping — seven answers from one function, each of
 *   which has to become a different error for a page to render. This is
 *   ordinary application branching over a value, which is exactly what a stub
 *   is good for.
 *
 *   `no_actor`, which the live script cannot exercise: `execute` was never
 *   granted to service_role, so over PostgREST the grant refuses first. The
 *   branch stays for callers that reach the function another way, and this is
 *   what proves it answers rather than falls through.
 */

type RpcResult = { data: unknown; error: { message: string } | null };

let requestOutcome: RpcResult = {
  data: [
    {
      outcome: 'requested',
      request_id: '11111111-1111-4111-8111-111111111111',
      state: 'pending',
      required_role: 'ops_admin',
      sla_due_at: '2026-08-14T00:00:00.000Z',
    },
  ],
  error: null,
};

let decideOutcome: RpcResult = {
  data: [
    {
      outcome: 'decided',
      request_id: '11111111-1111-4111-8111-111111111111',
      state: 'approved',
      decided_at: '2026-08-12T00:00:00.000Z',
    },
  ],
  error: null,
};

const seen = { rpcs: [] as [string, Record<string, unknown>][] };

function client() {
  return {
    schema() {
      return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          seen.rpcs.push([fn, args]);
          return fn === 'request_approval' ? requestOutcome : decideOutcome;
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role: 'ops_admin',
      userId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
    }),
  },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { requestApproval, decideApproval } = await import('../src/modules/approvals/service.ts');

const SUBJECT = '44444444-4444-4444-8444-444444444444';
const REQUEST = '11111111-1111-4111-8111-111111111111';

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260812120011_approval_engine.sql', import.meta.url)),
  'utf8',
);

beforeEach(() => {
  seen.rpcs = [];
  requestOutcome = {
    data: [
      {
        outcome: 'requested',
        request_id: REQUEST,
        state: 'pending',
        required_role: 'ops_admin',
        sla_due_at: '2026-08-14T00:00:00.000Z',
      },
    ],
    error: null,
  };
  decideOutcome = {
    data: [{ outcome: 'decided', request_id: REQUEST, state: 'approved', decided_at: '2026-08-12T00:00:00.000Z' }],
    error: null,
  };
});

describe('A. the vocabulary matches the constraints it mirrors', () => {
  test('every subject type in schema.ts is one the table admits', () => {
    for (const subject of APPROVAL_SUBJECT_TYPES) {
      assert.ok(
        migration.includes(`'${subject}'`),
        `${subject} is in schema.ts but not in the subject_type CHECK`,
      );
    }
  });

  test('every state in schema.ts is one the table admits', () => {
    for (const state of APPROVAL_STATES) {
      assert.ok(migration.includes(`'${state}'`), `${state} is in schema.ts but not in the state CHECK`);
    }
  });

  test('a decision is never `expired` — that one belongs to the system', () => {
    assert.ok(!(APPROVAL_DECISIONS as readonly string[]).includes('expired'));
    // …and the function agrees, which is what stops a human clicking it.
    assert.match(migration, /p_decision not in \('approved', 'rejected', 'changes_requested', 'cancelled'\)/);
  });

  test('every transition is one step, and terminal', () => {
    for (const [from, to] of Object.entries(APPROVAL_TRANSITIONS)) {
      if (from === 'pending') {
        assert.equal(to.length, 5, 'pending settles five ways');
        continue;
      }
      assert.deepEqual(to, [], `${from} is terminal; a settled request is superseded, not re-decided`);
    }
  });
});

describe('B. the rules the database holds are pinned here so they cannot be quietly removed', () => {
  test('one open request per subject, scoped to pending so a rejection may be resubmitted', () => {
    assert.match(migration, /approval_requests_open_subject_key[\s\S]*?where state = 'pending'/);
  });

  test('the required role is snapshotted on the request, not read from the policy at decision time', () => {
    assert.match(migration, /required_role\s+text not null check/);
    assert.match(migration, /v_policy\.required_role/);
  });

  test('a client decision cannot be recorded without its evidence (ADM-08d)', () => {
    assert.match(migration, /approval_requests_client_evidence/);
    assert.match(migration, /evidence_ref is not null and length\(btrim\(evidence_ref\)\) > 0/);
  });

  test('policy may not put money below the role that already holds it (ADM-08b)', () => {
    assert.match(migration, /approval_policies_money_floor/);
    assert.match(migration, /when subject_type = 'refund'\s+then required_role = 'owner'/);
  });

  test('two active policies at one threshold are unrepresentable, so resolution is total', () => {
    assert.match(migration, /approval_policies_threshold_key[\s\S]*?where active/);
  });

  test('the requests table takes no direct writes — select is the only policy', () => {
    const policies = migration.match(/create policy (\w+) on approvals\.approval_requests/g) ?? [];
    assert.deepEqual(
      policies,
      ['create policy approval_requests_select on approvals.approval_requests'],
      'a write policy here would let a role settle a request the function would have refused — D16',
    );
  });

  test('a settled request is never re-decided, and never deleted', () => {
    assert.match(migration, /a settled decision is not re-decided/);
    assert.match(migration, /approval requests are never deleted/);
  });
});

describe('C. raising', () => {
  test('a raise carries the caller’s own organization, never one from the input', async () => {
    const result = await requestApproval({ subjectType: 'deliverable', subjectId: SUBJECT });

    assert.ok(result.ok);
    const [, args] = seen.rpcs[0]!;
    assert.equal(args.p_organization_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(args.p_requested_by_type, 'user');
    assert.equal(args.p_requested_by_id, '22222222-2222-4222-8222-222222222222');
  });

  test('finding the question already asked is a success, and says so', async () => {
    requestOutcome = {
      data: [
        {
          outcome: 'already_pending',
          request_id: REQUEST,
          state: 'pending',
          required_role: 'owner',
          sla_due_at: '2026-08-14T00:00:00.000Z',
        },
      ],
      error: null,
    };

    const result = await requestApproval({ subjectType: 'deliverable', subjectId: SUBJECT });

    assert.ok(result.ok);
    assert.equal(result.data.alreadyPending, true);
    assert.equal(result.data.requestId, REQUEST);
  });

  test('no policy is a refusal that names the fix, not a silent approval', async () => {
    requestOutcome = {
      data: [{ outcome: 'no_policy', request_id: null, state: null, required_role: null, sla_due_at: null }],
      error: null,
    };

    const result = await requestApproval({ subjectType: 'refund', subjectId: SUBJECT });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /No approval policy covers refund/);
  });

  test('a database that does not answer is INTERNAL, not a request that succeeded', async () => {
    requestOutcome = { data: null, error: { message: 'connection reset by peer' } };

    const result = await requestApproval({ subjectType: 'deliverable', subjectId: SUBJECT });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /connection reset/, 'the driver message stays in the log');
  });

  test('an unknown subject type never reaches the database', async () => {
    const result = await requestApproval({
      subjectType: 'invoice_maybe' as 'invoice',
      subjectId: SUBJECT,
    });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0);
  });
});

describe('D. deciding — one function, seven answers, seven different errors', () => {
  test('a decision that lands comes back with what was written', async () => {
    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(result.ok);
    assert.equal(result.data.state, 'approved');
    assert.equal(result.data.decidedAt, '2026-08-12T00:00:00.000Z');
  });

  test('somebody else answering first is a conflict that names their answer', async () => {
    decideOutcome = {
      data: [{ outcome: 'already_decided', request_id: REQUEST, state: 'rejected', decided_at: null }],
      error: null,
    };

    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /already rejected/);
  });

  test('a role below the requirement is FORBIDDEN', async () => {
    decideOutcome = {
      data: [{ outcome: 'forbidden', request_id: REQUEST, state: 'pending', decided_at: null }],
      error: null,
    };

    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'FORBIDDEN');
  });

  /**
   * The branch the live script cannot reach.
   *
   * Over PostgREST the service role is refused by the missing grant before
   * `decide_approval` runs at all, so §6 of that script proves the grant. This
   * proves the function's own answer, for a caller that arrives another way —
   * and that the service treats it as UNAUTHORIZED rather than as a decision.
   */
  test('a caller with no identity cannot approve — directive §29, in the one place it is enforceable', async () => {
    decideOutcome = {
      data: [{ outcome: 'no_actor', request_id: REQUEST, state: null, decided_at: null }],
      error: null,
    };

    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'UNAUTHORIZED');
    assert.match(result.error.message, /signed-in approver/);
  });

  test('recording a client decision without evidence names the missing field', async () => {
    decideOutcome = {
      data: [{ outcome: 'evidence_required', request_id: REQUEST, state: 'pending', decided_at: null }],
      error: null,
    };

    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.ok(result.error.details?.evidenceRef, 'the form needs to know which field to light up');
  });

  test('another tenant’s request is NOT_FOUND rather than FORBIDDEN', async () => {
    decideOutcome = {
      data: [{ outcome: 'not_found', request_id: REQUEST, state: null, decided_at: null }],
      error: null,
    };

    const result = await decideApproval({ requestId: REQUEST, decision: 'approved' });

    assert.ok(!result.ok);
    assert.equal(
      result.error.code,
      'NOT_FOUND',
      'whether a request exists in another organization is not this caller’s business',
    );
  });

  test('a decision the request does not accept never reaches the database', async () => {
    const result = await decideApproval({
      requestId: REQUEST,
      decision: 'expired' as 'approved',
    });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0);
  });

  test('evidence is passed through when given, and omitted when not', async () => {
    await decideApproval({ requestId: REQUEST, decision: 'approved', evidenceRef: 'wamid.ABC' });
    assert.equal(seen.rpcs[0]![1].p_evidence_ref, 'wamid.ABC');

    seen.rpcs = [];
    await decideApproval({ requestId: REQUEST, decision: 'approved' });
    assert.ok(
      !('p_evidence_ref' in seen.rpcs[0]![1]),
      'an omitted optional argument is omitted, not sent as null',
    );
  });
});

describe('E. the rules that render a button', () => {
  test('an owner settles anything', () => {
    for (const required of ['owner', 'ops_admin', 'delivery_lead'] as const) {
      assert.equal(canSettle('owner', required), true);
    }
  });

  test('and everybody else settles only at or below their own level', () => {
    assert.equal(canSettle('ops_admin', 'owner'), false);
    assert.equal(canSettle('ops_admin', 'ops_admin'), true);
    assert.equal(canSettle('ops_admin', 'delivery_lead'), true);

    assert.equal(canSettle('delivery_lead', 'owner'), false);
    assert.equal(canSettle('delivery_lead', 'ops_admin'), false);
    assert.equal(canSettle('delivery_lead', 'delivery_lead'), true);

    assert.equal(canSettle('member', 'delivery_lead'), false);
    assert.equal(canSettle(null, 'delivery_lead'), false);
    assert.equal(canSettle(undefined, 'owner'), false);
  });

  test('the money floor answers before the constraint has to', () => {
    assert.ok(violatesMoneyFloor({ subjectType: 'refund', requiredRole: 'ops_admin' }));
    assert.ok(violatesMoneyFloor({ subjectType: 'invoice', requiredRole: 'delivery_lead' }));
    assert.equal(violatesMoneyFloor({ subjectType: 'refund', requiredRole: 'owner' }), null);
    assert.equal(violatesMoneyFloor({ subjectType: 'deliverable', requiredRole: 'delivery_lead' }), null);
  });

  test('overdue is a pending request past its deadline, and nothing else', () => {
    const now = new Date('2026-08-12T12:00:00.000Z');

    assert.equal(isOverdue({ state: 'pending', slaDueAt: '2026-08-12T11:00:00.000Z' }, now), true);
    assert.equal(isOverdue({ state: 'pending', slaDueAt: '2026-08-12T13:00:00.000Z' }, now), false);
    assert.equal(
      isOverdue({ state: 'approved', slaDueAt: '2026-08-12T11:00:00.000Z' }, now),
      false,
      'a settled request is not late; it is done',
    );
  });
});

describe('F. what is deliberately not built yet', () => {
  /**
   * ADM-08c decided that an unanswered request expires and escalates to the
   * owner. The state and the deadline exist; nothing walks them. That is
   * G-096, and this test is what stops it becoming folklore — if an expiry
   * job lands without the gap being closed, this fails and says so.
   */
  test('nothing expires a request yet — G-096, recorded rather than implied', () => {
    assert.ok(
      !migration.includes('expire_overdue'),
      'an expiry function landed: close G-096 in the record and delete this test',
    );
    assert.match(migration, /Nothing expires yet/);
    assert.ok(
      APPROVAL_STATES.includes('expired'),
      'the state is present so the escalation has somewhere to go when it is built',
    );
  });

  test('no consumer is wired to the engine yet', () => {
    assert.match(migration, /No consumer is wired/);
  });
});
