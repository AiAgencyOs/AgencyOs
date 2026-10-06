import type { TestIntegrationView } from '@/modules/projects/test-integration-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { RequestDocumentationDraftForm, RequestTestCaseDraftsForm } from './test-integration-forms';

/**
 * Test and integration records for one project, from the STORED state: how each integration has been checking (last success, last failure class,
 * error rate over the last checks), which acceptance criteria no passing test covers, the regression tests linked to defects, and what the Test
 * Automation agent has proposed. Agent output is labelled as a proposal: nothing here is evidence until a person accepts it.
 */

const HEALTH_TONE: Record<string, Tone> = { verified: 'success', configured: 'warning', degraded: 'danger', blocked: 'danger', unknown: 'neutral', disabled: 'neutral' };

export function TestIntegrationPanel({ projectId, view }: { projectId: string; view: TestIntegrationView }) {
  const held = new Set(view.dependencies.filter((d) => d.held).map((d) => d.connectionId));
  return (
    <Card className="flex flex-col gap-4 p-4">
      <span className="text-sm font-medium text-foreground">Tests and integrations</span>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Integration checks</h3>
        {view.observability.length === 0 ? (
          <p className="text-[13px] text-muted">No integration is registered.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {view.observability.map((o) => (
              <li key={o.connectionId} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{o.name}</span>
                <Badge tone={HEALTH_TONE[o.health] ?? 'neutral'}>{humanize(o.health)}</Badge>
                <span className="text-muted">
                  {o.checksCounted === 0
                    ? 'never checked'
                    : `${Math.round((o.errorRate ?? 0) * 100)}% errors over the last ${o.checksCounted} checks${o.avgLatencyMs !== null ? `, ${o.avgLatencyMs} ms average` : ''}`}
                  {o.lastSuccessAt ? `; last success ${new Date(o.lastSuccessAt).toLocaleString()}` : '; no success on record'}
                  {o.lastFailureClass ? `; last failure ${humanize(o.lastFailureClass)}` : ''}
                </span>
                {held.has(o.connectionId) ? <Badge tone="warning">Holding dependent tasks</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Acceptance criteria with no passing test</h3>
        {view.gaps.length === 0 ? (
          <p className="text-[13px] text-muted">None: every task that states acceptance criteria has a passing test.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {view.gaps.map((g) => (
              <li key={g.taskId}>
                <span className="text-foreground">{g.title}</span> <Badge tone="warning">{g.reason === 'no_linked_test' ? 'No test linked' : 'No passing test'}</Badge>
                <span className="block text-muted">{g.acceptanceCriteria}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Regression tests</h3>
        {view.regressionLinks.length === 0 ? (
          <p className="text-[13px] text-muted">No defect has a linked regression test yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {view.regressionLinks.map((l) => (
              <li key={l.id}>
                <span className="text-foreground">{l.testCaseName}</span> <Badge tone={l.state === 'verified' ? 'success' : 'warning'}>{l.state === 'verified' ? 'Verified on the fix build' : 'Linked, not yet verified'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Proposed test cases (drafts from the Test Automation agent, not evidence)</h3>
        {view.drafts.length === 0 ? (
          <p className="text-[13px] text-muted">None proposed.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {view.drafts.map((d) => (
              <li key={d.id}>
                <span className="text-foreground">{d.name}</span> <Badge tone="neutral">{humanize(d.layer)}</Badge>
                <span className="block text-muted">Expected: {d.expected}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-2 sm:flex-row">
        <RequestDocumentationDraftForm projectId={projectId} />
        <RequestTestCaseDraftsForm projectId={projectId} tasks={view.gaps.map((g) => ({ id: g.taskId, title: g.title }))} />
      </div>
    </Card>
  );
}
