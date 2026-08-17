import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { escalationFor, evaluate, type ContractInput } from '../src/modules/crm/follow-up-contract.ts';
import { RHYTHM_DAYS, maxAttempts } from '../src/modules/crm/follow-up-rhythms.ts';
import { SITUATIONS, isRunnable, situationFor } from '../src/modules/crm/follow-up-situations.ts';

/**
 * The eight situations and the ten-step contract — ADM-69, gap G-012.
 *
 * Two of these values would have been wrong if inferred rather than read, so
 * the first suite checks the transcription itself. The rest exercise the
 * contract's *order*, because ADM-69 wrote an order and the order is what
 * decides which fact a suppression reports.
 */

const IST = 'Asia/Kolkata';
const TRIGGER = new Date('2026-08-14T06:00:00Z'); // Friday
/** Well past every rhythm's last day, so timing never masks another check. */
const LATER = new Date('2027-01-01T06:00:00Z');

const base = (over: Partial<ContractInput> = {}): ContractInput => ({
  situationKey: 'no_response_after_quotation',
  triggeredAt: TRIGGER,
  attemptsSoFar: 0,
  timeZone: IST,
  hasConsent: true,
  optedOut: false,
  stopConditionsMet: [],
  now: LATER,
  ...over,
});

describe('A. the eight situations are transcribed, not inferred', () => {
  test('all eight are present, in ADM-69 order', () => {
    assert.equal(SITUATIONS.length, 8);
    assert.deepEqual(SITUATIONS.map((s) => s.ordinal), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('each points at the rhythm ADM-69 gives it', () => {
    const expected: Record<string, string | null> = {
      no_response_after_quotation: 'sales_active',
      no_response_after_requirements_request: 'sales_active',
      no_response_after_proposal: 'sales_active',
      abandoned_conversation: 'sales_nurture',
      pending_approval: 'internal_approval',
      pending_payment: null,
      inactive_lead: 'sales_nurture',
      post_project: 'customer_success',
    };
    for (const s of SITUATIONS) {
      assert.equal(s.rhythm, expected[s.key], `${s.key} points at the wrong rhythm`);
    }
  });

  test('pending payment has no rhythm and is deferred', () => {
    // ADM-69 names a fifth rhythm, Payment-Followup, and states no day values
    // for it. Pointing this at Sales-Active because those numbers exist would
    // be inventing a cadence for money.
    const payment = situationFor('pending_payment');
    assert.equal(payment?.rhythm, null);
    assert.equal(payment?.automation, 'deferred');
    assert.equal(isRunnable(payment!), false);
    assert.match(String(payment?.blockedBy), /DEFERRED/);
  });

  test('pending approval is internal, and ADM-69 says so explicitly', () => {
    // "INTERNAL communication, explicitly NOT governed by the client/lead
    // consent gate." Applying the consent rule here would stop the owner being
    // told what needs deciding.
    assert.equal(situationFor('pending_approval')?.audience, 'internal');
  });

  test('and every other situation is client-facing', () => {
    for (const s of SITUATIONS) {
      if (s.key === 'pending_approval') continue;
      assert.equal(s.audience, 'client_consent', `${s.key} escaped the consent gate`);
    }
  });

  test('every runnable situation has a rhythm that exists', () => {
    for (const s of SITUATIONS.filter(isRunnable)) {
      assert.ok(s.rhythm && RHYTHM_DAYS[s.rhythm], `${s.key} points at a rhythm with no days`);
    }
  });
});

describe('B. the contract runs in ADM-69 order', () => {
  test('an unknown situation is refused before anything else', () => {
    const r = evaluate(base({ situationKey: 'nope', hasConsent: false, optedOut: true }));
    assert.equal(r.send, false);
    assert.equal(r.send === false && r.reason, 'situation_unknown');
  });

  test('a deferred situation is refused even with everything else in order', () => {
    const r = evaluate(base({ situationKey: 'pending_payment' }));
    assert.equal(r.send === false && r.reason, 'situation_not_automated');
  });

  test('an exhausted rhythm outranks a consent problem', () => {
    // Order matters for the *explanation*. A sequence that finished is a
    // different fact from one that was blocked, and reporting the second sends
    // somebody to fix a permission that was never the issue.
    const r = evaluate(base({ attemptsSoFar: maxAttempts('sales_active'), hasConsent: false }));
    assert.equal(r.send === false && r.reason, 'rhythm_exhausted');
  });

  test('consent outranks an opt-out, which outranks a stop condition', () => {
    const reasonOf = (input: Partial<ContractInput>) => {
      const r = evaluate(base(input));
      return r.send === false ? r.reason : 'sent';
    };
    assert.equal(reasonOf({ hasConsent: false, optedOut: true, stopConditionsMet: ['reply'] }), 'no_consent');
    assert.equal(reasonOf({ optedOut: true, stopConditionsMet: ['reply'] }), 'opted_out');
    assert.equal(reasonOf({ stopConditionsMet: ['reply'] }), 'stop_condition_met');
  });

  test('and a stop condition outranks a state change', () => {
    const r = evaluate(base({ stopConditionsMet: ['reply'], stateChanged: true }));
    assert.equal(r.send === false && r.reason, 'stop_condition_met');
  });
});

describe('C. consent, and the one situation exempt from it', () => {
  test('a client-facing situation without consent does not send', () => {
    const r = evaluate(base({ hasConsent: false }));
    assert.equal(r.send === false && r.reason, 'no_consent');
  });

  test('an internal one sends without any consent at all', () => {
    // G-110 depends on this. Suppressing the approval reminder would stop the
    // owner being told what needs deciding, with nothing to say why.
    const r = evaluate(base({ situationKey: 'pending_approval', hasConsent: false }));
    assert.equal(r.send, true);
  });

  test('and consent is described here but enforced at the chokepoint', () => {
    // ADM-70 required the communication system to enforce suppression. This
    // check avoids queueing work that would be refused; it is not the refusal.
    const r = evaluate(base({ hasConsent: true }));
    assert.equal(r.send, true);
  });
});

describe('D. stop conditions belong to their own situation', () => {
  test("another situation's stop condition does not stop this one", () => {
    // `payment_verified` belongs to situation 6. Honouring it here would mean
    // the caller matched the wrong sequence and nothing said so.
    const r = evaluate(base({ stopConditionsMet: ['payment_verified'] }));
    assert.equal(r.send, true);
  });

  test('but its own does', () => {
    for (const condition of situationFor('no_response_after_quotation')!.stopsOn) {
      const r = evaluate(base({ stopConditionsMet: [condition] }));
      assert.equal(r.send === false && r.reason, 'stop_condition_met', `${condition} did not stop it`);
    }
  });

  test('a converted lead cannot receive a stale follow-up', () => {
    // The state-change branch: not one of the named conditions, but the
    // sequence is over regardless.
    const r = evaluate(base({ situationKey: 'inactive_lead', stateChanged: true }));
    assert.equal(r.send === false && r.reason, 'state_changed');
  });
});

describe('E. timing is respected, not merely calculated', () => {
  test('a job claimed before the send time waits', () => {
    // The window has already been applied by the arithmetic. This asks whether
    // that moment has arrived — a job claimed early must not send early.
    const r = evaluate(base({ now: TRIGGER }));
    assert.equal(r.send === false && r.reason, 'outside_sending_window');
  });

  test('and day 0 never sends', () => {
    // Every rhythm's first day is at least 1, so the trigger instant itself
    // can never be a send. Checked through the contract rather than the day
    // lists, because that is where an off-by-one would actually bite.
    for (const s of SITUATIONS.filter(isRunnable)) {
      const r = evaluate(base({ situationKey: s.key, now: TRIGGER, attemptsSoFar: 0 }));
      assert.equal(r.send, false, `${s.key} sent on day 0`);
    }
  });
});

describe('F. idempotency is on the attempt, not the clock', () => {
  test('an attempt already sent is refused', () => {
    // Two workers claiming the same row a second apart compute the same
    // attempt number, and the number is what makes them the same send.
    const r = evaluate(base({ attemptsSoFar: 2, alreadySentAttempts: [3] }));
    assert.equal(r.send === false && r.reason, 'already_sent');
  });

  test('a different attempt is not', () => {
    const r = evaluate(base({ attemptsSoFar: 2, alreadySentAttempts: [1, 2] }));
    assert.equal(r.send, true);
    assert.equal(r.send === true && r.attempt, 3);
  });

  test('and the same input always gives the same attempt number', () => {
    const once = evaluate(base({ attemptsSoFar: 4 }));
    const twice = evaluate(base({ attemptsSoFar: 4 }));
    assert.deepEqual(
      once.send === true ? once.attempt : null,
      twice.send === true ? twice.attempt : null,
    );
  });
});

describe('G. the SLA outranks the reminder count', () => {
  const approval = (over: Partial<ContractInput> = {}) =>
    evaluate(base({ situationKey: 'pending_approval', hasConsent: false, ...over }));

  test('a reminder due after the SLA is not sent, whatever the count says', () => {
    const r = approval({ attemptsSoFar: 0, slaDueAt: new Date('2026-08-14T07:00:00Z') });
    assert.equal(r.send === false && r.reason, 'rhythm_exhausted');
  });

  test('reminder 2 is refused once the SLA has passed, though 2 < 3', () => {
    // The precise failure ADM-69 resolved: chasing a request the system
    // already considers expired because the counter still had room.
    const r = approval({ attemptsSoFar: 1, slaDueAt: new Date('2026-08-17T06:00:00Z') });
    assert.equal(r.send === false && r.reason, 'rhythm_exhausted');
  });

  test('and without an SLA the count alone decides', () => {
    // internal_approval lists three reminders.
    assert.equal(approval({ attemptsSoFar: 2 }).send, true, 'the third reminder should be allowed');
    assert.equal(approval({ attemptsSoFar: 3 }).send, false, 'a fourth reminder should not be');
  });
});

describe('H. escalation', () => {
  test('each situation escalates where ADM-69 says', () => {
    // Situations 2 and 3 are absent: ADM-89 (G-138) collapses them into
    // situation 1, so they are not runnable and escalate nowhere of their own —
    // asserted in 'a deferred or collapsed situation escalates nowhere' below.
    const expected: Record<string, string> = {
      no_response_after_quotation: 'sales_agent_then_owner',
      abandoned_conversation: 'sales_agent',
      pending_approval: 'required_approver_then_owner',
      inactive_lead: 'sales_agent',
      post_project: 'customer_success',
    };
    for (const [key, target] of Object.entries(expected)) {
      assert.equal(escalationFor(key), target, `${key} escalates to the wrong place`);
    }
  });

  test('a deferred or collapsed situation escalates nowhere', () => {
    assert.equal(escalationFor('pending_payment'), null);
    // Situations 2 and 3 are collapsed into situation 1 by ADM-89 (G-138), so
    // they are not runnable and have no escalation of their own.
    assert.equal(escalationFor('no_response_after_requirements_request'), null);
    assert.equal(escalationFor('no_response_after_proposal'), null);
  });

  test('and an unknown one does not invent a target', () => {
    assert.equal(escalationFor('nope'), null);
  });
});
