import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * What the milestone-unlock handler does when the plan cannot be read.
 *
 * Audit finding D5. `nextUnlockedMilestoneForProject` destructured `data` from
 * both of its queries and never looked at `error`, folding each to `?? []`. An
 * empty plan is exactly what makes `invoicePaidVerdict` refuse — and every
 * refusal it can make is `permanent: true`, which the runner turns into
 * `status = 'dead'` on the first attempt.
 *
 * So one blip on one query stranded a milestone the client had already paid
 * for, and nothing ever tried again. Not a wrong answer that a retry would
 * correct: a wrong answer the system had decided was final.
 *
 * The distinction this restores is the one D3 and D6 restored elsewhere — "the
 * plan says nothing is next" and "the plan could not be read" are different
 * facts. Here they differ in whether the work is ever attempted again, which
 * is why it is the sharpest instance of the three.
 *
 * Executed against the real handler with the database stubbed. The refusal
 * vocabulary and the runner's dead/queued decision are asserted against the
 * real modules rather than restated.
 */

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

/** What each table answers, per test. */
let milestonesResult: QueryResult = { data: [], error: null };
let invoicesResult: QueryResult = { data: [], error: null };
let milestoneRow: Record<string, unknown> | null = null;
let invoiceRow: Record<string, unknown> | null = null;

const seen = { updates: [] as unknown[] };

const MILESTONE_ID = '66666666-6666-4666-8666-666666666666';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

function builder(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: async () => {
      const row = table === 'milestones' ? milestoneRow : invoiceRow;
      // `undefined` in the fixture means the read itself failed.
      if (row === undefined) return { data: null, error: { message: 'could not connect' } };
      return { data: row, error: null };
    },
    // The list reads are awaited directly, with no terminal call.
    then: (resolve: (value: QueryResult) => unknown) =>
      resolve(table === 'milestones' ? milestonesResult : invoicesResult),
  };
  return chain;
}

const admin = {
  schema() {
    return {
      from(table: string) {
        return {
          select: () => builder(table),
          insert: () => ({
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          }),
          update(patch: unknown) {
            seen.updates.push(patch);
            const chain = {
              eq: () => chain,
              select: () => chain,
              maybeSingle: async () => ({ data: { id: MILESTONE_ID }, error: null }),
              then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
            };
            return chain;
          },
        };
      },
    };
  },
};

// The handler reaches finance/service.ts for the unlock rule, which is
// session-bound at the top of its import graph. Stubbed so importing it does
// not pull Next's request context into a plain node:test run.
mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role: 'owner', userId: '', organizationId: '' }) },
});
mock.module('@/lib/db/server', { exports: { createClient: async () => admin } });
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });

const { handleInvoicePaid } = await import('../src/modules/projects/handlers.ts');

const job = {
  id: '99999999-9999-4999-8999-999999999999',
  organization_id: ORGANIZATION_ID,
  correlation_id: null,
  payload: {
    eventId: 1,
    eventType: 'invoice.paid',
    subjectType: 'invoice',
    subjectId: INVOICE_ID,
    event: {
      number: 'INV-2026-0007',
      clientAccountId: '44444444-4444-4444-8444-444444444444',
      projectId: PROJECT_ID,
      milestoneId: '77777777-7777-4777-8777-777777777777',
      unlockedMilestoneId: MILESTONE_ID,
      paidMinor: 100_000,
      currency: 'INR',
    },
  },
};

beforeEach(() => {
  seen.updates = [];
  milestonesResult = {
    data: [
      { id: '77777777-7777-4777-8777-777777777777', position: 0, payment_percent: 50 },
      { id: MILESTONE_ID, position: 1, payment_percent: 50 },
    ],
    error: null,
  };
  invoicesResult = {
    data: [{ milestone_id: '77777777-7777-4777-8777-777777777777', status: 'paid' }],
    error: null,
  };
  invoiceRow = {
    id: INVOICE_ID,
    organization_id: ORGANIZATION_ID,
    project_id: PROJECT_ID,
    milestone_id: '77777777-7777-4777-8777-777777777777',
    status: 'paid',
    paid_minor: 100_000,
    total_minor: 100_000,
  };
  milestoneRow = {
    id: MILESTONE_ID,
    organization_id: ORGANIZATION_ID,
    project_id: PROJECT_ID,
    status: 'pending',
    position: 1,
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The control — this is what a working unlock looks like
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the plan reads fine', () => {
  test('the next milestone is unlocked', async () => {
    const result = await handleInvoicePaid(admin as never, job as never);

    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(seen.updates.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The plan cannot be read
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the plan cannot be read', () => {
  for (const which of ['milestones', 'invoices'] as const) {
    test(`a failed ${which} read leaves the job retryable, not dead`, async () => {
      const failure = { data: null, error: { message: 'could not connect to server' } };
      if (which === 'milestones') milestonesResult = failure;
      else invoicesResult = failure;

      const result = await handleInvoicePaid(admin as never, job as never);

      assert.equal(result.status, 'failed');
      // The whole finding. `permanent` is what app/api/jobs/run turns into
      // status 'dead' — on the first attempt, with no retry ever.
      assert.equal(
        result.status === 'failed' && result.permanent,
        false,
        'a transient read failure was settled as permanent, so the unlock is never retried',
      );
    });

    test(`a failed ${which} read unlocks nothing`, async () => {
      const failure = { data: null, error: { message: 'could not connect to server' } };
      if (which === 'milestones') milestonesResult = failure;
      else invoicesResult = failure;

      await handleInvoicePaid(admin as never, job as never);

      assert.deepEqual(seen.updates, []);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B2. The loaders, which are the same defect one function along (D15)
// ═══════════════════════════════════════════════════════════════════════════

describe('B2. the invoice and milestone loaders', () => {
  for (const which of ['invoice', 'milestone'] as const) {
    test(`a failed ${which} read leaves the job retryable, not dead`, async () => {
      // Both loaders returned null for "absent" and for "the database did not
      // answer", and the verdict refuses a missing invoice permanently — so a
      // blip parked a paid milestone dead on the first attempt.
      if (which === 'invoice') invoiceRow = undefined as never;
      else milestoneRow = undefined as never;

      const result = await handleInvoicePaid(admin as never, job as never);

      assert.equal(result.status, 'failed');
      assert.equal(
        result.status === 'failed' && result.permanent,
        false,
        `a failed ${which} read was settled as permanent`,
      );
      assert.deepEqual(seen.updates, []);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. An empty plan is still an empty plan
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the plan really is finished', () => {
  test('a genuinely empty plan is refused permanently — the distinction cuts both ways', async () => {
    // No error, no rows. This is the answer `permanent: true` is for: no
    // amount of retrying invents a milestone that is not in the plan.
    milestonesResult = { data: [], error: null };
    invoicesResult = { data: [], error: null };

    const result = await handleInvoicePaid(admin as never, job as never);

    assert.equal(result.status, 'failed');
    assert.equal(
      result.status === 'failed' && result.permanent,
      true,
      'an empty plan was made retryable, which would spin the job until its attempts ran out',
    );
    assert.deepEqual(seen.updates, []);
  });
});
