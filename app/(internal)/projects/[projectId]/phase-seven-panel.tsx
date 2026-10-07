import type { GateRow, PhaseSevenOverview } from '@/modules/projects/phase-seven-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { SevenForm } from './phase-seven-forms';

/**
 * Phase 7 Overview (P701 §15): the state, the exact candidate, M4, the deployment plan and its gate, the deployment RECORD, production validation, incidents,
 * the handover package, client acceptance, financial clearance, the completion gate and the Phase 8 intake. It renders STORED state and never re-derives a
 * verdict; every form calls a database door that checks role, independence, the exact candidate and the gates, and its refusal is shown as written.
 *
 * HONESTY: no production deployment executor is bound (it needs the owner's production credentials). A deployment shows as APPROVED with its blocker; nothing
 * on this page can mark a deployment started or successful, mark production validated by assertion, or mark the project complete by assertion.
 * INTERNAL: a client sees none of this (the tables are internal-only by policy).
 */

const STATE_TONE: Record<string, Tone> = {
  waiting_phase6: 'warning', waiting_m4_verification: 'warning', phase7_ready: 'info', deployment_planning: 'info', waiting_deployment_approval: 'warning', deploying: 'info', post_deployment_validation: 'warning',
  production_validated: 'success', deployment_failed: 'danger', rollback_in_progress: 'danger', handover_preparing: 'info', admin_handover_review: 'warning', handover_ready: 'info', client_handover_review: 'warning',
  client_action_required: 'warning', client_accepted: 'success', completion_validation: 'info', completed: 'success', phase8_ready: 'success',
};
const TASK_TONE: Record<string, Tone> = { done: 'success', ready: 'info', blocked: 'neutral', failed: 'danger' };
const RUN_TONE: Record<string, Tone> = { passed: 'success', failed: 'danger', blocked: 'warning', running: 'info' };
const TRUTH_TONE: Record<string, Tone> = { passed: 'success', failed: 'danger', not_tested: 'warning' };
const KINDS: [string, string][] = ['environment', 'config_ref', 'secret_ref', 'migration', 'rollback', 'monitoring', 'external_dependency', 'manual_dns', 'manual_store', 'manual_signing', 'manual_account', 'manual_other'].map((k) => [k, humanize(k)]);
const CHECKS: [string, string][] = ['app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'external_integrations', 'monitoring_logging', 'no_critical_runtime_error', 'assets'].map((k) => [k, humanize(k)]);
const INCIDENT_TYPES: [string, string][] = ['deployment_failure', 'config_failure', 'migration_failure', 'runtime_failure', 'security_incident', 'provider_outage', 'data_integrity_risk', 'monitoring_failure'].map((k) => [k, humanize(k)]);
const CATEGORIES: [string, string][] = ['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression'].map((c) => [c, humanize(c)]);
const ITEM_KINDS: [string, string][] = ['scope', 'release', 'production_url', 'known_limitations', 'support_warranty', 'emergency_contacts', 'source_repository', 'deployment_docs', 'config_docs', 'db_docs', 'api_docs', 'admin_guide', 'user_guide', 'invoices_receipts', 'training'].map((k) => [k, humanize(k)]);
const CONTRACT_KINDS: [string, string][] = ['source_repository', 'deployment_docs', 'config_docs', 'db_docs', 'api_docs', 'admin_guide', 'user_guide', 'invoices_receipts', 'training'].map((k) => [k, humanize(k)]);

function Gates({ rows }: { rows: GateRow[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted">No gate has been evaluated yet.</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted">
      {rows.map((g, i) => (
        <li key={`${i}-${g.gate}`} className="flex flex-wrap items-center gap-2">
          <Badge tone={g.satisfied ? 'success' : 'danger'}>{g.satisfied ? 'Satisfied' : 'Not satisfied'}</Badge>
          <span className="font-medium text-foreground">{humanize(g.gate)}</span>
          <span>{g.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2 border-t border-line pt-3">
    <span className="text-xs font-medium uppercase tracking-wide text-faint">{title}</span>
    {children}
  </section>
);

export function PhaseSevenPanel({ view, projectId }: { view: PhaseSevenOverview; projectId: string }) {
  const { workspace, entry, plan, readiness, deploymentGate, approvals, deployments, deploymentEvents, production, validationRuns, incidents, rollbacks, changes, limitations, contract } = view;
  const { handoverPackage, packageVersions, handoverItems, accessTransfers, handoverCompleteness, handoverReviews, acceptances, feedback, finance, financeExceptions, completionGate, completionExceptions, completionRecord, customerSuccessIntake, taskGraph } = view;

  if (!workspace) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Task 5 (Phase 7): Production Launch and Handover</span>
          <Badge tone="neutral">{entry.phaseSixIntake ? 'Not opened' : 'Waiting for Phase 6'}</Badge>
        </div>
        <p className="text-xs text-muted">Phase 7 opens only after Phase 6 completed (the frozen intake), the exact approved candidate is still current, and an Admin has verified the M4 payment in full.</p>
        {entry.phaseSixIntake ? <SevenForm door="open" projectId={projectId} submit="Open Phase 7" /> : null}
      </Card>
    );
  }

  const latest = deployments[0] ?? null;
  const unclosed = incidents.filter((i) => i.state !== 'closed');

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Task 5 (Phase 7): Production Launch and Handover</span>
        <Badge tone={STATE_TONE[workspace.state] ?? 'neutral'}>{humanize(workspace.state)}</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>M4 payment:</span>
        <Badge tone={entry.m4VerifiedPaid ? 'success' : 'warning'}>{entry.m4VerifiedPaid ? 'Verified' : 'Not verified'}</Badge>
        <span>Approved candidate:</span>
        <Badge tone={entry.candidateCurrent ? 'success' : 'danger'}>{entry.candidateCurrent ? 'Current' : 'Not current'}</Badge>
        <span>commit {workspace.commit} · artifact {workspace.artifactSha256.slice(0, 12)}…</span>
        <span>Production:</span>
        <Badge tone={production.validated ? 'success' : 'neutral'}>{production.validated ? 'Validated' : 'Not validated'}</Badge>
      </div>
      {workspace.completionPaused ? <p className="text-xs text-danger">Completion is PAUSED: {workspace.pausedReason}</p> : null}
      {(workspace.state === 'waiting_m4_verification' || workspace.state === 'waiting_phase6') ? <SevenForm door="open" projectId={projectId} submit="Re-check the entry gate" /> : null}

      <Section title="Task graph (derived from the records)">
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {taskGraph.map((t, i) => (
            <li key={`${i}-${t.task}`} className="flex flex-wrap items-center gap-2">
              <Badge tone={TASK_TONE[t.state] ?? 'neutral'}>{humanize(t.state)}</Badge>
              <span className="font-medium text-foreground">{humanize(t.task)}</span>
              <span>{t.detail}</span>
              <span className="text-faint">after {t.dependsOn.map(humanize).join(', ')}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Deployment plan (the exact candidate)">
        {plan ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span>v{plan.version}</span>
              <Badge tone={plan.status === 'approved' ? 'success' : plan.status === 'draft' ? 'warning' : 'neutral'}>{humanize(plan.status)}</Badge>
              <span>target {plan.targetRef}</span>
              <span>commit {plan.commit} · artifact {plan.artifactSha256.slice(0, 12)}…</span>
            </div>
            <p>Rollback: {plan.rollbackStrategy ?? 'none'} · target {plan.rollbackTarget ?? 'UNKNOWN'} · owner {plan.rollbackOwner ?? 'none'}. Monitoring: {plan.monitoringPlan ?? 'none'}.</p>
            <p>Migration: <code>{JSON.stringify(plan.migrationPlan)}</code></p>
            <Gates rows={deploymentGate} />
            <span className="text-faint">Readiness items (configuration and secrets are references BY NAME; no value is ever stored)</span>
            {readiness.length === 0 ? <p>None recorded.</p> : (
              <ul className="flex flex-col gap-1">
                {readiness.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={r.status === 'ready' ? 'success' : r.status === 'blocked_manual_external' ? 'danger' : 'warning'}>{humanize(r.status)}</Badge>
                    <span>{humanize(r.kind)}: {r.name}</span>
                    {r.instruction ? <span>({r.instruction}{r.owner ? `, owner ${r.owner}` : ''})</span> : null}
                    <span>{r.evidenceRef ? `evidence ${r.evidenceRef}` : 'no evidence'}</span>
                  </li>
                ))}
              </ul>
            )}
            {approvals.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {approvals.map((a, i) => (<li key={`${i}-${a.decidedAt}`}>{humanize(a.decision)} on commit {a.commit} at {a.decidedAt}{a.note ? `: ${a.note}` : ''}</li>))}
              </ul>
            ) : null}
            {plan.status === 'draft' ? (
              <details>
                <summary className="cursor-pointer underline underline-offset-2">Add or update a readiness item</summary>
                <SevenForm door="readiness" projectId={projectId} hidden={{ planId: plan.id }} submit="Record" intro="Name only (for example DATABASE_URL). A value, a password or a token is refused."
                  fields={[{ kind: 'select', name: 'kind', label: 'Kind', options: KINDS }, { kind: 'text', name: 'name', label: 'Name', required: true }, { kind: 'select', name: 'status', label: 'Status', options: [['ready', 'Ready (needs evidence)'], ['pending', 'Pending'], ['not_ready', 'Not ready'], ['blocked_manual_external', 'Blocked: manual external step']] },
                    { kind: 'text', name: 'evidenceRef', label: 'Evidence reference (link or ticket)' }, { kind: 'text', name: 'owner', label: 'Owner (manual steps)' }, { kind: 'textarea', name: 'instruction', label: 'Exact instruction (manual steps)' }]} />
              </details>
            ) : null}
            {plan.status === 'draft' ? <SevenForm door="request_approval" projectId={projectId} hidden={{ planId: plan.id }} submit="Request Admin approval" /> : null}
            {plan.status === 'ready_for_approval' ? (
              <SevenForm door="decide_plan" projectId={projectId} hidden={{ planId: plan.id }} submit="Decide" intro="An Admin decides, never the person who built the plan."
                fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['approve', 'Approve this exact commit and artifact'], ['request_changes', 'Request changes'], ['reject', 'Reject']] }, { kind: 'textarea', name: 'note', label: 'Note (required unless approving)' }, { kind: 'yesno', name: 'ackDestructive', label: 'I acknowledge an irreversible migration step' }]} />
            ) : null}
          </div>
        ) : <p className="text-xs text-muted">No deployment plan yet. The plan carries the commit and artifact of the Phase 6 approved candidate; they are resolved, never typed.</p>}
        {(workspace.state !== 'waiting_m4_verification' && workspace.state !== 'waiting_phase6' && workspace.state !== 'completed' && workspace.state !== 'phase8_ready') ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">{plan ? 'Create a new plan version (supersedes the current one)' : 'Create the deployment plan'}</summary>
            <SevenForm door="create_plan" projectId={projectId} submit="Create plan" intro="Production target by name only. Migration steps run in order; an irreversible step needs a backup."
              fields={[{ kind: 'text', name: 'targetRef', label: 'Production target (name)', required: true }, { kind: 'select', name: 'migrationMode', label: 'Migration', options: [['none', 'No migration'], ['steps', 'Ordered steps']] }, { kind: 'text', name: 'migrationReason', label: 'If none: why' },
                { kind: 'textarea', name: 'migrationSteps', label: 'Steps, one per line: name | yes or no (reversible)' }, { kind: 'yesno', name: 'backup', label: 'A backup is taken first' },
                { kind: 'textarea', name: 'rollbackStrategy', label: 'Rollback strategy' }, { kind: 'text', name: 'rollbackTarget', label: 'Rollback target (previous stable version)' }, { kind: 'text', name: 'rollbackOwner', label: 'Rollback owner' },
                { kind: 'textarea', name: 'monitoringPlan', label: 'Monitoring plan' }, { kind: 'text', name: 'maintenanceWindow', label: 'Maintenance window (optional)' }, { kind: 'yesno', name: 'noConfig', label: 'No configuration or secrets are required' }]} />
          </details>
        ) : null}
      </Section>

      <Section title="Deployment record (written only by the runner door)">
        <p className="text-xs text-muted">No production deployment executor is bound: it needs the owner&apos;s production credentials (see docs/phase-7-manual-actions.md). A deployment therefore stays APPROVED with a recorded blocker; this page cannot start, succeed or fabricate one.</p>
        {deployments.length === 0 ? <p className="text-xs text-muted">No deployment has been requested.</p> : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {deployments.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={d.status === 'failed' || d.status === 'rolled_back' ? 'danger' : d.status.endsWith('pending_validation') ? 'warning' : d.status === 'approved' ? 'info' : 'neutral'}>{humanize(d.status)}</Badge>
                <span>attempt {d.attempt}</span><span>executor {humanize(d.executor)}</span><span>commit {d.commit}</span>
                {d.blockerCode ? <span className="text-danger">blocker: {humanize(d.blockerCode)}</span> : null}
                {d.note ? <span>{d.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {deploymentEvents.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {deploymentEvents.map((e, i) => (<li key={`${i}-${e.at}`}>{e.at}: {humanize(e.kind)} {e.from ? `${humanize(e.from)} → ` : ''}{e.to ? humanize(e.to) : ''}{e.blockerCode ? ` (${humanize(e.blockerCode)})` : ''}{e.note ? ` - ${e.note}` : ''}</li>))}
          </ul>
        ) : null}
      </Section>

      <Section title="Production validation (independent, evidenced)">
        <p className="text-xs text-muted">Deployment success is only &ldquo;pending validation&rdquo;. A person who did not execute the deployment records each check with evidence; a failed required check pauses completion and raises an incident.</p>
        {latest ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">Open a validation run for the latest deployment</summary>
            <SevenForm door="open_run" projectId={projectId} hidden={{ deploymentId: latest.id }} submit="Open run"
              fields={[{ kind: 'select', name: 'kind', label: 'Kind', options: [['smoke', 'Smoke'], ['live_journey', 'Live journey'], ['post_rollback', 'After rollback'], ['post_recovery', 'After recovery']] }, { kind: 'text', name: 'incidentId', label: 'Incident id this run verifies (optional)' }]} />
          </details>
        ) : null}
        {validationRuns.length === 0 ? <p className="text-xs text-muted">No validation run yet.</p> : (
          <ul className="flex flex-col gap-2 text-xs text-muted">
            {validationRuns.map((r) => (
              <li key={r.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{humanize(r.status)}</Badge><span>{humanize(r.kind)}</span><span>started {r.startedAt}</span></div>
                <ul className="flex flex-wrap gap-2">
                  {r.checks.map((c) => (<li key={c.key} title={c.detail ?? c.evidenceRef ?? undefined}><Badge tone={TRUTH_TONE[c.truth] ?? 'neutral'}>{humanize(c.key)}: {humanize(c.truth)}</Badge></li>))}
                </ul>
                {r.status === 'running' ? (
                  <div className="flex flex-col gap-2">
                    <SevenForm door="check" projectId={projectId} hidden={{ runId: r.id }} submit="Record a check"
                      fields={[{ kind: 'select', name: 'checkKey', label: 'Check', options: CHECKS }, { kind: 'select', name: 'truth', label: 'Result', options: [['passed', 'Passed (needs evidence)'], ['failed', 'Failed'], ['not_tested', 'Not tested']] }, { kind: 'text', name: 'evidenceRef', label: 'Evidence reference' }, { kind: 'textarea', name: 'detail', label: 'Detail (for a failure or a check not run)' }, { kind: 'yesno', name: 'optionalCheck', label: 'Optional (only integrations and assets)' }]} />
                    <SevenForm door="finish_run" projectId={projectId} hidden={{ runId: r.id }} submit="Finish the run" fields={[{ kind: 'textarea', name: 'summary', label: 'Summary' }]} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Incidents, rollback and the change-after-Phase-6 rule">
        {incidents.length === 0 ? <p className="text-xs text-muted">No incident.</p> : (
          <ul className="flex flex-col gap-2 text-xs text-muted">
            {incidents.map((i) => (
              <li key={i.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={i.severity === 'sev1' ? 'danger' : 'warning'}>{i.severity}</Badge><Badge tone={i.state === 'closed' ? 'success' : 'danger'}>{humanize(i.state)}</Badge><span>{humanize(i.type)}</span><span>path {humanize(i.recoveryPath)}</span></div>
                {i.impact ? <p>{i.impact}</p> : null}
                <ul className="list-disc pl-5">{i.timeline.map((t, n) => (<li key={`${n}-${t.at}`}>{humanize(t.kind)}: {t.note}</li>))}</ul>
                {i.rootCause ? <p>Root cause: {i.rootCause}. Corrective actions: {i.correctiveActions}</p> : null}
                {i.state !== 'closed' ? (
                  <details>
                    <summary className="cursor-pointer underline underline-offset-2">Work this incident</summary>
                    <div className="flex flex-col gap-2">
                      <SevenForm door="classify_incident" projectId={projectId} hidden={{ incidentId: i.id }} submit="Classify" fields={[{ kind: 'select', name: 'path', label: 'Recovery path', options: [['config', 'Configuration fix (same candidate)'], ['provider', 'Provider outage'], ['rollback', 'Rollback'], ['code', 'Code fix (new build, new candidate)']] }, { kind: 'textarea', name: 'note', label: 'Note' }]} />
                      <SevenForm door="incident_action" projectId={projectId} hidden={{ incidentId: i.id }} submit="Record an action" fields={[{ kind: 'select', name: 'kind', label: 'Kind', options: [['containment', 'Containment'], ['note', 'Note'], ['signal', 'Signal'], ['recovery', 'Recovery']] }, { kind: 'textarea', name: 'note', label: 'What happened', required: true }, { kind: 'text', name: 'evidenceRef', label: 'Evidence reference' }]} />
                      <SevenForm door="decide_rollback" projectId={projectId} hidden={{ incidentId: i.id }} submit="Decide rollback" intro="An Admin decides, with a named target. An irreversible migration is never rolled back blind."
                        fields={[{ kind: 'text', name: 'targetRef', label: 'Rollback target (a named version)' }, { kind: 'textarea', name: 'risk', label: 'Risk', required: true }, { kind: 'select', name: 'decision', label: 'Decision', options: [['approve', 'Approve'], ['reject', 'Reject']] }, { kind: 'textarea', name: 'reason', label: 'Reason (required to reject)' }, { kind: 'yesno', name: 'ackIrreversible', label: 'I acknowledge the data implication of an irreversible migration' }]} />
                      <SevenForm door="close_incident" projectId={projectId} hidden={{ incidentId: i.id }} submit="Close after verified recovery" intro="Closes only when a passed re-validation tied to this incident exists."
                        fields={[{ kind: 'textarea', name: 'rootCause', label: 'Root cause', required: true }, { kind: 'textarea', name: 'timeline', label: 'Timeline summary' }, { kind: 'textarea', name: 'correctiveActions', label: 'Corrective actions', required: true }]} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {rollbacks.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted">{rollbacks.map((r) => (<li key={r.id}>{humanize(r.decision)} rollback to {r.target} ({r.risk}){r.executedAt ? `, executed ${r.executedAt}` : ', not executed'}</li>))}</ul>
        ) : null}
        {changes.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted">{changes.map((c) => (<li key={c.id}><Badge tone={c.status === 'open' ? 'warning' : 'success'}>{humanize(c.status)}</Badge> {humanize(c.kind)}: {c.description}</li>))}</ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {latest ? (
            <details>
              <summary className="cursor-pointer text-xs underline underline-offset-2">Raise an incident</summary>
              <SevenForm door="raise_incident" projectId={projectId} hidden={{ deploymentId: latest.id }} submit="Raise" fields={[{ kind: 'select', name: 'type', label: 'Type', options: INCIDENT_TYPES }, { kind: 'select', name: 'severity', label: 'Severity', options: [['sev1', 'Sev 1'], ['sev2', 'Sev 2'], ['sev3', 'Sev 3']] }, { kind: 'textarea', name: 'impact', label: 'Impact' }, { kind: 'textarea', name: 'note', label: 'What was observed', required: true }]} />
            </details>
          ) : null}
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">Record a change after Phase 6</summary>
            <SevenForm door="change" projectId={projectId} submit="Record" intro="A code change voids the plan and needs a NEW approved candidate; a config-only change needs a re-smoke of the same candidate."
              fields={[{ kind: 'select', name: 'kind', label: 'Kind', options: [['config_only', 'Configuration only'], ['code_change', 'Code change']] }, { kind: 'textarea', name: 'description', label: 'What changes', required: true }, { kind: 'checkboxes', name: 'categories', label: 'Affected test categories', options: CATEGORIES }]} />
          </details>
          <SevenForm door="rebind" projectId={projectId} submit="Bind the new approved candidate" intro="Only a new Admin-approved candidate with every Phase 6 gate satisfied is bound." />
        </div>
      </Section>

      <Section title="Known limitations (the handover must disclose every one)">
        {limitations.length === 0 ? <p className="text-xs text-muted">None recorded.</p> : (
          <ul className="list-disc pl-5 text-xs text-muted">{limitations.map((l) => (<li key={l.id}>{l.title} ({humanize(l.source)})</li>))}</ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Record a limitation</summary>
          <SevenForm door="limitation" projectId={projectId} submit="Record" fields={[{ kind: 'text', name: 'title', label: 'Limitation', required: true }, { kind: 'textarea', name: 'detail', label: 'Detail' }]} />
        </details>
      </Section>

      <Section title="Handover package (structured and versioned)">
        {contract.length === 0 ? <p className="text-xs text-muted">The contractual deliverables are not recorded yet.</p> : (
          <ul className="flex flex-wrap gap-2 text-xs text-muted">{contract.map((c) => (<li key={c.kind}><Badge tone={c.required ? 'info' : 'neutral'}>{humanize(c.kind)}: {c.required ? 'required' : `not required (${c.exclusionReason})`}</Badge></li>))}</ul>
        )}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Record a contractual deliverable</summary>
          <SevenForm door="contract" projectId={projectId} submit="Record" fields={[{ kind: 'select', name: 'kind', label: 'Deliverable', options: CONTRACT_KINDS }, { kind: 'text', name: 'label', label: 'Label', required: true }, { kind: 'yesno', name: 'required', label: 'Required by the contract' }, { kind: 'text', name: 'exclusionReason', label: 'If not required: why' }]} />
        </details>
        {handoverPackage ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span>v{handoverPackage.version}</span>
              <Badge tone={handoverPackage.status === 'approved' || handoverPackage.status === 'delivered' ? 'success' : 'warning'}>{humanize(handoverPackage.status)}</Badge>
              <span>release {handoverPackage.commit}</span>
              <span>{packageVersions.length} version(s) preserved</span>
            </div>
            <p>URL {handoverPackage.productionUrl ?? 'not set'} · warranty ends {handoverPackage.warrantyEndsOn ?? 'not set'} · contacts {handoverPackage.emergencyContacts ?? 'not set'}</p>
            <p>Support terms: {handoverPackage.supportTerms ?? 'not set'}</p>
            <Gates rows={handoverCompleteness} />
            <ul className="flex flex-col gap-1">
              {handoverItems.map((i) => (
                <li key={i.kind} className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.status === 'ready' ? 'success' : i.status === 'not_required' ? 'neutral' : 'warning'}>{humanize(i.status)}</Badge>
                  <span>{i.label}</span><span>{i.artifactRef ?? i.reason ?? ''}</span>
                </li>
              ))}
            </ul>
            <span className="text-faint">Access transfer (a receipt: method, status, evidence reference - never a secret value)</span>
            {accessTransfers.length === 0 ? <p>No access-transfer record.</p> : (
              <ul className="flex flex-col gap-1">{accessTransfers.map((t) => (<li key={t.system}><Badge tone={t.status === 'completed' || t.status === 'not_applicable' ? 'success' : 'warning'}>{humanize(t.status)}</Badge> {t.system} ({humanize(t.kind)}, {humanize(t.method)}){t.rotated ? ', credentials rotated' : ''}{t.supportRetained ? ', support access retained (Admin-authorized)' : ''}{t.evidenceRef ? `, evidence ${t.evidenceRef}` : ''}</li>))}</ul>
            )}
            {handoverPackage.status === 'draft' ? (
              <div className="flex flex-col gap-2">
                <details>
                  <summary className="cursor-pointer underline underline-offset-2">Edit the package details and items</summary>
                  <div className="flex flex-col gap-2">
                    <SevenForm door="update_package" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Save details" fields={[{ kind: 'text', name: 'productionUrl', label: 'Production URL', defaultValue: handoverPackage.productionUrl ?? '' }, { kind: 'textarea', name: 'supportTerms', label: 'Support and warranty terms', defaultValue: handoverPackage.supportTerms ?? '' }, { kind: 'date', name: 'warrantyEndsOn', label: 'Warranty ends on', defaultValue: handoverPackage.warrantyEndsOn ?? '' }, { kind: 'textarea', name: 'emergencyContacts', label: 'Emergency and support contacts', defaultValue: handoverPackage.emergencyContacts ?? '' }]} />
                    <SevenForm door="set_item" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Mark an item" fields={[{ kind: 'select', name: 'kind', label: 'Item', options: ITEM_KINDS }, { kind: 'select', name: 'status', label: 'Status', options: [['ready', 'Ready (needs a reference)'], ['pending', 'Pending']] }, { kind: 'text', name: 'artifactRef', label: 'Reference (link or file id; never a secret)' }, { kind: 'text', name: 'evidenceRef', label: 'Evidence' }]} />
                    <SevenForm door="access_transfer" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Record an access transfer" intro="Record THAT access was transferred and HOW. Never type a password, key or token."
                      fields={[{ kind: 'text', name: 'system', label: 'System (name)', required: true }, { kind: 'select', name: 'kind', label: 'Kind', options: [['repository_ownership', 'Repository ownership'], ['hosting_account', 'Hosting account'], ['domain', 'Domain'], ['database', 'Database'], ['third_party_account', 'Third-party account'], ['signing_key', 'Signing key'], ['other', 'Other']] },
                        { kind: 'select', name: 'method', label: 'Method', options: [['password_manager_share', 'Password manager share'], ['ownership_transfer', 'Ownership transfer'], ['sealed_envelope', 'Sealed envelope'], ['in_person_or_call', 'In person or call'], ['provider_invite', 'Provider invite'], ['not_applicable', 'Not applicable']] },
                        { kind: 'select', name: 'status', label: 'Status', options: [['planned', 'Planned'], ['in_progress', 'In progress'], ['completed', 'Completed (needs evidence)'], ['blocked', 'Blocked'], ['not_applicable', 'Not applicable (needs a note)']] },
                        { kind: 'text', name: 'fromParty', label: 'From' }, { kind: 'text', name: 'toParty', label: 'To' }, { kind: 'text', name: 'evidenceRef', label: 'Evidence reference (ticket or share id)' }, { kind: 'yesno', name: 'rotated', label: 'Temporary credentials rotated' },
                        { kind: 'yesno', name: 'supportRetained', label: 'Support access retained' }, { kind: 'yesno', name: 'supportAuthorized', label: 'An Admin authorized retained support access' }, { kind: 'text', name: 'note', label: 'Note' }]} />
                  </div>
                </details>
                <SevenForm door="submit_package" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Submit for Admin review" intro="Discloses every known limitation and runs the completeness check." />
              </div>
            ) : null}
            {handoverPackage.status === 'admin_review' ? (
              <SevenForm door="decide_package" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Decide" intro="Only an Admin-approved version reaches the client. An edit creates a NEW version."
                fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['approve', 'Approve this exact version'], ['edit_requested', 'Request edits']] }, { kind: 'textarea', name: 'note', label: 'Note (required to request edits)' }]} />
            ) : null}
            {(handoverPackage.status === 'changes_requested' || handoverPackage.status === 'delivered') ? <SevenForm door="revise_package" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Create a corrected version" /> : null}
            {handoverPackage.status === 'approved' ? <SevenForm door="deliver_package" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Deliver to the client" fields={[{ kind: 'text', name: 'channel', label: 'Channel (for example client portal)', required: true }]} /> : null}
            {handoverReviews.length > 0 ? <ul className="flex flex-col gap-1">{handoverReviews.map((r, i) => (<li key={`${i}-${r.decidedAt}`}>Admin review of v{r.version}: {humanize(r.decision)}{r.note ? ` - ${r.note}` : ''}</li>))}</ul> : null}
          </div>
        ) : (
          <SevenForm door="create_package" projectId={projectId} submit="Create the handover package" intro="Needs ProductionValidated, M4 verified and the contractual deliverable list."
            fields={[{ kind: 'text', name: 'productionUrl', label: 'Production URL' }, { kind: 'textarea', name: 'supportTerms', label: 'Support and warranty terms' }, { kind: 'date', name: 'warrantyEndsOn', label: 'Warranty ends on' }, { kind: 'textarea', name: 'emergencyContacts', label: 'Emergency and support contacts' }]} />
        )}
      </Section>

      <Section title="Client acceptance and handover feedback (staff record; the client accepts)">
        {acceptances.length === 0 ? <p className="text-xs text-muted">No formal acceptance is recorded. An informal &ldquo;looks good&rdquo; is not acceptance.</p> : (
          <ul className="flex flex-col gap-1 text-xs text-muted">{acceptances.map((a, i) => (<li key={`${i}-${a.recordedAt}`}><Badge tone={a.decision === 'accepted' ? 'success' : 'warning'}>{humanize(a.decision)}</Badge> v{a.version} by {a.client} ({humanize(a.evidenceKind)}: {a.evidenceRef})</li>))}</ul>
        )}
        {handoverPackage && handoverPackage.status === 'delivered' ? (
          <SevenForm door="acceptance" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Record the client's decision on this exact version"
            fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['accepted', 'Accepted'], ['changes_requested', 'Changes requested'], ['disputed', 'Disputed']] }, { kind: 'select', name: 'evidenceKind', label: 'Evidence', options: [['signed_document', 'Signed document'], ['portal_confirmation', 'Portal confirmation'], ['email_reply', 'Email reply'], ['recorded_call', 'Recorded call'], ['meeting_minutes', 'Meeting minutes']] },
              { kind: 'text', name: 'evidenceRef', label: 'Evidence reference', required: true }, { kind: 'text', name: 'clientName', label: 'Client name', required: true }, { kind: 'textarea', name: 'note', label: 'Note' }]} />
        ) : null}
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {feedback.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2"><Badge tone={f.status === 'open' ? 'warning' : 'success'}>{humanize(f.status)}</Badge><span>{humanize(f.classification)} → {humanize(f.route)}: {f.body}</span>
              {f.status === 'open' ? (
                <details><summary className="cursor-pointer underline underline-offset-2">Resolve</summary><SevenForm door="resolve_feedback" projectId={projectId} hidden={{ feedbackId: f.id }} submit="Resolve" fields={[{ kind: 'textarea', name: 'resolution', label: 'Resolution', required: true }]} /></details>
              ) : <span>{f.resolution}</span>}
            </li>
          ))}
        </ul>
        {handoverPackage ? (
          <details>
            <summary className="cursor-pointer text-xs underline underline-offset-2">Record client feedback</summary>
            <SevenForm door="feedback" projectId={projectId} hidden={{ packageId: handoverPackage.id }} submit="Classify and record" intro="A correction, a defect, a change and a question are routed differently. Never record a secret."
              fields={[{ kind: 'select', name: 'classification', label: 'Classification', options: [['handover_correction', 'Handover correction'], ['production_defect', 'Production defect'], ['clarification', 'Clarification'], ['new_feature', 'New feature'], ['scope_change', 'Scope change'], ['access_issue', 'Access issue'], ['support_question', 'Support question']] }, { kind: 'textarea', name: 'body', label: 'What the client said', required: true }]} />
          </details>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Admin: acceptance policy</summary>
          <SevenForm door="acceptance_policy" projectId={projectId} submit="Set" intro={`Formal acceptance is ${workspace.clientAcceptanceRequired ? 'REQUIRED' : `waived (${workspace.acceptanceWaiverReason})`}. Waiving needs a reason.`} fields={[{ kind: 'yesno', name: 'waive', label: 'Waive formal acceptance' }, { kind: 'textarea', name: 'reason', label: 'Reason' }]} />
        </details>
      </Section>

      <Section title="Final financial clearance (read from finance records; Finance does not complete the project)">
        <Gates rows={finance} />
        {financeExceptions.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {financeExceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2"><Badge tone={e.status === 'open' ? 'danger' : 'success'}>{humanize(e.status)}</Badge><span>{humanize(e.kind)}: {e.note}</span>
                {e.status === 'open' ? <details><summary className="cursor-pointer underline underline-offset-2">Decide (Admin)</summary><SevenForm door="finance_decide" projectId={projectId} hidden={{ exceptionId: e.id }} submit="Decide" fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['resolved', 'Resolved'], ['waived', 'Waived (needs evidence)']] }, { kind: 'textarea', name: 'resolution', label: 'Resolution', required: true }, { kind: 'text', name: 'evidenceRef', label: 'Waiver evidence' }]} /></details> : <span>{e.resolution}</span>}
              </li>
            ))}
          </ul>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Open a financial exception</summary>
          <SevenForm door="finance_open" projectId={projectId} submit="Open" fields={[{ kind: 'select', name: 'kind', label: 'Kind', options: [['balance_outstanding', 'Balance outstanding'], ['refund_pending', 'Refund pending'], ['dispute', 'Dispute'], ['chargeback', 'Chargeback'], ['adjustment', 'Adjustment']] }, { kind: 'textarea', name: 'note', label: 'What happened', required: true }]} />
        </details>
      </Section>

      <Section title="Completion gate">
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {completionGate.map((g, i) => (
            <li key={`${i}-${g.gate}`} className="flex flex-wrap items-center gap-2">
              <Badge tone={g.passed ? 'success' : g.excepted ? 'warning' : 'danger'}>{g.passed ? 'Passed' : g.excepted ? 'Excepted by an Admin' : 'Not satisfied'}</Badge>
              <span className="font-medium text-foreground">{humanize(g.gate)}</span><span>{g.detail}</span>
            </li>
          ))}
        </ul>
        {completionExceptions.length > 0 ? <ul className="list-disc pl-5 text-xs text-muted">{completionExceptions.map((e, i) => (<li key={`${i}-${e.approvedAt}`}>Admin exception on {humanize(e.gate)}: {e.reason} (risk: {e.risk})</li>))}</ul> : null}
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">Admin: approve a completion exception (scope or client acceptance only)</summary>
          <SevenForm door="completion_exception" projectId={projectId} submit="Approve" fields={[{ kind: 'select', name: 'gate', label: 'Gate', options: [['scope_complete', 'Scope complete'], ['client_acceptance', 'Client acceptance']] }, { kind: 'textarea', name: 'reason', label: 'Reason', required: true }, { kind: 'textarea', name: 'risk', label: 'Risk', required: true }]} />
        </details>
        {completionRecord ? (
          <div className="flex flex-col gap-1 text-xs text-muted">
            <p><Badge tone="success">Completed</Badge> The immutable completion record {completionRecord.id.slice(0, 8)} was written at {completionRecord.completedAt} for commit {completionRecord.commit}.</p>
            <p>{customerSuccessIntake ? `The Customer Success intake (Phase 8) is frozen and ready: warranty ends ${customerSuccessIntake.warrantyEndsOn ?? 'not set'}.` : 'No Customer Success intake exists.'}</p>
          </div>
        ) : (
          <SevenForm door="complete" projectId={projectId} submit="Complete the project" tone="primary" intro="Completes only when the gate passes. Deployment success alone, payment alone, or a casual approval is not completion." />
        )}
        {unclosed.length > 0 ? <p className="text-xs text-danger">{unclosed.length} incident(s) are open: completion stays paused until each is closed after verified recovery.</p> : null}
      </Section>
    </Card>
  );
}
