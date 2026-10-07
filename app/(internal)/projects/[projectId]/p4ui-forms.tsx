'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  confirmPrototypeDesignIssueAction,
  decidePostLockRevisionAction,
  recordDesignInputsAction,
  recordFigmaRefsAction,
  requestPostLockRevisionAction,
  resolveDesignBlockerAction,
  resolvePrototypeBlockerAction,
  routePrototypeFeedbackAction,
  routeUiFeedbackAction,
} from '@/modules/projects/p4ui-actions';
import { buttonClass } from '@/ui';

/**
 * The Phase 4 UI Designer / Prototype forms. Each is one door, shown only where the record says the gate is open. Nothing here decides whether the door will
 * accept the call: the database re-checks the role, the organization and the state, and an agent is refused there (person_required / admin_required).
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

const CLASSIFICATIONS = ['CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST'] as const;
const FIELD = 'rounded-md border border-line bg-surface px-2 py-1';

export function ResolveBlockerForm({ projectId, blockerId, kind }: { projectId: string; blockerId: string; kind: 'design' | 'prototype' }) {
  const [state, action, pending] = useActionState(kind === 'design' ? resolveDesignBlockerAction : resolvePrototypeBlockerAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="blockerId" value={blockerId} />
      <input name="note" required className={FIELD} placeholder="What was done to clear it" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Resolving…' : 'Resolve'}</button>
      <Message state={state} />
    </form>
  );
}

export function RouteFeedbackForm({ projectId, subjectId, kind }: { projectId: string; subjectId: string; kind: 'ui' | 'prototype' }) {
  const [state, action, pending] = useActionState(kind === 'ui' ? routeUiFeedbackAction : routePrototypeFeedbackAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name={kind === 'ui' ? 'uiVersionId' : 'deliverableId'} value={subjectId} />
      <select name="classification" aria-label="Classification of the client feedback" required className={FIELD} defaultValue="">
        <option value="" disabled>Classify the client&apos;s feedback</option>
        {CLASSIFICATIONS.map((c) => (
          <option key={c} value={c}>{c.toLowerCase().replaceAll('_', ' ')}</option>
        ))}
      </select>
      <input name="reasoning" required className={FIELD} placeholder="Why (short)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Classify'}</button>
      <Message state={state} />
    </form>
  );
}

export function RequestPostLockForm({ projectId, uiVersionId }: { projectId: string; uiVersionId: string }) {
  const [state, action, pending] = useActionState(requestPostLockRevisionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="uiVersionId" value={uiVersionId} />
      <select name="kind" aria-label="Kind of change" required className={FIELD} defaultValue="redesign">
        <option value="redesign">redesign</option>
        <option value="colour_change">colour change</option>
        <option value="component_change">component change</option>
        <option value="other">other</option>
      </select>
      <input name="reason" required className={FIELD} placeholder="Why the locked UI must change" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Sending…' : 'Ask an Admin'}</button>
      <Message state={state} />
    </form>
  );
}

export function DecidePostLockForm({ projectId, requestId }: { projectId: string; requestId: string }) {
  const [state, action, pending] = useActionState(decidePostLockRevisionAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="requestId" value={requestId} />
      <input name="note" required className={FIELD} placeholder="Decision note" />
      <div className="flex gap-2">
        <button type="submit" name="decision" value="approve" disabled={pending} className={buttonClass('secondary', 'sm')}>Approve</button>
        <button type="submit" name="decision" value="reject" disabled={pending} className={buttonClass('secondary', 'sm')}>Reject</button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function ConfirmIssueForm({ projectId, issueId }: { projectId: string; issueId: string }) {
  const [state, action, pending] = useActionState(confirmPrototypeDesignIssueAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="issueId" value={issueId} />
      <select name="classification" aria-label="What the issue is" required className={FIELD} defaultValue="code_bug">
        <option value="code_bug">a prototype code bug (the Designer stays inactive)</option>
        <option value="source_ui_defect">the approved UI itself is defective</option>
      </select>
      <input name="note" required className={FIELD} placeholder="Why" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Record'}</button>
      <Message state={state} />
    </form>
  );
}

export function FigmaRefsForm({ projectId, uiVersionId }: { projectId: string; uiVersionId: string }) {
  const [state, action, pending] = useActionState(recordFigmaRefsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <p className="text-[13px] text-muted">Records where the design lives. AgencyOS does not write to Figma.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="uiVersionId" value={uiVersionId} />
      <input name="fileRef" required className={FIELD} placeholder="Figma file reference" />
      <input name="pageRef" className={FIELD} placeholder="Page (optional)" />
      <input name="replaceReason" className={FIELD} placeholder="Only if replacing a different file: why" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Record references'}</button>
      <Message state={state} />
    </form>
  );
}

export function DesignInputsForm({
  projectId,
  phaseFourId,
  current,
}: {
  projectId: string;
  phaseFourId: string;
  current: { brandAssets: Array<{ name: string; placeholderApproved: boolean }>; accessibilityTargets: string[]; deviceTargets: string[]; planningNote: string | null } | null;
}) {
  const [state, action, pending] = useActionState(recordDesignInputsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <p className="text-[13px] text-muted">What the Designer is told. A brand asset that is neither stored nor marked as an approved placeholder becomes an open blocker.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="phaseFourId" value={phaseFourId} />
      <textarea
        name="brandAssets"
        rows={3}
        className={FIELD}
        placeholder={'One brand asset per line, e.g.\nClient logo (SVG)\nBrand pattern | placeholder'}
        defaultValue={current?.brandAssets.map((a) => (a.placeholderApproved ? `${a.name} | placeholder` : a.name)).join('\n') ?? ''}
      />
      <input name="accessibility" className={FIELD} placeholder="Accessibility targets, comma-separated (wcag_aa, keyboard_only, screen_reader…)" defaultValue={current?.accessibilityTargets.join(', ') ?? ''} />
      <input name="devices" className={FIELD} placeholder="Devices, comma-separated (mobile, tablet, desktop, ios, android)" defaultValue={current?.deviceTargets.join(', ') ?? ''} />
      <textarea name="planningNote" rows={2} className={FIELD} placeholder="Planning note for the Designer (optional)" defaultValue={current?.planningNote ?? ''} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Record design inputs'}</button>
      <Message state={state} />
    </form>
  );
}
