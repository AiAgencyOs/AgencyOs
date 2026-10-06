import type { PhaseSixOverview } from '@/modules/projects/phase-six-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { DoorForm } from './phase-six-forms';

/**
 * Phase 6 Overview (P601 §46, §58): current state, intake and its blockers, the Master Test Plan with risk and coverage, defects, the exact release
 * candidate, its evidence by category, the hard gates (the decision) and the readiness score (the summary), exceptions, the Admin's review, and the Phase 7
 * intake and M4 gate. It renders STORED state and never re-derives a verdict; every form calls a database door that checks role, independence and gates,
 * and its refusal is shown as written. INTERNAL: a client sees none of this (the tables are internal-only by policy).
 */

const STATE_TONE: Record<string, Tone> = {
  waiting_m3_verified: 'warning', ready: 'info', intake_validating: 'info', plan_ready: 'info', testing: 'info', defect_fix_loop: 'warning',
  final_verification: 'info', admin_review: 'warning', blocked: 'danger', phase6_completed: 'success', m4_due: 'warning', phase7_financially_ready: 'success',
};
const RESULT_TONE: Record<string, Tone> = { pass: 'success', fail: 'danger', blocked: 'danger', skipped_with_reason: 'warning', invalidated: 'warning', planned: 'neutral', ready: 'neutral', running: 'info' };
const CATEGORIES: [string, string][] = ['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression'].map((c) => [c, humanize(c)]);

export function PhaseSixPanel({ view, projectId }: { view: PhaseSixOverview; projectId: string }) {
  const { workspace, gates, intake, plan, defects, candidate, completion, phaseSevenIntake, jobs, candidateCurrent, contracts, clarifications, performance, devices, compatibilityMatrix } = view;

  if (!workspace) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Task 4 (Phase 6): Master QA</span>
          <Badge tone="neutral">Waiting for Phase 5</Badge>
        </div>
        <p className="text-xs text-muted">Phase 6 is created when Phase 5 completes and becomes ready when an Admin has verified the M3 payment in full.</p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Task 4 (Phase 6): Master QA</span>
        <Badge tone={STATE_TONE[workspace.state] ?? 'neutral'}>{humanize(workspace.state)}</Badge>
      </div>
      {workspace.blockedReason ? <p className="text-xs text-danger">{workspace.blockedReason}</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>M3 payment:</span>
        <Badge tone={gates.m3VerifiedPaid ? 'success' : 'warning'}>{gates.m3VerifiedPaid ? 'Verified' : 'Not verified'}</Badge>
        <span>M4 payment:</span>
        <Badge tone={gates.m4VerifiedPaid ? 'success' : 'neutral'}>{gates.m4VerifiedPaid ? 'Verified' : 'Not verified'}</Badge>
        <span>Phase 7 gate: {gates.phaseSevenGate ? humanize(gates.phaseSevenGate) : 'unknown'}</span>
      </div>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">QA intake</span>
        {intake ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={intake.status === 'valid' ? 'success' : intake.status === 'pending' ? 'neutral' : 'danger'}>{humanize(intake.status)}</Badge>
              <span>commit {intake.commit}</span>
              <span>{intake.artifactSha256 ? `artifact ${intake.artifactSha256.slice(0, 12)}…` : 'no artifact hash'}</span>
              <span>platform: {intake.platforms.length > 0 ? intake.platforms.join(', ') : 'not recorded (not inferred)'}</span>
              <span>{intake.changeRequests} change request(s) on record</span>
            </div>
            {intake.blockers.map((b, i) => (
              <p key={`${i}-${b.detail}`} className="text-danger">{humanize(b.type)}: {b.detail}. Owner: {humanize(b.owner)}. Resume when: {b.resumeCondition}.</p>
            ))}
            {intake.external.map((e, i) => (
              <p key={`${i}-${e.name}`}>External dependency: {e.detail}. Tests that need it are BLOCKED, never skipped.</p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">Not validated yet.</p>
        )}
        <DoorForm door="validate_intake" projectId={projectId} submit="Validate the intake against the exact Phase 5 build" />
        <span className="text-xs text-faint">API / data contracts the tests run against (declared, never inferred)</span>
        {contracts.length === 0 ? <p className="text-xs text-muted">None declared.</p> : (
          <ul className="list-disc pl-5 text-xs text-muted">{contracts.map((c, i) => (<li key={`${i}-${c.name}`}>{c.name}: {c.ref}</li>))}</ul>
        )}
        {intake ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">Declare contracts</summary>
            <DoorForm door="declare_contracts" projectId={projectId} submit="Declare" fields={[{ kind: 'textarea', name: 'contracts', label: 'One per line: name | reference (file, link or document id)', required: true }]} />
          </details>
        ) : null}
        <span className="text-xs text-faint">Questions for the client (one at a time; QA does not guess)</span>
        {clarifications.length === 0 ? <p className="text-xs text-muted">None.</p> : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {clarifications.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={q.status === 'answered' ? 'success' : 'warning'}>{humanize(q.status)}</Badge>
                <span>{q.question}</span>
                {q.answer ? <span>→ {q.answer}</span> : (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Record the answer</summary>
                    <DoorForm door="answer_clarification" projectId={projectId} hidden={{ clarificationId: q.id }} submit="Record answer" fields={[{ kind: 'textarea', name: 'answer', label: "The client's answer", required: true }]} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Ask the client a question</summary>
          <DoorForm door="ask_clarification" projectId={projectId} submit="Ask" intro="Only for a genuinely ambiguous expected behaviour. The PM relays it as written."
            fields={[{ kind: 'textarea', name: 'question', label: 'The question', required: true }, { kind: 'text', name: 'caseId', label: 'Test case id it blocks (optional)' }]} />
        </details>
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Performance (against this project's own targets)</span>
        {performance.length === 0 ? <p className="text-xs text-muted">No performance targets set: none is invented.</p> : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {performance.map((m) => (
              <li key={m.metric} className="flex flex-wrap items-center gap-2">
                <Badge tone={m.ok === null ? 'neutral' : m.ok ? 'success' : 'danger'}>{m.ok === null ? 'No measurement' : m.ok ? 'Within target' : 'Over target'}</Badge>
                <span>{m.metric}: target {m.lowerIsBetter ? '≤' : '≥'} {m.target} {m.unit}</span>
                <span>{m.latest === null ? 'not measured' : `latest ${m.latest} ${m.unit}`}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Compatibility and devices</span>
        <p className="text-xs text-muted">{compatibilityMatrix.length > 0 ? `The plan declares ${compatibilityMatrix.length} target(s).` : 'The plan declares no matrix.'} A simulator is not a device, one browser is not all browsers, and an unavailable target is BLOCKED, never a pass.</p>
        {devices.length === 0 ? <p className="text-xs text-muted">No devices configured.</p> : (
          <ul className="flex flex-wrap gap-2 text-xs text-muted">
            {devices.map((d) => (
              <li key={d.name} title={d.reason ?? undefined}>{d.name} ({d.platform}): <Badge tone={d.status === 'supported' ? 'success' : 'neutral'}>{humanize(d.status)}</Badge></li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Master Test Plan</span>
        {plan ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span>v{plan.version}</span>
              <Badge tone={plan.status === 'approved' ? 'success' : plan.status === 'draft' ? 'warning' : 'neutral'}>{humanize(plan.status)}</Badge>
              <span>{plan.categories.map(humanize).join(', ')}</span>
              {plan.journeys.length > 0 ? <span>journeys: {plan.journeys.join(', ')}</span> : null}
            </div>
            {plan.status === 'draft' && plan.problems.length > 0 ? (
              <ul className="list-disc pl-5 text-danger">
                {plan.problems.map((p) => (<li key={p}>{p}</li>))}
              </ul>
            ) : null}
            <span className="text-faint">Risk matrix</span>
            {plan.risks.length === 0 ? <p>None recorded.</p> : (
              <ul className="list-disc pl-5">{plan.risks.map((r, i) => (<li key={`${i}-${r.area}-${r.kind}`}>{r.area} ({humanize(r.kind)}): {r.level}, {r.depth}</li>))}</ul>
            )}
            <span className="text-faint">Cases</span>
            <ul className="flex flex-col gap-1">
              {plan.cases.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <Badge tone={RESULT_TONE[c.status] ?? 'neutral'}>{humanize(c.status)}</Badge>
                  <span>{c.title}</span>
                  <span>({humanize(c.category)}, {c.priority}{c.journey ? `, journey ${c.journey}` : ''})</span>
                  {plan.status === 'approved' ? (
                    <details>
                      <summary className="cursor-pointer underline underline-offset-2">Record result</summary>
                      <DoorForm door="case_result" projectId={projectId} hidden={{ caseId: c.id }} submit="Record result" intro="An independent person records this on the plan's exact commit. A pass needs evidence; a critical case is never skipped."
                        fields={[{ kind: 'select', name: 'status', label: 'Result', options: [['pass', 'Pass'], ['fail', 'Fail (raises a defect)'], ['blocked', 'Blocked'], ['skipped_with_reason', 'Skipped with reason']] }, { kind: 'text', name: 'evidenceRef', label: 'Evidence link' }, { kind: 'text', name: 'reason', label: 'Reason / what failed' }]} />
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
            {plan.status === 'approved' ? (
              <>
                <span className="text-faint">QA jobs (scheduled by the QA Orchestrator)</span>
                {jobs.length === 0 ? <p>Not scheduled yet.</p> : (
                  <ul className="flex flex-col gap-1">
                    {jobs.map((j) => (
                      <li key={j.category} className="flex flex-wrap items-center gap-2">
                        <Badge tone={j.status === 'routed' ? 'success' : 'warning'}>{humanize(j.status)}</Badge>
                        <span>{humanize(j.category)} → {humanize(j.specialist)}</span>
                        <span>({j.mode}{j.dependsOn.length > 0 ? `, after ${j.dependsOn.map(humanize).join(' and ')}` : ''})</span>
                        <span>{j.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <DoorForm door="schedule_jobs" projectId={projectId} hidden={{ planId: plan.id }} submit="Schedule (or re-schedule held) jobs" />
              </>
            ) : null}
            {plan.status === 'draft' ? (
              <>
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Add a risk</summary>
                  <DoorForm door="add_risk" projectId={projectId} hidden={{ planId: plan.id }} submit="Add risk" intro="Payment, authentication, authorization, tenant data and destructive work cannot be recorded low or shallow."
                    fields={[{ kind: 'text', name: 'area', label: 'Area', required: true }, { kind: 'select', name: 'kind', label: 'Kind', options: ['payment', 'authentication', 'authorization', 'tenant_data', 'destructive', 'integration', 'late_change', 'escaped_defect', 'general'].map((k): [string, string] => [k, humanize(k)]) }, { kind: 'select', name: 'level', label: 'Level', options: [['high', 'High'], ['critical', 'Critical'], ['medium', 'Medium'], ['low', 'Low']] }, { kind: 'select', name: 'depth', label: 'Depth', options: [['deep', 'Deep'], ['standard', 'Standard']] }, { kind: 'text', name: 'reason', label: 'Reason', required: true }]} />
                </details>
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Add a test case</summary>
                  <DoorForm door="add_case" projectId={projectId} hidden={{ planId: plan.id }} submit="Add case"
                    fields={[{ kind: 'text', name: 'title', label: 'Title', required: true }, { kind: 'textarea', name: 'criterion', label: 'Acceptance criterion (the observable result)', required: true }, { kind: 'select', name: 'category', label: 'Category', options: CATEGORIES }, { kind: 'select', name: 'priority', label: 'Priority', options: [['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']] }, { kind: 'text', name: 'scopeItemId', label: 'Scope item id (requirement it covers)' }, { kind: 'text', name: 'journey', label: 'Critical journey (for end-to-end cases)' }, { kind: 'textarea', name: 'steps', label: 'Steps' }, { kind: 'textarea', name: 'expected', label: 'Expected result' }]} />
                </details>
                <DoorForm door="approve_plan" projectId={projectId} hidden={{ planId: plan.id }} submit="Approve the plan (Admin)" tone="primary" />
              </>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">No plan yet. Testing does not start without an approved Master Test Plan over a valid intake.</p>
        )}
        {!plan || plan.status !== 'draft' ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">{plan ? 'Create a new plan version' : 'Create the plan'}</summary>
            <DoorForm door="create_plan" projectId={projectId} submit="Create plan" intro="Functional, critical end-to-end and security are mandatory."
              fields={[{ kind: 'checkboxes', name: 'categories', label: 'Required categories', options: CATEGORIES }, { kind: 'textarea', name: 'journeys', label: 'Critical journeys, one per line' }, { kind: 'textarea', name: 'environments', label: 'Environments, one per line' }, { kind: 'text', name: 'dataStrategy', label: 'Test data strategy' }, { kind: 'text', name: 'performanceMethod', label: 'Performance method / target' }]} />
          </details>
        ) : null}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Defects</span>
        {defects.length === 0 ? <p className="text-xs text-muted">None.</p> : (
          <ul className="flex flex-col gap-1">
            {defects.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={d.sLevel !== null && d.sLevel <= 1 ? 'danger' : 'neutral'}>S{d.sLevel ?? '?'}</Badge>
                <Badge tone={d.status === 'verified' ? 'success' : d.status === 'fixed' ? 'warning' : 'danger'}>{humanize(d.status)}</Badge>
                <span>{d.title}</span>
                <span>({humanize(d.classification)}{d.duplicateOf ? ', duplicate of a canonical defect' : ''})</span>
                {d.classification === 'product_defect' && d.status !== 'verified' ? (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Mark duplicate</summary>
                    <DoorForm door="mark_duplicate" projectId={projectId} hidden={{ defectId: d.id }} submit="Link to the canonical defect" intro="Same root cause as another defect: the canonical one keeps this report's evidence."
                      fields={[{ kind: 'select', name: 'canonicalId', label: 'Canonical defect', options: defects.filter((x) => x.id !== d.id && x.classification === 'product_defect').map((x): [string, string] => [x.id, x.title]) }, { kind: 'text', name: 'reason', label: 'Why it is the same defect' }]} />
                  </details>
                ) : null}
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Triage</summary>
                  <DoorForm door="triage" projectId={projectId} hidden={{ defectId: d.id }} submit="Triage" intro="A test, environment or duplicate defect is not a product defect and says why; a new client request becomes a Change Request."
                    fields={[{ kind: 'select', name: 'sLevel', label: 'Severity', options: [['0', 'S0 blocker'], ['1', 'S1 critical'], ['2', 'S2 high'], ['3', 'S3 medium'], ['4', 'S4 low']], defaultValue: String(d.sLevel ?? 2) }, { kind: 'select', name: 'classification', label: 'Classification', options: ['product_defect', 'test_defect', 'environment_defect', 'integration_blocker', 'duplicate', 'needs_clarification', 'change_request', 'not_reproduced'].map((k): [string, string] => [k, humanize(k)]) }, { kind: 'text', name: 'reason', label: 'Reason (required unless a product defect)' }]} />
                </details>
                {d.status === 'open' && d.classification === 'product_defect' ? <DoorForm door="hand_off" projectId={projectId} hidden={{ defectId: d.id }} submit="Hand to Bug Fix" /> : null}
                {d.status === 'fixed' ? (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Independent retest</summary>
                    <DoorForm door="retest" projectId={projectId} hidden={{ defectId: d.id }} submit="Record retest" intro="Retest the FIXED build, not the build the defect was found on. The fixer cannot verify."
                      fields={[{ kind: 'select', name: 'passed', label: 'Retest result', options: [['yes', 'Passed'], ['no', 'Failed (reopens)']] }, { kind: 'text', name: 'retestCommit', label: 'Commit retested', required: true }, { kind: 'text', name: 'retestEvidence', label: 'Evidence link', required: true }]} />
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Release candidate</span>
        {candidate ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span>v{candidate.version}</span>
              <Badge tone={candidate.status === 'approved' ? 'success' : candidate.status === 'blocked' ? 'danger' : candidate.status === 'admin_review' ? 'warning' : 'neutral'}>{humanize(candidate.status)}</Badge>
              <span>commit {candidate.commit}</span>
              <span>artifact {candidate.artifactSha256.slice(0, 12)}…</span>
              {candidate.assessment ? <span>score {candidate.assessment.score} ({humanize(candidate.assessment.band)}) → <strong>{humanize(candidate.assessment.result)}</strong></span> : <span>not yet assessed</span>}
            </div>
            <p className="text-faint">The score is a summary. The gates below decide; a high score cannot hide a failed gate.</p>
            <ul className="flex flex-col gap-1">
              {candidate.gates.map((g) => (
                <li key={g.gate} className="flex flex-wrap items-center gap-2">
                  <Badge tone={g.satisfied ? 'success' : 'danger'}>{g.satisfied ? (g.exceptioned ? 'Excepted' : 'Pass') : 'Fail'}</Badge>
                  <span>{humanize(g.gate)}:</span>
                  <span>{g.detail}</span>
                </li>
              ))}
            </ul>
            <span className="text-faint">Evidence by category (on this exact commit)</span>
            <ul className="flex flex-wrap gap-2">
              {candidate.categories.map((c) => (
                <li key={c.category}>{humanize(c.category)}: <Badge tone={c.status === 'pass' && c.commit === candidate.commit ? 'success' : 'danger'}>{c.commit === candidate.commit ? humanize(c.status) : 'stale'}</Badge></li>
              ))}
            </ul>
            {candidate.exceptions.map((e) => (
              <p key={e.id}>Exception for {humanize(e.gate)}: {humanize(e.status)}, owner {e.owner}, expires {e.expiresAt.slice(0, 10)}
                {e.status === 'requested' ? <DoorForm door="approve_exception" projectId={projectId} hidden={{ exceptionId: e.id }} submit="Approve (owner only)" /> : null}
              </p>
            ))}
            {candidate.reviews.map((r, i) => (<p key={`${i}-${r.decidedAt}`}>Admin: {humanize(r.decision)}{r.note ? ` — ${r.note}` : ''}</p>))}
            {candidate.status === 'draft' || candidate.status === 'blocked' ? (
              <>
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Rollback, monitoring and configuration</summary>
                  <DoorForm door="prerequisites" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Record prerequisites" intro="What Phase 7 needs: the production configuration version, how to roll back (and who), and what is monitored."
                    fields={[{ kind: 'text', name: 'configVersion', label: 'Configuration version', defaultValue: candidate.configVersion ?? '' }, { kind: 'textarea', name: 'rollbackPlan', label: 'Rollback plan', defaultValue: candidate.rollbackPlan ?? '' }, { kind: 'text', name: 'rollbackOwner', label: 'Rollback owner' }, { kind: 'textarea', name: 'observability', label: 'Monitoring, alerts and logs', defaultValue: candidate.observability ?? '' }]} />
                </details>
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Record a category result</summary>
                  <DoorForm door="category_result" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Record" intro="A category passes only when every case of that category passed on this commit. The builder cannot record it."
                    fields={[{ kind: 'select', name: 'category', label: 'Category', options: CATEGORIES }, { kind: 'select', name: 'status', label: 'Result', options: [['pass', 'Pass'], ['fail', 'Fail'], ['blocked', 'Blocked']] }, { kind: 'text', name: 'evidenceRef', label: 'Evidence link' }, { kind: 'text', name: 'reason', label: 'Reason (not a pass)' }]} />
                </details>
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Request a release exception</summary>
                  <DoorForm door="request_exception" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Request" intro="Only performance, compatibility, observability and deployment configuration can be excepted. The owner approves; it expires."
                    fields={[{ kind: 'select', name: 'gate', label: 'Gate', options: [['performance', 'Performance'], ['compatibility', 'Compatibility'], ['observability', 'Observability'], ['deployment_config', 'Deployment configuration']] }, { kind: 'text', name: 'risk', label: 'Risk', required: true }, { kind: 'text', name: 'businessReason', label: 'Business reason', required: true }, { kind: 'text', name: 'mitigation', label: 'Mitigation', required: true }, { kind: 'text', name: 'owner', label: 'Owner', required: true }, { kind: 'text', name: 'containment', label: 'Rollback / containment plan', required: true }, { kind: 'number', name: 'days', label: 'Expires in days (max 90)', defaultValue: '14' }]} />
                </details>
                <DoorForm door="evaluate" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Evaluate readiness" />
                <DoorForm door="submit_review" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Send to Admin review" tone="primary" />
              </>
            ) : null}
            {candidate.status === 'admin_review' ? (
              <DoorForm door="decide" projectId={projectId} hidden={{ candidateId: candidate.id }} submit="Record the Admin's decision" tone="primary" intro="Human authority. Approving re-checks every gate now, for this exact candidate."
                fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['approve', 'Approve this exact candidate'], ['request_retest', 'Request a retest'], ['request_fix', 'Request a fix'], ['block', 'Block']] }, { kind: 'textarea', name: 'note', label: 'Note (required unless approving)' }]} />
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">No candidate yet. A candidate is one exact commit, build and artifact hash.</p>
        )}
        {plan && plan.status === 'approved' && (!candidate || candidate.status === 'superseded') ? (
          <DoorForm door="create_candidate" projectId={projectId} submit="Freeze the release candidate" />
        ) : null}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Can Phase 6 complete?</span>
        {candidate && candidate.status === 'approved' || candidate?.status === 'stale' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>The approved candidate still describes the build:</span>
            <Badge tone={candidateCurrent ? 'success' : 'danger'}>{candidateCurrent ? 'Yes' : 'No: new candidate and approval needed'}</Badge>
            <DoorForm door="reopen_on_change" projectId={projectId} submit="Check for a source change" />
          </div>
        ) : null}
        {phaseSevenIntake ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="success">Completed</Badge>
            <span>Phase 7 intake for commit {phaseSevenIntake.commit}. Deployed to production: {phaseSevenIntake.productionDeployed ? 'yes' : 'no (Phase 7 deploys it)'}.</span>
          </div>
        ) : completion?.outcome === 'ready' ? (
          <>
            <Badge tone="success">Ready to complete</Badge>
            <DoorForm door="complete_phase" projectId={projectId} submit="Complete Phase 6" tone="primary" />
          </>
        ) : (
          <ul className="list-disc pl-5 text-xs text-muted">
            {(completion?.missing ?? []).map((m) => (<li key={m}>{m}</li>))}
          </ul>
        )}
      </section>
    </Card>
  );
}
