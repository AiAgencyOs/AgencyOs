'use client';

import { useActionState, useId, useState } from 'react';

import { createContractAction, updateContractStatusAction } from '@/modules/sales/contract-actions';
import { CONTRACT_STATUS_LABEL, CONTRACT_STATUSES, nextContractStatuses, type ContractStatus } from '@/modules/sales/contract-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/** Where a form was opened from, so the door can refresh that page too. */
type Where = { leadId?: string | null; clientId?: string | null };

/**
 * Decision 10 — record a contract on a WON deal. Either the deal is fixed
 * (opened from the deal's own panel) or picked from the won deals. The door
 * (`sales.create_contract`) decides again: won only, owner or ops admin.
 */
export function NewContractForm({
  deals,
  fixedOpportunityId,
  leadId,
  clientId,
}: {
  deals: readonly { id: string; name: string }[];
  fixedOpportunityId?: string;
} & Where) {
  const [state, action, pending] = useActionState(createContractAction, IDLE_STATE);
  const [status, setStatus] = useState<ContractStatus>('draft');
  const id = useId();

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId ?? ''} />
      <input type="hidden" name="clientId" value={clientId ?? ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        {fixedOpportunityId ? (
          <input type="hidden" name="opportunityId" value={fixedOpportunityId} />
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-deal`} className={labelClass}>
              Won deal
            </label>
            <select id={`${id}-deal`} name="opportunityId" required defaultValue="" className={selectClass}>
              <option value="" disabled>
                Choose a won deal
              </option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-title`} className={labelClass}>
            Title
          </label>
          <input id={`${id}-title`} name="title" required maxLength={200} placeholder="e.g. Master services agreement" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-url`} className={labelClass}>
            File link
          </label>
          <input id={`${id}-url`} name="fileUrl" type="url" placeholder="https://…" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-status`} className={labelClass}>
            Status
          </label>
          <select id={`${id}-status`} name="status" value={status} onChange={(e) => setStatus(e.target.value as ContractStatus)} className={selectClass}>
            {CONTRACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CONTRACT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        {status === 'signed' ? (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-signer`} className={labelClass}>
                Signer name
              </label>
              <input id={`${id}-signer`} name="signerName" required maxLength={200} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-signed`} className={labelClass}>
                Signed on
              </label>
              <input id={`${id}-signed`} name="signedOn" type="date" required className={inputClass} />
            </div>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Record Contract'}
        </button>
        <FormMessage status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/**
 * Move one contract on: the statuses the door allows from where it is, with
 * the signer and the day when it is being recorded as signed, and a link if
 * the file is only now known. A signed contract shows no form — it is a record.
 */
export function ContractStatusForm({
  contractId,
  status,
  signerName,
  leadId,
  clientId,
}: {
  contractId: string;
  status: ContractStatus;
  signerName: string | null;
} & Where) {
  const next = nextContractStatuses(status);
  const [state, action, pending] = useActionState(updateContractStatusAction, IDLE_STATE);
  const [to, setTo] = useState<ContractStatus | ''>(next[0] ?? '');
  const id = useId();
  if (next.length === 0) return <span className="text-xs text-muted">Recorded</span>;

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="leadId" value={leadId ?? ''} />
      <input type="hidden" name="clientId" value={clientId ?? ''} />
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-to`} className={labelClass}>
          Move to
        </label>
        <select id={`${id}-to`} name="status" value={to} onChange={(e) => setTo(e.target.value as ContractStatus)} className={selectClass}>
          {next.map((s) => (
            <option key={s} value={s}>
              {CONTRACT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {to === 'signed' ? (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-signer`} className={labelClass}>
              Signer name
            </label>
            <input id={`${id}-signer`} name="signerName" required defaultValue={signerName ?? ''} maxLength={200} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-on`} className={labelClass}>
              Signed on
            </label>
            <input id={`${id}-on`} name="signedOn" type="date" required className={inputClass} />
          </div>
        </>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-url`} className={labelClass}>
          File link
        </label>
        <input id={`${id}-url`} name="fileUrl" type="url" placeholder="Keep current" className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Update'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full" />
    </form>
  );
}
