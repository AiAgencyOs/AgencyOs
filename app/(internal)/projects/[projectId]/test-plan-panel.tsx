'use client';

import { useActionState } from 'react';

import {
  addTestPlanItemAction,
  draftTestPlanAction,
  recordTestRunAction,
  removeTestPlanItemAction,
} from '@/modules/qa/actions';
import { TEST_CATEGORIES, TEST_RUN_SUITES } from '@/modules/qa/schema';
import type { TestPlanRow, TestRunRow } from '@/modules/qa/queries';
import type { ScopeItemRow } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

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
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={labelClass}>Scope item</label>
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
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Category</label>
          <select name="category" defaultValue="functional" className={selectClass}>
            {TEST_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Why this category applies</label>
        <input name="reason" required maxLength={600} className={inputClass} placeholder="Moves money; a bug here costs a client directly." />
      </div>
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
}: {
  projectId: string;
  plan: TestPlanRow;
  scopeItems: ScopeItemRow[];
  editable: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">Test plan — baseline v{plan.scopeVersionNumber}</span>
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
              </span>
              {editable ? <RemoveItemButton projectId={projectId} itemId={item.id} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing planned yet.</p>
      )}

      {editable ? <AddItemForm projectId={projectId} planId={plan.id} scopeItems={scopeItems} /> : null}
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
}: {
  projectId: string;
  builds: { id: string; title: string; version: number }[];
}) {
  const [state, action, pending] = useActionState(recordTestRunAction, IDLE_STATE);

  if (builds.length === 0) {
    return <p className="text-[13px] text-muted">No build deliverable exists yet — nothing to test.</p>;
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1">
          <label className={labelClass}>Build</label>
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
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Suite</label>
          <select name="suite" defaultValue="functional" className={selectClass}>
            {TEST_RUN_SUITES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Total</label>
          <input name="total" type="number" min={0} required className={`${inputClass} w-24`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Passed</label>
          <input name="passed" type="number" min={0} required className={`${inputClass} w-24`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Failed</label>
          <input name="failed" type="number" min={0} required className={`${inputClass} w-24`} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={labelClass}>Skipped</label>
          <input name="skipped" type="number" min={0} defaultValue={0} className={`${inputClass} w-24`} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className={labelClass}>Evidence link (optional)</label>
        <input name="evidenceUrl" type="url" className={inputClass} placeholder="https://ci.example.com/run/123" />
      </div>
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
}: {
  projectId: string;
  runs: TestRunRow[];
  builds: { id: string; title: string; version: number }[];
  editable: boolean;
}) {
  const buildLabel = new Map(builds.map((b) => [b.id, `v${b.version}`]));

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">Test runs</h3>

      {runs.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
              <span className="flex items-center gap-2">
                <Badge tone={run.failed > 0 || run.skipped > 0 ? 'warning' : 'success'}>{run.suite}</Badge>
                <span className="text-muted">{buildLabel.get(run.deliverableId) ?? 'build'}</span>
                <span className="tabular">
                  {run.passed}/{run.total} passed
                  {run.skipped > 0 ? `, ${run.skipped} skipped` : ''}
                </span>
              </span>
              {run.evidenceUrl ? (
                <a href={run.evidenceUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
                  evidence
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No test runs recorded yet.</p>
      )}

      {editable ? <RecordTestRunForm projectId={projectId} builds={builds} /> : null}
    </div>
  );
}
