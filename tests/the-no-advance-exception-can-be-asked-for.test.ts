import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * The no-advance exception can be asked for — G-230's dead branch, closed.
 *
 * `sales.won_gate_verdict` has read `payload->>'kind' = 'payment_exception'`
 * on the accepted proposal's approval since it was built, and nothing could
 * ever write that value — the migration's own comment said so, and the
 * "ADM-72" it cited for the open question was wrong (ADM-72 answered a
 * different question months earlier). This closes the branch by routing the
 * exception through the approval engine that already exists rather than
 * inventing a parallel one.
 *
 * Two halves, tested where each can be:
 *
 *   The door's shape — who may ask, what it refuses, and what it hands to
 *   approvals.request_approval — is read as source here and driven live
 *   against a real Postgres (member asks, owner alone may decide, and the
 *   gate flips from no_payment_evidence to null once approved).
 *
 *   The service's half is EXECUTED, with only the database stubbed.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(
  read('supabase/migrations/20260921100000_the_no_advance_exception_can_be_asked_for.sql'),
);

// ═══════════════════════════════════════════════════════════════════════════
// A. The door's shape — read as source
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the door raises the exact request the gate reads', () => {
  test('it names the accepted proposal, not the opportunity, as the subject', () => {
    assert.match(
      SQL,
      /approvals\.request_approval\(\s*\n\s*v_org, 'proposal', v_accepted\.id/,
    );
  });

  test('the payload carries kind=payment_exception, the exact string the gate checks', () => {
    assert.match(SQL, /jsonb_build_object\('kind', 'payment_exception', 'reason', p_reason\)/);
  });

  test('it selects the newest accepted version, the same selector the gate uses', () => {
    assert.match(
      SQL,
      /where p\.opportunity_id = v_opp\.id\s*\n\s*and p\.status = 'accepted'\s*\n\s*order by p\.version desc\s*\n\s*limit 1;/,
    );
  });

  test('any internal role may ask, not only the owner', () => {
    assert.match(SQL, /if not coalesce\(\(select core\.is_internal\(\)\), false\) then/);
    assert.doesNotMatch(SQL, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
  });

  test('a blank reason is refused before anything is looked up', () => {
    assert.match(SQL, /if p_reason is null or length\(btrim\(p_reason\)\) = 0 then/);
  });

  test('an opportunity with no accepted proposal is refused by name', () => {
    assert.match(SQL, /'no_accepted_quotation'::text, null::uuid, null::text, null::text, null::timestamptz;/);
  });

  test('deciding it is not reimplemented — no new approve/reject function exists here', () => {
    assert.doesNotMatch(SQL, /create (or replace )?function sales\.(decide|approve|reject)_payment_exception/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The service's half — executed, with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

const OPP = '99999999-9999-4999-8999-999999999999';

let role: Role = 'ops_admin';
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, Record<string, unknown>][] };

function client() {
  return {
    schema() {
      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          seen.rpcs.push([fn, args]);
          return { maybeSingle: async () => rpcResult };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role, userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { requestPaymentException } = await import('../src/modules/sales/service.ts');

beforeEach(() => {
  role = 'ops_admin';
  rpcResult = { data: null, error: null };
  seen.rpcs.length = 0;
});

describe('B. the service asks the door and translates its outcomes', () => {
  test('a caller without lead.write never reaches the door', async () => {
    role = 'member';
    const result = await requestPaymentException({ opportunityId: OPP, reason: 'trusted client' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0);
  });

  test('an empty reason is refused before the door is asked', async () => {
    const result = await requestPaymentException({ opportunityId: OPP, reason: '   ' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0);
  });

  test('a successful request passes the outcome and request id through', async () => {
    rpcResult = { data: { outcome: 'requested', request_id: 'r1' }, error: null };
    const result = await requestPaymentException({ opportunityId: OPP, reason: 'trusted client' });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.outcome, 'requested');
    assert.equal(result.ok && result.data.requestId, 'r1');
    assert.equal(seen.rpcs[0]?.[0], 'request_payment_exception');
    assert.equal(seen.rpcs[0]?.[1]?.p_opportunity_id, OPP);
    assert.equal(seen.rpcs[0]?.[1]?.p_reason, 'trusted client');
  });

  test('no_accepted_quotation is a named conflict, not a generic failure', async () => {
    rpcResult = { data: { outcome: 'no_accepted_quotation', request_id: null }, error: null };
    const result = await requestPaymentException({ opportunityId: OPP, reason: 'trusted client' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /accepted quotation/i);
  });

  test('a database failure refuses rather than pretending nothing was asked', async () => {
    rpcResult = { data: null, error: { message: 'connection reset' } };
    const result = await requestPaymentException({ opportunityId: OPP, reason: 'trusted client' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });
});
