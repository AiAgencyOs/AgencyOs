import type { QaSpecialistView } from '@/modules/projects/qa-specialist-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { AskQaSpecialistForm, DecideQaFindingForm } from './qa-specialist-forms';

/**
 * What the Phase 6 QA specialists have PROPOSED, from the stored state. A proposal is labelled as one: it is not a test result. Only an independent
 * person (not the one who asked for the run) can accept it, and acceptance goes through the existing result door under that person's name; a rejection
 * is final. Nothing here records anything by itself. Not run against a real model, browser, device, load tool or scanner: today's proposals come from a
 * stand-in model in tests only.
 */

const RESULT_TONE: Record<string, Tone> = { pass: 'success', fail: 'danger', blocked: 'warning', not_tested: 'neutral' };

export function QaSpecialistPanel({ projectId, view }: { projectId: string; view: QaSpecialistView }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">QA specialist proposals</span>
        <Badge tone="warning">Proposals, not results</Badge>
      </div>
      <AskQaSpecialistForm
        projectId={projectId}
        jobs={view.jobs.map((j) => ({ id: j.id, label: `${humanize(j.category)} - ${humanize(j.specialist)} (${humanize(j.status)})` }))}
        candidate={view.candidate ? { id: view.candidate.id, label: `Release candidate v${view.candidate.version} - release readiness` } : null}
      />
      {view.findings.length === 0 ? (
        <p className="text-[13px] text-muted">No specialist has proposed anything yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.findings.map((f) => (
            <li key={f.id} className="flex flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{humanize(f.agent)}</span>
                <Badge tone="neutral">{humanize(f.kind)}</Badge>
                {f.proposedResult ? <Badge tone={RESULT_TONE[f.proposedResult] ?? 'neutral'}>Proposes {humanize(f.proposedResult)}</Badge> : null}
                {f.decision ? <Badge tone={f.decision.decision === 'accepted' ? 'success' : 'danger'}>{humanize(f.decision.decision)}</Badge> : <Badge tone="info">Awaiting a person</Badge>}
              </div>
              {f.caseTitle ? <span className="text-muted">Case: {f.caseTitle}{f.casePriority ? ` (${f.casePriority})` : ''}</span> : null}
              <span className="text-foreground">{f.reason}</span>
              {f.detail ? <span className="text-muted">{f.detail}</span> : null}
              <span className="text-muted">
                Commit {f.commit}{f.environment ? `; environment ${f.environment}` : ''}
                {f.evidenceRefs.length ? `; evidence ${f.evidenceRefs.join(', ')}` : '; no evidence cited'}
              </span>
              {f.decision ? (
                <span className="text-muted">
                  {humanize(f.decision.decision)} - {humanize(f.decision.recordedOutcome)}
                  {f.decision.note ? `: ${f.decision.note}` : ''}
                </span>
              ) : (
                <DecideQaFindingForm projectId={projectId} findingId={f.id} canAccept={!f.viewerAsked} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
