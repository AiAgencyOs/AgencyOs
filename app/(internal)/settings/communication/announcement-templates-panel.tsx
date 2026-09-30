'use client';

import { useActionState, useId } from 'react';

import { saveAnnouncementTemplateAction } from '@/modules/crm/announcement-templates-actions';
import { TEMPLATE_PLACEHOLDERS } from '@/modules/crm/announcement-templates-schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, cx, FormMessage, inputClass, labelClass, selectClass, textareaClass } from '@/ui';

export type TemplateRowView = { id: string; name: string; kind: string; audience: string; titleTemplate: string; bodyTemplate: string; active: boolean };

/**
 * Settings › Communication › Announcement templates — reusable client-update
 * formats (`crm.save_announcement_template`, owner only). A title and a body
 * with {{project}}, {{client}}, {{milestone}} and {{due}}. The milestone
 * template, while active, drafts an announcement each time a client-visible
 * milestone is met; publishing what it drafts is still the owner's act, and
 * nothing is sent.
 */
export function AnnouncementTemplatesPanel({ templates, canWrite }: { templates: TemplateRowView[]; canWrite: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Placeholders: {TEMPLATE_PLACEHOLDERS.map((p) => (<code key={p} className="mr-1 rounded bg-surface-sunken px-1">{p}</code>))}
      </p>
      {templates.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">No template yet. Write one, or announce each thing fresh.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{t.name}</span>
                <Badge tone={t.kind === 'milestone' ? 'info' : 'neutral'}>{t.kind === 'milestone' ? 'Milestone' : 'General'}</Badge>
                <Badge tone={t.audience === 'clients' ? 'info' : 'neutral'}>{t.audience === 'clients' ? 'For clients' : 'Internal'}</Badge>
                {!t.active ? <Badge tone="neutral">archived</Badge> : null}
              </span>
              <p className="font-medium">{t.titleTemplate}</p>
              <p className="whitespace-pre-wrap text-muted">{t.bodyTemplate}</p>
              {canWrite ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-brand">Edit template</summary>
                  <div className="mt-2">
                    <TemplateForm existing={t} />
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <details className="rounded-lg border border-line bg-surface p-3">
          <summary className={cx(buttonClass('secondary', 'sm'), 'cursor-pointer list-none')}>New template</summary>
          <div className="pt-3">
            <TemplateForm />
          </div>
        </details>
      ) : (
        <p className="text-xs text-muted">Only the owner can write announcement templates.</p>
      )}
    </div>
  );
}

function TemplateForm({ existing }: { existing?: TemplateRowView }) {
  const [state, action, pending] = useActionState(saveAnnouncementTemplateAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-2">
      {existing ? <input type="hidden" name="templateId" value={existing.id} /> : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-1 sm:col-span-1">
          <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
          <input id={`${id}-name`} name="name" required maxLength={120} defaultValue={existing?.name ?? ''} placeholder="Milestone reached" className={cx(inputClass, 'h-9 text-[13px]')} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-kind`} className={labelClass}>Kind</label>
          <select id={`${id}-kind`} name="kind" defaultValue={existing?.kind ?? 'general'} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="general">General</option>
            <option value="milestone">Milestone (drafts when one is met)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-aud`} className={labelClass}>Audience</label>
          <select id={`${id}-aud`} name="audience" defaultValue={existing?.audience ?? 'clients'} className={cx(selectClass, 'h-9 text-[13px]')}>
            <option value="clients">Clients</option>
            <option value="internal">Internal</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className={labelClass}>Title</label>
        <input id={`${id}-title`} name="titleTemplate" required maxLength={160} defaultValue={existing?.titleTemplate ?? ''} placeholder="{{milestone}} is complete" className={cx(inputClass, 'h-9 text-[13px]')} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-body`} className={labelClass}>Body</label>
        <textarea id={`${id}-body`} name="bodyTemplate" required maxLength={5000} rows={4} defaultValue={existing?.bodyTemplate ?? ''} placeholder="Hello {{client}} — {{milestone}} on {{project}} is complete." className={cx(textareaClass, 'text-[13px]')} />
      </div>
      <label htmlFor={`${id}-active`} className="flex items-center gap-2 text-[13px]">
        <input id={`${id}-active`} type="checkbox" name="active" defaultChecked={existing?.active ?? true} />
        Active (untick to archive)
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : existing ? 'Save changes' : 'Save template'}
        </button>
        <FormMessage status={state.status} message={state.message} className="text-xs" />
      </div>
    </form>
  );
}
