'use client';

import { useActionState, useEffect, useState } from 'react';

import { ESCALATION_ROLES, type Escalation } from '@/lib/admin/escalation-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, FormMessage, inputClass, selectClass } from '@/ui';

import { ACTION_ITEMS_CHANGED_EVENT } from './changed-event';
import { acknowledgeEscalationAction, escalateAction } from './escalation-actions';

/**
 * The escalate / acknowledge control — SCR-001 and SCR-003 (bucket F,
 * stream F-A), ONE component mounted wherever the PDF puts the button: the
 * dashboard's Tasks & approvals feed, the inbox row and the notification
 * drawer. It shows the item's current escalation (who raised it, to whom,
 * why, whether it was acknowledged), lets any internal member raise one
 * with a role and a reason, and lets an admin acknowledge or resolve it.
 * Every button posts to the one door; the answer is shown verbatim.
 */
export type EscalationView = Pick<Escalation, 'id' | 'toRole' | 'reason' | 'state' | 'fromUserName' | 'acknowledgedByName'> & {
  createdAtLabel: string;
};

export function EscalateControl({
  subjectType,
  subjectKey,
  title,
  escalation,
  canAnswer,
  compact,
}: {
  subjectType: string;
  subjectKey: string;
  title: string;
  /** The open or acknowledged escalation on this item, if any. */
  escalation: EscalationView | null;
  /** True for the owner and the ops admin — the two roles an escalation names. */
  canAnswer: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(escalateAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') {
      setOpen(false);
      window.dispatchEvent(new Event(ACTION_ITEMS_CHANGED_EVENT));
    }
  }, [state]);

  if (escalation) {
    return (
      <div className={cx('flex flex-col gap-1.5', compact ? 'text-xs' : 'text-[13px]')}>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={escalation.state === 'acknowledged' ? 'info' : 'warning'} dot>
            {escalation.state === 'acknowledged' ? 'Acknowledged' : 'Escalated'} to {escalation.toRole.replace('_', ' ')}
          </Badge>
          <span className="text-muted">
            by {escalation.fromUserName ?? 'a member'} · {escalation.createdAtLabel}
            {escalation.acknowledgedByName ? ` · acknowledged by ${escalation.acknowledgedByName}` : ''}
          </span>
        </span>
        <span className="text-muted">Reason: {escalation.reason}</span>
        {canAnswer ? <AnswerForm escalationId={escalation.id} state={escalation.state} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" onClick={() => setOpen((o) => !o)} className={buttonClass('ghost', 'sm')}>
        {open ? 'Cancel escalation' : 'Escalate'}
      </button>
      {open ? (
        <form action={action} className="flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="subjectType" value={subjectType} />
          <input type="hidden" name="subjectKey" value={subjectKey} />
          <input type="hidden" name="title" value={title} />
          <select name="toRole" defaultValue="owner" aria-label="Escalate to" className={cx(selectClass, 'h-8 w-36 text-[13px]')}>
            {ESCALATION_ROLES.map((r) => (
              <option key={r} value={r}>
                to {r.replace('_', ' ')}
              </option>
            ))}
          </select>
          <input name="reason" required maxLength={2000} placeholder="Why this needs them" aria-label="Reason" className={cx(inputClass, 'h-8 w-64 text-[13px]')} />
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Escalating…' : 'Escalate'}
          </button>
        </form>
      ) : null}
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </div>
  );
}

function AnswerForm({ escalationId, state: current }: { escalationId: string; state: Escalation['state'] }) {
  const [state, action, pending] = useActionState(acknowledgeEscalationAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') window.dispatchEvent(new Event(ACTION_ITEMS_CHANGED_EVENT));
  }, [state]);
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="escalationId" value={escalationId} />
      {current === 'open' ? (
        <button type="submit" name="state" value="acknowledged" disabled={pending} className={buttonClass('secondary', 'sm')}>
          Acknowledge
        </button>
      ) : null}
      <input name="note" maxLength={2000} placeholder="Resolution note (optional)" aria-label="Resolution note" className={cx(inputClass, 'h-8 w-56 text-[13px]')} />
      <button type="submit" name="state" value="resolved" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Resolve'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
