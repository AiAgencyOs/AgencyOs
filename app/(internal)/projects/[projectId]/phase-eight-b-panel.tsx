import type { PhaseEightBView, WorkItemView } from '@/modules/projects/phase-eight-b-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import {
  AskAgentForm, AskFinanceForm, CancelWorkForm, DecideBillingForm, DecideProposalForm, DecideReleaseForm, LinkInvoiceForm, OpenWorkForm, QaResultForm,
  RecordReleaseForm, RequestReleaseForm, RouteForm, SlaPolicyForm, SubmitFixForm,
} from './phase-eight-b-forms';

/**
 * Post-launch maintenance (Phase 8 part B), from the STORED state. A change is tied to what authorizes it and to ONE exact commit; independent QA
 * results count only for that commit; a release needs its own Admin approval from someone who did not open, build or request it. Agents only propose.
 * Nothing here deploys, merges, sends to a client, creates an invoice or verifies a payment. Not run against a real model.
 */

const STATUS_TONE: Record<string, Tone> = { open: 'neutral', fix_submitted: 'info', changes_requested: 'warning', qa_passed: 'success', release_review: 'info', release_approved: 'success', released: 'success', cancelled: 'neutral' };
const PRIORITY_TONE: Record<string, Tone> = { p0: 'danger', p1: 'warning', p2: 'info', p3: 'neutral' };
const SLA_TONE: Record<string, Tone> = { ok: 'success', at_risk: 'warning', breached: 'danger', unknown: 'neutral' };

function Item({ projectId, i }: { projectId: string; i: WorkItemView }) {
  const live = !['released', 'cancelled'].includes(i.status);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground">{i.title}</span>
        <Badge tone="neutral">{humanize(i.kind)}</Badge>
        <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{humanize(i.status)}</Badge>
        <Badge tone={PRIORITY_TONE[i.priority] ?? 'neutral'}>{i.priority.toUpperCase()}</Badge>
        <Badge tone={SLA_TONE[i.sla.state] ?? 'neutral'}>{i.sla.state === 'unknown' ? 'SLA unknown' : `SLA ${humanize(i.sla.state)}`}</Badge>
        {i.emergency ? <Badge tone="danger">Emergency</Badge> : null}
        {i.sensitive ? <Badge tone="warning">Security-sensitive</Badge> : null}
      </div>
      <span className="text-muted">Commit: {i.commitRef ?? 'none submitted yet'}{i.sla.state === 'unknown' ? ` - ${i.sla.reason}` : ` - due ${i.sla.resolutionDueAt}`}</span>
      {i.fixSummary ? <span className="text-muted">Change: {i.fixSummary}</span> : null}
      <ul className="flex flex-col gap-0.5">
        {i.gates.map((g) => (
          <li key={g.gate} className="flex gap-2"><Badge tone={g.passed ? 'success' : 'warning'}>{g.passed ? 'Holds' : 'Open'}</Badge><span className="text-muted">{humanize(g.gate)}: {g.detail}</span></li>
        ))}
      </ul>
      {i.qaResults.length > 0 ? (
        <span className="text-muted">QA: {i.qaResults.slice(0, 6).map((r) => `${r.category} ${r.status} on ${r.commit.slice(0, 8)}`).join('; ')}</span>
      ) : null}
      <div className="rounded-md border border-line p-2">
        <span className="text-foreground">Orchestrator</span>
        <p className="text-muted">Now: {humanize(i.recommendation?.outcome ?? 'unknown')}. {i.recommendation?.reason}</p>
        {i.routing ? (
          <>
            <p className="text-muted">Recorded: {humanize(i.routing.outcome)}{i.routing.toAgent ? ` to ${humanize(i.routing.toAgent)}` : ''}. {i.routing.reason}</p>
            <p className="text-muted">Independent checkers: {i.routing.independentQa.map(humanize).join(', ') || 'none named'}. Candidates: {i.routing.candidates.filter((c) => !c.eligible).slice(0, 4).map((c) => `${c.agent} (${c.rejected})`).join('; ')}</p>
          </>
        ) : null}
        {live ? <RouteForm projectId={projectId} workItemId={i.id} /> : null}
      </div>
      {i.proposals.map((p) => (
        <div key={p.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
          <div className="flex flex-wrap items-center gap-2"><span className="text-foreground">{humanize(p.agent)}: {humanize(p.kind)}</span><Badge tone="warning">Proposal, not a result</Badge>
            {p.needsScopeChange ? <Badge tone="danger">Says this is new scope: raise a Change Request</Badge> : null}
            {p.decision ? <Badge tone={p.decision.decision === 'accepted' ? 'success' : 'danger'}>{humanize(p.decision.decision)}</Badge> : <Badge tone="info">Awaiting a person</Badge>}</div>
          <span className="text-foreground">{p.summary}</span>
          <ol className="list-decimal pl-5 text-muted">{p.steps.map((s, n) => <li key={`${p.id}-s${n}`}>{s}</li>)}</ol>
          {p.risks.length ? <span className="text-muted">Risks: {p.risks.join('; ')}</span> : null}
          {!p.decision ? <DecideProposalForm projectId={projectId} proposalId={p.id} canDecide={!p.viewerAsked} /> : null}
        </div>
      ))}
      {live ? <AskAgentForm projectId={projectId} workItemId={i.id} hasCommit={i.commitRef !== null} /> : null}
      {['open', 'fix_submitted', 'changes_requested', 'qa_passed', 'release_review'].includes(i.status) ? <SubmitFixForm projectId={projectId} workItemId={i.id} /> : null}
      {i.commitRef && ['fix_submitted', 'changes_requested', 'qa_passed', 'release_review'].includes(i.status) ? <QaResultForm projectId={projectId} workItemId={i.id} commit={i.commitRef} sensitive={i.sensitive} /> : null}
      {i.status === 'qa_passed' ? <RequestReleaseForm projectId={projectId} workItemId={i.id} /> : null}
      {i.status === 'release_review' ? <DecideReleaseForm projectId={projectId} workItemId={i.id} canDecide={!i.viewerIsAuthor} /> : null}
      {i.status === 'release_approved' ? <RecordReleaseForm projectId={projectId} workItemId={i.id} /> : null}
      {['open', 'fix_submitted', 'changes_requested', 'qa_passed', 'release_review'].includes(i.status) ? <CancelWorkForm projectId={projectId} workItemId={i.id} /> : null}
    </li>
  );
}

export function PhaseEightBPanel({ projectId, view }: { projectId: string; view: PhaseEightBView }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Post-launch maintenance</span>
        <Badge tone="warning">Agents propose; people decide</Badge>
      </div>
      <OpenWorkForm projectId={projectId} tickets={view.openable.tickets} defects={view.openable.defects} changeRequests={view.openable.changeRequests} />
      {view.items.length === 0 ? <p className="text-[13px] text-muted">No maintenance work has been opened for this project.</p> : <ul className="flex flex-col gap-3">{view.items.map((i) => <Item key={i.id} projectId={projectId} i={i} />)}</ul>}

      <div className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
        <span className="text-foreground">SLA policy (set by an Admin; none is assumed)</span>
        {view.slaPolicies.length === 0 ? <p className="text-muted">No policy is set, so every SLA shows as unknown and nothing is called late.</p> : (
          <ul className="text-muted">{view.slaPolicies.map((p) => <li key={`${p.priority}-${p.version}`}>{p.priority.toUpperCase()} v{p.version}: respond within {p.responseHours}h, resolve within {p.resolutionHours}h{p.atRiskPercent !== null ? `, at risk from ${p.atRiskPercent}%` : ''}</li>)}</ul>
        )}
        <SlaPolicyForm projectId={projectId} />
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-line p-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2"><span className="text-foreground">Maintenance billing</span><Badge tone="warning">Drafts only: no invoice, no send, no payment verification</Badge></div>
        <ul className="flex flex-col gap-1">
          {view.plans.map((p) => <li key={p.planId} className="text-muted">Plan {p.name} ({humanize(p.status)}): financial gate {humanize(p.gateState)}. {p.gateDetail}</li>)}
        </ul>
        <AskFinanceForm projectId={projectId} plans={view.openable.plans} invoices={view.openable.invoices} />
        {view.billing.map((b) => (
          <div key={b.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
            <div className="flex flex-wrap items-center gap-2"><span className="text-foreground">{humanize(b.kind)}</span>{b.decision ? <Badge tone={b.decision.decision === 'accepted' ? 'success' : 'danger'}>{humanize(b.decision.decision)}</Badge> : <Badge tone="info">Awaiting a person</Badge>}</div>
            {b.totalMinor !== null ? <span className="text-muted">Quoted total (copied from the accepted quote, not from the agent): {b.currency} {(b.totalMinor / 100).toFixed(2)}</span> : null}
            {b.balanceMinor !== null ? <span className="text-muted">Outstanding on verified money: {b.currency} {(b.balanceMinor / 100).toFixed(2)}</span> : null}
            {b.lines.length ? <ul className="text-muted">{b.lines.map((l, n) => <li key={`${b.id}-l${n}`}>{l.description} x{l.quantity}</li>)}</ul> : null}
            {b.narrative ? <span className="text-foreground">{b.narrative}</span> : null}
            {b.reminderText ? <span className="text-foreground">Reminder text (a person sends it): {b.reminderText}</span> : null}
            {!b.decision ? <DecideBillingForm projectId={projectId} proposalId={b.id} canDecide={!b.viewerAsked} invoices={view.openable.invoices} linkable={b.kind !== 'payment_reminder'} /> : null}
          </div>
        ))}
        {view.openable.plans.length > 0 && view.openable.invoices.length > 0 ? <LinkInvoiceForm projectId={projectId} plans={view.openable.plans} invoices={view.openable.invoices} /> : null}
      </div>
    </Card>
  );
}
