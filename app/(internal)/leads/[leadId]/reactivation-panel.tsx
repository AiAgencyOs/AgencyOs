'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass } from '@/ui';

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

/** One alias, so the buttons below match every other button in the product. */
const button = buttonClass('secondary', 'sm');

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
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
    <details className="rounded-lg border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-[13px] font-semibold">
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
