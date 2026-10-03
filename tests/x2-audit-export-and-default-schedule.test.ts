import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Owner decisions 11 and 2 (round 2).
 *
 * 11: the audit export is role-gated (owner and ops admin) and every export is
 * itself logged BEFORE the file is sent; a log that fails means no file. The
 * real route handler is executed with the session, the reader and the database
 * stubbed.
 *
 * 2: the seeded structure 30/20/30/20 drives a quotation's schedule exactly:
 * the amounts are whole paise and add up to the total, for any total.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

let role = 'owner';
let logOutcome: { data: unknown; error: { message: string } | null } = { data: [{ outcome: 'logged' }], error: null };
const order: string[] = [];
const rpcCalls: [string, Record<string, unknown>][] = [];

const entry = (id: number) => ({ id, createdAt: '2026-10-01T10:00:00Z', action: 'lead.qualified', subjectType: 'lead', subjectId: null, actorType: 'user', actorId: null, correlationId: null, before: null, after: null });

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1' }) } });
mock.module('@/lib/audit/queries', {
  exports: {
    readAuditPage: async () => {
      order.push('read');
      return { entries: [entry(1), entry(2), entry(3)], pageCount: 1, total: 3 };
    },
  },
});
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          order.push(fn);
          rpcCalls.push([fn, args]);
          return logOutcome;
        },
      }),
    }),
  },
});

const route = await import('../app/api/audit/export/route.ts');
const standards = await import('../src/modules/sales/quotation-standards.ts');

beforeEach(() => {
  role = 'owner';
  logOutcome = { data: [{ outcome: 'logged' }], error: null };
  order.length = 0;
  rpcCalls.length = 0;
});

const get = (qs = '') => route.GET(new Request(`https://agencyos.test/api/audit/export${qs}`));

describe('the audit export (decision 11)', () => {
  test('the owner and the ops admin get the file, and the export is logged before it is sent, with the filters and the row count', async () => {
    for (const r of ['owner', 'ops_admin']) {
      role = r;
      order.length = 0;
      rpcCalls.length = 0;
      const response = await get('?action=lead.&from=2026-01-01');
      assert.equal(response.status, 200, r);
      assert.match(await response.text(), /^Id,At,Action/);
      assert.deepEqual(order, ['read', 'log_audit_export'], 'read, then logged, then sent');
      assert.deepEqual(rpcCalls[0]?.[1], { p_filters: { action: 'lead.', from: '2026-01-01' }, p_row_count: 3 });
    }
  });

  test('every other role is refused and nothing is read or logged', async () => {
    for (const r of ['delivery_lead', 'member', 'contractor', 'finance']) {
      role = r;
      order.length = 0;
      const response = await get();
      assert.equal(response.status, 403, r);
      assert.deepEqual(order, [], `${r}: nothing was read or logged`);
    }
  });

  test('when the export cannot be logged no file is produced', async () => {
    logOutcome = { data: null, error: { message: 'database down' } };
    const response = await get();
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /Id,At,Action/);
    logOutcome = { data: [{ outcome: 'not_authorized' }], error: null };
    assert.equal((await get()).status, 500, 'the database refusing the export refuses the file');
  });
});

describe('the default payment structure (decision 2)', () => {
  const seeded = {
    name: 'Standard (30/20/30/20)',
    milestones: [
      { label: 'Advance - Phase 2 kickoff', pct: 30 },
      { label: 'On UI prototype approval - Phase 4 complete', pct: 20 },
      { label: 'On development completion - Phase 5 complete', pct: 30 },
      { label: 'On testing completion - Phase 6 complete', pct: 20 },
    ],
  };

  test('it splits any total into four whole-paise amounts that add up exactly', () => {
    for (const total of [100_000_00, 1_23_457_00, 99_999_99, 1, 7_777_777]) {
      const schedule = standards.paymentScheduleFor(total, seeded);
      assert.equal(schedule.rows.length, 4);
      assert.deepEqual(schedule.rows.map((r) => r.pct), [30, 20, 30, 20]);
      assert.equal(schedule.rows.reduce((n, r) => n + r.amountMinor, 0), total, `total ${total}`);
      assert.ok(schedule.rows.every((r) => Number.isInteger(r.amountMinor)));
    }
  });

  test('a structure the owner wrote with another split still works: any split totalling 100', () => {
    const schedule = standards.paymentScheduleFor(100_000_00, { name: 'Half and half', milestones: [{ label: 'Now', pct: 50 }, { label: 'At handover', pct: 50 }] });
    assert.deepEqual(schedule.rows.map((r) => r.amountMinor), [50_000_00, 50_000_00]);
  });
});
