'use client';

import { useActionState } from 'react';

import { approveTestPlanAction } from '@/modules/qa/case-results-actions';
import { TEST_CASE_RESULT_STATUSES } from '@/modules/qa/case-results-schema';
import type { TestCaseResultRow } from '@/modules/qa/case-results-queries';
import type { TestPlanItemRow } from '@/modules/qa/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass, type Tone } from '@/ui';

/**
 * SCR-045/046/048 — the pieces `test-plan-panel.tsx` gained in
 * 20260929170000: a case's preconditions / steps / expected result, the
 * plan's approval, a run's environment (device, browser, OS, performance
 * notes) and the per-case results grid a run may carry.
 *
 * Kept in their own file so the panel's edits are insertions; every control
 * here goes through a door that refuses on its own, and the refusal is shown
 * verbatim.
 */

const textarea = `${inputClass} min-h-16`;

/** The three case fields, inside the add-item form. All optional. */
export function CaseFieldsInputs() {
  return (
    <details className="rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted">Preconditions, steps and expected result (optional)</summary>
      <div className="flex flex-col gap-2 pt-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Preconditions</label>
          <textarea name="preconditions" rows={2} maxLength={2000} className={textarea} placeholder="A signed-in client with one unpaid invoice." />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Steps</label>
          <textarea name="steps" rows={3} maxLength={4000} className={textarea} placeholder="1. Open the invoice. 2. Pay by card. 3. Return to the list." />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Expected result</label>
          <textarea name="expectedResult" rows={2} maxLength={2000} className={textarea} placeholder="The invoice reads paid and a receipt number is shown." />
        </div>
      </div>
    </details>
  );
}

/** A planned case's how-to, beneath its row. Nothing rendered when none was written. */
export function CaseDetails({ item }: { item: TestPlanItemRow }) {
  if (!item.preconditions && !item.steps && !item.expectedResult) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer">How to run this case</summary>
      <dl className="mt-1 flex flex-col gap-1 border-l-2 border-line pl-2">
        {item.preconditions ? (
          <div>
            <dt className="font-medium text-foreground">Preconditions</dt>
            <dd className="whitespace-pre-line">{item.preconditions}</dd>
          </div>
        ) : null}
        {item.steps ? (
          <div>
            <dt className="font-medium text-foreground">Steps</dt>
            <dd className="whitespace-pre-line">{item.steps}</dd>
          </div>
        ) : null}
        {item.expectedResult ? (
          <div>
            <dt className="font-medium text-foreground">Expected result</dt>
            <dd className="whitespace-pre-line">{item.expectedResult}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

/** Owner or ops admin — `project.sign_off`, the role the QA sign-off door uses. */
export function ApproveTestPlanForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(approveTestPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Approving…' : 'Approve this plan'}
      </button>
      <span className="text-xs text-muted">Once approved, the plan accepts no new item and loses none.</span>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

/** Where the run ran, and what a performance run measured — SCR-048. */
export function RunEnvironmentInputs() {
  return (
    <details className="rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted">Device, browser, OS and performance notes (optional — the compatibility matrix reads these)</summary>
      <div className="flex flex-col gap-2 pt-2">
        <div className="flex flex-wrap gap-2">
          <div className="flex min-w-32 flex-1 flex-col gap-1">
            <label className={labelClass}>Device</label>
            <input name="device" maxLength={120} className={inputClass} placeholder="iPhone 15 / desktop" />
          </div>
          <div className="flex min-w-32 flex-1 flex-col gap-1">
            <label className={labelClass}>Browser</label>
            <input name="browser" maxLength={120} className={inputClass} placeholder="Safari 17" />
          </div>
          <div className="flex min-w-32 flex-1 flex-col gap-1">
            <label className={labelClass}>OS</label>
            <input name="os" maxLength={120} className={inputClass} placeholder="iOS 17.4" />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Performance notes</label>
          <textarea name="perfNotes" rows={2} maxLength={4000} className={textarea} placeholder="p95 checkout 1.4s at 50 concurrent users; no target is set for this project." />
        </div>
      </div>
    </details>
  );
}

/**
 * One row per planned case: leave it untouched, or mark it. The run's own
 * counts above stay the source of total/passed/failed — this grid never
 * fills them in, because a case marked here is one of those tests, not a
 * second count of them.
 */
export function RunResultsGrid({ planItems }: { planItems: TestPlanItemRow[] }) {
  if (planItems.length === 0) return null;

  return (
    <details className="rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted">Per-case results ({planItems.length} planned case{planItems.length === 1 ? '' : 's'}) — optional</summary>
      <div className="overflow-x-auto pt-2">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-1 font-normal">Case</th>
              <th className="py-1 font-normal">Result</th>
              <th className="py-1 font-normal">Notes</th>
            </tr>
          </thead>
          <tbody>
            {planItems.map((item) => (
              <tr key={item.id} className="border-b border-line last:border-0">
                <td className="py-1 pr-2">
                  <span className="flex items-center gap-2">
                    <span>{item.scopeItemTitle}</span>
                    <Badge tone="brand">{item.category}</Badge>
                  </span>
                </td>
                <td className="py-1 pr-2">
                  <select name={`result:${item.id}`} defaultValue="" className={selectClass}>
                    <option value="">not marked</option>
                    {TEST_CASE_RESULT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1">
                  <input name={`notes:${item.id}`} maxLength={2000} className={inputClass} placeholder="What was seen" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const RESULT_TONE: Record<string, Tone> = { passed: 'success', failed: 'danger', skipped: 'warning', blocked: 'neutral' };

/** A run's recorded case results, beneath its row. */
export function RunResultsList({ results, planItems }: { results: TestCaseResultRow[]; planItems: TestPlanItemRow[] }) {
  if (results.length === 0) return null;
  const itemById = new Map(planItems.map((i) => [i.id, i]));

  return (
    <details className="w-full text-xs">
      <summary className="cursor-pointer text-muted">
        {results.length} case result{results.length === 1 ? '' : 's'} · {results.filter((r) => r.status === 'passed').length} passed ·{' '}
        {results.filter((r) => r.status === 'failed').length} failed
      </summary>
      <ul className="mt-1 flex flex-col gap-1 border-l-2 border-line pl-2">
        {results.map((r) => {
          const item = itemById.get(r.testPlanItemId);
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={RESULT_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
              <span>{item ? `${item.scopeItemTitle} · ${item.category}` : 'a case no longer in the plan'}</span>
              {r.notes ? <span className="text-muted">— {r.notes}</span> : null}
              {r.evidenceUrl ? (
                <a href={r.evidenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  evidence
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
