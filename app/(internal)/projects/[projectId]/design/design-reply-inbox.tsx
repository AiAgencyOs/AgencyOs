'use client';

import { useActionState } from 'react';

import { acceptDesignReplyAction, dismissDesignReplyAction } from '@/modules/projects/design-reply-actions';
import type { DesignReplyRow } from '@/modules/projects/design-reply-queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * What the PM read from the client's replies (Phase 3 PM §4.5). Each row keeps the client's own words,
 * what was concluded and how sure it was. A reply the PM applied is shown as such; one it would not
 * decide on its own - a final confirmation (it locks the design), a possible scope change, a reading it
 * was unsure of - waits here for a person.
 */

const INTENT_LABEL: Record<string, string> = {
  client_selected: 'Chose a direction',
  design_change_request: 'Wants a visual change',
  client_reference: 'Sent a reference',
  possible_scope_change: 'Possible new scope',
  clarification_required: 'Asked a question',
  final_confirmed: 'Confirmed as final',
  unclear: 'Unclear',
  unrelated: 'Unrelated',
};

const STATUS_LABEL: Record<string, string> = {
  proposed: 'Being handled',
  applied: 'Applied by the project manager',
  awaiting_person: 'Waiting for a person',
  asked: 'The client was asked to clarify',
  ignored: 'No action needed',
  accepted: 'Recorded by a person',
  dismissed: 'Dismissed',
};

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return <p className={state.status === 'error' ? 'text-xs text-danger' : 'text-xs text-success'}>{state.message}</p>;
}

function WaitingActions({ projectId, reply }: { projectId: string; reply: DesignReplyRow }) {
  const [acceptState, accept, accepting] = useActionState(acceptDesignReplyAction, IDLE_STATE);
  const [dismissState, dismiss, dismissing] = useActionState(dismissDesignReplyAction, IDLE_STATE);
  const canAccept = !['unclear', 'unrelated'].includes(reply.intent);
  return (
    <div className="flex flex-col gap-2 pt-1">
      {canAccept ? (
        <form action={accept} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="proposalId" value={reply.id} />
          <button type="submit" disabled={accepting} className={buttonClass('primary', 'sm')}>
            {accepting ? 'Recording…' : `Record as: ${INTENT_LABEL[reply.intent] ?? reply.intent}`}
          </button>
          <Message state={acceptState} />
        </form>
      ) : null}
      <form action={dismiss} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="proposalId" value={reply.id} />
        <input name="note" required maxLength={1000} placeholder="Why no action is needed" className="min-w-[14rem] flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[13px]" />
        <button type="submit" disabled={dismissing} className={buttonClass('secondary', 'sm')}>
          Dismiss
        </button>
        <Message state={dismissState} />
      </form>
    </div>
  );
}

export function ReplyInbox({ projectId, replies, mayAct, dateTime }: { projectId: string; replies: DesignReplyRow[]; mayAct: boolean; dateTime: (iso: string) => string }) {
  if (replies.length === 0) {
    return <p className="text-[13px] text-muted">No client reply to the design options has been read yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {replies.map((r) => (
        <li key={r.id} className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{INTENT_LABEL[r.intent] ?? r.intent}</span>
            <span className="text-xs text-muted">
              {r.source === 'rule' ? 'read by rule' : `${Math.round(r.confidence * 100)}% sure`} · {STATUS_LABEL[r.status] ?? r.status} · {dateTime(r.createdAt)}
            </span>
          </div>
          <blockquote className="border-l-2 border-line pl-2 text-muted">“{r.clientWords}”</blockquote>
          {r.themeName || r.colorName || r.referenceUrl || r.referenceNote ? (
            <p className="text-xs text-muted">
              {r.themeName ? `Option: ${r.themeName}. ` : ''}
              {r.colorName ? `Palette: ${r.colorName}. ` : ''}
              {r.referenceUrl ? `Reference: ${r.referenceUrl}. ` : ''}
              {r.referenceNote ? `Note: ${r.referenceNote}` : ''}
            </p>
          ) : null}
          {r.reasoning ? <p className="text-xs text-faint">{r.reasoning}</p> : null}
          {r.resolutionNote ? <p className="text-xs text-faint">{r.resolutionNote}</p> : null}
          {mayAct && r.status === 'awaiting_person' ? <WaitingActions projectId={projectId} reply={r} /> : null}
        </li>
      ))}
    </ul>
  );
}
