'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';

import { createCampaignAction, previewCampaignAudienceAction } from '@/modules/crm/campaign-actions';
import type { CampaignAudienceInput, CampaignPreviewState } from '@/modules/crm/campaign-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, Field, FormMessage, inputClass, selectClass } from '@/ui';

/**
 * New campaign — SCR-059, owner decision 2026-09-30 (broadcast reopened as
 * a governed campaign).
 *
 * The template picker lists only Meta-approved, active templates; the
 * audience is the Leads list's own filter; the figure beside it is a LIVE
 * count from the same pure expansion approval will run, fetched through a
 * server action that re-checks the session. Saving writes a DRAFT: a second
 * owner or ops admin approves it, and only then does the tick send.
 */
export function NewCampaignForm({
  templates,
  statuses,
  sources,
  owners,
  services,
  projects = [],
}: {
  templates: { id: string; label: string; situationKey: string; parameters: string[] }[];
  statuses: readonly string[];
  sources: string[];
  owners: { id: string; email: string }[];
  services: string[];
  /** SCR-059 (bucket F): the project audience — leads behind one project. */
  projects?: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(createCampaignAction, IDLE_STATE);
  const [audience, setAudience] = useState<CampaignAudienceInput>({});
  const [preview, setPreview] = useState<CampaignPreviewState | null>(null);
  const [previewing, startPreview] = useTransition();

  // Debounced: a keystroke in the tag box should not be a round trip each.
  useEffect(() => {
    const handle = setTimeout(() => {
      startPreview(async () => {
        setPreview(await previewCampaignAudienceAction(audience));
      });
    }, 350);
    return () => clearTimeout(handle);
  }, [audience]);

  const set = (key: keyof CampaignAudienceInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setAudience((a) => ({ ...a, [key]: e.target.value }));

  if (templates.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        No approved, active WhatsApp template is registered, so there is nothing a campaign could carry. Register one under
        Settings › Communication (situation "Campaign") and have Meta approve it first.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="campaign-name" required>
          <input id="campaign-name" name="name" required maxLength={120} className={inputClass} placeholder="Diwali offer to qualified leads" />
        </Field>
        <Field label="Template" htmlFor="campaign-template" required hint="Only templates Meta approved and an Admin left active. The variables are filled from recorded facts per recipient.">
          <select id="campaign-template" name="templateId" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Choose an approved template…
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.parameters.length > 0 ? ` · fills ${t.parameters.join(', ')}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken/40 p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted">Audience — the Leads list&apos;s filter</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status" htmlFor="audience-status">
            <select id="audience-status" name="status" value={audience.status ?? ''} onChange={set('status')} className={selectClass}>
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Source" htmlFor="audience-source">
            <select id="audience-source" name="source" value={audience.source ?? ''} onChange={set('source')} className={selectClass}>
              <option value="">Any source</option>
              {sources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Owner" htmlFor="audience-owner">
            <select id="audience-owner" name="owner" value={audience.owner ?? ''} onChange={set('owner')} className={selectClass}>
              <option value="">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>{o.email}</option>
              ))}
            </select>
          </Field>
          <Field label="Service" htmlFor="audience-service">
            <input id="audience-service" name="service" list="audience-service-options" value={audience.service ?? ''} onChange={set('service')} maxLength={80} className={inputClass} placeholder="Any service" />
            <datalist id="audience-service-options">
              {services.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Tag" htmlFor="audience-tag">
            <input id="audience-tag" name="tag" value={audience.tag ?? ''} onChange={set('tag')} maxLength={80} className={inputClass} placeholder="Any tag" />
          </Field>
          <Field label="Active in the last (days)" htmlFor="audience-activity">
            <input id="audience-activity" name="lastActivityDays" type="number" min={1} max={3650} value={audience.lastActivityDays ?? ''} onChange={set('lastActivityDays')} className={inputClass} placeholder="Any time" />
          </Field>
          <Field label="Created from" htmlFor="audience-from">
            <input id="audience-from" name="createdFrom" type="date" value={audience.createdFrom ?? ''} onChange={set('createdFrom')} className={inputClass} />
          </Field>
          <Field label="Created to" htmlFor="audience-to">
            <input id="audience-to" name="createdTo" type="date" value={audience.createdTo ?? ''} onChange={set('createdTo')} className={inputClass} />
          </Field>
          <Field label="Project" htmlFor="audience-project" hint="Leads behind one project, through the opportunity it was won from.">
            <select id="audience-project" name="projectId" value={audience.projectId ?? ''} onChange={set('projectId')} className={selectClass}>
              <option value="">Any project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <p role="status" aria-live="polite" className="text-[13px]">
          {preview === null || previewing ? (
            <span className="text-muted">Counting…</span>
          ) : preview.status === 'error' ? (
            <span className="text-danger">{preview.message}</span>
          ) : (
            <>
              <span className="font-semibold tabular">{preview.count}</span> recipient{preview.count === 1 ? '' : 's'} right now
              {preview.withoutThread > 0 ? (
                <span className="text-muted"> · {preview.withoutThread} with no WhatsApp thread, who will be recorded as refused</span>
              ) : null}
            </>
          )}
        </p>
      </fieldset>

      <Field label="Send no earlier than" htmlFor="campaign-schedule" hint="Optional. Once approved, the tick sends nothing before this moment (the browser's local time).">
        <input id="campaign-schedule" name="scheduledFor" type="datetime-local" className={inputClass} />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <span className="text-xs text-muted">
          A draft sends nothing. A second owner or ops admin approves it; the audience is expanded then, and each recipient goes through the consent, window and outreach rules.
        </span>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
