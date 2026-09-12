import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * A deal that is handed off — PH1-CLS-002.
 *
 * CRM Doc 09 §33: "Handoff completion should be a real workflow event, not
 * simply a note." Until this, the project appearing WAS the note.
 *
 * Two halves. The row's rules are read as source and proved against a real
 * Postgres by `db:verify:handoff` and by scripts/apply-migrations-locally.sh.
 * The service's half — turning the database's verdict into a boolean the
 * caller can act on, and never throwing over a project that already exists —
 * is EXECUTED with only the database stubbed.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911180000_a_deal_that_is_handed_off.sql'));

// ═══════════════════════════════════════════════════════════════════════════
// A. The event, and the row
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a real workflow event, not a note', () => {
  test('opportunity.handed_off is a declared event type, and is emitted', () => {
    // Deliberately the opposite call from G-227: there `meeting.booked` was
    // NOT declared because no source named it. Here Doc 09 §33 names it.
    assert.match(SQL, /insert into core\.event_types \(type, description, canonical\) values\s*\n\s*\('opportunity\.handed_off'/);
    assert.match(SQL, /perform core\.emit_event\(\s*\n\s*v_opp\.organization_id, 'opportunity\.handed_off', 'opportunity', v_opp\.id/);
  });

  test('the handoff is Sales handing to the Project Manager, born queued', () => {
    // §13.4 field 8: packet READY, Phase 2 NOT activated. Both agents are
    // disabled; the row waits with no receiver, and that is the design.
    assert.match(SQL, /'sales', 'project_manager', 'queued'/);
  });

  test('a deal is handed off once — under the lock, and at the row', () => {
    // The row-level half. The lock-level half (already_recorded) is executed
    // by db:verify:handoff §5, and was driven live on a local Postgres.
    assert.match(SQL, /create unique index if not exists handoffs_won_handoff_key/);
  });

  test('it runs as DEFINER with the tenancy guard explicit, and the service role trusted', () => {
    assert.match(SQL, /security definer\s*\n\s*set search_path = ''\s*\n\s*as \$\$\s*\n\s*declare\s*\n\s*v_actor\s+uuid := \(select auth\.uid\(\)\);/);
    assert.match(SQL, /if v_actor is not null\s*\n\s*and v_opp\.organization_id is distinct from \(select core\.current_organization_id\(\)\) then/);
  });

  test('what the packet does not know, it lists by name (ADM-72)', () => {
    for (const absence of ['accepted_quotation', 'requirement_version', 'requirement_version_not_accepted', 'approval', 'contact', 'conversation_summary', 'payment_evidence', 'acceptance_actor', 'project_proposal_differs', 'project_rebound']) {
      assert.match(SQL, new RegExp(`(v_unresolved|h\\.unresolved) \\|\\| '"${absence}"'::jsonb`), `${absence} is never named as absent`);
    }
  });

  test('it is written at the moment of the win, by the transition itself', () => {
    // §13.4 field 8 — READY at the win, not at a later optional click. The
    // trigger fires on the transition only, as the gate does.
    assert.match(SQL, /create trigger opportunities_won_handoff\s*\n\s*after update of stage on sales\.opportunities/);
  });

  test('a portal client cannot call the door; staff can', () => {
    // Review: DEFINER + granted to authenticated + org check only = a client
    // of the same organization writing a handoff, an event and an audit row
    // the table policies deny them. The trigger and conversion are staff.
    assert.match(SQL, /if v_actor is not null and not \(select core\.is_internal\(\)\) then\s*\n\s*return query select 'forbidden'/);
  });

  test('the trigger keeps its promise: an answer other than recorded or already_recorded fails the close', () => {
    assert.match(SQL, /if v_outcome is null or v_outcome not in \('recorded', 'already_recorded'\) then\s*\n\s*raise exception 'won_handoff: %'/);
  });

  test('decisions cannot be NULL — an ADM-72 project has neither an approval nor a proposal', () => {
    // Found rereading the first draft: jsonb_agg over zero rows is NULL, the
    // column is NOT NULL, and the row that would have failed is exactly the
    // one whose absences the packet exists to record.
    assert.match(SQL, /coalesce\(\(select jsonb_agg\(d\) from \(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The service's half — executed
// ═══════════════════════════════════════════════════════════════════════════

const OPP = '99999999-9999-4999-8999-999999999999';
const PROJECT = '88888888-8888-4888-8888-888888888888';

let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, Record<string, unknown>][], errors: [] as string[] };

const client = {
  schema: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      seen.rpcs.push([fn, args]);
      return rpcOutcome;
    },
  }),
};

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role: 'owner', userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client } });

const { conversionMessage, recordWonHandoff } = await import('../src/modules/sales/service.ts');

const originalError = console.error;

beforeEach(() => {
  rpcOutcome = { data: null, error: null };
  seen.rpcs.length = 0;
  seen.errors.length = 0;
  console.error = (line: string) => { seen.errors.push(String(line)); };
});

describe('B1. it asks the one door, with this deal and this project', () => {
  test('sales.record_won_handoff, with both ids', async () => {
    rpcOutcome = { data: [{ outcome: 'recorded', handoff_id: 'h-1' }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordWonHandoff(client as any, OPP, PROJECT);

    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.[0], 'record_won_handoff');
    assert.equal(seen.rpcs[0]?.[1]?.p_opportunity_id, OPP);
    assert.equal(seen.rpcs[0]?.[1]?.p_project_id, PROJECT);
  });
});

describe('B2. the packet exists, or it does not — and the caller is told which', () => {
  test('recorded now → true, and nothing is logged', async () => {
    rpcOutcome = { data: [{ outcome: 'recorded', handoff_id: 'h-1' }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), true);
    assert.equal(seen.errors.length, 0);
  });

  test('project bound → true: the trigger wrote the packet at the win; conversion named the project', async () => {
    rpcOutcome = { data: [{ outcome: 'project_bound', handoff_id: 'h-1' }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), true);
    assert.equal(seen.errors.length, 0);
    assert.equal(seen.rpcs[0]?.[1]?.p_project_id, PROJECT, 'conversion always names its project');
  });

  test('already recorded → true: a second click or a repairing re-run is a success', async () => {
    rpcOutcome = { data: [{ outcome: 'already_recorded', handoff_id: 'h-1' }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), true);
    assert.equal(seen.errors.length, 0);
  });

  test('a row delivered bare rather than in an array is still read', async () => {
    rpcOutcome = { data: { outcome: 'recorded', handoff_id: 'h-1' }, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), true);
  });

  test('every refusal → false, logged with the database’s own word', async () => {
    for (const outcome of ['not_won', 'project_mismatch', 'not_found', 'forbidden']) {
      seen.errors.length = 0;
      rpcOutcome = { data: [{ outcome, handoff_id: null }], error: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), false, `${outcome} read as recorded`);
      assert.equal(seen.errors.length, 1, `${outcome} was not logged`);
      assert.match(seen.errors[0] ?? '', new RegExp(outcome), `the log does not name ${outcome}`);
      assert.match(seen.errors[0] ?? '', new RegExp(PROJECT), 'the log does not name the project');
    }
  });

  test('a transport error → false, logged, and never thrown', async () => {
    // The project this belongs to is already real. A throw here would surface
    // as a failed conversion over a project that exists, which is the lie
    // §33 exists to prevent in the other direction.
    rpcOutcome = { data: null, error: { message: 'connection reset' } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recordWonHandoff(client as any, OPP, PROJECT);

    assert.equal(result, false);
    assert.equal(seen.errors.length, 1);
    assert.match(seen.errors[0] ?? '', /connection reset/);
  });

  test('no row at all → false, and says so', async () => {
    rpcOutcome = { data: [], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), false);
    assert.match(seen.errors[0] ?? '', /no answer/);
  });

  test('an outcome nobody planned for is not a success', async () => {
    rpcOutcome = { data: [{ outcome: 'partially_recorded', handoff_id: 'h-9' }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await recordWonHandoff(client as any, OPP, PROJECT), false);
    assert.match(seen.errors[0] ?? '', /partially_recorded/);
  });
});

describe('B3. what the operator is told is what happened', () => {
  // Review: the declared return type erased handoffRecorded, so the one caller
  // said "Client and project created." whether or not the handoff was. The
  // sentence is now a function of both facts, and it is executed here.
  test('created and handed off → the plain success', () => {
    assert.equal(conversionMessage({ created: true, handoffRecorded: true }), 'Client and project created.');
  });

  test('created but the handoff was refused → the operator is told, and told what to do', () => {
    const line = conversionMessage({ created: true, handoffRecorded: false });
    assert.match(line, /^Client and project created\./);
    assert.match(line, /handoff was NOT recorded/);
    assert.match(line, /re-run the conversion/);
  });

  test('already converted → says so, and still reports the handoff', () => {
    assert.match(conversionMessage({ created: false, handoffRecorded: true }), /already converted/);
    const repair = conversionMessage({ created: false, handoffRecorded: false });
    assert.match(repair, /already converted/);
    assert.match(repair, /NOT recorded/);
  });
});

describe('B4. the log is a structured line, like every other in this repository', () => {
  test('level, scope and detail, as JSON', async () => {
    rpcOutcome = { data: [{ outcome: 'not_won', handoff_id: null }], error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordWonHandoff(client as any, OPP, PROJECT);
    const parsed = JSON.parse(seen.errors[0] ?? '{}');

    assert.equal(parsed.level, 'error');
    assert.equal(parsed.scope, 'convertToProject.handoff');
    assert.match(parsed.detail, /WON handoff was not recorded/);
  });
});

test('restore console.error', () => {
  console.error = originalError;
  assert.ok(true);
});
