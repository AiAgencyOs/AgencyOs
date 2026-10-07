'use client';

import { useActionState } from 'react';

import { IDLE_STATE, type FormState } from '@/modules/identity/types';
import {
  acknowledgeSlaBreachAction,
  activatePlanAction,
  addPriceLineAction,
  confirmRenewalAction,
  createCatalogVersionAction,
  decideCancellationAction,
  draftOverageAction,
  openMaintenancePlanAction,
  proposeRenewalAction,
  publishCatalogVersionAction,
  recordDataSafetyAction,
  recordPlanAcceptanceAction,
  recordRenewalDecisionAction,
  recordUsageAction,
  requestCancellationAction,
  reverseUsageAction,
  setStallPolicyAction,
} from '@/modules/projects/phase-eight-c-actions';
import { buttonClass } from '@/ui';

/** Forms for the plan lifecycle panel. They decide nothing: the database doors refuse and the refusal is shown as written. */

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';
type Opt = { value: string; label: string };
type F = { name: string; label: string; kind?: 'text' | 'select' | 'checkbox' | 'number' | 'date'; options?: Opt[]; required?: boolean };
const CHANNELS: Opt[] = ['email', 'whatsapp', 'signed_document', 'call_note', 'portal'].map((c) => ({ value: c, label: c.replace('_', ' ') }));

function Status({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

function DoorForm({ action, projectId, hidden = {}, fields, submit, buttons }: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  projectId: string;
  hidden?: Record<string, string>;
  fields: F[];
  submit?: string;
  buttons?: Opt[];
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
            <input name={f.name} type={f.kind ?? 'text'} className={field} required={f.required === true} step={f.kind === 'number' ? 'any' : undefined} />
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

export const CatalogVersionForm = ({ projectId }: { projectId: string }) => (
  <DoorForm action={createCatalogVersionAction} projectId={projectId} submit="Draft a version" fields={[
    { name: 'name', label: 'Plan name', required: true },
    { name: 'billingModel', label: 'Billing model', kind: 'select', options: ['monthly', 'quarterly', 'annual', 'prepaid'].map((v) => ({ value: v, label: v })) },
    { name: 'includedHours', label: 'Included hours per cycle (leave blank if none)', kind: 'number' },
    { name: 'includedRequests', label: 'Included requests per cycle (leave blank if none)', kind: 'number' },
    { name: 'coverage', label: 'What is covered' }, { name: 'excludedWork', label: 'What is not covered' }, { name: 'renewalTerms', label: 'Renewal terms' },
  ]} />
);
export const PriceLineForm = ({ projectId, catalogId }: { projectId: string; catalogId: string }) => (
  <DoorForm action={addPriceLineAction} projectId={projectId} hidden={{ catalogId }} submit="Enter a price line" fields={[
    { name: 'label', label: 'Label', required: true },
    { name: 'per', label: 'Per', kind: 'select', options: [{ value: 'cycle', label: 'cycle' }, { value: 'included_hour', label: 'included hour' }, { value: 'overage_hour', label: 'overage hour' }, { value: 'overage_request', label: 'overage request' }] },
    { name: 'amountMinor', label: 'Amount (minor units, a number you decide)', kind: 'number', required: true },
    { name: 'currency', label: 'Currency (3 letters)', required: true },
  ]} />
);
export const PublishCatalogForm = ({ projectId, catalogId, status }: { projectId: string; catalogId: string; status: string }) => (
  <DoorForm action={publishCatalogVersionAction} projectId={projectId} hidden={{ catalogId }} fields={[]} buttons={status === 'draft' ? [{ value: 'publish', label: 'Publish (not the author)' }] : [{ value: 'retire', label: 'Retire' }]} />
);
export const OpenPlanForm = ({ projectId, catalog }: { projectId: string; catalog: Opt[] }) =>
  catalog.length === 0 ? <p className="text-[13px] text-muted">No published catalog version yet.</p> : (
    <DoorForm action={openMaintenancePlanAction} projectId={projectId} submit="Open a plan" fields={[{ name: 'catalogId', label: 'Published version', kind: 'select', options: catalog }]} />
  );
export const AcceptanceForm = ({ projectId, planId, proposals }: { projectId: string; planId: string; proposals: Opt[] }) => (
  <DoorForm action={recordPlanAcceptanceAction} projectId={projectId} hidden={{ planId }} buttons={[{ value: 'accepted', label: 'Record: accepted' }, { value: 'declined', label: 'Record: declined' }]} fields={[
    { name: 'proposalId', label: 'The accepted quote (needed to record an acceptance)', kind: 'select', required: false, options: [{ value: '', label: 'none' }, ...proposals] },
    { name: 'channel', label: 'Where the client said it', kind: 'select', options: CHANNELS },
    { name: 'evidenceRef', label: 'Reference to the message or document (never a secret)', required: true },
    { name: 'clientContact', label: 'Client contact who decided', required: true },
    { name: 'reason', label: 'Reason (required for a decline)' },
  ]} />
);
export const ActivateForm = ({ projectId, planId, reinstate }: { projectId: string; planId: string; reinstate: boolean }) => (
  <DoorForm action={activatePlanAction} projectId={projectId} hidden={{ planId }} fields={[]} buttons={[{ value: reinstate ? 'reinstate' : 'activate', label: reinstate ? 'Reinstate (needs a paid or excepted cycle)' : 'Activate (needs a paid first cycle)' }]} />
);
export const UsageForm = ({ projectId, planId, targets }: { projectId: string; planId: string; targets: Opt[] }) => (
  <DoorForm action={recordUsageAction} projectId={projectId} hidden={{ planId }} submit="Record usage" fields={[
    { name: 'kind', label: 'Kind', kind: 'select', options: [{ value: 'hours', label: 'hours' }, { value: 'request', label: 'request' }] },
    { name: 'quantity', label: 'Quantity', kind: 'number', required: true }, { name: 'occurredOn', label: 'Date it happened', kind: 'date', required: true },
    { name: 'against', label: 'Answers to', kind: 'select', options: targets }, { name: 'note', label: 'Note' },
  ]} />
);
export const ReverseUsageForm = ({ projectId, entryId }: { projectId: string; entryId: string }) => (
  <DoorForm action={reverseUsageAction} projectId={projectId} hidden={{ entryId }} submit="Reverse this entry" fields={[{ name: 'reason', label: 'Why', required: true }]} />
);
export const OverageForm = ({ projectId, cycleId, kind }: { projectId: string; cycleId: string; kind: 'hours' | 'request' }) => (
  <DoorForm action={draftOverageAction} projectId={projectId} hidden={{ cycleId, kind }} submit={`Draft the ${kind} overage for a person to quote`} fields={[]} />
);
export const ProposeRenewalForm = ({ projectId, planId, proposals }: { projectId: string; planId: string; proposals: Opt[] }) => (
  <DoorForm action={proposeRenewalAction} projectId={projectId} hidden={{ planId }} submit="Propose a renewal" fields={[
    { name: 'proposalId', label: 'Quote for the renewal', kind: 'select', options: proposals }, { name: 'newEndsOn', label: 'New end date', kind: 'date', required: true },
  ]} />
);
export const RenewalDecisionForm = ({ projectId, renewalId }: { projectId: string; renewalId: string }) => (
  <DoorForm action={recordRenewalDecisionAction} projectId={projectId} hidden={{ renewalId }} buttons={[{ value: 'accepted', label: 'Record: accepted' }, { value: 'declined', label: 'Record: declined' }]} fields={[
    { name: 'channel', label: 'Where the client said it', kind: 'select', options: CHANNELS },
    { name: 'evidenceRef', label: 'Reference to the message or document', required: true }, { name: 'clientContact', label: 'Client contact who decided', required: true }, { name: 'reason', label: 'Reason (required for a decline)' },
  ]} />
);
export const ConfirmRenewalForm = ({ projectId, renewalId }: { projectId: string; renewalId: string }) => (
  <DoorForm action={confirmRenewalAction} projectId={projectId} hidden={{ renewalId }} submit="Confirm renewal (needs the renewal cycle paid)" fields={[]} />
);
export const CancellationRequestForm = ({ projectId, planId }: { projectId: string; planId: string }) => (
  <DoorForm action={requestCancellationAction} projectId={projectId} hidden={{ planId }} submit="Request cancellation" fields={[
    { name: 'reasonCode', label: 'Churn reason', kind: 'select', options: ['client_request', 'non_payment', 'scope_mismatch', 'price', 'service_issue', 'project_ended', 'other'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') })) },
    { name: 'reason', label: 'Reason in words', required: true }, { name: 'evidenceRef', label: 'Reference (optional)' },
  ]} />
);
export const CancellationDecisionForm = ({ projectId, cancellationId }: { projectId: string; cancellationId: string }) => (
  <DoorForm action={decideCancellationAction} projectId={projectId} hidden={{ cancellationId }} fields={[]} buttons={[{ value: 'confirm', label: 'Confirm (not the requester)' }, { value: 'withdraw', label: 'Withdraw' }]} />
);
export const DataSafetyForm = ({ projectId, workItemId, commitRef }: { projectId: string; workItemId: string; commitRef: string }) => (
  <DoorForm action={recordDataSafetyAction} projectId={projectId} hidden={{ workItemId, commitRef }} submit="Record data safety for this commit" fields={[
    { name: 'rollbackPlan', label: 'Rollback plan', required: true }, { name: 'backupEvidenceRef', label: 'Backup-confirmed evidence reference (never a secret)', required: true },
    { name: 'destructive', label: 'The change is destructive', kind: 'checkbox' },
  ]} />
);
export const AckBreachForm = ({ projectId, breachId }: { projectId: string; breachId: string }) => (
  <DoorForm action={acknowledgeSlaBreachAction} projectId={projectId} hidden={{ breachId }} submit="Acknowledge" fields={[{ name: 'note', label: 'What is being done', required: true }]} />
);
export const StallPolicyForm = ({ projectId }: { projectId: string }) => (
  <DoorForm action={setStallPolicyAction} projectId={projectId} submit="Set the stall threshold" fields={[{ name: 'hours', label: 'Hours without a change before work counts as stalled', kind: 'number', required: true }]} />
);
