'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import {
  dependOnIntegrationAction,
  linkRegressionAction,
  releaseIntegrationDependencyAction,
  reviewDocumentationDraftAction,
  reviewTestCaseDraftAction,
  verifyRegressionAction,
} from '@/modules/projects/review-actions';
import { buttonClass } from '@/ui';

/** Every form posts to a door that checks again in the database; what a form hides is a convenience, never the rule. */

const FIELD = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export function LinkRegressionForm({ projectId, defects, builds }: { projectId: string; defects: { id: string; title: string }[]; builds: { id: string; version: number; title: string }[] }) {
  const [state, action, pending] = useActionState(linkRegressionAction, IDLE_STATE);
  if (defects.length === 0) return <p className="text-[13px] text-muted">No defect to link a test to.</p>;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Link a defect to the automated test that will keep it fixed.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Defect" name="defectId" className={FIELD}>
        {defects.map((d) => (
          <option key={d.id} value={d.id}>{d.title}</option>
        ))}
      </select>
      <input aria-label="Automated test name" name="testCaseName" required maxLength={300} placeholder="Name of the automated test" className={FIELD} />
      <select aria-label="Defective build" name="defectiveBuildId" className={FIELD} defaultValue="">
        <option value="">Defective build (optional)</option>
        {builds.map((b) => (
          <option key={b.id} value={b.id}>{`v${b.version} ${b.title}`}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Linking…' : 'Link regression test'}</button>
      <Message state={state} />
    </form>
  );
}

export function VerifyRegressionForm({
  projectId,
  linkId,
  builds,
  runs,
}: {
  projectId: string;
  linkId: string;
  builds: { id: string; version: number; title: string }[];
  runs: { id: string; deliverableId: string; suite: string; createdAt: string }[];
}) {
  const [state, action, pending] = useActionState(verifyRegressionAction, IDLE_STATE);
  if (builds.length === 0 || runs.length === 0) return <p className="text-[13px] text-muted">Verification needs a fix build and a test run of it.</p>;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="linkId" value={linkId} />
      <select aria-label="Fix build" name="fixBuildId" className={FIELD}>
        {builds.map((b) => (
          <option key={b.id} value={b.id}>{`Fix build v${b.version} ${b.title}`}</option>
        ))}
      </select>
      <select aria-label="Test run of the fix build" name="testRunId" className={FIELD}>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>{`${r.suite} run, ${new Date(r.createdAt).toLocaleString()}`}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Verifying…' : 'Verify on the fix build'}</button>
      <Message state={state} />
    </form>
  );
}

export function DependOnIntegrationForm({ projectId, tasks, connections }: { projectId: string; tasks: { id: string; title: string }[]; connections: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(dependOnIntegrationAction, IDLE_STATE);
  if (tasks.length === 0 || connections.length === 0) return <p className="text-[13px] text-muted">A task and an integration are both needed to link them.</p>;
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">Declare that a task cannot work without an integration. If it degrades, only the tasks that depend on it are held.</p>
      <input type="hidden" name="projectId" value={projectId} />
      <select aria-label="Task" name="taskId" className={FIELD}>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>{t.title}</option>
        ))}
      </select>
      <select aria-label="Integration" name="connectionId" className={FIELD}>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Linking…' : 'Link task to integration'}</button>
      <Message state={state} />
    </form>
  );
}

export function ReleaseDependencyForm({ projectId, taskId, connectionId }: { projectId: string; taskId: string; connectionId: string }) {
  const [state, action, pending] = useActionState(releaseIntegrationDependencyAction, IDLE_STATE);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Releasing…' : 'Release'}</button>
      <Message state={state} />
    </form>
  );
}

export function ReviewTestDraftForm({ projectId, draftId }: { projectId: string; draftId: string }) {
  const [state, action, pending] = useActionState(reviewTestCaseDraftAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="draftId" value={draftId} />
      <input aria-label="Note (required to reject)" name="note" maxLength={1000} placeholder="Note (required to reject)" className={FIELD} />
      <div className="flex gap-2">
        <button type="submit" name="decision" value="accepted" disabled={pending} className={buttonClass('secondary', 'sm')}>Accept</button>
        <button type="submit" name="decision" value="rejected" disabled={pending} className={buttonClass('secondary', 'sm')}>Reject</button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function ReviewDocumentDraftForm({ projectId, documentId }: { projectId: string; documentId: string }) {
  const [state, action, pending] = useActionState(reviewDocumentationDraftAction, IDLE_STATE);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="documentId" value={documentId} />
      <select aria-label="Status if accepted" name="status" className={FIELD} defaultValue="partial">
        <option value="partial">Partial (reviewed, not complete)</option>
        <option value="implemented">Implemented (needs evidence)</option>
        <option value="not_implemented">Not implemented</option>
        <option value="not_required">Not required</option>
        <option value="manual_external">Manual or external</option>
      </select>
      <input aria-label="Evidence (required for implemented)" name="evidenceRef" maxLength={500} placeholder="Evidence (required for implemented)" className={FIELD} />
      <div className="flex gap-2">
        <button type="submit" name="decision" value="accepted" disabled={pending} className={buttonClass('secondary', 'sm')}>Accept with this status</button>
        <button type="submit" name="decision" value="rejected" disabled={pending} className={buttonClass('secondary', 'sm')}>Reject (deprecate)</button>
      </div>
      <Message state={state} />
    </form>
  );
}
