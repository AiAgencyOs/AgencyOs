'use client';

import { useActionState } from 'react';

import { reviseRequirementVersionAction } from '@/modules/crm/requirement-revise-actions';
import { scopeItemsToLines } from '@/modules/crm/requirement-revise-schema';
import type { requirementPayloadSchema } from '@/modules/crm/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage, IconEdit, labelClass, textareaClass } from '@/ui';

import type { z } from 'zod';

type Payload = z.infer<typeof requirementPayloadSchema>;

/**
 * SCR-009 — "Edit as new version", pre-filled from the version it edits.
 *
 * Collapsed by default: it is a form that mints a version, not a field on
 * one. Every list is one entry per line, scope items as `Title — detail`,
 * exactly as the panel prints them. What it writes is version n+1 as
 * `proposed`; the version edited becomes `superseded` — said in the summary
 * line so nobody is surprised that an accepted scope stops standing until
 * the new one is decided.
 */
function Lines({ id, label, hint, value }: { id: string; label: string; hint?: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass} htmlFor={id}>
        {label}
        {hint ? <span className="ml-1 font-normal text-muted">— {hint}</span> : null}
      </label>
      <textarea id={id} name={id.replace(/^rev-/, '')} defaultValue={value} rows={Math.min(8, Math.max(2, value.split('\n').length))} className={textareaClass} />
    </div>
  );
}

export function RequirementReviseForm({
  versionId,
  leadId,
  version,
  status,
  payload,
}: {
  versionId: string;
  leadId: string;
  version: number;
  status: string;
  payload: Payload;
}) {
  const [state, action, pending] = useActionState(reviseRequirementVersionAction, IDLE_STATE);

  return (
    <details className="mt-3 rounded-md border border-line bg-surface">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] font-medium">
        <IconEdit size={14} />
        Edit as new version
        <span className="text-xs font-normal text-muted">
          writes v{version + 1} as proposed; v{version} ({status}) becomes superseded
        </span>
      </summary>
      <form action={action} className="flex flex-col gap-3 border-t border-line px-3 py-3">
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="leadId" value={leadId} />

        <div className="flex flex-col gap-1">
          <label className={labelClass} htmlFor="rev-summary">
            Summary
          </label>
          <textarea id="rev-summary" name="summary" required maxLength={2000} defaultValue={payload.summary} rows={3} className={textareaClass} />
        </div>

        {/* SCR-029 (bucket G-3) — the nine PDF sections, one textarea each. */}
        <Lines id="rev-objectives" label="Objectives" hint="one per line, every objective in full" value={payload.objectives.join('\n')} />
        <Lines id="rev-scopeItems" label="Features (scope items)" hint="one per line, Title — detail" value={scopeItemsToLines(payload.scopeItems)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Lines id="rev-businessRules" label="Business rules" hint="one per line" value={payload.businessRules.join('\n')} />
          <Lines id="rev-nonFunctionalRequirements" label="Non-functional requirements" hint="one per line, performance / security / availability…" value={payload.nonFunctionalRequirements.join('\n')} />
          <Lines id="rev-constraints" label="Constraints (older versions)" hint={payload.constraints.length > 0 ? 'recorded before business rules existed; move them above or leave as history' : 'one per line'} value={payload.constraints.join('\n')} />
          <Lines id="rev-exclusions" label="Excluded" hint="one per line" value={payload.exclusions.join('\n')} />
          <Lines id="rev-assumptions" label="Assumptions" hint="one per line" value={payload.assumptions.join('\n')} />
          <Lines id="rev-niceToHaves" label="Nice to have" hint="one per line" value={payload.niceToHaves.join('\n')} />
          <Lines id="rev-designReferences" label="Design references" hint="one per line" value={payload.designReferences.join('\n')} />
          <Lines id="rev-openQuestions" label="Open questions" hint="one per line" value={payload.openQuestions.join('\n')} />
          {/* SCR-009 (bucket F-B) — the four fields the versioned requirement carries. */}
          <Lines id="rev-userRoles" label="User roles" hint="one per line, who uses it" value={payload.userRoles.join('\n')} />
          <Lines id="rev-platforms" label="Platforms" hint="one per line, web / iOS / Android…" value={payload.platforms.join('\n')} />
          <Lines id="rev-integrations" label="Integrations" hint="one per line, what it must talk to" value={payload.integrations.join('\n')} />
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor="rev-timelineBudgetNotes">
              Timeline and budget notes
              <span className="ml-1 font-normal text-muted">— in the client&rsquo;s words</span>
            </label>
            <textarea id="rev-timelineBudgetNotes" name="timelineBudgetNotes" maxLength={2000} defaultValue={payload.timelineBudgetNotes} rows={2} className={textareaClass} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Writing…' : `Write as v${version + 1}`}
          </button>
          <span className="text-xs text-muted">Nothing on v{version} is changed; it is kept as history.</span>
        </div>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}
