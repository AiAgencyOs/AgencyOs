import type { ReviewView } from '@/modules/projects/review-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import {
  DependOnIntegrationForm,
  LinkRegressionForm,
  ReleaseDependencyForm,
  ReviewDocumentDraftForm,
  ReviewTestDraftForm,
  VerifyRegressionForm,
} from './review-forms';

/**
 * Decisions on the work the agents and the doors produce. A draft is a PROPOSAL: it is shown as one, and nothing here makes it evidence. A person
 * accepts or rejects a test case draft (the decision is recorded; the test is still written and run by a person); an Admin promotes or rejects a
 * documentation draft, and an implemented document must name its evidence. Coverage gaps and integration health are the stored facts.
 */

const HEALTH_TONE: Record<string, Tone> = { verified: 'success', configured: 'warning', degraded: 'danger', blocked: 'danger', unknown: 'neutral', disabled: 'neutral' };

export function ReviewPanel({ projectId, view, canWrite, isAdmin }: { projectId: string; view: ReviewView; canWrite: boolean; isAdmin: boolean }) {
  const open = view.testDrafts.filter((d) => d.status === 'draft');
  const decided = view.testDrafts.filter((d) => d.status !== 'draft');
  const connectionName = new Map(view.connections.map((c) => [c.id, c.name]));
  const taskTitle = new Map(view.tasks.map((t) => [t.id, t.title]));
  return (
    <Card className="flex flex-col gap-4 p-4">
      <span className="text-sm font-medium text-foreground">Review: drafts, regression tests and integration dependencies</span>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Test case drafts to review (proposals, not evidence)</h3>
        {open.length === 0 ? <p className="text-[13px] text-muted">No draft is waiting for a decision.</p> : null}
        <ul className="flex flex-col gap-2 text-[13px]">
          {open.map((d) => (
            <li key={d.id} className="flex flex-col gap-1">
              <span><span className="text-foreground">{d.name}</span> <Badge tone="neutral">{humanize(d.layer)}</Badge> <span className="text-muted">for {d.taskTitle}</span></span>
              <span className="text-muted">{d.description}</span>
              <span className="text-muted">Expected: {d.expected}</span>
              {canWrite ? <ReviewTestDraftForm projectId={projectId} draftId={d.id} /> : null}
            </li>
          ))}
        </ul>
        {decided.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[13px]">
            {decided.map((d) => (
              <li key={d.id}>
                <span className="text-foreground">{d.name}</span> <Badge tone={d.status === 'accepted' ? 'success' : 'neutral'}>{d.status === 'accepted' ? 'Accepted (a person still writes the test)' : 'Rejected'}</Badge>
                {d.reviewNote ? <span className="block text-muted">{d.reviewNote}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Documentation drafts to review</h3>
        {view.docDrafts.length === 0 ? <p className="text-[13px] text-muted">No documentation draft is waiting.</p> : null}
        <ul className="flex flex-col gap-2 text-[13px]">
          {view.docDrafts.map((d) => (
            <li key={d.id} className="flex flex-col gap-1">
              <span><span className="text-foreground">{d.title}</span> <Badge tone="warning">{`Draft, ${humanize(d.kind)}`}</Badge></span>
              <span className="whitespace-pre-line text-muted">{d.body.slice(0, 600)}</span>
              {isAdmin ? <ReviewDocumentDraftForm projectId={projectId} documentId={d.id} /> : <span className="text-muted">An Admin promotes or rejects this draft.</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Regression tests</h3>
        <ul className="flex flex-col gap-2 text-[13px]">
          {view.links.map((l) => (
            <li key={l.id} className="flex flex-col gap-1">
              <span><span className="text-foreground">{l.testCaseName}</span> <span className="text-muted">for {l.defectTitle}</span> <Badge tone={l.state === 'verified' ? 'success' : 'warning'}>{l.state === 'verified' ? 'Verified on the fix build' : 'Linked, not yet verified'}</Badge></span>
              {canWrite && l.state !== 'verified' ? <VerifyRegressionForm projectId={projectId} linkId={l.id} builds={view.builds} runs={view.runs} /> : null}
            </li>
          ))}
        </ul>
        {canWrite ? <LinkRegressionForm projectId={projectId} defects={view.defects} builds={view.builds} /> : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">Task dependencies on integrations</h3>
        {view.integration.dependencies.length === 0 ? <p className="text-[13px] text-muted">No task depends on an integration yet.</p> : null}
        <ul className="flex flex-col gap-1 text-[13px]">
          {view.integration.dependencies.map((d) => (
            <li key={`${d.taskId}:${d.connectionId}`} className="flex flex-wrap items-center gap-2">
              <span className="text-foreground">{taskTitle.get(d.taskId) ?? 'A task'}</span>
              <span className="text-muted">needs {connectionName.get(d.connectionId) ?? 'an integration'}</span>
              {d.held ? <Badge tone="warning">Held</Badge> : null}
              {canWrite ? <ReleaseDependencyForm projectId={projectId} taskId={d.taskId} connectionId={d.connectionId} /> : null}
            </li>
          ))}
        </ul>
        {canWrite ? <DependOnIntegrationForm projectId={projectId} tasks={view.tasks} connections={view.connections} /> : null}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Coverage gaps and integration health</h3>
        <ul className="flex flex-col gap-1 text-[13px]">
          {view.integration.gaps.map((g) => (
            <li key={g.taskId}>
              <span className="text-foreground">{g.title}</span> <Badge tone="warning">{g.reason === 'no_linked_test' ? 'No test linked' : 'No passing test'}</Badge>
            </li>
          ))}
          {view.integration.observability.map((o) => (
            <li key={o.connectionId}>
              <span className="text-foreground">{o.name}</span> <Badge tone={HEALTH_TONE[o.health] ?? 'neutral'}>{humanize(o.health)}</Badge>
              <span className="text-muted">{o.checksCounted === 0 ? ' never checked' : ` ${Math.round((o.errorRate ?? 0) * 100)}% errors over the last ${o.checksCounted} checks`}</span>
            </li>
          ))}
        </ul>
        {view.integration.gaps.length === 0 && view.integration.observability.length === 0 ? <p className="text-[13px] text-muted">No gaps and no integration registered.</p> : null}
      </section>
    </Card>
  );
}
