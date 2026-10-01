'use client';

import { useActionState, useId } from 'react';

import { openIncidentAction, recordMetricResultAction, resolveIncidentAction, setPerformanceBudgetAction } from '@/modules/qa/performance-actions';
import { INCIDENT_SEVERITIES } from '@/modules/qa/performance-schema';
import { addRunEvidenceAction, closeTestRunAction, openTestRunAction, rerunTestRunAction } from '@/modules/qa/run-lifecycle-actions';
import { RUN_EVIDENCE_KINDS } from '@/modules/qa/run-lifecycle-schema';
import { setSuiteScheduleAction } from '@/modules/qa/schedule-actions';
import { TEST_RUN_SUITES } from '@/modules/qa/schema';
import { IDLE_STATE } from '@/modules/identity/types';
import { AREA_EXTENSIONS } from '@/modules/projects/attachment-rules';
import { buttonClass, FormMessage, inputClass, labelClass, selectClass } from '@/ui';

import { RunWhereAndWhoInputs, type TesterOption } from './run-who-where';

/**
 * SCR-046 / SCR-048 — the forms behind a run's life and the performance
 * register, each a thin skin over a `'use server'` action whose door
 * decides. Drawn for whoever the page says may write; refused in words
 * otherwise.
 */

type Build = { id: string; title: string; version: number };

export function OpenRunForm({ projectId, builds, testers = [] }: { projectId: string; builds: Build[]; testers?: readonly TesterOption[] }) {
  const [state, action, pending] = useActionState(openTestRunAction, IDLE_STATE);
  if (builds.length === 0) return <p className="text-xs text-muted">No build to run against yet.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="open-run-build" className={labelClass}>Build</label>
        <select id="open-run-build" name="deliverableId" required defaultValue={builds[0]?.id} className={selectClass}>
          {builds.map((b) => (
            <option key={b.id} value={b.id}>v{b.version} · {b.title}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="open-run-suite" className={labelClass}>Suite</label>
        <select id="open-run-suite" name="suite" required defaultValue="regression" className={selectClass}>
          {TEST_RUN_SUITES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <input name="device" maxLength={120} placeholder="Device" aria-label="Device" className={`${inputClass} w-28`} />
      <input name="browser" maxLength={120} placeholder="Browser" aria-label="Browser" className={`${inputClass} w-28`} />
      <input name="os" maxLength={120} placeholder="OS" aria-label="OS" className={`${inputClass} w-24`} />
      <RunWhereAndWhoInputs testers={testers} compact />
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Opening…' : 'Open a run'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

const EVIDENCE_ACCEPT = AREA_EXTENSIONS.evidence.map((e) => `.${e}`).join(',');

export function CloseRunForm({ projectId, runId }: { projectId: string; runId: string }) {
  const [state, action, pending] = useActionState(closeTestRunAction, IDLE_STATE);
  const evidenceFileId = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-canvas p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="runId" value={runId} />
      {(['passed', 'failed', 'skipped', 'blocked'] as const).map((k) => (
        <div key={k} className="flex flex-col gap-1">
          <label htmlFor={`close-${runId}-${k}`} className={labelClass}>{k}</label>
          <input id={`close-${runId}-${k}`} name={k} type="number" min={0} defaultValue={0} required className={`${inputClass} w-20`} />
        </div>
      ))}
      <input name="evidenceUrl" type="url" placeholder="Evidence URL" aria-label="Evidence URL" className={`${inputClass} min-w-40 flex-1`} />
      <input name="perfNotes" maxLength={4000} placeholder="Performance notes" aria-label="Performance notes" className={`${inputClass} min-w-40 flex-1`} />
      {/* Q-C6: the run's evidence may be a file — a screenshot or a log — under the project-file limits and credentials guard. */}
      <div className="flex min-w-48 flex-col gap-1">
        <label htmlFor={evidenceFileId} className={labelClass}>Evidence file (optional, up to 50 MB)</label>
        <input id={evidenceFileId} name="file" type="file" accept={EVIDENCE_ACCEPT} className={`${inputClass} h-auto max-w-full py-1.5`} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
        {pending ? 'Closing…' : 'Close run'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function RerunButton({ projectId, runId }: { projectId: string; runId: string }) {
  const [state, action, pending] = useActionState(rerunTestRunAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="runId" value={runId} />
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Opening rerun…' : 'Rerun failed cases'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function MetricForm({ projectId, runId }: { projectId: string; runId: string }) {
  const [state, action, pending] = useActionState(recordMetricResultAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="runId" value={runId} />
      <input name="metric" required maxLength={80} placeholder="Metric (LCP)" aria-label="Metric" className={`${inputClass} h-8 w-32 text-xs`} />
      <input name="value" required inputMode="decimal" placeholder="Value" aria-label="Value" className={`${inputClass} h-8 w-24 text-xs`} />
      <input name="unit" required maxLength={20} placeholder="Unit (ms)" aria-label="Unit" className={`${inputClass} h-8 w-20 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Attaching…' : 'Attach metric'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function BudgetForm({ projectId, existing }: { projectId: string; existing?: { metric: string; target: number; unit: string; lowerIsBetter: boolean } }) {
  const [state, action, pending] = useActionState(setPerformanceBudgetAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input name="metric" required maxLength={80} defaultValue={existing?.metric ?? ''} placeholder="Metric" aria-label="Metric" className={`${inputClass} h-8 w-32 text-xs`} />
      <input name="target" required inputMode="decimal" defaultValue={existing?.target ?? ''} placeholder="Target" aria-label="Target" className={`${inputClass} h-8 w-24 text-xs`} />
      <input name="unit" required maxLength={20} defaultValue={existing?.unit ?? ''} placeholder="Unit" aria-label="Unit" className={`${inputClass} h-8 w-20 text-xs`} />
      <select name="lowerIsBetter" defaultValue={existing ? String(existing.lowerIsBetter) : 'true'} aria-label="Direction" className={`${selectClass} h-8 text-xs`}>
        <option value="true">at most</option>
        <option value="false">at least</option>
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : existing ? 'Update' : 'Set budget'}
      </button>
      {existing ? (
        <button type="submit" name="remove" value="true" disabled={pending} className={buttonClass('ghost', 'sm')}>
          Remove
        </button>
      ) : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function OpenIncidentForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(openIncidentAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="severity" defaultValue="medium" aria-label="Severity" className={`${selectClass} h-8 text-xs`}>
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input name="summary" required maxLength={2000} placeholder="What happened" aria-label="Summary" className={`${inputClass} h-8 min-w-56 flex-1 text-xs`} />
        <button type="submit" disabled={pending} className={buttonClass('danger', 'sm')}>
          {pending ? 'Opening…' : 'Open incident'}
        </button>
      </div>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ResolveIncidentForm({ projectId, incidentId }: { projectId: string; incidentId: string }) {
  const [state, action, pending] = useActionState(resolveIncidentAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="incidentId" value={incidentId} />
      <input name="resolution" required maxLength={2000} placeholder="How it was resolved" aria-label="Resolution" className={`${inputClass} h-8 min-w-56 flex-1 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Resolving…' : 'Resolve'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

export function ScheduleSuiteForm({ projectId, builds, existing }: { projectId: string; builds: Build[]; existing?: { suite: string; cron: string; deliverableId: string; active: boolean } }) {
  const [state, action, pending] = useActionState(setSuiteScheduleAction, IDLE_STATE);
  if (builds.length === 0) return <p className="text-xs text-muted">A schedule needs a build to open runs against.</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <select name="suite" defaultValue={existing?.suite ?? 'regression'} aria-label="Suite" className={`${selectClass} h-8 text-xs`}>
        {TEST_RUN_SUITES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <select name="deliverableId" defaultValue={existing?.deliverableId ?? builds[0]?.id} aria-label="Build" className={`${selectClass} h-8 text-xs`}>
        {builds.map((b) => (
          <option key={b.id} value={b.id}>v{b.version}</option>
        ))}
      </select>
      <input name="cron" required defaultValue={existing?.cron ?? '0 2 * * *'} placeholder="0 2 * * *" aria-label="Cron expression" className={`${inputClass} h-8 w-32 font-mono text-xs`} title="minute hour day month weekday, in the agency's zone" />
      <select name="active" defaultValue={existing ? String(existing.active) : 'true'} aria-label="Active" className={`${selectClass} h-8 text-xs`}>
        <option value="true">active</option>
        <option value="false">paused</option>
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : existing ? 'Update' : 'Schedule'}
      </button>
      {existing ? (
        <button type="submit" name="remove" value="true" disabled={pending} className={buttonClass('ghost', 'sm')}>
          Remove
        </button>
      ) : null}
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

const KIND_LABEL: Record<(typeof RUN_EVIDENCE_KINDS)[number], string> = { screenshot: 'Screenshot', log: 'Log', report: 'Report', recording: 'Recording', note: 'Note' };

/**
 * SCR-046 "Screenshots/logs": one more piece of evidence on a run, open or
 * closed (`qa.add_run_evidence`). A link for everything but a note. Adding
 * evidence never changes the run's counts or status.
 */
export function AddEvidenceForm({ projectId, runId }: { projectId: string; runId: string }) {
  const [state, action, pending] = useActionState(addRunEvidenceAction, IDLE_STATE);
  const id = useId();
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="runId" value={runId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-kind`} className={labelClass}>Kind</label>
        <select id={`${id}-kind`} name="kind" defaultValue="screenshot" className={selectClass}>
          {RUN_EVIDENCE_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label htmlFor={`${id}-value`} className={labelClass}>Link, or the words for a note</label>
        <input id={`${id}-value`} name="value" required maxLength={2000} placeholder="https://files.example/failure.png" className={inputClass} />
      </div>
      <div className="flex min-w-36 flex-col gap-1">
        <label htmlFor={`${id}-label`} className={labelClass}>Label (optional)</label>
        <input id={`${id}-label`} name="label" maxLength={160} placeholder="Login error" className={inputClass} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Adding…' : 'Add evidence'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}
