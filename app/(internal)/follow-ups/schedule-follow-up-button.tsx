'use client';

import { useId, useState } from 'react';

import { buttonClass, Drawer, IconClock, selectClass } from '@/ui';

import { FollowUpForm } from '../leads/[leadId]/sales-panel';

/**
 * SCR-013 "Schedule": sets a lead's next follow-up date from the queue page,
 * through the field and door Lead 360 carries (`setLeadFollowUpAction`). No
 * second implementation — the lead is picked here, the form is the lead's own.
 */
export function ScheduleFollowUpButton({ leads }: { leads: readonly { id: string; title: string }[] }) {
  const [open, setOpen] = useState(false);
  const [leadId, setLeadId] = useState(leads[0]?.id ?? '');
  const id = useId();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonClass('primary', 'sm')}>
        <IconClock size={14} /> Schedule follow-up
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Schedule a follow-up" description="The lead’s next follow-up date — the same field and door its own page carries.">
        {leads.length === 0 ? (
          <p className="text-[13px] text-muted">No lead to attach this to. Add a lead first.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label htmlFor={`${id}-lead`} className="text-xs font-medium text-muted">Lead</label>
            <select id={`${id}-lead`} value={leadId} onChange={(e) => setLeadId(e.target.value)} className={selectClass}>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
            {open ? <FollowUpForm key={leadId} leadId={leadId} current={null} /> : null}
          </div>
        )}
      </Drawer>
    </>
  );
}
