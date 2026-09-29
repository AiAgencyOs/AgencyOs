'use client';

import { useActionState, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Drawer, FormMessage, IconEdit, inputClass, labelClass, textareaClass } from '@/ui';

import { updateClientAccountAction } from './edit-actions';

export type ClientEditValues = {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  billingAddress: string | null;
};

/**
 * SCR-014/015 — the client edit form: name, legal name, GSTIN, PAN, billing
 * address, through `core.update_client_account`. One form, mounted twice
 * (bucket F rule 1): in a drawer from the clients list and on the Client
 * 360's Settings tab. The GSTIN's checksum is checked by the door; a
 * refusal comes back as the door said it.
 */
export function ClientEditForm({ client }: { client: ClientEditValues }) {
  const [state, action, pending] = useActionState(updateClientAccountAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="clientAccountId" value={client.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={labelClass}>Client name</span>
          <input name="name" required maxLength={200} defaultValue={client.name} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={labelClass}>Legal name</span>
          <input name="legalName" maxLength={200} defaultValue={client.legalName ?? ''} placeholder="As registered, if it differs" className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>GSTIN</span>
          <input name="gstin" maxLength={15} defaultValue={client.gstin ?? ''} placeholder="27AAPFU0939F1ZV" className={`${inputClass} font-mono uppercase`} />
          <span className="text-[11px] text-muted">Shape, state code and check character are verified on save.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>PAN</span>
          <input name="pan" maxLength={10} defaultValue={client.pan ?? ''} placeholder="AAPFU0939F" className={`${inputClass} font-mono uppercase`} />
          <span className="text-[11px] text-muted">Must match characters 3–12 of the GSTIN when both are given.</span>
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={labelClass}>Billing address</span>
          <textarea name="billingAddress" rows={3} maxLength={1000} defaultValue={client.billingAddress ?? ''} className={textareaClass} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save client'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

/** The list's per-row "Edit" — the same form in a drawer. */
export function ClientEditButton({ client }: { client: ClientEditValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')} aria-label={`Edit ${client.name}`}>
        <IconEdit size={13} /> Edit
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={`Edit ${client.name}`} description="Name, legal name, GSTIN, PAN and billing address. Audited.">
        <ClientEditForm client={client} />
      </Drawer>
    </>
  );
}
