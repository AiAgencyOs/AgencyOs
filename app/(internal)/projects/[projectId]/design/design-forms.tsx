'use client';

import { useActionState } from 'react';

import {
  assignDesignReviewerAction,
  submitAdminDesignDecisionAction,
  submitInternalDesignReviewAction,
} from '@/modules/projects/actions';
import type { RosterMember } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * The two queues §10 asks for — Master §10, §16; Designer §15; PM §7; G-287.
 *
 * G-280 built the gate order; G-286 rendered the trail it produces. These are
 * the forms over the doors between them, which nothing had called.
 *
 * ── they do not decide what is submittable ────────────────────────────
 *
 * A form appears when the option's stored status says the gate is open, and
 * the door checks again — including the two rules no capability can express:
 * the internal gate wants the **assigned reviewer specifically**, and the
 * Admin gate refuses an option internal review has not passed. Nothing here
 * re-derives either. A client-side copy of "this looks ready for Admin" would
 * disagree with the database the moment a review landed, and it would
 * disagree in the direction that offers somebody a button that will fail.
 *
 * ── an edit and a rejection are the same thing ────────────────────────
 *
 * §7.8 gives the Admin CONFIRM and EDIT and no third word. There is no reject
 * button here because there is no reject outcome: an edit with a reason IS the
 * rejection, and it returns the option to the designer *and* to internal
 * review. Offering "reject" would invent a state the gate does not have.
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export function InternalReviewForm({
  projectId,
  themeOptionId,
}: {
  projectId: string;
  themeOptionId: string;
}) {
  const [state, action, pending] = useActionState(submitInternalDesignReviewAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="themeOptionId" value={themeOptionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          What has to change — required when you send it back, so a designer is not left guessing
        </span>
        <textarea
          name="comments"
          rows={2}
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="The header contrast fails at the smallest size…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="result" value="passed" disabled={pending} className={buttonClass()}>
          Pass
        </button>
        <button
          type="submit"
          name="result"
          value="changes_required"
          disabled={pending}
          className={buttonClass('secondary')}
        >
          Ask for changes
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function AdminDecisionForm({
  projectId,
  themeOptionId,
}: {
  projectId: string;
  themeOptionId: string;
}) {
  const [state, action, pending] = useActionState(submitAdminDesignDecisionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="themeOptionId" value={themeOptionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          What to change — required for an edit. An edit returns the option to the designer and runs
          internal review again before it comes back to you.
        </span>
        <textarea
          name="reason"
          rows={2}
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="Use the other logo lockup…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="decision" value="confirm" disabled={pending} className={buttonClass()}>
          Confirm
        </button>
        <button
          type="submit"
          name="decision"
          value="edit"
          disabled={pending}
          className={buttonClass('secondary')}
        >
          Send back for an edit
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function AssignReviewerForm({
  projectId,
  roster,
  current,
}: {
  projectId: string;
  roster: RosterMember[];
  current: string | null;
}) {
  const [state, action, pending] = useActionState(assignDesignReviewerAction, IDLE_STATE);

  if (roster.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        Nobody is on this organisation’s roster yet, so there is no one to appoint.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Who holds the internal design gate</span>
        <select
          name="userId"
          defaultValue={current ?? ''}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          <option value="" disabled>
            Choose somebody
          </option>
          {roster.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName} — {m.role}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        {current ? 'Change reviewer' : 'Appoint reviewer'}
      </button>
      <Message state={state} />
    </form>
  );
}
