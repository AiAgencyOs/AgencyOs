'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { commitTestCaseImportAction, linkTestCaseTaskAction, previewTestCaseImportAction } from '@/modules/qa/test-case-import-actions';
import { IMPORT_IDLE_STATE } from '@/modules/qa/test-case-import-types';
import { Badge, FormMessage, buttonClass, inputClass, labelClass, selectClass, statusTone, humanize } from '@/ui';

/**
 * SCR-045 — "Create/import test case" and "Linked requirement/task".
 *
 * The import is two forms. The first parses what was pasted or uploaded
 * (`previewTestCaseImportAction`) and writes nothing; it answers with every
 * row it understood and every row it did not, numbered. The second carries
 * the previewed rows and commits them through `qa.import_test_cases` — one
 * transaction, all or none — so what was shown is exactly what lands. A
 * preview with errors offers no commit button: there is nothing honest it
 * could do.
 */

const textarea = `${inputClass} min-h-28 font-mono text-xs`;

const EXAMPLE = `requirement,category,reason,preconditions,steps,expected
Checkout,functional,"Moves money, a bug here costs a client",Signed-in client with one unpaid invoice,"1. Open the invoice
2. Pay by card",The invoice reads paid
Checkout,security,Card data must never reach our logs,,Pay with a test card; read the request log,No PAN in any log line`;

export function ImportTestCasesForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [preview, previewAction, previewing] = useActionState(previewTestCaseImportAction, IMPORT_IDLE_STATE);
  const [commit, commitAction, committing] = useActionState(commitTestCaseImportAction, IMPORT_IDLE_STATE);

  const parsed = preview.preview;
  const committed = commit.status === 'success';
  const canCommit = parsed !== undefined && parsed.issues.length === 0 && parsed.rows.length > 0 && !committed;

  return (
    <details className="rounded-lg border border-dashed border-line p-3">
      <summary className="cursor-pointer text-[13px] font-medium">Import cases (CSV or JSON)</summary>
      <div className="flex flex-col gap-3 pt-3">
        <form action={previewAction} className="flex flex-col gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="planId" value={planId} />
          <div className="flex flex-col gap-1">
            <label className={labelClass} htmlFor={`import-source-${planId}`}>
              Paste CSV (header row: requirement, category, reason, and optionally preconditions, steps, expected, critical, task) or a JSON array of cases
            </label>
            <textarea id={`import-source-${planId}`} name="source" className={textarea} placeholder={EXAMPLE} />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor={`import-file-${planId}`}>
                or upload a file (≤ 200 KB)
              </label>
              <input id={`import-file-${planId}`} name="file" type="file" accept=".csv,.json,text/csv,application/json,text/plain" className="text-xs" />
            </div>
            <button type="submit" disabled={previewing} className={buttonClass('secondary', 'sm')}>
              {previewing ? 'Reading…' : 'Preview'}
            </button>
          </div>
          <p className="text-xs text-muted">
            A requirement is a scope item of this plan&apos;s baseline, by exact title or id. The category is the suite (functional, ui, api, database, integration, e2e, regression, security, performance, compatibility, smoke). One case per requirement and category.
          </p>
          <FormMessage status={preview.status} message={preview.message} />
        </form>

        {parsed && parsed.format !== 'empty' ? (
          <div className="flex flex-col gap-2">
            {parsed.issues.length > 0 ? (
              <ul className="flex flex-col gap-0.5 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs">
                {parsed.issues.map((issue, i) => (
                  <li key={`${issue.row}-${i}`}>
                    <span className="font-medium">{issue.row === 0 ? 'Input' : `Row ${issue.row}`}:</span> {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {parsed.rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="py-1 pr-2 font-normal">#</th>
                      <th className="py-1 pr-2 font-normal">Requirement</th>
                      <th className="py-1 pr-2 font-normal">Category</th>
                      <th className="py-1 pr-2 font-normal">Reason</th>
                      <th className="py-1 font-normal">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.map((row, i) => (
                      <tr key={i} className="border-b border-line last:border-0 align-top">
                        <td className="py-1 pr-2 tabular text-muted">{i + 1}</td>
                        <td className="py-1 pr-2">{row.requirement}</td>
                        <td className="py-1 pr-2">
                          <Badge tone="brand">{row.category}</Badge>
                          {row.criticalPath ? <Badge tone="warning" className="ml-1">critical path</Badge> : null}
                        </td>
                        <td className="py-1 pr-2">{row.reason}</td>
                        <td className="py-1 text-xs text-muted">
                          {[row.preconditions ? 'preconditions' : null, row.steps ? 'steps' : null, row.expectedResult ? 'expected result' : null, row.task ? 'task' : null].filter(Boolean).join(', ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {canCommit ? (
              <form action={commitAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="planId" value={planId} />
                <input type="hidden" name="cases" value={JSON.stringify(parsed.rows)} />
                <button type="submit" disabled={committing} className={buttonClass('primary', 'sm')}>
                  {committing ? 'Importing…' : `Commit ${parsed.rows.length} case${parsed.rows.length === 1 ? '' : 's'}`}
                </button>
                <span className="text-xs text-muted">One transaction: every case lands, or none does.</span>
              </form>
            ) : null}
            <FormMessage status={commit.status} message={commit.message} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** The task a planned case exercises — shown on the row, linked to its Development page. */
export function LinkedTask({ projectId, task }: { projectId: string; task: { id: string; title: string; status: string } | null | undefined }) {
  if (!task) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted">
      Task:{' '}
      <Link href={`/projects/${projectId}/development/tasks/${task.id}`} className="underline underline-offset-2 hover:text-foreground">
        {task.title}
      </Link>
      <Badge tone={statusTone(task.status)}>{humanize(task.status)}</Badge>
    </span>
  );
}

/** `qa.link_test_case_task` — pick a task of the project, or none. Allowed on an approved plan: who builds it is not what is tested. */
export function LinkTaskForm({
  projectId,
  itemId,
  currentTaskId,
  tasks,
}: {
  projectId: string;
  itemId: string;
  currentTaskId: string | null;
  tasks: { id: string; title: string; status: string }[];
}) {
  const [state, action, pending] = useActionState(linkTestCaseTaskAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="itemId" value={itemId} />
      <label className="sr-only" htmlFor={`case-task-${itemId}`}>
        Linked task
      </label>
      <select id={`case-task-${itemId}`} name="taskId" defaultValue={currentTaskId ?? ''} className={`${selectClass} max-w-56 text-xs`}>
        <option value="">No task</option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
            {t.status === 'done' ? ' (done)' : ''}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('ghost', 'sm')}>
        {pending ? 'Linking…' : 'Link task'}
      </button>
      {state.status !== 'idle' ? <span className={`text-xs ${state.status === 'error' ? 'text-danger' : 'text-muted'}`}>{state.message}</span> : null}
    </form>
  );
}
