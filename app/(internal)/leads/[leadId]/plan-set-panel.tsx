'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  draftPlanSetAction,
  recordPlanSetChoiceAction,
  recordPlanSetResponseAction,
  sendPlanSetAction,
  submitPlanSetAction,
} from '@/modules/sales/actions';
import { PLAN_SET_MAX_PLANS, PLAN_SET_MIN_PLANS } from '@/modules/sales/schema';
import type { PlanSetView } from '@/modules/sales/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * The offer that is a choice — Master Quotation System Part H, ADM-97; G-305.
 *
 * G-166 built the whole ladder: `proposal_plan_sets` above proposals, eight
 * doors, seven service wrappers and three schemas. **Nothing called any of
 * them** — the only references outside `service.ts` were its own log scope
 * strings — so a 2–3 plan offer was reachable by somebody with database access
 * and by nobody else. Found by a caller sweep, not by reading Part H.
 *
 * ── what this panel refuses to do ─────────────────────────────────────
 *
 * **It does not invent a second vocabulary.** A plan-set moves through the
 * same four states as a single quotation — draft, with the owner, sent,
 * answered — and the controls sit in the same order, because it is the same
 * process with more than one price in it.
 *
 * **It does not price the plans itself.** Each member is an ordinary draft
 * proposal; its lines and its total come from the existing line and pricing
 * forms, which neither know nor care that a proposal belongs to a set. A
 * second pricing path would be a second place for the arithmetic to drift.
 *
 * **It does not let the client's answer be typed as a state.** Accepting means
 * naming which plan won (`record_plan_set_choice`), and declining is the only
 * answer the response door takes. There is no free-text status anywhere here.
 */

const input = inputClass;
const label = labelClass;

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

const SLOTS = Array.from({ length: PLAN_SET_MAX_PLANS }, (_, i) => i + 1);

export function DraftPlanSetForm({
  leadId,
  opportunityId,
  defaultTitle,
}: {
  leadId: string;
  opportunityId: string;
  defaultTitle: string;
}) {
  const [state, action, pending] = useActionState(draftPlanSetAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="opportunityId" value={opportunityId} />

      <p className="text-xs text-muted">
        Part H: two or three priced plans, for a client whose budget is unknown or an engagement with
        a genuine feature ladder. Leave the third blank for two. Each plan becomes a draft quotation
        you price below.
      </p>

      {SLOTS.map((slot) => (
        <div key={slot} className="flex flex-wrap gap-2">
          <div className="flex w-28 flex-col gap-1">
            <label className={label} htmlFor={`plan-label-${slot}`}>
              Rung {slot}
              {slot > PLAN_SET_MIN_PLANS ? ' (optional)' : ''}
            </label>
            <input
              id={`plan-label-${slot}`}
              name={`label${slot}`}
              maxLength={80}
              placeholder={['Essential', 'Growth', 'Complete'][slot - 1]}
              className={input}
            />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1">
            <label className={label} htmlFor={`plan-title-${slot}`}>
              Title
            </label>
            <input
              id={`plan-title-${slot}`}
              name={`title${slot}`}
              maxLength={200}
              defaultValue={slot <= PLAN_SET_MIN_PLANS ? defaultTitle : ''}
              className={input}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={label} htmlFor={`plan-valid-${slot}`}>
              Valid until
            </label>
            <input id={`plan-valid-${slot}`} name={`validUntil${slot}`} type="date" className={input} />
          </div>
        </div>
      ))}

      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="plan-recommended">
          Recommended plan
        </label>
        {/*
          ADM-97: the recommendation is REQUIRED, and it is not a nicety. Its
          price is the amount the money-floor policy resolves an approver from,
          and it is the plan the client sees defaulted — a set with no
          recommendation is three questions rather than one offer.
        */}
        <select id="plan-recommended" name="recommendedSlot" required defaultValue="" className={input}>
          <option value="" disabled>
            Which one are you recommending?
          </option>
          {SLOTS.map((slot) => (
            <option key={slot} value={slot}>
              Rung {slot}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Drafting…' : 'Offer a choice of plans'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function SubmitPlanSetForm({ leadId, planSet }: { leadId: string; planSet: PlanSetView }) {
  const [state, action, pending] = useActionState(submitPlanSetAction, IDLE_STATE);
  // The door refuses a set with no recommendation (`no_recommendation`) and one
  // whose members are not all priced. Saying so here is a sentence; finding out
  // by pressing the button is a round-trip and a refusal.
  const unpriced = planSet.members.filter((m) => m.total_minor <= 0);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="planSetId" value={planSet.id} />

      <label className={label} htmlFor="plan-set-summary">
        What the owner should know
      </label>
      <input id="plan-set-summary" name="summary" maxLength={500} className={input} />

      {unpriced.length > 0 ? (
        <p className="text-xs text-warning">
          {unpriced.map((m) => m.plan_label ?? m.title).join(', ')} still{' '}
          {unpriced.length === 1 ? 'has' : 'have'} no price.
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Sending…' : 'Send the offer for approval'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function SendPlanSetForm({
  leadId,
  planSetId,
  conversationId,
}: {
  leadId: string;
  planSetId: string;
  conversationId: string | null;
}) {
  const [state, action, pending] = useActionState(sendPlanSetAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="planSetId" value={planSetId} />
      {conversationId ? <input type="hidden" name="conversationId" value={conversationId} /> : null}

      <label className={label} htmlFor="plan-set-ref">
        Message reference (optional)
      </label>
      <input id="plan-set-ref" name="messageRef" maxLength={200} placeholder="wamid.…" className={input} />

      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Sending…' : 'Send the offer to the client'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function PlanSetAnswerForm({ leadId, planSet }: { leadId: string; planSet: PlanSetView }) {
  const [chooseState, chooseAction, choosing] = useActionState(recordPlanSetChoiceAction, IDLE_STATE);
  const [declineState, declineAction, declining] = useActionState(recordPlanSetResponseAction, IDLE_STATE);

  return (
    <div className="flex flex-col gap-3">
      <form action={chooseAction} className="flex flex-col gap-2">
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="planSetId" value={planSet.id} />

        <label className={label} htmlFor="plan-set-chosen">
          Which plan did they pick?
        </label>
        {/*
          The members of THIS set and nothing else. `record_plan_set_choice`
          refuses a proposal that is not one of them, and offering the rest of
          the deal's history would make that refusal the normal result.
        */}
        <select id="plan-set-chosen" name="chosenProposalId" required defaultValue="" className={input}>
          <option value="" disabled>
            Choose the plan they accepted
          </option>
          {planSet.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.plan_label ?? `Plan ${m.plan_slot ?? ''}`} — {m.title}
            </option>
          ))}
        </select>

        <input name="note" maxLength={2000} placeholder="What they said (optional)" aria-label="Note" className={input} />

        <button type="submit" disabled={choosing} className={buttonClass('primary', 'sm')}>
          {choosing ? 'Recording…' : 'Record the plan they chose'}
        </button>
        <Status state={chooseState} />
      </form>

      <form action={declineAction} className="flex flex-col gap-2 border-t border-line pt-3">
        <input type="hidden" name="leadId" value={leadId} />
        <input type="hidden" name="planSetId" value={planSet.id} />
        <input
          name="note"
          maxLength={2000}
          placeholder="Why they declined (optional)"
          aria-label="Decline note"
          className={input}
        />
        {/*
          Declining is the whole offer, not one rung — there is no "they said no
          to Growth" state, because a client who wanted a different rung chose
          one. Every member is rejected by the door.
        */}
        <button type="submit" disabled={declining} className={buttonClass('secondary', 'sm')}>
          {declining ? 'Recording…' : 'They declined the whole offer'}
        </button>
        <Status state={declineState} />
      </form>
    </div>
  );
}
