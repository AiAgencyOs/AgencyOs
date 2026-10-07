import type { PhaseEightCView, PlanLifecycleView } from '@/modules/projects/phase-eight-c-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import {
  AckBreachForm, AcceptanceForm, ActivateForm, CancellationDecisionForm, CancellationRequestForm, CatalogVersionForm, ConfirmRenewalForm, DataSafetyForm, OpenPlanForm, OverageForm,
  PriceLineForm, ProposeRenewalForm, PublishCatalogForm, RenewalDecisionForm, StallPolicyForm, UsageForm,
} from './phase-eight-c-forms';

/**
 * The maintenance plan lifecycle (Phase 8 part C), from the STORED state. A plan is active only when its first cycle is paid on VERIFIED money (or an
 * owner-approved, expiring exception stands in); a renewal is proposed by a person, accepted by the client (recorded by staff against a reference), paid and
 * confirmed by another Admin; overage is a DRAFT a person quotes; cancellation needs a reason. Nothing here invents a price, bills, quotes, refunds,
 * verifies a payment or sends anything to a client.
 */

const STATUS_TONE: Record<string, Tone> = { draft: 'neutral', active: 'success', renewed: 'success', renewal_approaching: 'warning', renewal_proposed: 'info', at_risk: 'danger', expired: 'neutral', cancelled: 'neutral', declined: 'neutral', paused: 'warning', pending_client: 'info' };
const GATE_TONE: Record<string, Tone> = { verified_paid: 'success', exception_approved: 'warning', not_billed: 'neutral', awaiting_payment_verification: 'warning', invoice_not_issued: 'warning' };
const fmt = (n: number | null) => (n === null ? 'not in the entitlement' : String(n));

function Plan({ projectId, p, view }: { projectId: string; p: PlanLifecycleView; view: PhaseEightCView }) {
  const inForce = ['active', 'renewed', 'renewal_approaching', 'renewal_proposed'].includes(p.status);
  const proposals = view.acceptedProposals.map((x) => ({ value: x.id, label: x.title }));
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground">{p.name} v{p.version}</span>
        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{humanize(p.status)}</Badge>
        {p.gateState ? <Badge tone={GATE_TONE[p.gateState] ?? 'neutral'}>{humanize(p.gateState)}</Badge> : null}
      </div>
      <span className="text-muted">Period: {p.startsOn ?? 'not set until the first cycle is paid'} to {p.endsOn ?? 'not set'}{p.gateDetail ? ` - ${p.gateDetail}` : ''}</span>
      {p.cycle ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted">Cycle {p.cycle.startsOn} to {p.cycle.endsOn}</span>
          <span className="text-muted">Hours: {fmt(p.usedHours)} used of {fmt(p.entitledHours)}{p.overageHours ? ` (${p.overageHours} over)` : ''}</span>
          <span className="text-muted">Requests: {fmt(p.usedRequests)} used of {fmt(p.entitledRequests)}{p.overageRequests ? ` (${p.overageRequests} over)` : ''}</span>
          {p.overageHours ? <OverageForm projectId={projectId} cycleId={p.cycle.id} kind="hours" /> : null}
          {p.overageRequests ? <OverageForm projectId={projectId} cycleId={p.cycle.id} kind="request" /> : null}
        </div>
      ) : null}
      {p.drafts.map((d) => (
        <span key={`${p.planId}-${d.kind}-${d.overage}`} className="text-muted">
          <Badge tone="warning">Draft, not billed</Badge> {d.overage} {d.kind} over{d.amountMinor !== null ? `: ${d.amountMinor} ${d.currency ?? ''} (minor units, from the rate you entered)` : ': no rate was entered, a person quotes it'}
        </span>
      ))}
      {p.status === 'draft' && !p.accepted ? <AcceptanceForm projectId={projectId} planId={p.planId} proposals={proposals} /> : null}
      {p.status === 'draft' && p.accepted ? <ActivateForm projectId={projectId} planId={p.planId} reinstate={false} /> : null}
      {p.status === 'at_risk' ? <ActivateForm projectId={projectId} planId={p.planId} reinstate /> : null}
      {inForce ? <UsageForm projectId={projectId} planId={p.planId} targets={view.usageTargets} /> : null}
      {p.usage.length > 0 ? <span className="text-muted">Ledger: {p.usage.map((u) => `${u.occurredOn} ${u.type === 'reversal' ? '-' : '+'}${u.quantity} ${u.kind}`).join('; ')}</span> : null}
      {['active', 'renewed', 'renewal_approaching'].includes(p.status) && !p.openRenewalStatus ? <ProposeRenewalForm projectId={projectId} planId={p.planId} proposals={proposals} /> : null}
      {p.openRenewalStatus === 'proposed' && p.renewalId ? <RenewalDecisionForm projectId={projectId} renewalId={p.renewalId} /> : null}
      {p.openRenewalStatus === 'accepted' && p.renewalId ? <ConfirmRenewalForm projectId={projectId} renewalId={p.renewalId} /> : null}
      {p.openCancellationId ? <CancellationDecisionForm projectId={projectId} cancellationId={p.openCancellationId} /> : inForce || p.status === 'at_risk' ? <CancellationRequestForm projectId={projectId} planId={p.planId} /> : null}
    </li>
  );
}

export function PhaseEightCPanel({ projectId, view }: { projectId: string; view: PhaseEightCView }) {
  const published = view.catalog.filter((c) => c.status === 'published').map((c) => ({ value: c.id, label: `${c.name} v${c.version}` }));
  return (
    <Card title="Maintenance plans">
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-muted">
          A plan is active only when its first cycle is paid on verified money, or an owner-approved, expiring exception stands in. Nothing here sets a price, bills, quotes, refunds or messages a client.
        </p>
        {view.plans.length === 0 ? <p className="text-[13px] text-muted">No lifecycle plan on this project yet.</p> : <ul className="flex flex-col gap-3">{view.plans.map((p) => <Plan key={p.planId} projectId={projectId} p={p} view={view} />)}</ul>}
        <OpenPlanForm projectId={projectId} catalog={published} />

        <h3 className="text-[13px] font-medium text-foreground">Catalog (an Admin sets it; a different Admin publishes it)</h3>
        <ul className="flex flex-col gap-2">
          {view.catalog.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-md border border-line p-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2"><span className="text-foreground">{c.name} v{c.version}</span><Badge tone={c.status === 'published' ? 'success' : 'neutral'}>{humanize(c.status)}</Badge><span className="text-muted">{c.billingModel}; {fmt(c.includedHours)} hours, {fmt(c.includedRequests)} requests per cycle</span></div>
              {c.priceLines.map((l) => <span key={`${c.id}-${l.label}`} className="text-muted">{l.label} ({humanize(l.per)}): {l.amountMinor} {l.currency} minor units, entered by a person</span>)}
              {c.status === 'draft' ? <PriceLineForm projectId={projectId} catalogId={c.id} /> : null}
              {c.status !== 'retired' ? <PublishCatalogForm projectId={projectId} catalogId={c.id} status={c.status} /> : null}
              {c.status === 'draft' && c.createdByViewer ? <span className="text-muted">You drafted this version: another Admin must publish it.</span> : null}
            </li>
          ))}
        </ul>
        <CatalogVersionForm projectId={projectId} />

        {view.churn.length > 0 ? <p className="text-[13px] text-muted">Churn reasons: {view.churn.map((c) => `${humanize(c.reason)} ${c.plans}`).join('; ')}</p> : null}

        <h3 className="text-[13px] font-medium text-foreground">Post-launch work: SLA breaches and stalls</h3>
        {view.breaches.length === 0 ? <p className="text-[13px] text-muted">No work item has passed an SLA target an Admin set.</p> : (
          <ul className="flex flex-col gap-2">
            {view.breaches.map((b) => (
              <li key={b.id} className="flex flex-col gap-1 text-[13px]">
                <span className="text-muted"><Badge tone={b.acknowledged ? 'neutral' : 'danger'}>{b.acknowledged ? 'Acknowledged' : 'Needs an Admin'}</Badge> {b.priority.toUpperCase()} work item passed its target at {b.dueAt}</span>
                {b.acknowledged ? null : <AckBreachForm projectId={projectId} breachId={b.id} />}
              </li>
            ))}
          </ul>
        )}
        {view.stalls.length > 0 ? <ul className="flex flex-col gap-1 text-[13px] text-muted">{view.stalls.map((s) => <li key={`${s.workItemId}-${s.reason}-${s.detectedAt}`}><Badge tone="warning">Stalled</Badge> {humanize(s.reason)}: {s.detail}</li>)}</ul> : null}
        <span className="text-[13px] text-muted">Inactivity counts as a stall only against a threshold an Admin sets: {view.stallPolicyHours === null ? 'none is set' : `${view.stallPolicyHours} hours`}.</span>
        <StallPolicyForm projectId={projectId} />

        {view.safety.length > 0 ? (
          <>
            <h3 className="text-[13px] font-medium text-foreground">Sensitive database changes: data safety before release approval</h3>
            <ul className="flex flex-col gap-2">
              {view.safety.map((s) => (
                <li key={s.workItemId} className="flex flex-col gap-1 text-[13px]">
                  <span className="text-muted"><Badge tone={s.recorded ? 'success' : 'warning'}>{s.recorded ? 'Recorded for this commit' : 'Rollback plan and backup evidence needed'}</Badge> {s.title}</span>
                  {!s.recorded && s.commitRef ? <DataSafetyForm projectId={projectId} workItemId={s.workItemId} commitRef={s.commitRef} /> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Card>
  );
}
