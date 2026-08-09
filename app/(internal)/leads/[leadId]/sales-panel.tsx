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
import { IDLE_STATE } from '@/modules/identity/types';

/**
 * Manual pipeline controls.
 *
 * Every action is a plain form posting to a Server Action, so a human can walk
 * a deal end to end today. WhatsApp ingest and AI qualification will call the
 * same services later — they replace who triggers these, not what they do.
 */

const input =
  'w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20';
const button =
  'rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10';
const label = 'text-xs font-medium uppercase tracking-wide text-muted';

function Status({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle') return null;
  return (
    <p
      role="status"
      className={`text-sm ${state.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
    >
      {state.message}
    </p>
  );
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
        <input name="reason" placeholder="Reason (required to disqualify)" className={`${input} w-64`} />
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
      <textarea name="body" rows={2} required placeholder="Sales note…" className={input} />
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
      />
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
        <input name="name" defaultValue={defaultName} required className={`${input} w-72`} />
        <input
          name="valueMinor"
          type="number"
          min="0"
          placeholder="Value (paise)"
          className={`${input} w-48`}
        />
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
        <input name="lostReason" placeholder="Reason (required to lose)" className={`${input} w-64`} />
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
        <input name="projectName" defaultValue={defaultProjectName} required className={`${input} w-72`} />
        <input name="clientAccountName" placeholder="Client name (optional)" className={`${input} w-56`} />
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Converting…' : 'Create client & project'}
        </button>
      </div>
      <Status state={state} />
    </form>
  );
}
