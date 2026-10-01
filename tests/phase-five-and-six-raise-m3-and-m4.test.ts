import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({}) } });
mock.module('@/lib/db/server', { exports: { createClient: async () => ({}) } });
mock.module('@/lib/db/admin', { exports: { createAdminClient: () => ({}) } });

const { HANDLER_JOB_KIND, HANDLERS, subscribersFor } = await import('../src/lib/events/catalog.ts');
const { handlePhaseFiveCompletedForFinance, handlePhaseSixCompletedForFinance } = await import('../src/modules/finance/handlers.ts');
const { generateM3Invoice, generateM4Invoice } = await import('../src/modules/finance/service.ts');
import { phaseCompletedEventSchema, task3CompleteAnnouncementFor, task4CompleteAnnouncementFor } from '../src/modules/crm/schema.ts';
import { completePhaseSchema } from '../src/modules/projects/phase-completion-schema.ts';

/**
 * Q-PH56 (owner, round 3): completing Phase 5 raises the M3 invoice and the PM's
 * Task 3 message; Phase 6 raises M4 and Task 4 — exactly as Phase 4 does for M2.
 */

describe('the events fan out exactly as Phase 4’s does', () => {
  test('Phase 4 is the pattern: an invoice handler and a PM announcement', () => {
    assert.deepEqual([...subscribersFor('project.phase_four_completed')], ['finance:generateM2Invoice', 'crm:announceTask2Complete']);
  });

  test('Phase 5 raises M3 and the Task 3 message', () => {
    assert.deepEqual([...subscribersFor('project.phase_five_completed')], ['finance:generateM3Invoice', 'crm:announceTask3Complete']);
  });

  test('Phase 6 raises M4 and the Task 4 message', () => {
    assert.deepEqual([...subscribersFor('project.phase_six_completed')], ['finance:generateM4Invoice', 'crm:announceTask4Complete']);
  });

  test('every new handler is registered with its own job kind', () => {
    const kinds = new Set<string>();
    for (const h of ['finance:generateM3Invoice', 'finance:generateM4Invoice', 'crm:announceTask3Complete', 'crm:announceTask4Complete'] as const) {
      assert.ok(HANDLERS.includes(h), h);
      kinds.add(HANDLER_JOB_KIND[h]);
    }
    assert.equal(kinds.size, 4);
  });
});

describe('a job that names no project is refused, not guessed at', () => {
  const job = { organization_id: 'org', payload: {} } as never;
  test('the M3 and M4 handlers fail permanently', async () => {
    for (const handler of [handlePhaseFiveCompletedForFinance, handlePhaseSixCompletedForFinance]) {
      const result = await handler({} as never, job);
      assert.equal(result.status, 'failed');
      assert.equal((result as { permanent?: boolean }).permanent, true);
    }
  });
});

describe('the messages and the request', () => {
  test('Task 3 and Task 4 messages name the task, the invoice and the project', () => {
    assert.match(task3CompleteAnnouncementFor({ projectName: 'Acme App' }), /Task 3 \(development\) is complete\. The M3 invoice is being raised\.\nProject: Acme App/);
    assert.match(task4CompleteAnnouncementFor({ projectName: null }), /Task 4 \(testing and QA\) is complete\. The M4 invoice is being raised\.\nProject: an unnamed project/);
  });

  test('the event payload the door emits parses', () => {
    const ok = phaseCompletedEventSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', phaseCompletionId: '22222222-2222-4222-8222-222222222222', phase: 5 });
    assert.equal(ok.success, true);
    assert.equal(phaseCompletedEventSchema.safeParse({ projectId: 'nope' }).success, false);
  });

  test('only Phase 5 and Phase 6 are completed this way', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    assert.equal(completePhaseSchema.safeParse({ projectId, phase: 5 }).success, true);
    assert.equal(completePhaseSchema.safeParse({ projectId, phase: 6 }).success, true);
    assert.equal(completePhaseSchema.safeParse({ projectId, phase: 4 }).success, false);
  });
});

/** A fake admin client: each table answers `maybeSingle()` with its row; rpc calls are recorded. */
function fakeAdmin(tables: Record<string, unknown>, rpcRow: unknown) {
  const seen = { positions: [] as unknown[], rpcs: [] as { fn: string; args: Record<string, unknown> }[], writes: 0 };
  const admin = {
    schema: () => ({
      from(table: string) {
        const builder: Record<string, unknown> = {};
        for (const m of ['select', 'neq', 'is', 'like', 'order', 'limit']) builder[m] = () => builder;
        builder.eq = (column: string, value: unknown) => {
          if (table === 'milestones' && column === 'position') seen.positions.push(value);
          return builder;
        };
        for (const m of ['insert', 'update', 'delete', 'upsert']) builder[m] = () => { seen.writes += 1; return builder; };
        builder.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
        return builder;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        seen.rpcs.push({ fn, args });
        return { data: [rpcRow], error: null };
      },
    }),
  };
  return { admin: admin as never, seen };
}

const scope = { organizationId: '22222222-2222-4222-8222-222222222222', projectId: '11111111-1111-4111-8111-111111111111' };
const tables = {
  milestones: { id: 'ms', name: 'On development completion (30%)', position: 3, status: 'pending', payment_percent: 30, amount_minor: 3_000_000, currency: 'INR', due_on: null },
  projects: { id: scope.projectId, name: 'Acme App', client_account_id: 'ca' },
  billing_profiles: { id: 'bp', mode: 'non_gst', legal_name: 'Acme Pvt Ltd', billing_address: '1 Road', billing_state: 'KA', gstin: null },
};

describe('M3 and M4 are raised from the milestone at their position', () => {
  test('M3 reads position 3 and M4 reads position 4', async () => {
    const m3 = fakeAdmin({}, null);
    const r3 = await generateM3Invoice(m3.admin, scope);
    assert.deepEqual(m3.seen.positions, [3]);
    assert.deepEqual(r3.ok && r3.data, { outcome: 'skipped', reason: 'no milestone at position 3' });

    const m4 = fakeAdmin({}, null);
    const r4 = await generateM4Invoice(m4.admin, scope);
    assert.deepEqual(m4.seen.positions, [4]);
    assert.deepEqual(r4.ok && r4.data, { outcome: 'skipped', reason: 'no milestone at position 4' });
  });

  test('a ready milestone is invoiced through the invoice door, once, and nothing is marked paid', async () => {
    const { admin, seen } = fakeAdmin(tables, { outcome: 'created', invoice_id: 'inv-1', number: 'INV-2026-0003' });
    const result = await generateM3Invoice(admin, scope);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.data, { outcome: 'created', invoiceId: 'inv-1', number: 'INV-2026-0003', created: true });
    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.fn, 'create_milestone_invoice');
    assert.equal(seen.rpcs[0]?.args.p_milestone_id, 'ms');
    assert.equal(seen.rpcs[0]?.args.p_total_minor, 3_000_000);
    assert.equal(seen.writes, 0, 'no direct write to any table');
  });

  test('a replay answers already_invoiced', async () => {
    const { admin } = fakeAdmin(tables, { outcome: 'already_invoiced', invoice_id: 'inv-1', number: 'INV-2026-0003' });
    const result = await generateM4Invoice(admin, scope);
    assert.equal(result.ok && result.data.outcome, 'already_invoiced');
  });

  test('an incomplete billing profile is reported, not invoiced', async () => {
    const { admin, seen } = fakeAdmin({ ...tables, billing_profiles: { id: 'bp', mode: 'non_gst', legal_name: '', billing_address: '', billing_state: '', gstin: null } }, null);
    const result = await generateM3Invoice(admin, scope);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : '', /Phase 5 completed but the billing profile is incomplete/);
    assert.equal(seen.rpcs.length, 0);
  });
});
