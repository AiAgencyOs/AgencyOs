'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { scheduleAnnouncementAction } from '@/modules/crm/announcement-schedule-actions';
import { createAnnouncementAction, setAnnouncementStatusAction } from '@/modules/crm/announcements-actions';
import { renderAnnouncementText } from '@/modules/crm/announcement-templates-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, FormMessage, inputClass, labelClass, selectClass, StatusBadge, textareaClass } from '@/ui';

/** One announcement as the page formatted it (dates already through the agency clock). */
export type AnnouncementView = {
  id: string;
  title: string;
  body: string;
  audience: string;
  status: string;
  when: string;
  /** SCR-059 (bucket F): ISO moment the tick publishes this draft, when one is set. */
  scheduledFor?: string | null;
  /** SCR-059: what it is recorded against, and whether a met milestone drafted it. */
  projectName?: string | null;
  clientName?: string | null;
  fromMilestone?: boolean;
};

/** The pickers and formats the composer offers (`listAnnouncementTargets`, `listAnnouncementTemplates`). */
export type AnnouncementTargetsView = {
  projects: { id: string; name: string; clientAccountId: string }[];
  clients: { id: string; name: string; billingEmail?: string | null }[];
};
export type AnnouncementTemplateView = { id: string; name: string; kind: string; audience: string; titleTemplate: string; bodyTemplate: string; active: boolean };

/**
 * Settings › Communication › Announcements — draft, publish, archive
 * (`crm.announcements`). Publishing RECORDS the announcement so the
 * Communication Center and every Client 360 can show it; nothing here
 * sends. WhatsApp broadcast is declined on record (traceability row 59)
 * and the page says so beside the button.
 */
export function AnnouncementsPanel({ announcements, canWrite, targets, templates = [] }: { announcements: AnnouncementView[]; canWrite: boolean; targets?: AnnouncementTargetsView; templates?: AnnouncementTemplateView[] }) {
  return (
    <div className="flex flex-col gap-3">
      {canWrite ? <DraftForm targets={targets ?? { projects: [], clients: [] }} templates={templates.filter((t) => t.active)} /> : <p className="text-xs text-muted">Only the owner can write announcements.</p>}
      {announcements.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">No announcement yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {announcements.map((a) => (
            <li key={a.id} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{a.title}</span>
                  <Badge tone={a.audience === 'clients' ? 'info' : 'neutral'}>{a.audience === 'clients' ? 'For clients' : 'Internal'}</Badge>
                  <StatusBadge status={a.status} />
                  {a.projectName ? <Badge tone="brand">Project: {a.projectName}</Badge> : null}
                  {a.clientName ? <Badge tone="neutral">Client: {a.clientName}</Badge> : null}
                  {a.fromMilestone ? <Badge tone="info">From a milestone</Badge> : null}
                </span>
                <span className="text-xs text-muted">{a.when}</span>
              </div>
              <p className="whitespace-pre-wrap text-muted">{a.body}</p>
              {canWrite && a.status !== 'archived' ? <StatusButtons id={a.id} status={a.status} /> : null}
              {canWrite && a.status === 'draft' ? <ScheduleForm id={a.id} scheduledFor={a.scheduledFor ?? null} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** SCR-059 (bucket F): set or clear the moment the tick publishes a draft (`crm.schedule_announcement`, owner only). */
function ScheduleForm({ id, scheduledFor }: { id: string; scheduledFor: string | null }) {
  const [state, action, pending] = useActionState(scheduleAnnouncementAction, IDLE_STATE);
  const local = scheduledFor ? new Date(new Date(scheduledFor).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="announcementId" value={id} />
      <input name="scheduledFor" type="datetime-local" defaultValue={local} aria-label="Publish at" className={cx(inputClass, 'h-8 text-xs')} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : scheduledFor ? 'Reschedule' : 'Schedule'}
      </button>
      {scheduledFor ? <span className="text-xs text-muted">Clear the field and save to unschedule.</span> : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function DraftForm({ targets, templates }: { targets: AnnouncementTargetsView; templates: AnnouncementTemplateView[] }) {
  const [state, action, pending] = useActionState(createAnnouncementAction, IDLE_STATE);
  const ref = useRef<HTMLFormElement>(null);
  const id = useId();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'internal' | 'clients'>('internal');
  const [projectId, setProjectId] = useState('');
  const [clientId, setClientId] = useState('');
  const [templateId, setTemplateId] = useState('');

  useEffect(() => {
    if (state.status === 'success') {
      ref.current?.reset();
      setTitle('');
      setBody('');
      setAudience('internal');
      setProjectId('');
      setClientId('');
      setTemplateId('');
    }
  }, [state]);

  const project = targets.projects.find((p) => p.id === projectId) ?? null;
  // A project names its client; a client alone is only offered when no project is chosen.
  const effectiveClientId = project ? project.clientAccountId : clientId;
  const clientName = targets.clients.find((c) => c.id === effectiveClientId)?.name ?? null;
  const values = { project: project?.name ?? '', client: clientName ?? '' };

  function applyTemplate(nextId: string) {
    setTemplateId(nextId);
    const t = templates.find((x) => x.id === nextId);
    if (!t) return;
    setTitle(renderAnnouncementText(t.titleTemplate, values));
    setBody(renderAnnouncementText(t.bodyTemplate, values));
    setAudience(t.audience === 'clients' ? 'clients' : 'internal');
  }

  return (
    <form ref={ref} action={action} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      {templates.length > 0 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-tpl`} className={labelClass}>Start from a template (optional)</label>
          <select id={`${id}-tpl`} name="templateId" value={templateId} onChange={(e) => applyTemplate(e.target.value)} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="">No template — write it fresh</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.kind === 'milestone' ? ' (milestone)' : ''}</option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input name="title" required maxLength={160} placeholder="Title" aria-label="Announcement title" value={title} onChange={(e) => setTitle(e.target.value)} className={cx(inputClass, 'h-9 flex-1 text-[13px]')} />
        <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value === 'clients' ? 'clients' : 'internal')} aria-label="Audience" className={cx(selectClass, 'h-9 w-40 text-[13px]')}>
          <option value="internal">Internal</option>
          <option value="clients">Clients</option>
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-project`} className={labelClass}>About a project (optional)</label>
          <select id={`${id}-project`} name="projectId" value={projectId} onChange={(e) => { setProjectId(e.target.value); if (e.target.value) setClientId(''); }} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="">Agency-wide, or one client</option>
            {targets.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-client`} className={labelClass}>{project ? 'Client (from the project)' : 'For one client (optional)'}</label>
          <select id={`${id}-client`} name="clientAccountId" value={effectiveClientId} disabled={Boolean(project)} onChange={(e) => setClientId(e.target.value)} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="">No single client</option>
            {targets.clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {project ? <input type="hidden" name="clientAccountId" value={project.clientAccountId} /> : null}
        </div>
      </div>
      <textarea name="body" required maxLength={5000} rows={3} placeholder="What is being announced" aria-label="Announcement body" value={body} onChange={(e) => setBody(e.target.value)} className={cx(textareaClass, 'text-[13px]')} />
      {title.trim() || body.trim() ? (
        <div className="rounded-md border border-dashed border-line bg-canvas p-3 text-[13px]" aria-label="Preview of the announcement">
          <p className="text-xs font-medium text-muted">Preview — how it will be recorded</p>
          <p className="mt-1 font-medium text-foreground">{title.trim() || 'Untitled'}</p>
          <p className="whitespace-pre-wrap text-muted">{body.trim()}</p>
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={audience === 'clients' ? 'info' : 'neutral'}>{audience === 'clients' ? 'For clients' : 'Internal'}</Badge>
            {project ? <Badge tone="brand">Recorded on the {project.name} timeline</Badge> : null}
            {clientName ? <Badge tone="neutral">Recorded on {clientName}</Badge> : null}
            {!project && !clientName ? <span>Agency-wide: shown in Communication and to every client.</span> : null}
            <span>A record, not a send.</span>
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}

function StatusButtons({ id, status }: { id: string; status: string }) {
  const [state, action, pending] = useActionState(setAnnouncementStatusAction, IDLE_STATE);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'draft' ? (
        <form action={action}>
          <input type="hidden" name="announcementId" value={id} />
          <input type="hidden" name="status" value="published" />
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Publishing…' : 'Publish (record only)'}
          </button>
        </form>
      ) : null}
      <form action={action}>
        <input type="hidden" name="announcementId" value={id} />
        <input type="hidden" name="status" value="archived" />
        <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
          {pending ? 'Archiving…' : 'Archive'}
        </button>
      </form>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </div>
  );
}
