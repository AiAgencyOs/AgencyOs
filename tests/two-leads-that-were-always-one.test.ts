import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * Two leads that were always one — Doc 09 §5/§34, closing a granular gap.
 *
 * "Merge duplicate records through controlled workflow" (§34) and "maintain
 * source history after merge" (§5, CRITICAL) named a capability this
 * repository never had — a grep for merge_lead/merge_contact/merge_duplicate
 * returned nothing anywhere. `crm.merge_leads` closes it for the safe,
 * common case only: two leads for the SAME contact, neither carrying a
 * sales.opportunities row. A cross-contact merge or a merge touching deal
 * state is refused by name rather than guessed at.
 *
 * Two halves, tested where each can be:
 *
 *   The door's shape — who may call it, what it refuses, and which tables it
 *   moves — is read as source here and driven live against a real Postgres
 *   (a real merge with a genuine unique-constraint collision on
 *   qualification_coverage, proving the collision is handled rather than
 *   crashing the whole merge).
 *
 *   The service's half is EXECUTED, with only the database stubbed.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260921130000_two_leads_that_were_always_one.sql');
const CODE = sqlCode(MIGRATION);
const FN = region(MIGRATION, 'create or replace function crm.merge_leads', '$$;');

describe('A. the door refuses what it cannot safely merge', () => {
  test('owner only, checked in the database', () => {
    assert.match(MIGRATION, /security definer/);
    assert.match(FN, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
  });

  test('a reason is required before anything else is checked', () => {
    assert.match(FN, /if p_reason is null or length\(btrim\(p_reason\)\) = 0 then/);
  });

  test('merging a lead with itself is refused by name', () => {
    assert.match(FN, /if p_winner_lead_id = p_loser_lead_id then/);
    assert.match(FN, /'same_lead'::text/);
  });

  test('a lead already merged cannot be a winner or a loser again', () => {
    assert.match(
      FN,
      /if v_winner\.merged_into_lead_id is not null or v_loser\.merged_into_lead_id is not null then/,
    );
  });

  test('two leads for different contacts are refused, not guessed at', () => {
    assert.match(FN, /if v_winner\.contact_id is distinct from v_loser\.contact_id then/);
    assert.match(FN, /'different_contact'::text/);
  });

  test('either lead carrying a sales.opportunities row refuses the whole merge', () => {
    assert.match(
      FN,
      /where o\.lead_id in \(p_winner_lead_id, p_loser_lead_id\)/,
    );
    assert.match(FN, /'has_opportunity'::text/);
  });
});

describe('B. what actually moves, and the one table handled with care', () => {
  test('activities, conversations, objections, meetings and evidence move to the winner', () => {
    for (const table of [
      'crm.lead_activities',
      'crm.conversations',
      'sales.objections',
      'crm.meetings',
      'crm.meeting_evidence',
    ]) {
      assert.match(CODE, new RegExp(`update ${table.replace('.', '\\.')} set lead_id = p_winner_lead_id`));
    }
  });

  test('qualification_coverage only moves rows the winner does not already have (unique lead_id+area)', () => {
    assert.match(
      CODE,
      /update crm\.qualification_coverage qc\s*\n\s*set lead_id = p_winner_lead_id\s*\n\s*where qc\.lead_id = p_loser_lead_id\s*\n\s*and qc\.area not in \(/,
    );
  });

  test('nothing is deleted — the loser is marked, not removed', () => {
    assert.doesNotMatch(CODE, /delete from crm\.leads/);
    assert.match(CODE, /set merged_into_lead_id = p_winner_lead_id,\s*\n\s*merged_at = now\(\)/);
  });

  test('the merge is audited', () => {
    assert.match(FN, /'lead\.merged'/);
  });

  test('sales.opportunities is never reassigned — deal state is out of scope', () => {
    assert.doesNotMatch(CODE, /update sales\.opportunities set lead_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The service's half — executed, with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

let role: Role = 'owner';
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

const { mergeLeads } = await import('../src/modules/crm/service.ts');

beforeEach(() => {
  role = 'owner';
  rpcResult = { data: null, error: null };
  seen.rpcs.length = 0;
});

describe('C. the service asks the door and translates its outcomes', () => {
  test('a caller without organization.settings never reaches the door', async () => {
    role = 'ops_admin';
    const result = await mergeLeads({ winnerLeadId: '11111111-1111-4111-8111-111111111111', loserLeadId: '22222222-2222-4222-8222-222222222222', reason: 'dup' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0);
  });

  test('an empty reason is refused before the door is asked', async () => {
    const result = await mergeLeads({ winnerLeadId: '11111111-1111-4111-8111-111111111111', loserLeadId: '22222222-2222-4222-8222-222222222222', reason: '   ' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0);
  });

  test('a successful merge passes the outcome through', async () => {
    rpcResult = { data: { outcome: 'merged' }, error: null };
    const result = await mergeLeads({ winnerLeadId: '11111111-1111-4111-8111-111111111111', loserLeadId: '22222222-2222-4222-8222-222222222222', reason: 'dup inquiry' });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.outcome, 'merged');
    assert.equal(seen.rpcs[0]?.[0], 'merge_leads');
    assert.equal(seen.rpcs[0]?.[1]?.p_winner_lead_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(seen.rpcs[0]?.[1]?.p_loser_lead_id, '22222222-2222-4222-8222-222222222222');
  });

  test('has_opportunity is a named conflict a person can act on', async () => {
    rpcResult = { data: { outcome: 'has_opportunity' }, error: null };
    const result = await mergeLeads({ winnerLeadId: '11111111-1111-4111-8111-111111111111', loserLeadId: '22222222-2222-4222-8222-222222222222', reason: 'dup inquiry' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CONFLICT');
    assert.match(result.ok === false ? result.error.message : '', /open deal/i);
  });

  test('a database failure refuses rather than pretending nothing was asked', async () => {
    rpcResult = { data: null, error: { message: 'connection reset' } };
    const result = await mergeLeads({ winnerLeadId: '11111111-1111-4111-8111-111111111111', loserLeadId: '22222222-2222-4222-8222-222222222222', reason: 'dup inquiry' });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });
});
