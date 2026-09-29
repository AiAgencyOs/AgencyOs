'use client';

import { useActionState } from 'react';

import { sendRequirementQuestionAction } from '@/modules/crm/requirement-question-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconSend } from '@/ui';

/**
 * SCR-029 — "Request client clarification", one question at a time. One
 * small form per open question: the version, the question's index in the
 * payload and its text go to the door, which refuses if the three disagree.
 * Goes through the same outbound chokepoint as every other send; the
 * refusal (no consent, outbound paused, already sent) is shown as written.
 */
export function RequirementQuestionSendForm({ versionId, leadId, questionIndex, question }: { versionId: string; leadId: string; questionIndex: number; question: string }) {
  const [state, action, pending] = useActionState(sendRequirementQuestionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="questionIndex" value={questionIndex} />
      <input type="hidden" name="question" value={question} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        <IconSend size={13} />
        {pending ? 'Sending…' : 'Request clarification'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
