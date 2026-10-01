'use client';

import { useActionState, useId } from 'react';

import { restoreCoverageAction, updateTestCaseAction, waiveCoverageAction } from '@/modules/qa/case-edit-actions';
import type { RequirementCoverage } from '@/modules/qa/coverage-queries';
import type { TestPlanItemRow } from '@/modules/qa/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, textareaClass } from '@/ui';

/**
 * SCR-045 — edit a case of a draft plan, and account for a requirement that
 * has none. Every control goes through a door that refuses on its own
 * (`qa.update_test_plan_item`, `qa.waive_test_coverage`,
 * `qa.restore_test_coverage`); an approved plan is offered neither.
 */

export function EditCaseForm({ projectId, item }: { projectId: string; item: TestPlanItemRow }) {
  const [state, action, pending] = useActionState(updateTestCaseAction, IDLE_STATE);
  const id = useId();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-brand">Edit case</summary>
      <form action={action} className="mt-2 flex flex-col gap-2 rounded-md border border-dashed border-line p-3">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="itemId" value={item.id} />
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-reason`} className={labelClass}>Why this category applies</label>
          <input id={`${id}-reason`} name="reason" required maxLength={600} defaultValue={item.reason} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-pre`} className={labelClass}>Preconditions</label>
          <textarea id={`${id}-pre`} name="preconditions" rows={2} maxLength={2000} defaultValue={item.preconditions ?? ''} className={textareaClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-steps`} className={labelClass}>Steps</label>
          <textarea id={`${id}-steps`} name="steps" rows={3} maxLength={4000} defaultValue={item.steps ?? ''} className={textareaClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-exp`} className={labelClass}>Expected result</label>
          <textarea id={`${id}-exp`} name="expectedResult" rows={2} maxLength={2000} defaultValue={item.expectedResult ?? ''} className={textareaClass} />
        </div>
        <label htmlFor={`${id}-crit`} className="flex items-center gap-2 text-[13px]">
          <input id={`${id}-crit`} type="checkbox" name="criticalPath" defaultChecked={item.criticalPath} />
          Critical path
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
            {pending ? 'Saving…' : 'Save case'}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </div>
      </form>
    </details>
  );
}

function WaiveForm({ projectId, planId, scopeItemId, title }: { projectId: string; planId: string; scopeItemId: string; title: string }) {
  const [state, action, pending] = useActionState(waiveCoverageAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={`${id}-why`} className="sr-only">Why {title} needs no test case</label>
        <input id={`${id}-why`} name="reason" required maxLength={600} placeholder="Why it needs no case (static copy, covered by another requirement…)" className={`${inputClass} h-8 text-xs`} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Saving…' : 'Record rationale'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RestoreForm({ projectId, planId, scopeItemId }: { projectId: string; planId: string; scopeItemId: string }) {
  const [state, action, pending] = useActionState(restoreCoverageAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <input type="hidden" name="scopeItemId" value={scopeItemId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Withdrawing…' : 'Withdraw rationale'}
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

/**
 * The guardrail as a view: every requirement still in scope, and whether a
 * case covers it, a written rationale explains its absence, or neither (an
 * uncovered requirement — the list a QA lead works down).
 */
export function RequirementCoverageList({ projectId, planId, coverage, editable }: { projectId: string; planId: string; coverage: RequirementCoverage[]; editable: boolean }) {
  const uncovered = coverage.filter((c) => c.cases === 0 && !c.waiver);
  return (
    <div id="coverage" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Requirement coverage</span>
        <Badge tone={uncovered.length === 0 ? 'success' : 'warning'}>
          {uncovered.length === 0 ? 'Every requirement is covered or explained' : `${uncovered.length} without a case or a rationale`}
        </Badge>
      </div>
      {coverage.length === 0 ? (
        <p className="text-[13px] text-muted">This baseline has no requirement in scope.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {coverage.map((c) => (
            <li key={c.scopeItemId} className="flex flex-col gap-1.5 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.title}</span>
                {c.cases > 0 ? (
                  <Badge tone="success">{c.cases} case{c.cases === 1 ? '' : 's'}</Badge>
                ) : c.waiver ? (
                  <Badge tone="neutral">Explained</Badge>
                ) : (
                  <Badge tone="warning">No case</Badge>
                )}
              </span>
              {c.waiver ? <span className="text-xs text-muted">No case needed: {c.waiver.reason}</span> : null}
              {editable && c.cases === 0 && !c.waiver ? <WaiveForm projectId={projectId} planId={planId} scopeItemId={c.scopeItemId} title={c.title} /> : null}
              {editable && c.waiver ? <RestoreForm projectId={projectId} planId={planId} scopeItemId={c.scopeItemId} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
