import type { Rhythm } from './follow-up-rhythms';

/**
 * The eight situations ADM-69 names, and what each one actually is — gap
 * G-012.
 *
 * ADM-69 defined follow-up as **reusable rhythms that situations point at**,
 * rather than a cadence per situation. This file is the pointing: it records
 * which rhythm each situation uses, what stops it, where it escalates, and
 * whether it is client communication at all.
 *
 * Every value here is transcribed from the decision. Nothing is inferred, and
 * two of them would have been wrong if they had been:
 *
 *   · **Pending payment uses a fifth rhythm**, `Payment-Followup`, whose day
 *     values ADM-69 never states and whose automation it marks **DEFERRED**.
 *     Reading the four rhythms and assuming payment shared one would have
 *     invented a cadence.
 *
 *   · **Pending approval is internal communication**, and ADM-69 says so
 *     explicitly: it is *"INTERNAL communication, explicitly NOT governed by
 *     the client/lead consent gate"*. Applying the consent rule there would
 *     have stopped the owner being told what needs deciding.
 */

/** Who a rhythm escalates to when it is exhausted. ADM-69's own words. */
export type EscalationTarget =
  | 'sales_agent'
  | 'sales_agent_then_owner'
  | 'required_approver_then_owner'
  | 'finance_then_owner'
  | 'customer_success';

/**
 * Whether AgencyOS may run this situation automatically **today**.
 *
 * `deferred` is not a synonym for "off": it records that ADM-69 explicitly
 * withheld automation for that situation, so turning it on is a decision
 * rather than a configuration change.
 */
export type Automation = 'automated' | 'deferred';

/**
 * Which permission regime a situation's messages fall under.
 *
 * `client_consent` messages reach a client or lead and are gated by the
 * consent chokepoint in `crm.send_outbound_message`. `internal` messages do
 * not — there is no client on the other end of them.
 *
 * This is a *description*, not an enforcement point. The chokepoint decides,
 * because ADM-70 required the communication system rather than a caller to
 * enforce suppression. Recording it here lets a reader see which situations
 * are client-facing without reading the send path.
 */
export type Audience = 'client_consent' | 'internal';

export type Situation = {
  readonly key: string;
  /** ADM-69's numbering, kept so the record and the code can be compared. */
  readonly ordinal: number;
  readonly name: string;
  /** `null` only for Payment-Followup, whose rhythm ADM-69 leaves unstated. */
  readonly rhythm: Rhythm | null;
  readonly automation: Automation;
  readonly audience: Audience;
  /** Transcribed from ADM-69. Each is a fact something else must observe. */
  readonly stopsOn: readonly string[];
  readonly escalatesTo: EscalationTarget;
  /** Why a situation cannot run, when it cannot. Null when it can. */
  readonly blockedBy: string | null;
};

export const SITUATIONS: readonly Situation[] = [
  {
    key: 'no_response_after_quotation',
    ordinal: 1,
    name: 'No response after quotation',
    rhythm: 'sales_active',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['reply', 'quotation_accepted', 'quotation_rejected', 'quotation_lapsed', 'deal_closed'],
    escalatesTo: 'sales_agent_then_owner',
    blockedBy: null,
  },
  {
    key: 'no_response_after_requirements_request',
    ordinal: 2,
    name: 'No response after requirements request',
    rhythm: 'sales_active',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['reply', 'requirements_received'],
    escalatesTo: 'sales_agent',
    // G-138, ADM-89: collapsed into situation 1. In this schema `sales.proposals`
    // IS the quotation, so no recorded fact distinguishes "no response after a
    // requirements request" from "no response after quotation"; the observer
    // (`crm.observe_follow_up_candidates`) deliberately never offers it, and this
    // marks it non-runnable so the registry stops claiming otherwise.
    blockedBy:
      'ADM-89 collapses this into situation 1 (no_response_after_quotation): sales.proposals is the quotation, so no fact separates the two, and firing both would chase one client twice for one silence.',
  },
  {
    key: 'no_response_after_proposal',
    ordinal: 3,
    name: 'No response after proposal',
    rhythm: 'sales_active',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['reply', 'proposal_accepted', 'proposal_rejected', 'deal_closed'],
    escalatesTo: 'sales_agent_then_owner',
    // G-138, ADM-89: collapsed into situation 1, for the same reason as
    // situation 2 — `sales.proposals` is the quotation, so "no response after a
    // proposal" has no fact separating it from "no response after quotation".
    blockedBy:
      'ADM-89 collapses this into situation 1 (no_response_after_quotation): sales.proposals is the quotation, so no fact separates the two, and firing both would chase one client twice for one silence.',
  },
  {
    key: 'abandoned_conversation',
    ordinal: 4,
    name: 'Abandoned conversation',
    rhythm: 'sales_nurture',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['reply', 'lead_closed', 'lead_lost', 'opt_out'],
    escalatesTo: 'sales_agent',
    blockedBy: null,
  },
  {
    key: 'pending_approval',
    ordinal: 5,
    name: 'Pending approval',
    rhythm: 'internal_approval',
    automation: 'automated',
    // ADM-69, verbatim: "INTERNAL communication, explicitly NOT governed by
    // the client/lead consent gate."
    audience: 'internal',
    stopsOn: ['approved', 'rejected', 'cancelled'],
    escalatesTo: 'required_approver_then_owner',
    blockedBy: null,
  },
  {
    key: 'pending_payment',
    ordinal: 6,
    name: 'Pending payment',
    // ADM-69 names a fifth rhythm, `Payment-Followup`, and states no day
    // values for it. Null rather than a guess: pointing this at Sales-Active
    // because the numbers exist would be inventing a cadence for money.
    rhythm: null,
    automation: 'deferred',
    audience: 'client_consent',
    stopsOn: ['payment_verified', 'invoice_cancelled', 'invoice_refunded', 'explicit_close'],
    escalatesTo: 'finance_then_owner',
    blockedBy:
      'ADM-69 marks this situation automated: DEFERRED and states no day values for its Payment-Followup rhythm. Running it would mean inventing both.',
  },
  {
    key: 'inactive_lead',
    ordinal: 7,
    name: 'Inactive lead',
    rhythm: 'sales_nurture',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['reply', 'lead_converted', 'lead_lost', 'lead_closed', 'opt_out'],
    escalatesTo: 'sales_agent',
    blockedBy: null,
  },
  {
    key: 'post_project',
    ordinal: 8,
    name: 'Post-project',
    rhythm: 'customer_success',
    automation: 'automated',
    audience: 'client_consent',
    stopsOn: ['response', 'follow_up_completed', 'opt_out'],
    escalatesTo: 'customer_success',
    blockedBy: null,
  },
];

export function situationFor(key: string): Situation | null {
  return SITUATIONS.find((s) => s.key === key) ?? null;
}

/**
 * The situations that may run today.
 *
 * A situation is runnable when ADM-69 marked it automated **and** it has a
 * rhythm to run. Both conditions are checked rather than one, because they
 * fail independently: a decision could authorise automation for something
 * whose cadence is still unstated, and the reverse is how a deferred
 * situation quietly starts sending.
 */
export function isRunnable(situation: Situation): boolean {
  return situation.automation === 'automated' && situation.rhythm !== null && situation.blockedBy === null;
}
