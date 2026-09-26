import Link from 'next/link';

import type { PhaseFourOverview } from '@/modules/projects/queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

/**
 * Phase 4 Overview — Impl §10; Master's own Admin Panel checklist ("WHAT IS
 * CURRENT? WHAT VERSION? WHAT BUILD? ... IS M2 VERIFIED? CAN PHASE 5
 * START?"). `docs/phase-4-gap-analysis.md` step 7.
 *
 * Read-only in this pass, the same discipline `phase-two-panel.tsx` keeps
 * for its own gate: this renders the STORED state and QA findings; it never
 * re-derives them. Every write path this panel describes (share with
 * client, record a client decision, lock, approve) is a real, tested door
 * already — `projects.share_ui_version_with_client`,
 * `projects.record_ui_version_client_decision`, `projects.lock_ui_version`
 * — reachable via API/psql today, without a form on this page yet. Building
 * those forms is real, separate frontend work, named here rather than
 * silently assumed done.
 */

const WORKSPACE_TONE: Record<string, Tone> = {
  not_started: 'neutral',
  task2_started: 'info',
  ui_design: 'info',
  ui_review: 'warning',
  ui_locked: 'success',
  prototype_build: 'info',
  prototype_review: 'warning',
  prototype_locked: 'success',
  completed: 'success',
  waiting_client: 'warning',
  waiting_admin: 'warning',
  waiting_designer: 'warning',
  waiting_prototype: 'warning',
  blocked_requirement: 'danger',
  scope_escalation: 'danger',
  revision_limit_escalation: 'danger',
};

const UI_VERSION_TONE: Record<string, Tone> = {
  draft: 'neutral',
  qa_review: 'info',
  qa_changes_required: 'danger',
  qa_pass: 'success',
  admin_review: 'info',
  admin_edit: 'danger',
  admin_approved: 'success',
  client_review: 'info',
  client_change: 'danger',
  client_approved: 'success',
  locked: 'success',
};

const GATE_TONE: Record<string, Tone> = {
  verified: 'success',
  invoice_issued: 'warning',
  not_ready: 'neutral',
  no_m2_milestone: 'neutral',
};

const GATE_LABEL: Record<string, string> = {
  verified: 'M2 verified — Phase 5 eligible',
  invoice_issued: 'M2 invoice issued, not yet Admin-verified',
  not_ready: 'M2 not yet invoiced',
  no_m2_milestone: 'No M2 milestone on this project\'s payment plan',
};

export function PhaseFourPanel({ view }: { view: PhaseFourOverview }) {
  if (!view.workspace) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted">Task 2 (Phase 4) has not started for this project yet.</p>
      </Card>
    );
  }

  const { workspace, uiVersion, prototype, phaseFiveGate } = view;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Task 2 (Phase 4)</span>
        <Badge tone={WORKSPACE_TONE[workspace.state] ?? 'neutral'}>{humanize(workspace.state)}</Badge>
      </div>
      {workspace.blockedReason ? <p className="text-xs text-danger">{workspace.blockedReason}</p> : null}

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">UI version</span>
        {uiVersion ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={UI_VERSION_TONE[uiVersion.status] ?? 'neutral'}>{humanize(uiVersion.status)}</Badge>
              <span className="text-xs text-muted">{uiVersion.screenCount} screen(s)</span>
            </div>
            {uiVersion.qaFindings ? (
              <QaFindingsList
                items={[
                  ...(uiVersion.qaFindings.missingScreens ?? []).map((s) => `missing screen: ${s}`),
                  ...(uiVersion.qaFindings.stateGaps ?? []),
                ]}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">No UI version drafted yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Prototype</span>
        {prototype ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">v{prototype.version}</span>
              <Badge tone={UI_VERSION_TONE[prototype.deliverableStatus] ?? 'neutral'}>
                {humanize(prototype.deliverableStatus)}
              </Badge>
              {prototype.artifactUrl ? (
                <Link
                  href={prototype.artifactUrl}
                  className="text-xs underline underline-offset-2"
                >
                  Open preview
                </Link>
              ) : null}
            </div>
            {prototype.qaFindings ? (
              <QaFindingsList
                items={[
                  ...(prototype.qaFindings.missingScreens ?? []).map((s) => `missing screen: ${s}`),
                  ...(prototype.qaFindings.brokenRoutes ?? []).map((s) => `broken route: ${s}`),
                ]}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">No prototype build yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Phase 5 gate (M2)</span>
        {phaseFiveGate ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={GATE_TONE[phaseFiveGate.outcome] ?? 'neutral'}>
              {GATE_LABEL[phaseFiveGate.outcome] ?? humanize(phaseFiveGate.outcome)}
            </Badge>
            {phaseFiveGate.invoiceId ? (
              <Link href={`/invoices/${phaseFiveGate.invoiceId}`} className="text-xs underline underline-offset-2">
                View M2 invoice
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">This project has no M2 milestone.</p>
        )}
      </section>
    </Card>
  );
}

function QaFindingsList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="ml-4 list-disc text-xs text-danger">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
