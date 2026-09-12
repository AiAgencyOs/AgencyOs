import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * A deal that is won says what was won — gap G-230.
 *
 * `setOpportunityStage` moved a deal to `won` on `lead.write` and a legal
 * transition. It never asked whether a quotation had been accepted. The LOSING
 * path asks for more than that: `opportunities_lost_says_why` refuses a lost
 * deal with no category and no sentence, at the row.
 *
 * Two halves, tested where each can be:
 *
 *   The trigger's firing condition and the two-tier verdict are read as source
 *   here and PROVED against a real Postgres by `db:verify:wongate`.
 *
 *   The service's half — asking the verdict, refusing on it, and failing
 *   CLOSED when the verdict cannot be read — is EXECUTED, with only the
 *   database stubbed. That last one is the property most worth running: a gate
 *   that opens when the database has a bad minute is not a gate.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911120000_a_deal_that_is_won_says_what_was_won.sql'));

// ═══════════════════════════════════════════════════════════════════════════
// A. The row's half — the shape a unit test can see
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the gate binds the transition, not the state', () => {
  test('it fires only on the move INTO won, so deals already won are untouched', () => {
    // Bound to the transition for the reason opportunities_lost_says_why was
    // declared NOT VALID: backfilling a judgement nobody made is worse than a
    // rule that starts today (ADM-76). The transition test lives in the body,
    // because a WHEN clause cannot mention OLD on an insert.
    assert.match(SQL, /if tg_op = 'UPDATE' and old\.stage = 'won' then\s*\n\s*return new;/);
    assert.match(SQL, /if new\.stage <> 'won' then\s*\n\s*return new;/);
  });

  test('and it fires on INSERT as well, because a deal cannot be born won', () => {
    // Found by review: the first draft was UPDATE-only, and a direct POST with
    // stage='won' walked straight past it — the exact write that
    // opportunities_lost_says_why, being a CHECK, would have refused. On an
    // insert there is no row for a proposal to reference, so the answer is
    // known without asking the verdict.
    assert.match(SQL, /before insert or update of stage on sales\.opportunities/);
    assert.match(SQL, /if tg_op = 'INSERT' then\s*\n\s*raise exception 'won_gate: no_accepted_quotation'/);
  });

  test('the accepted quotation is required unconditionally, and payment only when configured', () => {
    assert.match(SQL, /return 'no_accepted_quotation';/);
    assert.match(SQL, /if v_required is distinct from 'on' then\s*\n\s*return null;/);
  });

  test('an unreadable organization refuses rather than reading as "switch off"', () => {
    // A null setting has two meanings — off, or the row could not be read.
    // Collapsing them makes an unreadable row silently mean off, which is the
    // one direction a close gate must never fail. G-054's rule, applied to a
    // decision instead of to a page.
    assert.match(SQL, /if not found then\s*\n\s*return 'organization_unreadable';/);
  });

  test('a claimed payment is not a payment — only a captured one', () => {
    assert.match(SQL, /pay\.status = 'captured'/);
    assert.doesNotMatch(SQL, /payment_submissions/);
  });

  test('the quotation’s own approval does not count as a payment exception', () => {
    // Every accepted quotation already carries an approved money-floor
    // approval on the same proposal (submit_proposal raised it). An exists()
    // on state alone would therefore pass every properly-approved quote, and
    // the switch would stop nothing it was turned on to stop. Found by review
    // while writing the fixture that would have exercised it.
    assert.match(SQL, /and a\.state = 'approved'\s*\n\s*and coalesce\(a\.payload->>'kind', ''\) = 'payment_exception'/);
  });

  test('the function is not reachable by anon or the public role', () => {
    assert.match(SQL, /revoke all on function sales\.won_gate_verdict\(uuid\) from public, anon/);
    assert.match(
      SQL,
      /grant execute on function sales\.won_gate_verdict\(uuid\) to authenticated, service_role/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The service's half — executed, with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

const OPP = '99999999-9999-4999-8999-999999999999';

let role: Role = 'owner';
let stageRow: Record<string, unknown> | null = { id: OPP, organization_id: 'o', stage: 'negotiation' };
let verdict: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let writeOutcome: { data: { id: string } | null; error: { code?: string; message: string } | null } = {
  data: { id: OPP },
  error: null,
};

const seen = { rpcs: [] as [string, Record<string, unknown>][], updates: 0 };

function client() {
  return {
    schema() {
      return {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          seen.rpcs.push([fn, args]);
          return verdict;
        },
        from() {
          const read = {
            select: () => read,
            eq: () => read,
            is: () => read,
            maybeSingle: async () => ({ data: stageRow, error: null }),
          };
          return {
            select: () => read,
            update() {
              seen.updates += 1;
              const chain = {
                eq: () => chain,
                select: () => chain,
                maybeSingle: async () => writeOutcome,
                then: (r: (v: typeof writeOutcome) => unknown) => r(writeOutcome),
              };
              return chain;
            },
            insert: () => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }),
          };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role, userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { setOpportunityStage } = await import('../src/modules/sales/service.ts');

beforeEach(() => {
  role = 'owner';
  stageRow = { id: OPP, organization_id: 'o', stage: 'negotiation' };
  verdict = { data: null, error: null };
  writeOutcome = { data: { id: OPP }, error: null };
  seen.rpcs.length = 0;
  seen.updates = 0;
});

describe('B. the gate is asked, and only where it applies', () => {
  test('moving to won asks the verdict for this exact opportunity', async () => {
    await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.[0], 'won_gate_verdict');
    assert.equal(seen.rpcs[0]?.[1]?.p_opportunity_id, OPP);
  });

  test('moving anywhere else does not ask it', async () => {
    stageRow = { id: OPP, organization_id: 'o', stage: 'proposal' };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'negotiation' });

    assert.equal(result.ok, true);
    assert.equal(seen.rpcs.length, 0, 'a move that is not a close asked the WON gate');
  });

  test('losing a deal does not ask it either', async () => {
    const result = await setOpportunityStage({
      opportunityId: OPP,
      stage: 'lost',
      lostReason: 'Chose another agency.',
      lostCategory: 'chose_competitor',
    });

    assert.equal(result.ok, true);
    assert.equal(seen.rpcs.length, 0);
  });

  test('an illegal transition is refused before the gate is troubled', async () => {
    stageRow = { id: OPP, organization_id: 'o', stage: 'discovery' };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.equal(seen.rpcs.length, 0);
  });

  test('a caller without permission never reaches the gate', async () => {
    role = 'member';
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0);
  });
});

describe('C. what the gate refuses, and what it says', () => {
  test('no accepted quotation refuses, and the deal is not written', async () => {
    verdict = { data: 'no_accepted_quotation', error: null };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /accepted quotation/i);
    assert.equal(seen.updates, 0, 'a refused close still wrote the deal');
  });

  test('the sentence names what the operator has to go and do', async () => {
    // "Could not move the deal" would send them looking in the wrong place.
    verdict = { data: 'no_accepted_quotation', error: null };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.match(result.ok === false ? result.error.message : '', /exact quotation version/i);
  });

  test('missing payment evidence refuses separately, and says which switch is on', async () => {
    verdict = { data: 'no_payment_evidence', error: null };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /payment evidence/i);
    assert.match(result.ok === false ? result.error.message : '', /exception/i);
    assert.equal(seen.updates, 0);
  });

  test('a reason nobody planned for still refuses, and names itself', async () => {
    verdict = { data: 'not_found', error: null };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /not_found/);
    assert.equal(seen.updates, 0);
  });
});

describe('D. the gate fails closed', () => {
  test('a verdict that cannot be read refuses rather than letting the deal through', async () => {
    // The property worth executing. A gate that opens when the database is
    // having a bad minute is not a gate — and this is exactly the shape G-054
    // removed from the read paths, where a failed read rendered as "nothing".
    verdict = { data: null, error: { message: 'connection reset' } };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.equal(seen.updates, 0, 'an unreadable verdict let the deal be won');
  });

  test('and it does not leak the database’s words to the screen', async () => {
    verdict = { data: null, error: { message: 'relation "sales.proposals" does not exist' } };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.doesNotMatch(result.ok === false ? result.error.message : '', /relation/);
  });
});

describe('E. a deal with an accepted quotation still closes', () => {
  test('a null verdict lets the move through and writes it', async () => {
    verdict = { data: null, error: null };
    const result = await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.stage, 'won');
    assert.equal(seen.updates, 1);
  });

  test('the gate adds no reach of its own — one verdict, one write', async () => {
    await setOpportunityStage({ opportunityId: OPP, stage: 'won' });

    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.updates, 1);
  });
});
