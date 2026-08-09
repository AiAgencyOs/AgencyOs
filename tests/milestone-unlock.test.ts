import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  invoicePaidEventSchema,
  invoicePaidVerdict,
  MILESTONE_STATUSES,
  UNLOCKED_MILESTONE_STATUSES,
  type InvoicePaidFacts,
  type MilestoneStatus,
} from '../src/modules/projects/schema.ts';

/**
 * The `invoice.paid` → next-milestone rule, judged in isolation.
 *
 * `invoicePaidVerdict` is pure, so every refusal this handler can produce is
 * reachable here without a database, a queue, or a payment. That matters most
 * for the branches that are hardest to arrange in real life — a stale event,
 * a cross-tenant payload, a milestone that is not actually next.
 */

const ORG = 'org-1';
const PROJECT = 'project-1';
const PAID_MILESTONE = 'milestone-1';
const NEXT_MILESTONE = 'milestone-2';
const INVOICE = 'invoice-1';

/** The world as it looks when milestone 1's invoice has just been paid. */
function facts(overrides: Partial<InvoicePaidFacts> = {}): InvoicePaidFacts {
  return {
    jobOrganizationId: ORG,
    invoiceId: INVOICE,
    event: {
      projectId: PROJECT,
      milestoneId: PAID_MILESTONE,
      unlockedMilestoneId: NEXT_MILESTONE,
    },
    invoice: {
      id: INVOICE,
      organizationId: ORG,
      projectId: PROJECT,
      milestoneId: PAID_MILESTONE,
      status: 'paid',
      paidMinor: 30_000_00,
      totalMinor: 30_000_00,
    },
    target: {
      id: NEXT_MILESTONE,
      organizationId: ORG,
      projectId: PROJECT,
      status: 'pending',
    },
    intendedNextMilestoneId: NEXT_MILESTONE,
    ...overrides,
  };
}

// ── C. the happy path ──────────────────────────────────────────────────────

describe('unlocking the next milestone', () => {
  test('C. a paid milestone invoice unlocks the milestone after it', () => {
    assert.deepEqual(invoicePaidVerdict(facts()), {
      outcome: 'unlock',
      milestoneId: NEXT_MILESTONE,
    });
  });

  test('only the named milestone is considered — nothing else is touched', () => {
    // The verdict addresses exactly one milestone. Anything that would move a
    // second one has to come from a second event.
    const verdict = invoicePaidVerdict(facts());
    assert.equal(verdict.outcome === 'unlock' && verdict.milestoneId, NEXT_MILESTONE);
  });
});

// ── D/E/F. the event must describe reality ─────────────────────────────────

describe('validation of the event against the database', () => {
  test('D. an event naming a different project than the invoice is refused', () => {
    const verdict = invoicePaidVerdict(
      facts({ event: { projectId: 'other-project', milestoneId: PAID_MILESTONE, unlockedMilestoneId: NEXT_MILESTONE } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.equal(verdict.outcome === 'refuse' && verdict.permanent, true);
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /project/);
  });

  test('E. an event naming a different milestone than the invoice is refused', () => {
    const verdict = invoicePaidVerdict(
      facts({ event: { projectId: PROJECT, milestoneId: 'other-milestone', unlockedMilestoneId: NEXT_MILESTONE } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /milestone/);
  });

  test('F. an invoice belonging to another organization is refused', () => {
    const verdict = invoicePaidVerdict(
      facts({ invoice: { ...facts().invoice!, organizationId: 'org-2' } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.equal(verdict.outcome === 'refuse' && verdict.permanent, true);
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /organization/);
  });

  test('F. a target milestone belonging to another organization is refused', () => {
    const verdict = invoicePaidVerdict(
      facts({ target: { ...facts().target!, organizationId: 'org-2' } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /organization/);
  });

  test('F. an invoice the organization cannot see is refused, never assumed', () => {
    // The handler scopes its lookup by organization_id, so a cross-tenant id
    // simply finds nothing. "Not found" must not become "proceed anyway".
    const verdict = invoicePaidVerdict(facts({ invoice: null }));
    assert.equal(verdict.outcome, 'refuse');
    assert.equal(verdict.outcome === 'refuse' && verdict.permanent, true);
  });

  test('a target milestone in a different project is refused', () => {
    const verdict = invoicePaidVerdict(
      facts({ target: { ...facts().target!, projectId: 'other-project' } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /project/);
  });

  test('a missing target milestone is refused', () => {
    assert.equal(invoicePaidVerdict(facts({ target: null })).outcome, 'refuse');
  });

  test('an event with no invoice id is refused', () => {
    assert.equal(invoicePaidVerdict(facts({ invoiceId: null })).outcome, 'refuse');
  });
});

// ── G. the invoice must actually be paid ───────────────────────────────────

describe('the invoice must actually be paid', () => {
  for (const status of ['draft', 'pending_approval', 'issued', 'partially_paid', 'overdue', 'void']) {
    test(`G. a ${status} invoice unlocks nothing`, () => {
      const verdict = invoicePaidVerdict(
        facts({ invoice: { ...facts().invoice!, status } }),
      );
      assert.equal(verdict.outcome, 'refuse');
      assert.equal(verdict.outcome === 'refuse' && verdict.permanent, true);
      assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /not paid/);
    });
  }

  test('G. an invoice marked paid whose payments do not cover it is refused', () => {
    // Status and money must agree. They can only disagree through a write that
    // bypassed recordManualPayment — exactly the case worth catching.
    const verdict = invoicePaidVerdict(
      facts({ invoice: { ...facts().invoice!, paidMinor: 10_000_00, totalMinor: 30_000_00 } }),
    );
    assert.equal(verdict.outcome, 'refuse');
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /do not cover/);
  });

  test('an overpaid invoice is still paid — the guard is one-sided', () => {
    const verdict = invoicePaidVerdict(
      facts({ invoice: { ...facts().invoice!, paidMinor: 30_000_01, totalMinor: 30_000_00 } }),
    );
    assert.equal(verdict.outcome, 'unlock');
  });
});

// ── H/I. redelivery ────────────────────────────────────────────────────────

describe('idempotency under redelivery', () => {
  for (const status of UNLOCKED_MILESTONE_STATUSES) {
    test(`H. a milestone that is already ${status} stays ${status}`, () => {
      const verdict = invoicePaidVerdict(
        facts({ target: { ...facts().target!, status } }),
      );
      assert.equal(verdict.outcome, 'already_unlocked');
      assert.equal(verdict.outcome === 'already_unlocked' && verdict.status, status);
    });
  }

  test('I. replaying the same event twice never yields a second unlock', () => {
    // First delivery unlocks; the world then has the milestone in_progress,
    // which is the state the second delivery sees.
    const first = invoicePaidVerdict(facts());
    assert.equal(first.outcome, 'unlock');

    const second = invoicePaidVerdict(
      facts({ target: { ...facts().target!, status: 'in_progress' } }),
    );
    assert.equal(second.outcome, 'already_unlocked');
  });

  test('I. a submitted milestone is not dragged back to in_progress', () => {
    const verdict = invoicePaidVerdict(facts({ target: { ...facts().target!, status: 'submitted' } }));
    assert.equal(verdict.outcome, 'already_unlocked');
  });

  test('a rejected milestone is not unlocked by a payment', () => {
    const verdict = invoicePaidVerdict(facts({ target: { ...facts().target!, status: 'rejected' } }));
    assert.equal(verdict.outcome, 'refuse');
  });

  test('an unrecognised milestone status is refused rather than guessed at', () => {
    const verdict = invoicePaidVerdict(facts({ target: { ...facts().target!, status: 'archived' } }));
    assert.equal(verdict.outcome, 'refuse');
  });
});

// ── J. the end of the plan ─────────────────────────────────────────────────

describe('the final milestone', () => {
  test('J. a plan with nothing left unlocks nothing and invents nothing', () => {
    const verdict = invoicePaidVerdict(
      facts({
        event: { projectId: PROJECT, milestoneId: PAID_MILESTONE, unlockedMilestoneId: null },
        target: null,
        intendedNextMilestoneId: null,
      }),
    );

    assert.equal(verdict.outcome, 'nothing_to_unlock');
    assert.match(verdict.outcome === 'nothing_to_unlock' ? verdict.reason : '', /no further/);
  });

  test('J. the final payment is a success, not a failure', () => {
    // A job that ends here must not be parked as dead: nothing went wrong.
    const verdict = invoicePaidVerdict(
      facts({
        event: { projectId: PROJECT, milestoneId: PAID_MILESTONE, unlockedMilestoneId: null },
        target: null,
        intendedNextMilestoneId: null,
      }),
    );
    assert.notEqual(verdict.outcome, 'refuse');
  });

  test('an invoice with no project or milestone has nothing to gate', () => {
    const verdict = invoicePaidVerdict(
      facts({
        event: { projectId: null, milestoneId: null, unlockedMilestoneId: null },
        invoice: { ...facts().invoice!, projectId: null, milestoneId: null },
        target: null,
        intendedNextMilestoneId: null,
      }),
    );
    assert.equal(verdict.outcome, 'nothing_to_unlock');
  });
});

// ── no skipping ────────────────────────────────────────────────────────────

describe('milestones are never skipped', () => {
  test('an event naming a milestone the live plan does not unlock next is refused', () => {
    // The decisive check. The payload says "open milestone 4"; the plan says
    // milestone 2 is next, because 2 and 3 are unpaid. The plan wins.
    const verdict = invoicePaidVerdict(
      facts({
        event: { projectId: PROJECT, milestoneId: PAID_MILESTONE, unlockedMilestoneId: 'milestone-4' },
        target: { id: 'milestone-4', organizationId: ORG, projectId: PROJECT, status: 'pending' },
        intendedNextMilestoneId: NEXT_MILESTONE,
      }),
    );

    assert.equal(verdict.outcome, 'refuse');
    assert.equal(verdict.outcome === 'refuse' && verdict.permanent, true);
    assert.match(verdict.outcome === 'refuse' ? verdict.reason : '', /does not unlock next/);
  });

  test('a stale event is refused once the plan has moved past it', () => {
    const verdict = invoicePaidVerdict(facts({ intendedNextMilestoneId: 'milestone-3' }));
    assert.equal(verdict.outcome, 'refuse');
  });

  test('an event unlocking nothing while the plan has more is reported, not acted on', () => {
    const verdict = invoicePaidVerdict(
      facts({
        event: { projectId: PROJECT, milestoneId: PAID_MILESTONE, unlockedMilestoneId: null },
        target: null,
        intendedNextMilestoneId: NEXT_MILESTONE,
      }),
    );
    assert.equal(verdict.outcome, 'nothing_to_unlock');
    assert.match(verdict.outcome === 'nothing_to_unlock' ? verdict.reason : '', /moved on/);
  });
});

// ── payload parsing ────────────────────────────────────────────────────────

describe('the invoice.paid payload', () => {
  test('parses the event finance actually emits', () => {
    const emitted = {
      number: 'INV-2026-0001',
      clientAccountId: '00000000-0000-4000-8000-0000000000c1',
      projectId: '00000000-0000-4000-8000-0000000000p1'.replace(/p/g, '1'),
      milestoneId: '00000000-0000-4000-8000-0000000000m1'.replace(/m/g, '2'),
      unlockedMilestoneId: '00000000-0000-4000-8000-0000000000m2'.replace(/m/g, '3'),
      paidMinor: 3_000_000,
      currency: 'INR',
    };

    const parsed = invoicePaidEventSchema.safeParse(emitted);
    assert.equal(parsed.success, true);
  });

  test('extra fields are kept, not rejected — publishers may add to an event', () => {
    const parsed = invoicePaidEventSchema.safeParse({
      projectId: null,
      milestoneId: null,
      unlockedMilestoneId: null,
      somethingNew: 'later',
    });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && (parsed.data as { somethingNew?: string }).somethingNew, 'later');
  });

  test('malformed payloads are rejected rather than coerced', () => {
    for (const payload of [
      null,
      undefined,
      'not an object',
      42,
      {},
      { projectId: 'not-a-uuid', milestoneId: null, unlockedMilestoneId: null },
      { projectId: null, milestoneId: null },
    ]) {
      assert.equal(
        invoicePaidEventSchema.safeParse(payload).success,
        false,
        `${JSON.stringify(payload)} should not parse`,
      );
    }
  });
});

// ── the milestone state machine ────────────────────────────────────────────

describe('the milestone state machine is the one the database already had', () => {
  test('the vocabulary matches migration 006 exactly', () => {
    assert.deepEqual([...MILESTONE_STATUSES], [
      'pending',
      'in_progress',
      'submitted',
      'met',
      'rejected',
    ]);
  });

  test('there is no "unlocked" status — unlocking means in_progress', () => {
    assert.ok(!(MILESTONE_STATUSES as readonly string[]).includes('unlocked'));
    assert.ok(UNLOCKED_MILESTONE_STATUSES.includes('in_progress'));
  });

  test('pending and rejected are not "already unlocked"', () => {
    for (const status of ['pending', 'rejected'] as MilestoneStatus[]) {
      assert.ok(!UNLOCKED_MILESTONE_STATUSES.includes(status));
    }
  });

  test('every unlocked status is a real milestone status', () => {
    for (const status of UNLOCKED_MILESTONE_STATUSES) {
      assert.ok(MILESTONE_STATUSES.includes(status));
    }
  });
});
