import Link from 'next/link';

import type { PhaseFiveOverview } from '@/modules/projects/phase-five-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

/**
 * Phase 5 Overview - the Admin Panel's answer to "what is current, what is blocked, who approved what, can Phase 6 start?" for full
 * development. READ-ONLY: it renders the STORED state (baseline, builds, QA, reviews, defects, feedback, integrations, specialists, the
 * Phase 6 intake) and never re-derives a verdict. The writes live behind the database doors (`record_build_qa_verdict`,
 * `decide_build_admin`, `record_code_review`, `classify_build_feedback`, ...); a form for each is not built yet and is named here rather
 * than assumed done.
 */

const STATE_TONE: Record<string, Tone> = {
  baseline_locked: 'info',
  in_development: 'info',
  integration: 'info',
  admin_review: 'warning',
  client_testing: 'warning',
  final_approved: 'success',
  completed: 'success',
  blocked: 'danger',
};
const HEALTH_TONE: Record<string, Tone> = {
  verified: 'success',
  configured: 'warning',
  unknown: 'neutral',
  degraded: 'danger',
  blocked: 'danger',
  disabled: 'neutral',
};
const VERDICT_TONE: Record<string, Tone> = {
  passed: 'success',
  missing: 'neutral',
  stale: 'warning',
  changes_required: 'danger',
  blocked: 'danger',
  needs_second: 'warning',
};
const BUILD_TONE: Record<string, Tone> = {
  draft: 'neutral',
  in_review: 'warning',
  changes_requested: 'danger',
  approved: 'success',
  superseded: 'neutral',
};

export function PhaseFivePanel({ view, projectId }: { view: PhaseFiveOverview; projectId: string }) {
  const { workspace, gates, baseline, readiness, phaseSixMissing, builds, defects, feedback, integrations, agentStates, handoff } = view;

  if (!workspace) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Task 3 (Phase 5)</span>
          <Badge tone={gates.m2VerifiedPaid ? 'warning' : 'neutral'}>{gates.m2VerifiedPaid ? 'M2 verified - waiting for Phase 4' : 'Waiting for Phase 4 and M2'}</Badge>
        </div>
        <p className="text-xs text-muted">
          Phase 5 starts only when Phase 4 is complete and an Admin has verified the M2 payment; it then locks a baseline of the exact approved UI,
          prototype and scope. Neither has happened yet.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Task 3 (Phase 5)</span>
        <Badge tone={STATE_TONE[workspace.state] ?? 'neutral'}>{humanize(workspace.state)}</Badge>
      </div>
      {workspace.blockedReason ? <p className="text-xs text-danger">{workspace.blockedReason}</p> : null}

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Locked baseline</span>
        {baseline ? (
          <p className="text-xs text-muted">
            UI v{baseline.uiVersion ?? '?'} · prototype build v{baseline.prototypeVersion ?? '?'} · scope v{baseline.scopeVersion ?? '?'}
            {baseline.repository ? ` · ${baseline.repository}` : ' · no repository linked'}
            {baseline.baseCommit ? ` @ ${baseline.baseCommit}` : ''}
          </p>
        ) : (
          <p className="text-xs text-muted">No baseline recorded.</p>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Builds</span>
        {builds.length === 0 ? (
          <p className="text-xs text-muted">No development build yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {builds.map((b) => (
              <li key={b.deliverableId} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>v{b.version}</span>
                <Badge tone={BUILD_TONE[b.status] ?? 'neutral'}>{humanize(b.status)}</Badge>
                <span>{b.commitRef ? `commit ${b.commitRef}` : 'no commit recorded'}</span>
                {b.buildNumber ? <span>#{b.buildNumber}</span> : null}
                {b.targetEnv ? <span>{humanize(b.targetEnv)}</span> : null}
                <span>QA: {b.qaStatus ? humanize(b.qaStatus) : 'not run'}</span>
                <span>Review:</span>
                <Badge tone={VERDICT_TONE[b.reviewVerdict ?? 'missing'] ?? 'neutral'}>{humanize(b.reviewVerdict ?? 'missing')}</Badge>
                <span>Admin: {b.adminStatus ? humanize(b.adminStatus) : 'pending'}</span>
                {b.artifactUrl ? (
                  <Link href={b.artifactUrl} className="underline underline-offset-2">
                    Artifact
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Defects</span>
        <p className="text-xs text-muted">
          {defects.unresolved} not yet verified · {defects.verified} verified · {defects.total} total. A fix claim does not count until someone other than the fixer verifies it.
        </p>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Client feedback</span>
        {feedback.length === 0 ? (
          <p className="text-xs text-muted">No feedback recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {feedback.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={f.classification ? 'info' : 'warning'}>{f.classification ? humanize(f.classification) : 'Unclassified'}</Badge>
                <span>{f.words}</span>
                {f.defectId ? <span>→ defect</span> : null}
                {f.changeRequestId ? <span>→ change request</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Integrations</span>
        {integrations.length === 0 ? (
          <p className="text-xs text-muted">None registered.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {integrations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{i.name}</span>
                <span>({humanize(i.kind)})</span>
                <Badge tone={HEALTH_TONE[i.health] ?? 'neutral'}>{humanize(i.health)}</Badge>
                {i.isMock ? <span>mock only</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Specialists</span>
        <ul className="flex flex-wrap gap-2">
          {agentStates.map((a) => (
            <li key={a.agentKey} className="text-xs text-muted" title={a.reason ?? undefined}>
              {humanize(a.agentKey)}: <Badge tone={a.state === 'not_required' ? 'neutral' : 'info'}>{humanize(a.state)}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Can Phase 5 complete?</span>
        {readiness?.outcome === 'ready' || workspace.completedAt ? (
          <Badge tone="success">{workspace.completedAt ? 'Completed' : 'Ready to complete'}</Badge>
        ) : (
          <ul className="list-disc pl-5 text-xs text-muted">
            {(readiness?.missing ?? []).map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Phase 6</span>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>M3 payment:</span>
          <Badge tone={gates.m3VerifiedPaid ? 'success' : 'warning'}>{gates.m3VerifiedPaid ? 'Verified paid - gate open' : 'Not verified - gate closed'}</Badge>
          {handoff ? <span>Intake written for commit {handoff.commit}</span> : <span>No QA intake yet (written when Phase 5 completes).</span>}
        </div>
        {!gates.m3VerifiedPaid || phaseSixMissing.length > 0 ? (
          <ul className="list-disc pl-5 text-xs text-muted">
            {phaseSixMissing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <p className="text-xs text-faint" data-project={projectId}>
        Read-only: the actions behind this view (QA verdict, Admin decision, code review, feedback classification, integration check) are database doors; their forms are not built yet.
      </p>
    </Card>
  );
}
