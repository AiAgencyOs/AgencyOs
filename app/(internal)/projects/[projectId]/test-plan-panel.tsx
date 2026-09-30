'use client';

import { useActionState } from 'react';

import {
  addTestPlanItemAction,
  draftTestPlanAction,
  removeTestPlanItemAction,
} from '@/modules/qa/actions';
import { recordTestRunWithResultsAction } from '@/modules/qa/case-results-actions';
import type { TestCaseResultRow } from '@/modules/qa/case-results-queries';
import { TEST_CATEGORIES, TEST_RUN_SUITES } from '@/modules/qa/schema';
import type { TestPlanItemRow, TestPlanRow, TestRunRow } from '@/modules/qa/queries';
import type { ScopeItemRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

import { ApproveTestPlanForm, CaseDetails, CaseFieldsInputs, RunEnvironmentInputs, RunResultsGrid, RunResultsList } from './qa/case-results-panel';
import { ImportTestCasesForm, LinkedTask, LinkTaskForm } from './qa/test-case-import-panel';

/**
 * SCR-045's Test Plan screen. `qa.draft_test_plan` / `.add_test_plan_item` /
 * `.remove_test_plan_item` (20260921170000) had SELECT policies and no way
 * in — this is the first caller either table has ever had. A plan can only
 * be drafted against a FROZEN scope baseline (Doc 14 §3), so this panel sits
 * below the scope baseline's own on the project page.
 */
export function DraftTestPlanForm({ projectId, scopeVersionId }: { projectId: string; scopeVersionId: string }) {
  const [state, action, pending] = useActionState(draftTestPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="scopeVersionId" value={scopeVersionId} />
      <button type="submit" disabled={pending} className={`${buttonClass('primary', 'sm')} self-start`}>
        {pending ? 'Drafting…' : 'Draft a test plan against this baseline'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function AddItemForm({
  projectId,
  planId,
  scopeItems,
}: {
  projectId: string;
  planId: string;
  scopeItems: ScopeItemRow[];
}) {
  const [state, action, pending] = useActionState(addTestPlanItemAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className={labelClass}>Scope item</span>
          <select name="scopeItemId" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Choose…
            </option>
            {scopeItems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Category</span>
          <select name="category" defaultValue="functional" className={selectClass}>
            {TEST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Why this category applies</span>
        <input name="reason" required maxLength={600} className={inputClass} placeholder="Moves money; a bug here costs a client directly." />
      </label>
      <CaseFieldsInputs />
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="criticalPath" />
        Critical path
      </label>
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Adding…' : 'Add to plan'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RemoveItemButton({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [state, action, pending] = useActionState(removeTestPlanItemAction, IDLE_STATE);

  return (
    <form action={action} className="inline-flex items-center gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="itemId" value={itemId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        Remove
      </button>
      {state.status === 'error' ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}

export function TestPlanCard({
  projectId,
  plan,
  scopeItems,
  editable,
  canApprove = false,
  tasks,
}: {
  projectId: string;
  plan: TestPlanRow;
  scopeItems: ScopeItemRow[];
  editable: boolean;
  /** `project.sign_off` — the approve door refuses everyone else, so nobody else is offered it. */
  canApprove?: boolean;
  /** SCR-045: the project's tasks, for the linked-task label and picker (`qa.link_test_case_task`). Omitted by callers that have not read them. */
  tasks?: { id: string; title: string; status: string }[];
}) {
  // An approved plan accepts no new item and loses none (qa.add_test_plan_item
  // / remove_test_plan_item refuse plan_approved); a control whose only
  // outcome is a refusal is a form built to fail, so none is offered.
  const approved = plan.status === 'approved';
  const mayEdit = editable && !approved;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          Test plan — baseline v{plan.scopeVersionNumber}
          <Badge tone={approved ? 'success' : 'neutral'}>{approved ? 'approved' : 'draft'}</Badge>
        </span>
        <span className="text-xs text-muted">{plan.draftedByAgent ? `agent: ${plan.draftedByAgent}` : 'drafted by a person'}</span>
      </div>

      {plan.items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {plan.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{item.scopeItemTitle}</span>
                  <Badge tone="brand">{item.category}</Badge>
                  {item.criticalPath ? <Badge tone="warning">critical path</Badge> : null}
                </span>
                <span className="text-muted">{item.reason}</span>
                <LinkedTask projectId={projectId} task={tasks?.find((t) => t.id === item.taskId)} />
                <CaseDetails item={item} />
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {/* Linking a task is allowed on an approved plan: who builds the case is not what is tested. */}
                {editable && tasks ? <LinkTaskForm projectId={projectId} itemId={item.id} currentTaskId={item.taskId} tasks={tasks} /> : null}
                {mayEdit ? <RemoveItemButton projectId={projectId} itemId={item.id} /> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing planned yet.</p>
      )}

      {mayEdit ? <AddItemForm projectId={projectId} planId={plan.id} scopeItems={scopeItems} /> : null}
      {mayEdit ? <ImportTestCasesForm projectId={projectId} planId={plan.id} /> : null}
      {!approved && canApprove && plan.items.length > 0 ? <ApproveTestPlanForm projectId={projectId} planId={plan.id} /> : null}
    </div>
  );
}

/**
 * SCR-046's Test Runs screen. `qa.record_test_run` (20260921180000) is the
 * first writer either table has had — `qa.release_gates`'s
 * `critical_tests_pass` gate has read `qa.test_runs` since it was written and
 * had no way to see anything but `undecided` until now.
 */
function RecordTestRunForm({
  projectId,
  builds,
  planItems,
}: {
  projectId: string;
  builds: { id: string; title: string; version: number }[];
  planItems: TestPlanItemRow[];
}) {
  // The existing recordTestRun door first, then recordTestCaseResults
  // beside it — the run's totals stay the source of total/passed/failed.
  const [state, action, pending] = useActionState(recordTestRunWithResultsAction, IDLE_STATE);

  if (builds.length === 0) {
    return <p className="text-[13px] text-muted">No build deliverable exists yet — nothing to test.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap gap-2">
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className={labelClass}>Build</span>
          <select name="deliverableId" required defaultValue="" className={selectClass}>
            <option value="" disabled>
              Choose…
            </option>
            {builds.map((b) => (
              <option key={b.id} value={b.id}>
                v{b.version} — {b.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Suite</span>
          <select name="suite" defaultValue="functional" className={selectClass}>
            {TEST_RUN_SUITES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Total</span>
          <input name="total" type="number" min={0} required className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Passed</span>
          <input name="passed" type="number" min={0} required className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Failed</span>
          <input name="failed" type="number" min={0} required className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Skipped</span>
          <input name="skipped" type="number" min={0} defaultValue={0} className={`${inputClass} w-24`} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Evidence link (optional)</span>
        <input name="evidenceUrl" type="url" className={inputClass} placeholder="https://ci.example.com/run/123" />
      </label>
      <RunEnvironmentInputs />
      <RunResultsGrid planItems={planItems} />
      <button type="submit" disabled={pending} className={`${buttonClass('secondary', 'sm')} self-start`}>
        {pending ? 'Recording…' : 'Record run'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function TestRunsCard({
  projectId,
  runs,
  builds,
  editable,
  planItems = [],
  results,
}: {
  projectId: string;
  runs: TestRunRow[];
  builds: { id: string; title: string; version: number }[];
  editable: boolean;
  planItems?: TestPlanItemRow[];
  /** Per-case results by run id — `listTestCaseResults`. */
  results?: Map<string, TestCaseResultRow[]>;
}) {
  const buildLabel = new Map(builds.map((b) => [b.id, `v${b.version}`]));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold">Test runs</h2>

      {runs.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={run.failed > 0 || run.skipped > 0 ? 'warning' : 'success'}>{run.suite}</Badge>
                <span className="text-muted">{buildLabel.get(run.deliverableId) ?? 'build'}</span>
                <span className="tabular">
                  {run.passed}/{run.total} passed
                  {run.skipped > 0 ? `, ${run.skipped} skipped` : ''}
                </span>
                {run.device || run.browser || run.os ? (
                  <span className="text-xs text-muted">{[run.device, run.browser, run.os].filter(Boolean).join(' · ')}</span>
                ) : null}
              </span>
              {run.evidenceUrl ? (
                <a href={run.evidenceUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
                  evidence
                </a>
              ) : null}
              {run.perfNotes ? <span className="w-full text-xs text-muted">Performance: {run.perfNotes}</span> : null}
              <RunResultsList results={results?.get(run.id) ?? []} planItems={planItems} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No test runs recorded yet.</p>
      )}

      {editable ? <RecordTestRunForm projectId={projectId} builds={builds} planItems={planItems} /> : null}
    </div>
  );
}
