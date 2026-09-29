import type { Metadata } from 'next';

import {
  getLeadSourceBreakdown,
  getPricingReflex,
  getSalesFunnel,
  MIN_LEADS_TO_NAME_A_LEAK,
} from '@/lib/admin/sales-funnel';
import { requireInternal } from '@/lib/auth/session';
import { isOpenOpportunity, LOST_CATEGORY_LABELS, OPPORTUNITY_STAGES, type OpportunityStage } from '@/modules/sales/schema';
import { listOpportunities } from '@/modules/sales/queries';
import { can } from '@/lib/authz/permissions';
import Link from 'next/link';

import { buttonClass, DonutChart, humanize, IconCheck, IconDownload, IconRupee, IconTarget, IconTrendUp, IconUsers, PageHeader, Stat, StatGrid, statusTone, type KanbanColumn, PermissionDenied } from '@/ui';

import { PipelineBoard, type PipelineCard } from './pipeline-board';

export const metadata: Metadata = { title: 'Sales funnel' };

/**
 * Where the leads are lost — Document 09 §37, and the Sales Dashboard of §30.
 *
 * Every number is a count of rows somebody or something wrote; the definitions
 * live in `crm.sales_funnel` so this page cannot disagree with them. What it
 * adds is the only thing a reader actually wants: the drop between each pair,
 * and which drop is the largest.
 *
 * It refuses to name a leak from too few leads, and says so on the page rather
 * than quietly. With four leads the biggest drop is noise, and pointing at a
 * stage on that evidence is a fabricated insight.
 *
 * The open pipeline above it is `listOpportunities()` grouped by stage —
 * `PipelineBoard` (drag-and-drop, added on top of the original read-only
 * grid) writes through the exact same `setOpportunityStageAction` the Lead
 * 360 sales panel's own stage dropdown calls, restricted to the three OPEN
 * stages: `won`/`lost` stay on that panel's guarded flow (a mandatory
 * reason+category for lost, the won-gate RPC and a separate
 * `convertToProject` capability for won — none of which a card drag can
 * supply).
 *
 * Gated on `lead.read` for viewing; dragging additionally requires
 * `lead.write` (the same capability the stage-change action itself enforces
 * server-side regardless of what this page shows).
 */

const STAGE_LABEL: Record<OpportunityStage, string> = {
  discovery: 'Discovery',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

const hours = (h: number | null): string => {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

const WINDOWS = [30, 90, 180, 365] as const;

export default async function SalesFunnelPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const context = await requireInternal('/sales-funnel');
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { days: daysParam } = await searchParams;
  const days = (WINDOWS as readonly number[]).includes(Number(daysParam)) ? Number(daysParam) : 90;

  const { counts, steps, biggestDrop, outOfOrder, lostReasons } = await getSalesFunnel(days);
  const reflex = await getPricingReflex(days);
  const leadSources = await getLeadSourceBreakdown(days);
  const widest = Math.max(...steps.map((s) => s.count), 1);

  const opportunities = await listOpportunities();
  const openStages = OPPORTUNITY_STAGES.filter(isOpenOpportunity);
  const open = opportunities.filter((o) => isOpenOpportunity(o.stage as OpportunityStage));
  const canWritePipeline = can(context.role, 'lead.write');

  // SCR-004's KPI row — every figure a sum or count of rows, per stage.
  const currency = open[0]?.currency ?? opportunities[0]?.currency ?? 'INR';
  const valueByStage = new Map<string, number>();
  for (const o of opportunities) if (o.currency === currency) valueByStage.set(o.stage, (valueByStage.get(o.stage) ?? 0) + o.value_minor);
  const openValue = open.filter((o) => o.currency === currency).reduce((n, o) => n + o.value_minor, 0);
  const decided = counts.won + counts.lost;
  const winRate = decided > 0 ? Math.round((counts.won / decided) * 100) : null;
  const wonValue = valueByStage.get('won') ?? 0;

  const pipelineColumns: KanbanColumn[] = openStages.map((stage) => ({
    id: stage,
    label: STAGE_LABEL[stage],
    tone: statusTone(stage),
  }));
  // An open opportunity's lead link is expected but the column is nullable
  // in the schema; skip the rare row without one rather than render a card
  // whose "open the lead" click would have nowhere to go.
  const pipelineDeals: PipelineCard[] = open
    .filter((o): o is typeof o & { lead_id: string } => o.lead_id !== null)
    .map((o) => ({
      id: o.id,
      columnId: o.stage as OpportunityStage,
      leadId: o.lead_id,
      name: o.name,
      valueLabel: money(o.value_minor, o.currency),
    }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Sales funnel"
        description={`Leads created in the last ${days} days, and how far each got. Every number is a row somebody wrote.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-lg border border-line bg-surface p-0.5">
              {WINDOWS.map((w) => (
                <Link key={w} href={`/sales-funnel?days=${w}`} className={buttonClass(days === w ? 'primary' : 'ghost', 'sm')} aria-current={days === w ? 'page' : undefined}>
                  {w}d
                </Link>
              ))}
            </div>
            <a href="/api/sales/pipeline/export" className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} /> Export CSV
            </a>
          </div>
        }
      />

      <StatGrid cols={5}>
        <Stat label="Leads in window" value={String(counts.leads)} caption={`${counts.qualified} qualified · ${counts.quoted} quoted`} tone="brand" icon={<IconUsers size={16} />} href="/leads" />
        <Stat label="Open deals" value={String(open.length)} caption={openStages.map((st) => `${valueByStage.has(st) ? money(valueByStage.get(st) ?? 0, currency) : '₹0'} ${STAGE_LABEL[st].toLowerCase()}`).join(' · ')} tone="info" icon={<IconTarget size={16} />} />
        <Stat label="Pipeline value" value={money(openValue, currency)} caption="Sum of open deal values" tone="accent" icon={<IconRupee size={16} />} />
        <Stat label="Won" value={String(counts.won)} caption={wonValue > 0 ? `${money(wonValue, currency)} across all won deals` : `${counts.lost} lost`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Win rate" value={winRate === null ? '—' : `${winRate}%`} caption={decided > 0 ? `${counts.won} won of ${decided} decided` : 'Nothing decided in the window'} tone={winRate !== null && winRate >= 50 ? 'success' : 'neutral'} icon={<IconTrendUp size={16} />} />
      </StatGrid>

      <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm font-medium">Open pipeline</p>
        <p className="text-[12.5px] text-muted">
          Every deal currently open, grouped by stage.{' '}
          {canWritePipeline ? 'Drag a card to move it to the next stage.' : ''} {open.length} open deal
          {open.length === 1 ? '' : 's'}.
        </p>
        {open.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No open deals right now.</p>
        ) : (
          <div className="mt-2">
            <PipelineBoard columns={pipelineColumns} deals={pipelineDeals} canWrite={canWritePipeline} />
          </div>
        )}
      </section>

      {leadSources.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          <p className="text-sm font-medium">Lead source breakdown</p>
          <p className="text-[12.5px] text-muted">
            Leads created in the last {days} days, by how they reached us.
          </p>
          <div className="mt-2">
            <DonutChart
              data={leadSources.map((s) => ({ label: humanize(s.source), value: s.count }))}
              totalLabel="Leads"
            />
          </div>
        </section>
      ) : null}

      {counts.leads === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
          No leads were created in this window, so there is nothing to measure yet. This page
          reports what happened; it does not estimate.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
            {steps.map((step) => (
              <div key={step.key} className="flex items-center gap-3">
                <div className="w-44 shrink-0">
                  <p className="text-sm font-medium">{step.label}</p>
                  <p className="text-[11.5px] leading-tight text-muted">{step.evidence}</p>
                </div>

                <div className="h-6 flex-1 overflow-hidden rounded bg-surface-sunken">
                  <div
                    className="h-full rounded bg-accent/70"
                    style={{ width: `${Math.max((step.count / widest) * 100, step.count > 0 ? 2 : 0)}%` }}
                  />
                </div>

                <p className="w-14 shrink-0 text-right text-sm tabular">{step.count}</p>
                <p className="w-28 shrink-0 text-right text-[12.5px] tabular text-muted">
                  {step.rate === null ? '' : `${step.rate}% of previous`}
                </p>
                <p className="w-24 shrink-0 text-right text-[12.5px] tabular text-muted">
                  {step.ofLeads === null ? '' : `${step.ofLeads}% of leads`}
                </p>
              </div>
            ))}
          </section>

          <section className="grid gap-3 sm:grid-cols-3">
            {[
              ['Time to first reply', hours(counts.hoursToFirstReply)],
              ['Time to first quote', hours(counts.hoursToFirstQuote)],
              ['Time to won', hours(counts.hoursToWon)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-surface p-4">
                <p className="text-[12.5px] text-muted">{label}</p>
                <p className="mt-0.5 text-xl tabular">{value}</p>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            {biggestDrop ? (
              <p className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
                <span className="font-medium">The biggest loss is between {biggestDrop.from} and{' '}
                {biggestDrop.to}</span> — {biggestDrop.lost} lead
                {biggestDrop.lost === 1 ? '' : 's'} ({biggestDrop.rate}%) do not get there.
              </p>
            ) : (
              <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
                Not enough leads yet to say where the losses are. Below{' '}
                {MIN_LEADS_TO_NAME_A_LEAK} in the window, the biggest drop is noise — naming a
                stage on that evidence would be a guess wearing a number.
              </p>
            )}

            {/* Not smoothed away. A later stage larger than an earlier one means
                deals are reaching it without the evidence for the one before —
                most often closing outside the quotation system. */}
            {outOfOrder ? (
              <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">
                A later stage counts more leads than an earlier one. That is not an error here:
                the stages are counted independently, so it means deals are reaching that point
                without the record for the one before it — usually closing without a quotation
                in the system.
              </p>
            ) : null}

            {/* G-172 — what the anchor costs. The corpus study found this
                agency's prices cluster on round numbers and the scope bends
                to meet them; the gap between the formula's reading and the
                price actually set was invisible until it was recorded. It is
                not an error — the owner may have had every reason. It is a
                number nobody could see before. */}
            {reflex.quoted > 0 ? (
              <div className="rounded-lg border border-line bg-surface p-4">
                <p className="mb-2 text-[12.5px] text-muted">
                  Priced below the agency&rsquo;s own formula
                </p>
                {reflex.below === 0 ? (
                  <p className="text-sm text-muted">
                    None of the {reflex.quoted} quotation{reflex.quoted === 1 ? '' : 's'} in this
                    window was priced below what the formula read for its shape.
                  </p>
                ) : (
                  <>
                    <p className="text-sm">
                      <span className="tabular font-medium">{reflex.below}</span> of{' '}
                      <span className="tabular">{reflex.quoted}</span> quotation
                      {reflex.quoted === 1 ? '' : 's'}, totalling{' '}
                      <span className="tabular font-medium">
                        ₹{reflex.belowByRupees.toLocaleString('en-IN')}
                      </span>{' '}
                      below the reference.
                    </p>
                    {reflex.widest ? (
                      <p className="mt-1 text-[12.5px] text-muted">
                        Widest: {reflex.widest.title} — priced ₹
                        {reflex.widest.proposedRupees.toLocaleString('en-IN')} against a reference of
                        ₹{reflex.widest.referenceRupees.toLocaleString('en-IN')}.
                      </p>
                    ) : null}
                    <p className="mt-2 text-[12.5px] text-muted">
                      The reference is the one recorded when each quotation was drafted, not what
                      the formula would say today. A gap is not a mistake — it is the cost of a
                      decision, shown so it can be weighed.
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {/* Doc 09 §37's "lost reason distribution" and §30's "top lost
                reasons". Ordered by how many deals each took, because the
                first row is the only one anybody acts on. */}
            {lostReasons.length > 0 ? (
              <div className="rounded-lg border border-line bg-surface p-4">
                <p className="mb-2 text-[12.5px] text-muted">Why deals were lost</p>
                <div className="flex flex-col gap-1.5">
                  {lostReasons.map((reason) => (
                    <div key={reason.category} className="flex items-center gap-3">
                      {/* 'not recorded' is the function's own word for a deal
                          lost before the category existed — it has no label
                          because it is not a category. */}
                      <p className="w-44 shrink-0 text-sm">
                        {(LOST_CATEGORY_LABELS as Record<string, string>)[reason.category] ??
                          reason.category}
                      </p>
                      <div className="h-4 flex-1 overflow-hidden rounded bg-surface-sunken">
                        <div className="h-full rounded bg-danger/60" style={{ width: `${reason.share}%` }} />
                      </div>
                      <p className="w-10 shrink-0 text-right text-sm tabular">{reason.deals}</p>
                      <p className="w-14 shrink-0 text-right text-[12.5px] tabular text-muted">
                        {reason.share}%
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <p className="px-1 text-[12.5px] text-muted">
              {counts.lost} lead{counts.lost === 1 ? '' : 's'} recorded as lost.{' '}
              {counts.budgetKnown} have a budget on file — kept beside the funnel rather than in
              it, because plenty of leads are quoted without one and counting it as a step would
              invent a loss. Deal values, discount impact and lead-source ROI are not here:
              nothing records enough of them yet to average, and an average of nulls is not a
              number.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
