import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LEAD_STATUSES, LEAD_TRANSITIONS } from '../src/modules/crm/schema.ts';
import {
  MILESTONE_STATUSES,
  PROJECT_STATUSES,
  PROJECT_TRANSITIONS,
} from '../src/modules/projects/schema.ts';
import { OPPORTUNITY_STAGES, OPPORTUNITY_TRANSITIONS } from '../src/modules/sales/schema.ts';

/**
 * Regression guard for the workflow this layer must not disturb.
 *
 * Adding a consumer for `invoice.paid` touches the delivery side of the
 * system, and the easiest way to break something valuable is to widen a state
 * machine "just a little" while wiring it up. These are pinned so that any
 * such change is a deliberate edit to a test rather than a silent one.
 *
 * Every value below is also the vocabulary of a database CHECK constraint, so
 * a drift here is a drift from what Postgres will accept.
 */

describe('LEAD → SALES → CLIENT WON → PROJECT is unchanged', () => {
  /**
   * A deliberate edit, which is what this file exists to force — G-203.
   *
   * `nurture` joined the five on 2026-09-04. It is not an invented state:
   * Doc 09 §6 lists it among the lead statuses and §26 gives it a section, so
   * this is the specification arriving rather than the vocabulary drifting.
   *
   * What it replaced was worse than an absence. A lead that was not lost and
   * not ready either stayed `qualified` forever — inflating the one number
   * the pipeline exists to report — or was closed as `disqualified` with a
   * reason that was not true.
   */
  test('lead statuses are the five the CRM has always had, plus nurture (G-203)', () => {
    assert.deepEqual([...LEAD_STATUSES], [
      'new',
      'qualifying',
      'qualified',
      'nurture',
      'disqualified',
      'converted',
    ]);
  });

  test('lead transitions: nurture is reachable from anywhere alive, and is a waiting room', () => {
    // Reachable from anywhere a lead is still alive, because "not ready yet"
    // is something you learn at any point — including from a client who was
    // about to sign. And it is not a terminus: a lead comes back OUT of it,
    // which is the entire reason it is not `disqualified`.
    assert.deepEqual(LEAD_TRANSITIONS, {
      new: ['qualifying', 'disqualified'],
      qualifying: ['qualified', 'nurture', 'disqualified'],
      qualified: ['converted', 'nurture', 'disqualified'],
      nurture: ['qualifying', 'qualified', 'disqualified'],
      disqualified: ['qualifying'],
      converted: [],
    });
    assert.deepEqual(LEAD_TRANSITIONS.converted, [], 'converted stays terminal');
  });

  test('opportunity stages and transitions are unchanged', () => {
    assert.deepEqual([...OPPORTUNITY_STAGES], [
      'discovery',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    assert.deepEqual(OPPORTUNITY_TRANSITIONS, {
      discovery: ['proposal', 'lost'],
      proposal: ['negotiation', 'won', 'lost'],
      negotiation: ['won', 'lost'],
      won: [],
      lost: ['discovery'],
    });
  });
});

describe('the project state machine is preserved', () => {
  test('project statuses are unchanged — no state was added for unlocking', () => {
    assert.deepEqual([...PROJECT_STATUSES], [
      'planning',
      'onboarding',
      'active',
      'on_hold',
      'completed',
      'cancelled',
    ]);
  });

  test('project transitions are unchanged, including the onboarding step', () => {
    assert.deepEqual(PROJECT_TRANSITIONS, {
      planning: ['onboarding', 'cancelled'],
      onboarding: ['active', 'on_hold', 'cancelled'],
      active: ['on_hold', 'completed', 'cancelled'],
      on_hold: ['active', 'cancelled'],
      completed: [],
      cancelled: [],
    });
  });

  test('no project status means "paid up but not delivered"', () => {
    // Requirement 12: when the final milestone is paid there is no existing
    // state that says "ready for the last workflow step", so the handler
    // records the gap and leaves the project alone rather than inventing one.
    // If such a state is ever added, this test is the reminder to use it.
    const candidates = ['fully_paid', 'awaiting_handover', 'ready_for_closure', 'delivered'];
    for (const candidate of candidates) {
      assert.ok(
        !(PROJECT_STATUSES as readonly string[]).includes(candidate),
        `${candidate} now exists — the unlock handler should use it instead of reporting a gap`,
      );
    }
  });

  test('milestone statuses gained nothing either', () => {
    assert.equal(MILESTONE_STATUSES.length, 5);
    assert.ok(!(MILESTONE_STATUSES as readonly string[]).includes('unlocked'));
    assert.ok(!(MILESTONE_STATUSES as readonly string[]).includes('paid'));
  });
});
