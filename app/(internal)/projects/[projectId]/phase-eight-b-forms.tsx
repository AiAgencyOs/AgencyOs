'use client';

import { useActionState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import {
  askFinanceAgentAction,
  askMaintenanceAgentAction,
  cancelMaintenanceWorkAction,
  decideBillingProposalAction,
  decideMaintenanceProposalAction,
  decideMaintenanceReleaseAction,
  linkMaintenanceInvoiceAction,
  openMaintenanceWorkAction,
  recordMaintenanceQaAction,
  recordMaintenanceReleaseAction,
  requestMaintenanceReleaseAction,
  routeMaintenanceWorkAction,
  setMaintenanceSlaPolicyAction,
  submitMaintenanceFixAction,
} from '@/modules/projects/phase-eight-b-actions';
import { buttonClass } from '@/ui';

/** Forms for the post-launch maintenance panel. They decide nothing: the database doors refuse and the refusal is shown as written. */

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';

type Field = { name: string; label: string; kind?: 'text' | 'select' | 'checkbox' | 'number' | 'date'; options?: { value: string; label: string }[]; required?: boolean };

function Status({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

function DoorForm({
  action, projectId, hidden = {}, fields, submit, buttons,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  projectId: string;
  hidden?: Record<string, string>;
  fields: Field[];
  submit?: string;
  /** Several submit buttons that differ by the `decision` they post. */
  buttons?: { value: string; label: string }[];
}) {
  const [state, run, pending] = useActionState(action, IDLE_STATE);
  return (
    <form action={run} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {fields.map((f) =>
        f.kind === 'select' ? (
          <label key={f.name} className="flex flex-col gap-1 text-[13px] text-muted">
            {f.label}
            <select name={f.name} className={field} required={f.required !== false} defaultValue={f.options?.[0]?.value}>
              {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ) : f.kind === 'checkbox' ? (
          <label key={f.name} className="flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" name={f.name} /> {f.label}
          </label>
        ) : (
          <label key={f.name} className="flex flex-col gap-1 text-[13px] text-muted">
            {f.label}
            <input name={f.name} type={f.kind ?? 'text'} className={field} required={f.required === true} />
          </label>
        ),
      )}
      <div className="flex gap-2">
        {buttons ? buttons.map((b) => (
          <button key={b.value} type="submit" name="decision" value={b.value} disabled={pending} className={buttonClass('secondary', 'sm')}>{b.label}</button>
        )) : <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Working…' : submit}</button>}
      </div>
      <Status state={state} />
    </form>
  );
}

const opt = (rows: { id: string; title?: string; name?: string; number?: string }[], prefix: string) => rows.map((r) => ({ value: `${prefix}:${r.id}`, label: r.title ?? r.name ?? r.number ?? r.id }));

export function OpenWorkForm({ projectId, tickets, defects, changeRequests }: { projectId: string; tickets: { id: string; title: string }[]; defects: { id: string; title: string }[]; changeRequests: { id: string; title: string }[] }) {
  const options = [
    ...opt(defects, 'defectId').map((o) => ({ ...o, label: `Defect: ${o.label}` })),
    ...opt(tickets, 'ticketId').map((o) => ({ ...o, label: `Covered ticket: ${o.label}` })),
    ...opt(changeRequests, 'changeRequestId').map((o) => ({ ...o, label: `Approved change request: ${o.label}` })),
  ];
  if (options.length === 0) return <p className="text-[13px] text-muted">There is no defect, covered ticket or approved change request to work against. New requests become a Change Request first; nothing is done as free scope.</p>;
  return (
    <DoorForm action={openMaintenanceWorkAction} projectId={projectId} submit="Open maintenance work" fields={[
      { name: 'authorization', label: 'What authorizes this work', kind: 'select', options },
      { name: 'kind', label: 'Kind', kind: 'select', options: [{ value: 'patch', label: 'Patch' }, { value: 'hotfix', label: 'Hotfix' }, { value: 'enhancement', label: 'Enhancement (needs a change request)' }] },
      { name: 'area', label: 'Area', kind: 'select', options: ['backend', 'frontend', 'database', 'mobile', 'integration', 'devops', 'dependency'].map((a) => ({ value: a, label: a })) },
      { name: 'title', label: 'Title', required: true },
      { name: 'description', label: 'Description' },
      { name: 'sensitive', label: 'Touches auth, payments, migrations or secrets (a security QA result is then required)', kind: 'checkbox' },
      { name: 'emergency', label: 'Emergency hotfix (an Admin authorizes it; QA and approval still apply)', kind: 'checkbox' },
    ]} />
  );
}
export const SubmitFixForm = ({ projectId, workItemId }: { projectId: string; workItemId: string }) => (
  <DoorForm action={submitMaintenanceFixAction} projectId={projectId} hidden={{ workItemId }} submit="Submit this commit" fields={[
    { name: 'commit', label: 'Exact commit (40 characters)', required: true }, { name: 'summary', label: 'What changed', required: true },
    { name: 'rollbackPlan', label: 'Rollback plan', required: true }, { name: 'rollbackOwner', label: 'Rollback owner', required: true },
  ]} />
);
export const QaResultForm = ({ projectId, workItemId, commit, sensitive }: { projectId: string; workItemId: string; commit: string; sensitive: boolean }) => (
  <DoorForm action={recordMaintenanceQaAction} projectId={projectId} hidden={{ workItemId, commit }} submit="Record QA result" fields={[
    { name: 'category', label: 'Category', kind: 'select', options: ['targeted', 'regression', ...(sensitive ? ['security'] : [])].map((c) => ({ value: c, label: c })) },
    { name: 'status', label: 'Result', kind: 'select', options: [{ value: 'pass', label: 'Pass (needs evidence)' }, { value: 'fail', label: 'Fail (opens a defect)' }, { value: 'blocked', label: 'Blocked' }] },
    { name: 'evidence', label: 'Evidence reference' }, { name: 'reason', label: 'Reason (for fail or blocked)' },
  ]} />
);
export const RequestReleaseForm = ({ projectId, workItemId }: { projectId: string; workItemId: string }) => <DoorForm action={requestMaintenanceReleaseAction} projectId={projectId} hidden={{ workItemId }} fields={[]} submit="Request release approval" />;
export const DecideReleaseForm = ({ projectId, workItemId, canDecide }: { projectId: string; workItemId: string; canDecide: boolean }) =>
  canDecide ? <DoorForm action={decideMaintenanceReleaseAction} projectId={projectId} hidden={{ workItemId }} fields={[{ name: 'note', label: 'Note (required to reject)' }]} buttons={[{ value: 'approve', label: 'Approve this exact commit' }, { value: 'reject', label: 'Reject' }]} /> : <p className="text-[13px] text-muted">You opened, built or requested this, so another Admin approves it.</p>;
export const RecordReleaseForm = ({ projectId, workItemId }: { projectId: string; workItemId: string }) => (
  <DoorForm action={recordMaintenanceReleaseAction} projectId={projectId} hidden={{ workItemId }} submit="Record that it was released" fields={[{ name: 'deploymentRef', label: 'Deployment reference', required: true }, { name: 'smokeEvidence', label: 'Smoke check evidence', required: true }]} />
);
export const CancelWorkForm = ({ projectId, workItemId }: { projectId: string; workItemId: string }) => <DoorForm action={cancelMaintenanceWorkAction} projectId={projectId} hidden={{ workItemId }} submit="Cancel this work" fields={[{ name: 'reason', label: 'Reason', required: true }]} />;
export const RouteForm = ({ projectId, workItemId }: { projectId: string; workItemId: string }) => <DoorForm action={routeMaintenanceWorkAction} projectId={projectId} hidden={{ workItemId }} fields={[]} submit="Record the Orchestrator's routing" />;
export const AskAgentForm = ({ projectId, workItemId, hasCommit }: { projectId: string; workItemId: string; hasCommit: boolean }) => (
  <DoorForm action={askMaintenanceAgentAction} projectId={projectId} hidden={{ workItemId }} submit="Ask the agent for a plan" fields={[
    { name: 'agent', label: 'Agent', kind: 'select', options: [{ value: 'bug_fix', label: 'Bug Fix: fix plan' }, ...(hasCommit ? [{ value: 'regression_test', label: 'Regression: test plan for this commit' }] : [])] },
  ]} />
);
export const DecideProposalForm = ({ projectId, proposalId, canDecide }: { projectId: string; proposalId: string; canDecide: boolean }) =>
  canDecide ? <DoorForm action={decideMaintenanceProposalAction} projectId={projectId} hidden={{ proposalId }} fields={[{ name: 'note', label: 'Note (required to reject)' }]} buttons={[{ value: 'accepted', label: 'Accept as a plan' }, { value: 'rejected', label: 'Reject' }]} /> : <p className="text-[13px] text-muted">You asked for this, so someone else decides.</p>;
export const SlaPolicyForm = ({ projectId }: { projectId: string }) => (
  <DoorForm action={setMaintenanceSlaPolicyAction} projectId={projectId} submit="Save SLA policy (new version)" fields={[
    { name: 'priority', label: 'Priority', kind: 'select', options: ['p0', 'p1', 'p2', 'p3'].map((p) => ({ value: p, label: p })) },
    { name: 'responseHours', label: 'Response hours', kind: 'number', required: true }, { name: 'resolutionHours', label: 'Resolution hours', kind: 'number', required: true }, { name: 'atRiskPercent', label: 'At-risk at % of resolution time (optional)', kind: 'number' },
  ]} />
);
export function AskFinanceForm({ projectId, plans, invoices }: { projectId: string; plans: { id: string; name: string }[]; invoices: { id: string; number: string }[] }) {
  const options = [...opt(plans, 'maintenance_invoice').map((o) => ({ ...o, label: `Invoice proposal for plan ${o.label}` })), ...opt(invoices, 'payment_reminder').map((o) => ({ ...o, label: `Reminder text for invoice ${o.label}` }))];
  if (options.length === 0) return <p className="text-[13px] text-muted">No plan or collectible invoice to prepare a proposal for.</p>;
  return <DoorForm action={askFinanceAgentAction} projectId={projectId} submit="Ask the Finance agent for a draft" fields={[{ name: 'subject', label: 'Prepare', kind: 'select', options }]} />;
}
export const DecideBillingForm = ({ projectId, proposalId, canDecide, invoices, linkable }: { projectId: string; proposalId: string; canDecide: boolean; invoices: { id: string; number: string }[]; linkable: boolean }) =>
  canDecide ? (
    <DoorForm action={decideBillingProposalAction} projectId={projectId} hidden={{ proposalId }} buttons={[{ value: 'accepted', label: 'Accept' }, { value: 'rejected', label: 'Reject' }]} fields={[
      { name: 'note', label: 'Note (required to reject)' },
      ...(linkable ? [{ name: 'invoiceId', label: 'Invoice you made through the existing doors (its total must equal the quote)', kind: 'select' as const, required: false, options: [{ value: '', label: 'None yet' }, ...invoices.map((i) => ({ value: i.id, label: i.number }))] }] : []),
    ]} />
  ) : <p className="text-[13px] text-muted">You asked for this, so another Admin decides.</p>;
export const LinkInvoiceForm = ({ projectId, plans, invoices }: { projectId: string; plans: { id: string; name: string }[]; invoices: { id: string; number: string }[] }) => (
  <DoorForm action={linkMaintenanceInvoiceAction} projectId={projectId} submit="Link invoice to the plan cycle" fields={[
    { name: 'planId', label: 'Plan', kind: 'select', options: plans.map((p) => ({ value: p.id, label: p.name })) },
    { name: 'invoiceId', label: 'Invoice', kind: 'select', options: invoices.map((i) => ({ value: i.id, label: i.number })) },
    { name: 'purpose', label: 'Purpose', kind: 'select', options: [{ value: 'activation', label: 'Activation' }, { value: 'renewal', label: 'Renewal' }] },
    { name: 'cycleStart', label: 'Cycle start', kind: 'date', required: true }, { name: 'cycleEnd', label: 'Cycle end', kind: 'date', required: true },
  ]} />
);
