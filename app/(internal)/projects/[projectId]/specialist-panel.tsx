import type { SpecialistView } from '@/modules/projects/specialist-queries';
import { Badge, Card, humanize } from '@/ui';

import { AskSpecialistForm } from './specialist-forms';

/**
 * Implementation proposals from the development specialists, read-only, from the STORED records. A proposal is a plan: it is not code, not a test
 * result and not an approval, and nothing here is evidence until QA has verified a build. Each carries the validator's verdict (the rules the database
 * door enforces, run again over what is stored). An Admin can ask the specialist a task was routed to; nothing else on this panel writes.
 */
export function SpecialistPanel({ projectId, view }: { projectId: string; view: SpecialistView }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <span className="text-sm font-medium text-foreground">Specialist proposals (plans only: no code, no test result, no approval)</span>
      {view.tasks.length === 0 ? (
        <p className="text-[13px] text-muted">No task has been routed to a development specialist yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {view.tasks.map((t) => (
            <li key={t.taskId} className="flex flex-col gap-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{t.title}</span>
                <Badge tone="neutral">{humanize(t.agentKey)}</Badge>
              </div>
              {t.proposals.length === 0 ? <p className="text-muted">No proposal yet.</p> : null}
              {t.proposals.map((p) => (
                <div key={p.id} className="flex flex-col gap-1 rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{p.outcome === 'not_required' ? 'Not required' : 'Proposed'}</Badge>
                    <Badge tone={p.verdict.ok ? 'success' : 'danger'}>{p.verdict.ok ? 'Passes the validator' : 'Fails the validator'}</Badge>
                    <span className="text-muted">{new Date(p.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-foreground">{p.summary}</p>
                  {p.plannedFiles.length > 0 ? <p className="text-muted">Would touch: {p.plannedFiles.join(', ')}</p> : null}
                  {p.plannedTests.length > 0 ? <p className="text-muted">Would test: {p.plannedTests.join('; ')}</p> : null}
                  {p.risks.length > 0 ? <p className="text-muted">Risks: {p.risks.join('; ')}</p> : null}
                  <p className="text-muted">Evidence it would need: {p.evidencePlan.join(', ') || 'none'}</p>
                  {!p.verdict.ok ? <p className="text-danger">{p.verdict.messages.join('; ')}</p> : null}
                </div>
              ))}
              <AskSpecialistForm projectId={projectId} taskId={t.taskId} agentLabel={humanize(t.agentKey).toLowerCase()} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
