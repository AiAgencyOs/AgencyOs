import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { getLeadHeader, getLeadPipeline } from '@/modules/crm/queries';
import { LEAD_TRANSITIONS, leadQualificationSchema, type LeadStatus } from '@/modules/crm/schema';
import { listDisqualificationHistory, readQualificationCoverage } from '@/modules/crm/lead-insight-queries';
import { heatTitle } from '@/modules/crm/lead-heat';
import { LeadHeatBadge } from '@/modules/crm/lead-heat-badge';
import { readLeadHeatReading } from '@/modules/crm/lead-heat-queries';
import { readLeadService } from '@/modules/crm/lead-service-queries';
import { listOpenObjectionsForLead } from '@/modules/sales/queries';
import { Badge, buttonClass, Card, CardHeader, DetailList, DetailRow, humanize, IconArrowLeft, PageHeader, PermissionDenied, Stat, StatGrid, StatusBadge } from '@/ui';

import { LeadStatusForm, QualificationForm } from '../sales-panel';
import { ReturnToDiscoveryForm } from '../return-to-discovery-form';

export const metadata: Metadata = { title: 'Qualification' };

function money(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100);
}

/**
 * SCR-008 — the qualification surface as its own screen: the header figures
 * (score, fit criteria, budget, timeline, decision maker, objections), the
 * qualification form, the score explanation beside the human decision, the
 * disqualification history and the guarded moves (disqualify with a reason,
 * return to discovery). Every figure is a stored row; nothing here is typed in
 * by a model, and the override and the original score are both kept.
 *
 * The fit criteria are the Document 09 §9 areas the conversation has already
 * answered (`crm.qualification_coverage`); a budget BAND needs boundaries the
 * specs do not give, so the screen shows the recorded budget itself.
 */
export default async function LeadQualificationPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  const context = await requireInternal(`/leads/${leadId}/qualification`);
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const lead = await getLeadHeader(leadId);
  if (!lead) notFound();
  const [pipeline, heatReading, coverage, history, objections, service, clock] = await Promise.all([
    getLeadPipeline(leadId),
    readLeadHeatReading({ id: leadId, status: lead.status }),
    readQualificationCoverage(leadId),
    listDisqualificationHistory(leadId),
    listOpenObjectionsForLead(leadId),
    readLeadService(leadId),
    agencyClock(),
  ]);
  const status = (pipeline?.status ?? 'new') as LeadStatus;
  const parsed = leadQualificationSchema.safeParse(pipeline?.qualification ?? {});
  const q = parsed.success ? parsed.data : {};
  const mayWrite = can(context, 'lead.write');
  const allowed = (LEAD_TRANSITIONS[status] ?? []).filter((s) => s !== 'converted');
  const canReturn = (LEAD_TRANSITIONS[status] ?? []).includes('qualifying') && status !== 'qualifying';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Qualification — ${lead.title}`}
        description="Service fit, budget, urgency, authority and timeline in one place. The system recommends; a person decides."
        actions={
          <Link href={`/leads/${leadId}`} className={buttonClass('secondary', 'sm')}>
            <IconArrowLeft size={14} />
            Lead 360
          </Link>
        }
      />

      <StatGrid cols={5}>
        <Stat label="Lead heat" value={heatReading.label} caption="From stage, last reply and budget" />
        <Stat label="Fit criteria" value={`${coverage.covered.length}/${coverage.total}`} caption="Areas the conversation answered" />
        <Stat label="Budget" value={q.budgetMinor !== undefined ? money(q.budgetMinor) : '—'} caption={q.budgetMinor !== undefined ? 'As recorded' : 'Not recorded'} />
        <Stat label="Timeline" value={q.timelineNote ? q.timelineNote : '—'} caption={q.timelineNote ? 'As recorded' : 'Not recorded'} />
        <Stat label="Decision maker" value={q.isDecisionMaker === undefined ? 'Unknown' : q.isDecisionMaker ? 'Yes' : 'No'} caption={`Status: ${humanize(status)}`} />
      </StatGrid>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Qualification form" description="Budget is in paise. Saved through the same door as on Lead 360." />
            <div className="px-4 pb-4 sm:px-5">
              {mayWrite ? (
                <QualificationForm leadId={leadId} current={q} />
              ) : (
                <DetailList>
                  <DetailRow label="Service" value={<>{service ?? 'Not recorded'}</>} />
                  <DetailRow label="Fit notes" value={<>{q.notes ?? 'None'}</>} />
                </DetailList>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Fit criteria" description="Which of the sixteen discovery areas the client has already answered, with their own words." />
            <ul className="divide-y divide-line px-4 pb-3 sm:px-5">
              {coverage.covered.map((c) => (
                <li key={c.area} className="py-2 text-[13px]">
                  <Badge tone="success" dot={false}>{humanize(c.area)}</Badge>
                  <span className="mt-1 block text-muted">“{c.quote}”</span>
                </li>
              ))}
              {coverage.missing.length > 0 ? (
                <li className="py-2 text-[13px]">
                  <span className="text-muted">Not yet answered: </span>
                  <span className="inline-flex flex-wrap gap-1 align-middle">
                    {coverage.missing.map((a) => (
                      <Badge key={a} tone="neutral" dot={false}>{humanize(a)}</Badge>
                    ))}
                  </span>
                </li>
              ) : null}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Risk and objections" description="Concerns the client raised that nobody has answered yet." />
            <div className="px-4 pb-4 sm:px-5">
              {objections.length === 0 ? (
                <p className="text-[13px] text-muted">No open objection.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {objections.map((o) => (
                    <li key={o.id} className="text-[13px]">
                      <Badge tone="warning" dot={false}>{humanize(o.kind)}</Badge> <span className="text-muted">{o.concern}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Why This Heat" description="A Hot, Warm or Cold label worked out from the stage, the last reply and whether a budget is recorded. Never a number." />
            <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              <div>
                <LeadHeatBadge label={heatReading.label} title={heatTitle(heatReading)} />
              </div>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {heatReading.reasons.map((r) => (
                  <li key={r} className="px-3 py-1.5 text-[13px]">{r}</li>
                ))}
              </ul>
            </div>
          </Card>

          {mayWrite ? (
            <Card>
              <CardHeader title="Decisions" description="Moves are guarded: disqualifying needs a reason, returning to discovery records what is missing." />
              <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
                <div>
                  <p className="mb-1 text-[13px] font-semibold">Move the lead</p>
                  <LeadStatusForm leadId={leadId} current={status} allowed={allowed} />
                </div>
                {canReturn ? (
                  <div className="border-t border-line pt-3">
                    <ReturnToDiscoveryForm leadId={leadId} />
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Disqualification history" />
            <div className="px-4 pb-4 sm:px-5">
              {history.length === 0 ? (
                <p className="text-[13px] text-muted">This lead has never been disqualified.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {history.map((h) => (
                    <li key={h.id} className="text-[13px]">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status="disqualified" />
                        <span className="text-xs text-muted">{clock.dateTime(h.occurredAt)}{h.from ? ` · from ${humanize(h.from)}` : ''}</span>
                      </span>
                      <span className="mt-0.5 block text-muted">{h.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
