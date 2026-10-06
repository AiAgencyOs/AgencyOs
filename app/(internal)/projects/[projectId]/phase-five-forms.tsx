'use client';

import { useActionState } from 'react';

import {
  approveDevelopmentPlanAction,
  classifyBuildFeedbackAction,
  createDevelopmentPlanAction,
  deriveDocumentsAction,
  linkTaskTestRunAction,
  planTaskAction,
  recordDocumentAction,
  recordFlakyTestAction,
  registerIntegrationAction,
  resolveFlakyTestAction,
  setIntegrationStateAction,
  setSpecialistStateAction,
  startPhaseFiveAction,
  recordBaselineCommitAction,
  resolveEscalationAction,
  runIntegrationCheckAction,
  setIntegrationCheckTargetAction,
  decideBuildAdminAction,
  recordBuildFeedbackAction,
  recordBuildQaAction,
  recordCodeReviewAction,
  shareBuildWithClientAction,
} from '@/modules/projects/phase-five-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * The Phase 5 doors, with a form each. Nothing here decides whether an action is allowed: the database door refuses (independence, gates,
 * state) and its refusal is shown as written. Each form is a collapsed <details> so the overview stays a read first.
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

const field = 'rounded-md border border-line bg-surface px-2 py-1';

function Hidden({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="deliverableId" value={deliverableId} />
    </>
  );
}

function QaForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordBuildQaAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Independent QA of this exact build. Whoever built it cannot pass it.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="QA outcome" name="outcome" defaultValue="passed" className={field}>
        <option value="passed">Passed</option>
        <option value="changes_required">Changes required</option>
      </select>
      <textarea aria-label="Note" name="note" rows={2} className={field} placeholder="What was tested (required when changes are required)" />
      <input aria-label="Evidence link" name="evidenceUrl" className={field} placeholder="https:// link to the test evidence (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record QA verdict'}</button>
      <Message state={state} />
    </form>
  );
}

function ReviewForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordCodeReviewAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Independent code and security review of the exact commit. A critical or high finding cannot pass.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="Review verdict" name="verdict" defaultValue="passed" className={field}>
        <option value="passed">Passed</option>
        <option value="changes_required">Changes required</option>
        <option value="blocked">Blocked</option>
      </select>
      <textarea aria-label="Review findings, one per line" name="findings" rows={3} className={field} placeholder={'One finding per line, e.g.\nhigh: SQL built from user input\nlow: naming'} />
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="changedCode" /> I changed the code myself while reviewing (a second reviewer will be required)
      </label>
      <input aria-label="Note" name="note" className={field} placeholder="Note (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record review'}</button>
      <Message state={state} />
    </form>
  );
}

function AdminForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(decideBuildAdminAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Admin decision on a build QA has passed. EDIT goes back to development, never to the client.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <select aria-label="Admin decision" name="decision" defaultValue="approved" className={field}>
        <option value="approved">Approve</option>
        <option value="changes_required">Edit (changes required)</option>
      </select>
      <textarea aria-label="Note" name="note" rows={2} className={field} placeholder="Note (required for an edit)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record decision'}</button>
      <Message state={state} />
    </form>
  );
}

function ShareForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(shareBuildWithClientAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Share this exact build for client testing. The database refuses unless it has a commit, a build run, a passed review, QA and Admin approval.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <button type="submit" disabled={pending} className={buttonClass()}>{pending ? 'Sharing…' : 'Share with the client'}</button>
      <Message state={state} />
    </form>
  );
}

function FeedbackForm({ projectId, deliverableId }: { projectId: string; deliverableId: string }) {
  const [state, action, pending] = useActionState(recordBuildFeedbackAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">The client&apos;s own words about this build, not a summary.</p>
      <Hidden projectId={projectId} deliverableId={deliverableId} />
      <textarea aria-label="What the client wrote" name="clientWords" rows={2} required className={field} placeholder="What the client wrote" />
      <input aria-label="Message reference" name="evidenceRef" className={field} placeholder="Message reference (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record feedback'}</button>
      <Message state={state} />
    </form>
  );
}

/** The actions a person can take on one development build. */
export function BuildActions({ projectId, deliverableId, status }: { projectId: string; deliverableId: string; status: string }) {
  const open = status === 'draft' || status === 'changes_requested';
  const shared = status === 'in_review' || status === 'changes_requested' || status === 'approved';
  return (
    <div className="flex flex-col gap-2 pl-4">
      {open ? (
        <>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">QA verdict</summary><QaForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Code review</summary><ReviewForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Admin decision</summary><AdminForm projectId={projectId} deliverableId={deliverableId} /></details>
          <details><summary className="cursor-pointer text-xs underline underline-offset-2">Share with the client</summary><ShareForm projectId={projectId} deliverableId={deliverableId} /></details>
        </>
      ) : null}
      {shared ? (
        <details><summary className="cursor-pointer text-xs underline underline-offset-2">Record client feedback</summary><FeedbackForm projectId={projectId} deliverableId={deliverableId} /></details>
      ) : null}
    </div>
  );
}

const CLASSES: [string, string][] = [
  ['bug', 'Bug'],
  ['missed_requirement', 'Missed requirement'],
  ['ui_mismatch', 'UI mismatch'],
  ['included_small_revision', 'Included small revision'],
  ['clarification', 'Clarification'],
  ['possible_scope_change', 'Possible scope change'],
  ['new_feature', 'New feature'],
];

export function ClassifyFeedbackForm({ projectId, feedbackId }: { projectId: string; feedbackId: string }) {
  const [state, action, pending] = useActionState(classifyBuildFeedbackAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="feedbackId" value={feedbackId} />
      <select aria-label="Feedback classification" name="classification" defaultValue="bug" className={field}>
        {CLASSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Routing…' : 'Classify and route'}</button>
      <Message state={state} />
    </form>
  );
}


const SPECIALISTS = ['frontend_developer', 'backend_developer', 'database_developer', 'mobile_developer', 'integration', 'devops_build', 'test_automation', 'security_review', 'bug_fix', 'refactor_performance', 'documentation'];
const label = (v: string) => v.replace(/_/g, ' ');

export function CreatePlanForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(createDevelopmentPlanAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">A technical plan over the locked baseline. Planning is not the PM&apos;s job; an Admin approves it.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <textarea aria-label="Plan summary" name="summary" rows={2} required className={field} placeholder="What will be built, in technical terms" />
      <textarea aria-label="Risks" name="risks" rows={2} className={field} placeholder="Risks (optional)" />
      <input aria-label="Test strategy" name="testStrategy" className={field} placeholder="Test strategy (optional)" />
      <input aria-label="Rollback plan" name="rollbackPlan" className={field} placeholder="Rollback plan (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Creating…' : 'Create plan'}</button>
      <Message state={state} />
    </form>
  );
}

export function PlanTaskForm({ projectId, planId, taskId, title }: { projectId: string; planId: string; taskId: string; title: string }) {
  const [state, action, pending] = useActionState(planTaskAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px]">{title}</p>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="taskId" value={taskId} />
      <textarea aria-label="Acceptance criteria" name="acceptanceCriteria" rows={2} required className={field} placeholder="Acceptance criteria: how will anyone know this is done?" />
      <select aria-label="Specialist" name="capability" defaultValue="backend_developer" className={field}>
        {SPECIALISTS.map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
      <select aria-label="Risk level" name="riskLevel" defaultValue="medium" className={field}>
        {['low', 'medium', 'high', 'critical'].map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input aria-label="Affected files" name="paths" className={field} placeholder="Files it touches, comma separated (for conflict detection)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Planning…' : 'Add to the plan'}</button>
      <Message state={state} />
    </form>
  );
}

export function ApprovePlanForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(approveDevelopmentPlanAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <button type="submit" disabled={pending} className={buttonClass()}>{pending ? 'Approving…' : 'Approve this plan (Admin)'}</button>
      <Message state={state} />
    </form>
  );
}

export function RegisterIntegrationForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(registerIntegrationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Integration kind" name="kind" defaultValue="whatsapp" className={field}>
        {['whatsapp', 'email', 'sms_otp', 'oauth', 'firebase', 'payment', 'storage', 'maps', 'analytics', 'ai_api', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
      <input aria-label="Integration name" name="name" required className={field} placeholder="Name, e.g. Razorpay sandbox" />
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="isMock" /> Only a mock exists (a mock can never be verified)</label>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Registering…' : 'Register integration'}</button>
      <Message state={state} />
    </form>
  );
}

export function IntegrationStateForm({ projectId, connectionId }: { projectId: string; connectionId: string }) {
  const [state, action, pending] = useActionState(setIntegrationStateAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <select aria-label="Integration state" name="health" defaultValue="configured" className={field}>
        {['configured', 'degraded', 'blocked', 'disabled', 'unknown'].map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input aria-label="Note" name="note" className={field} placeholder="Note" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? '…' : 'Set'}</button>
      <Message state={state} />
    </form>
  );
}

export function SpecialistStateForm({ projectId, agentKey, state: current }: { projectId: string; agentKey: string; state: string }) {
  const [state, action, pending] = useActionState(setSpecialistStateAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="agentKey" value={agentKey} />
      <select aria-label={`State of ${label(agentKey)}`} name="state" defaultValue={current} className={field}>
        {['required', 'not_required', 'active', 'blocked', 'complete'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
      <input aria-label="Reason" name="reason" className={field} placeholder="Reason (required for not required / blocked)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? '…' : 'Set'}</button>
      <Message state={state} />
    </form>
  );
}

export function RecordFlakyForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(recordFlakyTestAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input aria-label="Test" name="testKey" required className={field} placeholder="Test name or path" />
      <input aria-label="Suite" name="suite" className={field} placeholder="Suite (optional)" />
      <input aria-label="Suspected cause" name="cause" className={field} placeholder="Suspected cause (optional)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record a flaky test'}</button>
      <Message state={state} />
    </form>
  );
}

export function ResolveFlakyForm({ projectId, flakyId }: { projectId: string; flakyId: string }) {
  const [state, action, pending] = useActionState(resolveFlakyTestAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="flakyId" value={flakyId} />
      <select aria-label="Action" name="action" defaultValue="quarantine" className={field}>
        <option value="quarantine">Quarantine (owned, time-boxed)</option>
        <option value="resolve">Resolve (root cause fixed)</option>
      </select>
      <input aria-label="Quarantine days" name="days" type="number" min={1} max={30} defaultValue={7} className={`${field} w-20`} />
      <input aria-label="What was fixed" name="resolution" className={field} placeholder="What was fixed (to resolve)" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? '…' : 'Apply'}</button>
      <Message state={state} />
    </form>
  );
}

export function RecordDocumentForm({ projectId, integrations }: { projectId: string; integrations: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(recordDocumentAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Document what exists. An implemented document names its evidence; an integration is implemented only when it is verified; never a secret value.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Document kind" name="kind" defaultValue="api" className={field}>
        {['architecture', 'api', 'database', 'integration', 'build_run', 'test', 'known_limitations', 'handoff', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
      <input aria-label="Title" name="title" required className={field} placeholder="Title" />
      <select aria-label="Status" name="status" defaultValue="partial" className={field}>
        {['implemented', 'partial', 'not_implemented', 'not_required', 'manual_external', 'blocked', 'deprecated'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
      <input aria-label="Evidence" name="evidenceRef" className={field} placeholder="Evidence: file, test or run it was derived from" />
      <select aria-label="Integration" name="integrationId" defaultValue="" className={field}>
        <option value="">(not an integration document)</option>
        {integrations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
      <textarea aria-label="Body" name="body" rows={3} className={field} placeholder="Body" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record document'}</button>
      <Message state={state} />
    </form>
  );
}


export function LinkTestRunForm({ projectId, taskId, runs }: { projectId: string; taskId: string; runs: { id: string; suite: string; passed: number; failed: number }[] }) {
  const [state, action, pending] = useActionState(linkTaskTestRunAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <select aria-label="Test run" name="testRunId" className={field} defaultValue={runs[0]?.id ?? ''}>
        {runs.map((r) => <option key={r.id} value={r.id}>{r.suite}: {r.passed} passed, {r.failed} failed</option>)}
      </select>
      <button type="submit" disabled={pending || runs.length === 0} className={buttonClass('secondary', 'sm')}>{pending ? '…' : 'Link as evidence'}</button>
      <Message state={state} />
    </form>
  );
}

export function DeriveDocumentsForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(deriveDocumentsAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Deriving…' : 'Derive documentation from the current records'}</button>
      <Message state={state} />
    </form>
  );
}


export function StartPhaseFiveForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(startPhaseFiveAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Normally Phase 5 starts by itself when the M2 payment is verified. If it did not, ask the door: it re-checks Phase 4, M2, the locked UI, the approved prototype and the scope.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Checking…' : 'Start Phase 5'}</button>
      <Message state={state} />
    </form>
  );
}


export function RecordBaselineCommitForm({ projectId, repositories }: { projectId: string; repositories: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(recordBaselineCommitAction, IDLE_STATE);
  if (repositories.length === 0) {
    return <p className="text-[13px] text-muted">Link a repository to this project to record the baseline's base commit.</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">The baseline has no base commit yet. Record the commit it was cut from; this is done once and never changed.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Repository" name="repositoryId" className="rounded-md border border-line bg-surface px-2 py-1">
        {repositories.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
      <input aria-label="Base commit" name="baseCommit" required placeholder="abc1234" className="rounded-md border border-line bg-surface px-2 py-1" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Recording…' : 'Record base commit'}</button>
      <Message state={state} />
    </form>
  );
}


export function ResolveEscalationForm({ projectId, escalationId }: { projectId: string; escalationId: string }) {
  const [state, action, pending] = useActionState(resolveEscalationAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="escalationId" value={escalationId} />
      <input aria-label="Decision taken" name="resolution" required className={`${field} min-w-64`} placeholder="What was decided" />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? '…' : 'Close'}</button>
      <Message state={state} />
    </form>
  );
}


export function IntegrationCheckForm({ projectId, connectionId, checkUrl, credentialRef }: { projectId: string; connectionId: string; checkUrl: string | null; credentialRef: string | null }) {
  const [targetState, targetAction, targetPending] = useActionState(setIntegrationCheckTargetAction, IDLE_STATE);
  const [checkState, checkAction, checkPending] = useActionState(runIntegrationCheckAction, IDLE_STATE);
  return (
    <div className="flex flex-col gap-2">
      <form action={targetAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="connectionId" value={connectionId} />
        <input aria-label="Check URL" name="checkUrl" required defaultValue={checkUrl ?? ''} placeholder="https://api.provider.example/health" className={`${field} min-w-64`} />
        <input aria-label="Secret name" name="credentialRef" defaultValue={credentialRef ?? ''} placeholder="SECRET_NAME (not the value)" className={`${field} w-56`} />
        <button type="submit" disabled={targetPending} className={buttonClass('secondary', 'sm')}>{targetPending ? '…' : 'Set check target'}</button>
        <Message state={targetState} />
      </form>
      {checkUrl ? (
        <form action={checkAction} className="flex items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="connectionId" value={connectionId} />
          <button type="submit" disabled={checkPending} className={buttonClass('secondary', 'sm')}>{checkPending ? 'Checking…' : 'Run check now'}</button>
          <Message state={checkState} />
        </form>
      ) : null}
    </div>
  );
}
