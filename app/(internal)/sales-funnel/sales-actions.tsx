'use client';

import { useState } from 'react';

import { buttonClass, Drawer, IconCalendar, IconClock, IconPlus, selectClass } from '@/ui';

import { MeetingRequestForm } from '../leads/[leadId]/meeting-request-form';
import { FollowUpForm } from '../leads/[leadId]/sales-panel';
import { openQuickCreate } from '../shell-controls';

/**
 * SCR-005's three buttons — add lead, meeting, follow-up — each the door
 * that already exists, mounted here (bucket F rule 1): the header's
 * quick-create for a lead; the Lead 360's own meeting-request and
 * follow-up forms, on a lead picked from the ones the reader can see. No
 * second door, no form invented here.
 */
export type LeadOption = { id: string; title: string; conversationId: string | null };

export function SalesActions({ leads, agencyZone, canWrite }: { leads: readonly LeadOption[]; agencyZone: string; canWrite: boolean }) {
  const [mode, setMode] = useState<'meeting' | 'follow_up' | null>(null);
  const [leadId, setLeadId] = useState(leads[0]?.id ?? '');
  const lead = leads.find((l) => l.id === leadId) ?? null;

  if (!canWrite) return null;
  return (
    <>
      <button type="button" onClick={() => openQuickCreate('lead')} className={buttonClass('primary', 'sm')}>
        <IconPlus size={14} /> Add lead
      </button>
      <button type="button" onClick={() => setMode('meeting')} className={buttonClass('secondary', 'sm')}>
        <IconCalendar size={14} /> Add meeting
      </button>
      <button type="button" onClick={() => setMode('follow_up')} className={buttonClass('secondary', 'sm')}>
        <IconClock size={14} /> Add follow-up
      </button>
      <Drawer
        open={mode !== null}
        onClose={() => setMode(null)}
        title={mode === 'meeting' ? 'Request a meeting' : 'Schedule a follow-up'}
        description={mode === 'meeting' ? 'Recorded on the lead; nothing is agreed by recording it — times are offered from the calendar afterwards.' : 'The lead’s next follow-up date, the same field its page carries.'}
      >
        {leads.length === 0 ? (
          <p className="text-[13px] text-muted">No lead to attach this to. Add a lead first.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-xs font-medium text-muted">Lead</span>
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={selectClass}>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </label>
            {lead && mode === 'meeting' ? <MeetingRequestForm key={lead.id} leadId={lead.id} conversationId={lead.conversationId} agencyZone={agencyZone} /> : null}
            {lead && mode === 'follow_up' ? <FollowUpForm key={lead.id} leadId={lead.id} current={null} /> : null}
          </div>
        )}
      </Drawer>
    </>
  );
}
