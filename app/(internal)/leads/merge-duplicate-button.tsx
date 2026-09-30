'use client';

import { useActionState, useEffect, useId, useState } from 'react';

import { mergeLeadsAction } from '@/modules/crm/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Drawer, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-006 "Merge duplicates through a governed flow", from the list: folds
 * one of this lead's same-contact duplicates INTO this lead, through the same
 * door Lead 360 uses (`crm.merge_leads` — a reason is required, refused when
 * either has a deal, nothing deleted, audited). Only offered to a caller who
 * holds `organization.settings`, like the Lead 360 form.
 */
export function MergeDuplicateButton({ leadId, name, duplicates }: { leadId: string; name: string; duplicates: { id: string; title: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(mergeLeadsAction, IDLE_STATE);
  const id = useId();
  useEffect(() => {
    if (state.status === 'success') setOpen(false);
  }, [state]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('ghost', 'sm')}>
        Merge duplicate
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={`Merge into ${name}`} description="Fold a duplicate of this lead into it. Nothing is deleted — the duplicate is kept and marked merged.">
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="leadId" value={leadId} />
          <label htmlFor={`${id}-loser`} className={labelClass}>Duplicate to fold in</label>
          <select id={`${id}-loser`} name="loserLeadId" required defaultValue="" className={selectClass}>
            <option value="" disabled>Choose a duplicate…</option>
            {duplicates.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
          <label htmlFor={`${id}-reason`} className={labelClass}>Why these are the same inquiry</label>
          <textarea id={`${id}-reason`} name="reason" rows={3} required className={inputClass} />
          <p className="text-xs text-muted">Only leads for the same contact, with no open deal on either, can be merged; the reason is recorded in the audit log.</p>
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Merging…' : 'Merge into this lead'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </form>
      </Drawer>
    </>
  );
}
