'use client';

import { useActionState, useState } from 'react';

import { linkRequirementAction } from '@/modules/crm/requirement-link-actions';
import { REQUIREMENT_LINK_TARGET_LABEL, REQUIREMENT_LINK_TARGETS, type RequirementLinkTarget } from '@/modules/crm/requirement-link-schema';
import type { RequirementLinkTargetOptions } from '@/modules/crm/requirement-link-types';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconAttach, inputClass, labelClass, selectClass } from '@/ui';

/**
 * SCR-029 — "Link to quotation/design/development task". Three pickers over
 * what the lead actually has: its quotations, and the design deliverables
 * and tasks of the project the deal became. An empty picker says so rather
 * than offering nothing silently. The door decides whether the pair is
 * real; the refusal is shown as written.
 */
export function RequirementLinkForm({ versionId, leadId, targets }: { versionId: string; leadId: string; targets: RequirementLinkTargetOptions }) {
  const [state, action, pending] = useActionState(linkRequirementAction, IDLE_STATE);
  const [targetType, setTargetType] = useState<RequirementLinkTarget>('quotation');

  const options =
    targetType === 'quotation'
      ? targets.quotations.map((q) => ({ id: q.id, label: `${q.title} v${q.version} · ${q.status}` }))
      : targetType === 'design'
        ? targets.designs.map((d) => ({ id: d.id, label: `${d.title} v${d.version} · ${d.status} · ${d.projectName}` }))
        : targets.tasks.map((t) => ({ id: t.id, label: `${t.title} · ${t.status} · ${t.projectName}` }));

  const nothing =
    targetType === 'quotation'
      ? 'This lead has no quotation yet — draft one from the accepted version first.'
      : targetType === 'design'
        ? 'No design or prototype deliverable on this lead’s project yet.'
        : 'No development task on this lead’s project yet.';

  return (
    <details className="rounded-md border border-line bg-surface">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium">
        <IconAttach size={14} />
        Link…
        <span className="text-xs font-normal text-muted">declare what this version prices, designs or builds</span>
      </summary>
      <form action={action} className="flex flex-col gap-2 border-t border-line px-3 py-3">
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="leadId" value={leadId} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>Link to</span>
            <select name="targetType" value={targetType} onChange={(e) => setTargetType(e.target.value as RequirementLinkTarget)} className={selectClass}>
              {REQUIREMENT_LINK_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {REQUIREMENT_LINK_TARGET_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className={labelClass}>Record</span>
            {options.length > 0 ? (
              <select name="targetId" required className={selectClass} defaultValue="">
                <option value="" disabled>
                  Pick one…
                </option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[13px] text-muted">{nothing}</span>
            )}
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className={labelClass}>Note (optional)</span>
            <input name="note" maxLength={500} placeholder="why this link" className={inputClass} />
          </label>
          <button type="submit" disabled={pending || options.length === 0} className={buttonClass('primary', 'sm')}>
            {pending ? 'Linking…' : 'Link'}
          </button>
        </div>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}
