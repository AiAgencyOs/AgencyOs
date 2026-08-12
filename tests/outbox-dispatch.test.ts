import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  dedupeKeyFor,
  planJobsForEvent,
  subscribersFor,
  HANDLERS,
  HANDLER_JOB_KIND,
  SUBSCRIPTIONS,
  type OutboxEvent,
} from '../src/lib/events/catalog.ts';

/**
 * The dispatcher's decisions, without a queue.
 *
 * Everything that decides *what* an event turns into is pure, so the parts
 * worth being sure about — that redelivery produces the same key, that the
 * payload survives untouched, that nothing is enqueued for an event nobody
 * listens to — are testable directly.
 */

/** The event finance/service.ts actually emits when an invoice is paid. */
const invoicePaid: OutboxEvent = {
  id: 4242,
  organization_id: 'org-1',
  type: 'invoice.paid',
  subject_type: 'invoice',
  subject_id: 'invoice-1',
  payload: {
    number: 'INV-2026-0001',
    clientAccountId: 'client-1',
    projectId: 'project-1',
    milestoneId: 'milestone-1',
    unlockedMilestoneId: 'milestone-2',
    paidMinor: 30_000_00,
    currency: 'INR',
  },
};

/**
 * A. The publisher's half of the contract.
 *
 * Everything below tests what happens *to* an `invoice.paid` event. This one
 * checks that it is still published, and still carries the three fields the
 * handler navigates by — the assertion that would otherwise only be caught by
 * a live run.
 *
 * It reads the migration rather than finance/service.ts. Audit finding D17
 * moved publication into finance.record_manual_payment, so that the event and
 * the payment commit together; scanning the service for it would now find
 * nothing. A source check rather than a call, because publishing requires a
 * database; what is worth pinning here is the shape.
 */
describe('finance publishes invoice.paid', () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        '../supabase/migrations/20260812120004_events_written_where_the_state_changes.sql',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  /** An index that is a real position, or the assertion fails saying why. */
  function at(needle: string): number {
    const index = migration.indexOf(needle);
    assert.ok(index >= 0, `the migration no longer contains ${needle}`);
    return index;
  }

  test('A. an invoice paid in full publishes an invoice.paid event', () => {
    assert.match(migration, /'invoice\.paid'/);
  });

  test('A. the event carries projectId, milestoneId and unlockedMilestoneId', () => {
    const emission = migration.slice(at("'invoice.paid'"), at("'invoice.paid'") + 700);
    for (const field of ['projectId', 'milestoneId', 'unlockedMilestoneId']) {
      assert.match(emission, new RegExp(`'${field}'`), `the event no longer carries ${field}`);
    }
  });

  test('A. it is published only when the invoice is fully paid', () => {
    // The emission sits inside the `v_new = 'paid'` branch. A partial payment
    // must not open the next milestone.
    const branch = at("if v_new = 'paid' then");
    const emission = at("'invoice.paid'");
    assert.ok(
      branch < emission,
      'invoice.paid is published outside the fully-paid branch, so a partial payment would open the next milestone',
    );
  });

  test('A. and it is published after the invoice total is written, not before', () => {
    // `next_unlocked_milestone` answers "the first priced milestone with no
    // paid invoice". Before the UPDATE lands that is the milestone being paid
    // for right now, so publishing above it would name the wrong one every
    // time.
    assert.ok(at('set paid_minor = v_after') < at("'invoice.paid'"));
  });
});

describe('the subscription catalog', () => {
  test('invoice.paid is consumed by the milestone unlock handler', () => {
    assert.deepEqual(subscribersFor('invoice.paid'), ['projects:unlockNextMilestone']);
  });

  test('an event nobody listens to has no subscribers', () => {
    for (const type of ['invoice.issued', 'invoice.created', 'payment.recorded', 'nonsense']) {
      assert.deepEqual(subscribersFor(type), [], `${type} should have no subscriber yet`);
    }
  });

  test('every declared handler has a job kind to run under', () => {
    for (const handler of HANDLERS) {
      assert.ok(HANDLER_JOB_KIND[handler], `${handler} has no job kind`);
    }
  });

  test('every subscribed handler is a declared handler', () => {
    for (const [type, handlers] of Object.entries(SUBSCRIPTIONS)) {
      for (const handler of handlers) {
        assert.ok(HANDLERS.includes(handler), `${type} subscribes unknown handler ${handler}`);
      }
    }
  });
});

describe('dedupe keys', () => {
  test('are the (event, handler) pair, per ARCHITECTURE §9.1', () => {
    assert.equal(dedupeKeyFor(7, 'projects:unlockNextMilestone'), 'evt:7:projects:unlockNextMilestone');
  });

  test('the same event and handler always produce the same key', () => {
    // This is the whole of at-least-once safety: redelivery re-derives the key
    // the first pass used, so the unique index turns the insert into a no-op.
    assert.equal(
      dedupeKeyFor(invoicePaid.id, 'projects:unlockNextMilestone'),
      dedupeKeyFor(invoicePaid.id, 'projects:unlockNextMilestone'),
    );
  });

  test('different events never share a key', () => {
    assert.notEqual(
      dedupeKeyFor(1, 'projects:unlockNextMilestone'),
      dedupeKeyFor(2, 'projects:unlockNextMilestone'),
    );
  });
});

describe('planJobsForEvent', () => {
  test('an invoice.paid event plans exactly one unlock job', () => {
    const jobs = planJobsForEvent(invoicePaid);

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.kind, 'milestone.unlock');
    assert.equal(jobs[0]?.dedupe_key, 'evt:4242:projects:unlockNextMilestone');
  });

  test('the organization comes from the event row, not its payload', () => {
    // The payload is data a handler has yet to validate; the row's column is
    // the tenancy the emitter's RLS policy already vouched for.
    const spoofed: OutboxEvent = {
      ...invoicePaid,
      payload: { ...(invoicePaid.payload as object), organizationId: 'org-attacker' },
    };

    assert.equal(planJobsForEvent(spoofed)[0]?.organization_id, 'org-1');
  });

  test('the emitted payload travels through verbatim', () => {
    // No parallel event format: the handler reads the same projectId,
    // milestoneId and unlockedMilestoneId finance wrote.
    const job = planJobsForEvent(invoicePaid)[0];

    assert.deepEqual(job?.payload.event, invoicePaid.payload);
    assert.equal(job?.payload.eventId, 4242);
    assert.equal(job?.payload.eventType, 'invoice.paid');
    assert.equal(job?.payload.subjectId, 'invoice-1');
    assert.equal(job?.payload.subjectType, 'invoice');
  });

  test('fields the publisher adds later are not dropped', () => {
    const extended: OutboxEvent = {
      ...invoicePaid,
      payload: { ...(invoicePaid.payload as object), settledVia: 'bank_transfer' },
    };

    assert.equal(
      (planJobsForEvent(extended)[0]?.payload.event as { settledVia?: string }).settledVia,
      'bank_transfer',
    );
  });

  test('an unsubscribed event plans nothing', () => {
    assert.deepEqual(planJobsForEvent({ ...invoicePaid, type: 'invoice.issued' }), []);
  });

  test('planning twice yields identical jobs — replay changes nothing', () => {
    assert.deepEqual(planJobsForEvent(invoicePaid), planJobsForEvent(invoicePaid));
  });
});
