'use client';

import { useCallback, useEffect, useState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { createTaskAction, submitChangeRequestAction } from '@/modules/projects/actions';
import { listProjectOptionsAction } from '@/modules/projects/project-create-actions';
import type { ProjectOption } from '@/modules/projects/project-create-queries';
import { draftProposalAction } from '@/modules/sales/actions';
import { Button, Field, FormMessage, inputClass, selectClass, textareaClass } from '@/ui';

import { requestMeetingAction } from './leads/[leadId]/meeting-request-actions';
import { listLeadOptionsAction, listOpenOpportunityOptionsAction, type LeadOption, type OpportunityOption } from './palette-actions';

/**
 * Quick Create's four further in-place forms — SCR-004 (bucket F, stream
 * F-A): a task, a quotation draft, a meeting request and a change request,
 * inline in the ⌘K dialog like the lead, client, project and invoice forms
 * before them. Each posts to the EXISTING door the record's own page uses
 * (`createTaskAction`, `draftProposalAction`, `requestMeetingAction`,
 * `submitChangeRequestAction`); nothing here is a second door.
 *
 * Two things every form here does the same way:
 *   • Context pre-fill: the palette hands in the project or lead the person
 *     is looking at, and the picker starts on it.
 *   • Drafts: the palette hands in the fields it saved when the dialog was
 *     last closed on this form, and `onFields` reports every keystroke back
 *     so the palette can save them again on close.
 */
export type PaletteFormProps = {
  onCancel: () => void;
  onCreated: (href: string) => void;
  /** Saved fields to restore, if any. */
  draft?: Record<string, string>;
  /** Called with the current fields on every change, so the palette can keep a draft. */
  onFields?: (fields: Record<string, string>) => void;
  /** The route's own project or lead, for pre-fill. */
  context?: { projectId?: string; leadId?: string };
};

function useFields<T extends Record<string, string>>(initial: T, draft: Record<string, string> | undefined, onFields: PaletteFormProps['onFields']) {
  const [fields, setFields] = useState<T>(() => {
    const merged = { ...initial } as Record<string, string>;
    for (const k of Object.keys(initial)) if (draft && typeof draft[k] === 'string' && draft[k]) merged[k] = draft[k];
    return merged as T;
  });
  useEffect(() => {
    onFields?.(fields);
  }, [fields, onFields]);
  const patch = useCallback((partial: Partial<T>) => setFields((f) => ({ ...f, ...partial })), []);
  const set = (key: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = e.target.value;
    patch({ [key]: value } as Partial<T>);
  };
  return { fields, set, patch };
}

function toFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

export function CreateTaskForm({ onCancel, onCreated, draft, onFields, context }: PaletteFormProps) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fields, set } = useFields({ projectId: context?.projectId ?? '', title: '', dueOn: '', description: '' }, draft, onFields);

  useEffect(() => {
    listProjectOptionsAction()
      .then((r) => (r.ok ? setProjects(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Projects could not be read.'));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const state = await createTaskAction(IDLE_STATE, toFormData(fields));
    setSubmitting(false);
    if (state.status === 'error') return setError(state.message ?? 'Refused.');
    onCreated(`/projects/${fields.projectId}/board`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">New task</h2>
      <Field label="Project" htmlFor="qc-task-project" required hint={loadError ?? (projects === null ? 'Loading projects…' : projects.length === 0 ? 'No open projects.' : context?.projectId && fields.projectId === context.projectId ? 'Pre-filled from the project you are on.' : undefined)}>
        <select id="qc-task-project" required value={fields.projectId} onChange={set('projectId')} className={selectClass} disabled={projects === null || Boolean(loadError)}>
          <option value="">Choose a project…</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title" htmlFor="qc-task-title" required>
        <input id="qc-task-title" required maxLength={200} value={fields.title} onChange={set('title')} className={inputClass} placeholder="What needs doing" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due on" htmlFor="qc-task-due">
          <input id="qc-task-due" type="date" value={fields.dueOn} onChange={set('dueOn')} className={inputClass} />
        </Field>
      </div>
      <Field label="Description" htmlFor="qc-task-description">
        <textarea id="qc-task-description" rows={3} maxLength={4000} value={fields.description} onChange={set('description')} className={textareaClass} />
      </Field>
      <FormMessage status={error ? 'error' : 'idle'} message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fields.projectId}>
          {submitting ? 'Creating…' : 'Create task'}
        </Button>
      </div>
    </form>
  );
}

export function CreateQuotationForm({ onCancel, onCreated, draft, onFields, context }: PaletteFormProps) {
  const [deals, setDeals] = useState<OpportunityOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fields, set, patch } = useFields({ opportunityId: '', title: '', validUntil: '', body: '' }, draft, onFields);
  const [preselected, setPreselected] = useState(false);

  useEffect(() => {
    listOpenOpportunityOptionsAction()
      .then((r) => (r.ok ? setDeals(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Open deals could not be read.'));
  }, []);

  // Context pre-fill: the lead the person is looking at names its open deal.
  useEffect(() => {
    if (preselected || !deals || !context?.leadId || fields.opportunityId) return;
    const mine = deals.find((d) => d.leadId === context.leadId);
    if (mine) patch({ opportunityId: mine.opportunityId });
    setPreselected(true);
  }, [deals, context?.leadId, fields.opportunityId, preselected, patch]);

  const deal = deals?.find((d) => d.opportunityId === fields.opportunityId) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const fd = toFormData(fields);
    if (deal?.leadId) fd.set('leadId', deal.leadId);
    const state = await draftProposalAction(IDLE_STATE, fd);
    setSubmitting(false);
    if (state.status === 'error') return setError(state.message ?? 'Refused.');
    onCreated(deal?.leadId ? `/leads/${deal.leadId}#quotations` : '/quotations');
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">New quotation</h2>
      <p className="text-[13px] text-muted">
        Drafts version one against an open deal — the same door as the Lead 360&rsquo;s quotation panel. Lines, pricing and
        submission for approval follow on the lead&rsquo;s page.
      </p>
      <Field label="Deal" htmlFor="qc-quote-deal" required hint={loadError ?? (deals === null ? 'Loading open deals…' : deals.length === 0 ? 'No open deals — a quotation needs one.' : deal && context?.leadId === deal.leadId ? 'Pre-filled from the lead you are on.' : undefined)}>
        <select id="qc-quote-deal" required value={fields.opportunityId} onChange={set('opportunityId')} className={selectClass} disabled={deals === null || Boolean(loadError)}>
          <option value="">Choose a deal…</option>
          {(deals ?? []).map((d) => (
            <option key={d.opportunityId} value={d.opportunityId}>
              {d.leadTitle} — {d.name} · {d.stage.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title" htmlFor="qc-quote-title" required>
        <input id="qc-quote-title" required maxLength={200} value={fields.title} onChange={set('title')} className={inputClass} placeholder="e.g. Website redesign — phase 1" />
      </Field>
      <Field label="Valid until" htmlFor="qc-quote-valid">
        <input id="qc-quote-valid" type="date" value={fields.validUntil} onChange={set('validUntil')} className={inputClass} />
      </Field>
      <Field label="Scope summary" htmlFor="qc-quote-body">
        <textarea id="qc-quote-body" rows={3} maxLength={4000} value={fields.body} onChange={set('body')} className={textareaClass} />
      </Field>
      <FormMessage status={error ? 'error' : 'idle'} message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fields.opportunityId}>
          {submitting ? 'Drafting…' : 'Draft quotation'}
        </Button>
      </div>
    </form>
  );
}

const MEETING_MODES = [
  { value: 'call', label: 'Call' },
  { value: 'video_meeting', label: 'Video meeting' },
  { value: 'in_person_meeting', label: 'In person' },
  { value: 'other', label: 'Other' },
] as const;

export function RequestMeetingForm({ onCancel, onCreated, draft, onFields, context }: PaletteFormProps) {
  const [leads, setLeads] = useState<LeadOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fields, set } = useFields({ leadId: context?.leadId ?? '', mode: 'call', purpose: '' }, draft, onFields);

  useEffect(() => {
    listLeadOptionsAction()
      .then((r) => (r.ok ? setLeads(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Leads could not be read.'));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const state = await requestMeetingAction(IDLE_STATE, toFormData(fields));
    setSubmitting(false);
    if (state.status === 'error') return setError(state.message ?? 'Refused.');
    onCreated(`/leads/${fields.leadId}#meetings`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">Schedule a meeting</h2>
      <p className="text-[13px] text-muted">
        Schedules by recording the meeting wanted — the same door as the Lead 360. It books nothing by itself; the time is
        offered and booked from the calendar's live availability, never invented here.
      </p>
      <Field label="Lead" htmlFor="qc-meeting-lead" required hint={loadError ?? (leads === null ? 'Loading leads…' : context?.leadId && fields.leadId === context.leadId ? 'Pre-filled from the lead you are on.' : undefined)}>
        <select id="qc-meeting-lead" required value={fields.leadId} onChange={set('leadId')} className={selectClass} disabled={leads === null || Boolean(loadError)}>
          <option value="">Choose a lead…</option>
          {(leads ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.title} · {l.status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="How they want to meet" htmlFor="qc-meeting-mode" required>
        <select id="qc-meeting-mode" value={fields.mode} onChange={set('mode')} className={selectClass}>
          {MEETING_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Purpose" htmlFor="qc-meeting-purpose">
        <input id="qc-meeting-purpose" maxLength={200} value={fields.purpose} onChange={set('purpose')} className={inputClass} placeholder="Optional — in the client's words" />
      </Field>
      <FormMessage status={error ? 'error' : 'idle'} message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fields.leadId}>
          {submitting ? 'Recording…' : 'Record the request'}
        </Button>
      </div>
    </form>
  );
}

export function CreateChangeRequestForm({ onCancel, onCreated, draft, onFields, context }: PaletteFormProps) {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fields, set } = useFields({ projectId: context?.projectId ?? '', requested: '', source: 'client' }, draft, onFields);

  useEffect(() => {
    listProjectOptionsAction()
      .then((r) => (r.ok ? setProjects(r.data) : setLoadError(r.error.message)))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Projects could not be read.'));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const state = await submitChangeRequestAction(IDLE_STATE, toFormData(fields));
    setSubmitting(false);
    if (state.status === 'error') return setError(state.message ?? 'Refused.');
    onCreated(`/projects/${fields.projectId}/scope`);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-4">
      <h2 className="text-sm font-semibold text-foreground">New change request</h2>
      <p className="text-[13px] text-muted">
        Submits a change against the project&rsquo;s frozen scope — the same door as the Scope page. It waits for
        classification and the owner&rsquo;s decision there.
      </p>
      <Field label="Project" htmlFor="qc-cr-project" required hint={loadError ?? (projects === null ? 'Loading projects…' : context?.projectId && fields.projectId === context.projectId ? 'Pre-filled from the project you are on.' : undefined)}>
        <select id="qc-cr-project" required value={fields.projectId} onChange={set('projectId')} className={selectClass} disabled={projects === null || Boolean(loadError)}>
          <option value="">Choose a project…</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.status.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What is being asked for" htmlFor="qc-cr-requested" required>
        <textarea id="qc-cr-requested" required rows={4} maxLength={4000} value={fields.requested} onChange={set('requested')} className={textareaClass} placeholder="In the requester's own words" />
      </Field>
      <Field label="Who asked" htmlFor="qc-cr-source" required>
        <select id="qc-cr-source" value={fields.source} onChange={set('source')} className={selectClass}>
          <option value="client">The client</option>
          <option value="internal">Someone internal</option>
        </select>
      </Field>
      <FormMessage status={error ? 'error' : 'idle'} message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fields.projectId}>
          {submitting ? 'Submitting…' : 'Submit change request'}
        </Button>
      </div>
    </form>
  );
}
