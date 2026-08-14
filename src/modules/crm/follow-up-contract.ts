import { nextSendAt, type Rhythm } from './follow-up-rhythms';
import { isRunnable, situationFor, type Situation } from './follow-up-situations';

/**
 * The ten-step execution contract — decision ADM-69, gap G-012.
 *
 * ADM-69 does not merely list conditions; it lists them **in order**:
 *
 *   1. trigger satisfied
 *   2. rhythm active
 *   3. required channel consent exists
 *   4. contact not opted out or suppressed
 *   5. stop conditions false
 *   6. state unchanged in any way that cancels the sequence
 *   7. business-hours and timezone rules satisfied
 *   8. idempotency prevents duplicates
 *   9. the message goes through the central outbound chokepoint
 *  10. the decision and the resulting send are audited
 *
 * This function is steps 1 through 8. Nine and ten are not decisions — they
 * are where the send happens and where it is recorded — and putting them here
 * would make this the thing that sends, which is exactly what the contract
 * separates.
 *
 * ── why the order is preserved rather than optimised ──────────────────────
 *
 * The checks could run in any order and reach the same yes. They cannot reach
 * the same *explanation*. A lead that both converted and has no consent should
 * be reported as converted, because that is the fact somebody acting on the
 * report needs; reordering turns a business event into a permissions
 * complaint. ADM-69 wrote an order, so the order is the contract.
 *
 * ── what this deliberately does not do ────────────────────────────────────
 *
 * **It does not enforce consent.** It reports what it was told. ADM-70
 * required the *communication system* to enforce suppression, and G-135 put
 * that in `crm.send_outbound_message` where every caller passes through it.
 * Checking here as well is a courtesy to the caller — it avoids queueing work
 * that will be refused — and a second copy of a rule is not a second
 * enforcement of it. If these two ever disagree, the chokepoint is right.
 */

/** Why a follow-up will not be sent. Ordered as ADM-69 orders the checks. */
export type SuppressionReason =
  | 'situation_unknown'
  | 'situation_not_automated'
  | 'rhythm_exhausted'
  | 'no_consent'
  | 'opted_out'
  | 'stop_condition_met'
  | 'state_changed'
  | 'outside_sending_window'
  | 'already_sent';

export type ContractInput = {
  readonly situationKey: string;
  /** Day 0. The observable fact that started the sequence. */
  readonly triggeredAt: Date;
  readonly attemptsSoFar: number;
  /** Required — G-137 records that no timezone is stored anywhere yet. */
  readonly timeZone: string;
  /**
   * Whether recorded consent exists on the channel, for a client-facing
   * situation. Ignored for `internal` ones, which ADM-69 exempts explicitly.
   */
  readonly hasConsent: boolean;
  readonly optedOut: boolean;
  /**
   * Any stop condition from the situation's own list that has occurred.
   * The caller observes these; this decides what they mean.
   */
  readonly stopConditionsMet: readonly string[];
  /**
   * True when the subject moved in a way that cancels the sequence but is not
   * one of the named stop conditions — a converted lead, a closed deal.
   */
  readonly stateChanged?: boolean;
  /** Already-sent attempt numbers, so a retry cannot double-send. */
  readonly alreadySentAttempts?: readonly number[];
  /** `approval_requests.sla_due_at`, for the internal-approval rhythm. */
  readonly slaDueAt?: Date | null;
  /** The moment being decided for. Passed in so the decision is reproducible. */
  readonly now: Date;
};

export type ContractResult =
  | { readonly send: true; readonly at: Date; readonly attempt: number; readonly situation: Situation }
  | { readonly send: false; readonly reason: SuppressionReason; readonly situation: Situation | null };

/**
 * Whether a follow-up may be sent, and when.
 *
 * `send: false` always carries a reason, because ADM-69's tenth step requires
 * the *decision* to be audited and not only the send. A suppression with no
 * recorded reason is indistinguishable from a scheduler that silently stopped
 * working, which is the failure this whole record-keeping discipline exists to
 * prevent.
 */
export function evaluate(input: ContractInput): ContractResult {
  // ── 1. trigger satisfied ───────────────────────────────────────────────
  const situation = situationFor(input.situationKey);
  if (!situation) return { send: false, reason: 'situation_unknown', situation: null };

  if (!isRunnable(situation)) {
    // Pending payment reaches this: ADM-69 marks it DEFERRED and states no
    // cadence. It is refused here rather than filtered out earlier, so a
    // caller that asks gets an answer it can record.
    return { send: false, reason: 'situation_not_automated', situation };
  }

  // ── 2. rhythm active ───────────────────────────────────────────────────
  const rhythm = situation.rhythm as Rhythm;
  const due = nextSendAt({
    triggeredAt: input.triggeredAt,
    rhythm,
    attemptsSoFar: input.attemptsSoFar,
    timeZone: input.timeZone,
    // The SLA outranks the reminder count. `nextSendAt` returns null when a
    // reminder would land after it, which lands here as an exhausted rhythm —
    // correct, because there is no next reminder either way.
    slaDueAt: input.slaDueAt ?? null,
  });
  if (!due) return { send: false, reason: 'rhythm_exhausted', situation };

  // ── 3. required channel consent exists ─────────────────────────────────
  //
  // Skipped for internal situations, which ADM-69 exempts in as many words.
  // The chokepoint makes the same distinction by conversation kind; this one
  // is by situation, and they must agree — a client-facing situation posting
  // into an internal group would be a routing bug, not a consent question.
  if (situation.audience === 'client_consent' && !input.hasConsent) {
    return { send: false, reason: 'no_consent', situation };
  }

  // ── 4. contact not opted out or suppressed ─────────────────────────────
  if (input.optedOut) return { send: false, reason: 'opted_out', situation };

  // ── 5. stop conditions false ───────────────────────────────────────────
  //
  // Only the situation's own conditions count. A stop condition belonging to
  // another situation arriving here would mean the caller matched the wrong
  // sequence, and silently ignoring it would hide that.
  const relevant = input.stopConditionsMet.filter((c) => situation.stopsOn.includes(c));
  if (relevant.length > 0) return { send: false, reason: 'stop_condition_met', situation };

  // ── 6. state unchanged in any way that cancels the sequence ────────────
  if (input.stateChanged) return { send: false, reason: 'state_changed', situation };

  // ── 7. business hours and timezone ─────────────────────────────────────
  //
  // `nextSendAt` has already moved the due time into the window, so this is
  // not a second window calculation. It asks whether that moment has arrived:
  // a job claimed early must wait rather than send early.
  if (due.getTime() > input.now.getTime()) {
    return { send: false, reason: 'outside_sending_window', situation };
  }

  // ── 8. idempotency prevents duplicates ─────────────────────────────────
  //
  // Last of the eight, and checked on the *attempt number* rather than on
  // time: two workers claiming the same row a second apart compute the same
  // attempt, and the number is what makes them the same send.
  const attempt = input.attemptsSoFar + 1;
  if (input.alreadySentAttempts?.includes(attempt)) {
    return { send: false, reason: 'already_sent', situation };
  }

  return { send: true, at: due, attempt, situation };
}

/**
 * Whether an exhausted rhythm should escalate, and to whom.
 *
 * Separate from `evaluate` because escalation is not a send decision: it fires
 * when the sequence *ends*, and ADM-69 requires it exactly once. A caller asks
 * this after a `rhythm_exhausted` result, and the "exactly once" is the
 * caller's to guarantee with a uniqueness constraint — a function cannot
 * promise it, and pretending otherwise would be a decorative guarantee.
 */
export function escalationFor(situationKey: string): Situation['escalatesTo'] | null {
  const situation = situationFor(situationKey);
  if (!situation || !isRunnable(situation)) return null;
  return situation.escalatesTo;
}
