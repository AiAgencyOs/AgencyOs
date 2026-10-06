import Link from 'next/link';

import type { EscalationRow, PhaseFiveOverview, PmMessageRow } from '@/modules/projects/phase-five-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import {
  ApprovePlanForm,
  BuildActions,
  ClassifyFeedbackForm,
  CreatePlanForm,
  DeriveDocumentsForm,
  LinkTestRunForm,
  IntegrationCheckForm,
  IntegrationStateForm,
  PlanTaskForm,
  RecordDocumentForm,
  RecordFlakyForm,
  RegisterIntegrationForm,
  ResolveFlakyForm,
  SpecialistStateForm,
  RecordBaselineCommitForm,
  ResolveEscalationForm,
  StartPhaseFiveForm,
} from './phase-five-forms';

/**
 * Phase 5 Overview - the Admin Panel's answer to "what is current, what is blocked, who approved what, can Phase 6 start?" for full
 * development. Read-first: it renders the STORED state (baseline, builds, QA, reviews, defects, feedback, integrations, specialists, the
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

export function PhaseFivePanel({ view, projectId, repositories = [] }: { view: PhaseFiveOverview; projectId: string; repositories?: { id: string; name: string }[] }) {
  const { workspace, gates, baseline, readiness, phaseSixMissing, builds, defects, feedback, integrations, agentStates, handoff, plan, unplannedTasks, flaky, documents, routing, testGaps, staleDocuments, recentRuns } = view;

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
        {gates.m2VerifiedPaid ? <StartPhaseFiveForm projectId={projectId} /> : null}
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
        {baseline && !baseline.baseCommit ? <RecordBaselineCommitForm projectId={projectId} repositories={repositories} /> : null}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Development plan</span>
        {plan ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>v{plan.version}</span>
              <Badge tone={plan.status === 'approved' ? 'success' : plan.status === 'draft' ? 'warning' : 'neutral'}>{humanize(plan.status)}</Badge>
              <span>{plan.summary}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {plan.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{t.title}</span>
                  <Badge tone={t.capability ? 'info' : 'warning'}>{t.capability ? humanize(t.capability) : 'No specialist'}</Badge>
                  {t.hasCriteria ? null : <span className="text-danger">no acceptance criteria</span>}
                  {t.waitsFor.length > 0 ? (
                    <span>
                      waits for:{' '}
                      {t.waitsFor.map((w) => `${w.title} (${w.status === 'done' ? 'done' : humanize(w.status)})`).join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {plan.status === 'draft' && plan.problems.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-danger">
                {plan.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {plan.status === 'draft' ? (
              <>
                {unplannedTasks.map((t) => (
                  <details key={t.id}>
                    <summary className="cursor-pointer text-xs underline underline-offset-2">Plan task: {t.title}</summary>
                    <PlanTaskForm projectId={projectId} planId={plan.id} taskId={t.id} title={t.title} />
                  </details>
                ))}
                <ApprovePlanForm projectId={projectId} planId={plan.id} />
              </>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">No plan yet. Development does not start without an approved plan.</p>
        )}
        {!plan || plan.status !== 'draft' ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">{plan ? 'Create a new plan version' : 'Create the plan'}</summary>
            <CreatePlanForm projectId={projectId} />
          </details>
        ) : null}
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
                <BuildActions projectId={projectId} deliverableId={b.deliverableId} status={b.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Test evidence per task</span>
        {testGaps.length === 0 ? (
          <p className="text-xs text-muted">Every planned task has a linked passing run (or none is planned yet).</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {testGaps.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="text-danger">No passing evidence:</span>
                <span>{g.title}</span>
                <LinkTestRunForm projectId={projectId} taskId={g.id} runs={recentRuns} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Routing decisions</span>
        {routing.length === 0 ? (
          <p className="text-xs text-muted">No task has been routed yet (routing happens when a plan is approved).</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {routing.map((r, i) => (
              <li key={`${r.taskTitle}-${i}`} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={r.outcome === 'routed' ? 'success' : r.outcome === 'held' ? 'warning' : 'danger'}>{humanize(r.outcome)}</Badge>
                <span>{r.taskTitle}</span>
                {r.toAgent ? <span>→ {humanize(r.toAgent)}</span> : null}
                <span>{r.reason}</span>
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
                {!f.classification ? <ClassifyFeedbackForm projectId={projectId} feedbackId={f.id} /> : null}
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
                {i.lastCheckClass ? <span>last check: {humanize(i.lastCheckClass)}</span> : null}
                <IntegrationStateForm projectId={projectId} connectionId={i.id} />
                {i.isMock ? null : <IntegrationCheckForm projectId={projectId} connectionId={i.id} checkUrl={i.checkUrl} credentialRef={i.credentialRef} />}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Register an integration</summary>
          <RegisterIntegrationForm projectId={projectId} />
        </details>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Flaky tests</span>
        {flaky.length === 0 ? (
          <p className="text-xs text-muted">None recorded. A flaky test is never a pass; an open one, or an expired quarantine, blocks completion.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {flaky.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{f.testKey}</span>
                <Badge tone={f.status === 'resolved' ? 'success' : f.status === 'quarantined' ? 'warning' : 'danger'}>{humanize(f.status)}</Badge>
                <span>seen {f.occurrences}x</span>
                {f.expiresAt ? <span>quarantine until {f.expiresAt.slice(0, 10)}</span> : null}
                {f.status !== 'resolved' ? <ResolveFlakyForm projectId={projectId} flakyId={f.id} /> : null}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Record a flaky test</summary>
          <RecordFlakyForm projectId={projectId} />
        </details>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Documentation</span>
        {documents.length === 0 ? (
          <p className="text-xs text-muted">No technical documents recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{humanize(d.kind)}: {d.title}</span>
                <Badge tone={d.status === 'implemented' ? 'success' : d.status === 'blocked' ? 'danger' : 'neutral'}>{humanize(d.status)}</Badge>
                {d.evidenceRef ? <span>evidence: {d.evidenceRef}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {staleDocuments > 0 ? <p className="text-xs text-danger">{staleDocuments} derived document(s) are stale: a newer build exists than the one they describe.</p> : null}
        <DeriveDocumentsForm projectId={projectId} />
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Record a document</summary>
          <RecordDocumentForm projectId={projectId} integrations={integrations.map((i) => ({ id: i.id, name: i.name }))} />
        </details>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Specialists</span>
        <ul className="flex flex-wrap gap-2">
          {agentStates.map((a) => (
            <li key={a.agentKey} className="text-xs text-muted" title={a.reason ?? undefined}>
              {humanize(a.agentKey)}: <Badge tone={a.state === 'not_required' ? 'neutral' : 'info'}>{humanize(a.state)}</Badge>
              <SpecialistStateForm projectId={projectId} agentKey={a.agentKey} state={a.state} />
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
        Each form calls a database door that checks the role, the independence rules and the gates; its refusal is shown as written. The one action with no form is an adapter-verified integration check, which only a runner's real result can make.
      </p>
    </Card>
  );
}


/** What the PM said, in which wording (template version), and whether the message arrived: the record P5-PM-01 / P6-PM-01 asked for. */
export function PmMessageHistoryPanel({ rows }: { rows: PmMessageRow[] }) {
  return (
    <Card>
      <h3 className="text-[15px] font-semibold">PM messages</h3>
      <p className="mt-1 text-[13px] text-muted">Each milestone message, the version of its wording, and its delivery state. Staff relay to the client.</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">No PM milestone message has gone out for this project yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-[13px]">
          {rows.map((r, i) => (
            <li key={`${i}-${r.milestone}-${r.sentAt}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.milestone}</span>
              <Badge tone={r.delivery === 'sent' ? 'success' : r.delivery === 'failed' ? 'danger' : 'neutral'}>{humanize(r.delivery)}</Badge>
              <span className="text-muted">wording v{r.templateVersion} · {new Date(r.sentAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}


/** Work the Orchestrator could not place, or that failed past its rules: each waits for a person's decision and says why. */
export function EscalationsPanel({ rows, projectId }: { rows: EscalationRow[]; projectId: string }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <h3 className="text-[15px] font-semibold">Waiting for a decision</h3>
      <ul className="mt-2 flex flex-col gap-3 text-[13px]">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1">
            <span><span className="font-medium">{r.taskTitle}</span> <Badge tone="warning">{humanize(r.rootCause)}</Badge></span>
            <span className="text-muted">{r.recommendation}</span>
            <ResolveEscalationForm projectId={projectId} escalationId={r.id} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
