'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';

import { enrollLeadAction, removeLeadAction } from './reactivation-actions';

/**
 * The lead-page reactivation cohort control — owner-only, the "operate" end of
 * the pilot the Settings page configures. It shows whether this lead is
 * enrolled and lets an owner enrol or remove it. Enrolment needs a granted
 * WhatsApp consent row; when that is absent the button is disabled and says so,
 * and even were it clicked the database refuses `no_consent` — consent is never
 * assumed here. Nothing sends on enrolment: a lead only receives the inactive
 * rhythm once the org pilot is on and the timezone, provider and WhatsApp are
 * configured.
 */

const button =
  'rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10';

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

export function ReactivationPanel({
  leadId,
  inPilot,
  consentEligible,
}: {
  leadId: string;
  inPilot: boolean;
  consentEligible: boolean;
}) {
  const [enrollState, enroll, enrolling] = useActionState(enrollLeadAction, IDLE_STATE);
  const [removeState, remove, removing] = useActionState(removeLeadAction, IDLE_STATE);

  return (
    <details className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
      <summary className="cursor-pointer text-sm font-medium">
        Reactivation cohort{' '}
        <span className="font-normal text-muted">— {inPilot ? 'enrolled' : 'not enrolled'}</span>
      </summary>
      <div className="flex flex-col gap-3 pt-3">
        <p className="text-xs text-muted">
          Only enrolled leads are nurtured on the inactive-lead rhythm, and only when the reactivation
          pilot is on for the agency. Enrolment requires a granted WhatsApp consent row for this
          lead&rsquo;s contact — it is never assumed.
        </p>

        {inPilot ? (
          <form action={remove} className="flex flex-col gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <button type="submit" disabled={removing} className={`${button} self-start`}>
              {removing ? 'Removing…' : 'Remove from cohort'}
            </button>
            <Status state={removeState} />
          </form>
        ) : (
          <form action={enroll} className="flex flex-col gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <button
              type="submit"
              disabled={enrolling || !consentEligible}
              title={consentEligible ? undefined : 'No granted WhatsApp consent for this contact'}
              className={`${button} self-start`}
            >
              {enrolling ? 'Enrolling…' : 'Enrol in cohort'}
            </button>
            {!consentEligible ? (
              <p className="text-xs text-muted">
                This lead&rsquo;s contact has no granted WhatsApp consent, so it cannot be enrolled.
                Record consent first.
              </p>
            ) : null}
            <Status state={enrollState} />
          </form>
        )}
      </div>
    </details>
  );
}
