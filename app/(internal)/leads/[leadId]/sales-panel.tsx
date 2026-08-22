'use client';

import { useActionState } from 'react';

import {
  addLeadNoteAction,
  setLeadFollowUpAction,
  setLeadQualificationAction,
  setLeadStatusAction,
} from '@/modules/crm/actions';
import {
  convertToProjectAction,
  createOpportunityAction,
  setOpportunityStageAction,
} from '@/modules/sales/actions';
import { LOST_CATEGORIES, LOST_CATEGORY_LABELS } from '@/modules/sales/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * Manual pipeline controls.
 *
 * Every action is a plain form posting to a Server Action, so a human can walk
 * a deal end to end today. WhatsApp ingest and AI qualification will call the
 * same services later — they replace who triggers these, not what they do.
 */

/**
 * The controls take their appearance from the design system rather than from
 * class strings copied per file, so a change to what an input looks like lands
 * everywhere at once. Kept as local aliases because the markup below already
 * reads `className={input}` in forty places.
 */
const input = inputClass;
const button = buttonClass('secondary', 'sm');
const label = labelClass;

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

export function LeadStatusForm({
  leadId,
  current,
  allowed,
}: {
  leadId: string;
  current: string;
  allowed: readonly string[];
}) {
  const [state, action, pending] = useActionState(setLeadStatusAction, IDLE_STATE);

  if (allowed.length === 0) {
    return <p className="text-sm text-muted">No further pipeline moves from “{current}”.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="status" defaultValue={allowed[0]} aria-label="New status" className={`${input} w-auto`}>
          {allowed.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="reason" placeholder="Reason (required to disqualify)" className={`${input} w-64`} aria-label="Reason" />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Moving…' : 'Move'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

export function LeadNoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(addLeadNoteAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <textarea name="body" rows={2} required placeholder="Sales note…" className={input} aria-label="Sales note" />
      <button type="submit" disabled={pending} className={`${button} self-start`}>
        {pending ? 'Adding…' : 'Add note'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function QualificationForm({
  leadId,
  current,
}: {
  leadId: string;
  current: { budgetMinor?: number; timelineNote?: string; isDecisionMaker?: boolean; notes?: string };
}) {
  const [state, action, pending] = useActionState(setLeadQualificationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="budgetMinor">
            Budget (paise)
          </label>
          <input
            id="budgetMinor"
            name="budgetMinor"
            type="number"
            min="0"
            step="1"
            defaultValue={current.budgetMinor ?? ''}
            className={input}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="timelineNote">
            Timeline
          </label>
          <input
            id="timelineNote"
            name="timelineNote"
            defaultValue={current.timelineNote ?? ''}
            placeholder="e.g. live before December"
            className={input}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="isDecisionMaker">
          Speaking to the decision maker?
        </label>
        <select
          id="isDecisionMaker"
          name="isDecisionMaker"
          defaultValue={current.isDecisionMaker === undefined ? '' : current.isDecisionMaker ? 'yes' : 'no'}
          className={`${input} w-auto`}
        >
          <option value="">Unknown</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
      <textarea
        name="notes"
        rows={2}
        defaultValue={current.notes ?? ''}
        placeholder="Fit notes…"
        className={input}
      aria-label="Fit notes" />
      <button type="submit" disabled={pending} className={`${button} self-start`}>
        {pending ? 'Saving…' : 'Save qualification'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function FollowUpForm({ leadId, current }: { leadId: string; current: string | null }) {
  const [state, action, pending] = useActionState(setLeadFollowUpAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-col gap-1">
        <label className={label} htmlFor="nextFollowUpAt">
          Next follow-up
        </label>
        <input
          id="nextFollowUpAt"
          name="nextFollowUpAt"
          type="date"
          defaultValue={current ? current.slice(0, 10) : ''}
          className={`${input} w-auto`}
        />
      </div>
      <button type="submit" disabled={pending} className={button}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function OpenDealForm({ leadId, defaultName }: { leadId: string; defaultName: string }) {
  const [state, action, pending] = useActionState(createOpportunityAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="name" defaultValue={defaultName} required className={`${input} w-72`} aria-label="Deal name" />
        <input
          name="valueMinor"
          type="number"
          min="0"
          placeholder="Value (paise)"
          className={`${input} w-48`}
        aria-label="Deal value in paise" />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Opening…' : 'Open deal'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

export function DealStageForm({
  leadId,
  opportunityId,
  current,
  allowed,
}: {
  leadId: string;
  opportunityId: string;
  current: string;
  allowed: readonly string[];
}) {
  const [state, action, pending] = useActionState(setOpportunityStageAction, IDLE_STATE);

  if (allowed.length === 0) {
    return <p className="text-sm text-muted">Deal is {current}; no further stage moves.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="stage" defaultValue={allowed[0]} aria-label="New stage" className={`${input} w-auto`}>
          {allowed.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {/* Doc 09 §25. Both, because they answer different questions: the
            category is what "top lost reasons" counts, the sentence is what
            somebody reads six months later and learns from. */}
        <select
          name="lostCategory"
          defaultValue=""
          aria-label="Why the deal was lost"
          className={`${input} w-auto`}
        >
          <option value="">Why lost…</option>
          {LOST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {LOST_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <input
          name="lostReason"
          placeholder="In your own words (required to lose)"
          className={`${input} w-56`}
          aria-label="Reason for losing"
        />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Moving…' : 'Move deal'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}

export function ConvertForm({
  leadId,
  opportunityId,
  defaultProjectName,
}: {
  leadId: string;
  opportunityId: string;
  defaultProjectName: string;
}) {
  const [state, action, pending] = useActionState(convertToProjectAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="projectName" defaultValue={defaultProjectName} required className={`${input} w-72`} aria-label="Project name" />
        <input name="clientAccountName" placeholder="Client name (optional)" className={`${input} w-56`} aria-label="Client name" />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Converting…' : 'Create client & project'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}
