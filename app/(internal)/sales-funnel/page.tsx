import type { Metadata } from 'next';

import {
  getLeadSourceBreakdown,
  getPricingReflex,
  getSalesFunnel,
  MIN_LEADS_TO_NAME_A_LEAK,
} from '@/lib/admin/sales-funnel';
import { agencyClock, getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { meetingsToday } from '@/lib/admin/overview';
import { listRecentSalesActivity, listUpcomingMeetings } from '@/lib/admin/sales-activity';
import { requireInternal } from '@/lib/auth/session';
import { listLeadsForTable } from '@/modules/crm/queries';
import { listMyTasks } from '@/modules/projects/queries';
import { isOpenOpportunity, LOST_CATEGORY_LABELS, OPPORTUNITY_STAGES, type OpportunityStage } from '@/modules/sales/schema';
import { listPipelineOpportunities } from '@/modules/sales/pipeline-queries';
import { listInternalRoster } from '@/modules/projects/queries';
import { can } from '@/lib/authz/permissions';
import Link from 'next/link';

import { BarChart, buttonClass, Card, CardHeader, DonutChart, FilterChips, humanize, IconCheck, IconDownload, IconRupee, IconTarget, IconTrendUp, IconUsers, PageHeader, Stat, StatGrid, statusTone, StatusBadge, type KanbanColumn, PermissionDenied } from '@/ui';

import { TodayCard } from '../today-card';
import { PipelineBoard, type PipelineCard } from './pipeline-board';
import { SalesActions } from './sales-actions';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SalesFunnelPage({ searchParams }: { searchParams: Promise<{ days?: string; source?: string; owner?: string }> }) {
  const context = await requireInternal('/sales-funnel');
  if (!can(context.role, 'lead.read')) return <PermissionDenied />;

  const { days: daysParam, source: sourceParam, owner: ownerParam } = await searchParams;
  const days = (WINDOWS as readonly number[]).includes(Number(daysParam)) ? Number(daysParam) : 90;

  const canWritePipeline = can(context.role, 'lead.write');
  const { counts, steps, biggestDrop, outOfOrder, lostReasons } = await getSalesFunnel(days);
  const reflex = await getPricingReflex(days);
  const leadSources = await getLeadSourceBreakdown(days);
  const widest = Math.max(...steps.map((s) => s.count), 1);

  // SCR-005 — source and owner filters. They apply to the pipeline board
  // and the deal KPIs (rows this page holds, with the lead's source and
  // assignee on each). The funnel bars come from `crm.sales_funnel`, a
  // database function that takes only a window; they stay unfiltered and
  // the page says so rather than re-deriving them here.
  const allOpportunities = await listPipelineOpportunities();
  const sources = [...new Set(allOpportunities.map((o) => o.lead?.source).filter((v): v is string => Boolean(v)))].sort();
  const source = sources.includes(sourceParam ?? '') ? sourceParam : undefined;
  const owner = ownerParam === 'mine' ? context.userId : UUID.test(ownerParam ?? '') ? ownerParam : undefined;
  const ownerIds = [...new Set(allOpportunities.map((o) => o.ownerId).filter((v): v is string => Boolean(v)))];
  const roster = await listInternalRoster();
  const nameOf = (id: string) => roster.find((m) => m.userId === id)?.fullName ?? id.slice(0, 8);
  const filtering = Boolean(source || owner);
  const opportunities = allOpportunities.filter((o) => (!source || o.lead?.source === source) && (!owner || o.ownerId === owner));
  const filterHref = (over: Partial<{ source: string; owner: string }>) => {
    const next = { days: String(days), source: source ?? '', owner: ownerParam === 'mine' ? 'mine' : (owner ?? ''), ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && !(k === 'days' && v === '90')) q.set(k, v);
    const qs = q.toString();
    return `/sales-funnel${qs ? `?${qs}` : ''}`;
  };

  // SCR-005 — today, upcoming meetings, recent activity, the add buttons'
  // lead list. Each a reader that already exists or a row-level read.
  const clock = await agencyClock();
  const now = new Date();
  const todayWindow = clock.today(now);
  const todayKey = clock.dayKey(now);
  const agencyZone = await getAgencyTimeZone();
  // Said as unavailable rather than as none when the read fails, like the dashboard.
  const todayMeetings: { ok: true; value: Awaited<ReturnType<typeof meetingsToday>> } | { ok: false } = await meetingsToday(todayWindow.from, todayWindow.to)
    .then((value) => ({ ok: true as const, value }))
    .catch(() => ({ ok: false as const }));
  const [myTasks, upcoming, activity, leadsForActions] = await Promise.all([
    listMyTasks(context.userId),
    listUpcomingMeetings(now),
    listRecentSalesActivity(10),
    canWritePipeline ? listLeadsForTable(200) : Promise.resolve([]),
  ]);
  const dueToday = myTasks.filter((t) => t.dueOn === todayKey);
  const overdueMine = myTasks.filter((t) => t.dueOn !== null && t.dueOn < todayKey).length;
  const exportQuery = new URLSearchParams();
  if (source) exportQuery.set('source', source);
  if (owner) exportQuery.set('owner', owner);
  const exportHref = `/api/sales/pipeline/export${exportQuery.toString() ? `?${exportQuery}` : ''}`;

  const openStages = OPPORTUNITY_STAGES.filter(isOpenOpportunity);
  const open = opportunities.filter((o) => isOpenOpportunity(o.stage as OpportunityStage));

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
            {/* SCR-005 — the export carries the page's own filters. */}
            <a href={exportHref} className={buttonClass('secondary', 'sm')}>
              <IconDownload size={14} /> Export CSV{filtering ? ' (filtered)' : ''}
            </a>
            <SalesActions leads={leadsForActions.map((l) => ({ id: l.id, title: l.contact?.fullName ?? l.title, conversationId: null }))} agencyZone={agencyZone} canWrite={canWritePipeline} />
          </div>
        }
      />

      <nav aria-label="Pipeline filters" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Source</span>
          <FilterChips
            options={[
              { key: 'any', label: 'Any', href: filterHref({ source: '' }), active: !source },
              ...sources.map((s) => ({ key: s, label: humanize(s), href: filterHref({ source: s }), active: source === s })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Owner</span>
          <FilterChips
            options={[
              { key: 'any', label: 'Anyone', href: filterHref({ owner: '' }), active: !owner },
              { key: 'mine', label: 'Mine', href: filterHref({ owner: 'mine' }), active: ownerParam === 'mine' },
              ...ownerIds.filter((id) => id !== context.userId).map((id) => ({ key: id, label: nameOf(id), href: filterHref({ owner: id }), active: owner === id })),
            ]}
          />
        </div>
        {filtering ? (
          <span className="text-[12px] text-muted">
            Deal tiles and the board are filtered; the funnel bars and lead-source chart are the window&rsquo;s whole count.
          </span>
        ) : null}
      </nav>

      <StatGrid cols={5}>
        <Stat label="Leads in window" value={String(counts.leads)} caption={`${counts.qualified} qualified · ${counts.quoted} quoted`} tone="brand" icon={<IconUsers size={16} />} href="/leads" />
        <Stat label="Open deals" value={String(open.length)} caption={`${openStages.map((st) => `${valueByStage.has(st) ? money(valueByStage.get(st) ?? 0, currency) : '₹0'} ${STAGE_LABEL[st].toLowerCase()}`).join(' · ')}${filtering ? ' · filtered' : ''}`} tone="info" icon={<IconTarget size={16} />} />
        <Stat label="Pipeline value" value={money(openValue, currency)} caption={filtering ? 'Sum of open deal values matching the filters' : 'Sum of open deal values'} tone="accent" icon={<IconRupee size={16} />} />
        <Stat label="Won" value={String(counts.won)} caption={wonValue > 0 ? `${money(wonValue, currency)} across all won deals` : `${counts.lost} lost`} tone="success" icon={<IconCheck size={16} />} />
        <Stat label="Win rate" value={winRate === null ? '—' : `${winRate}%`} caption={decided > 0 ? `${counts.won} won of ${decided} decided` : 'Nothing decided in the window'} tone={winRate !== null && winRate >= 50 ? 'success' : 'neutral'} icon={<IconTrendUp size={16} />} />
      </StatGrid>

      {/* SCR-005 — pipeline value by stage. One measure (money), ordered
          categories, a single series: a bar chart in one hue, the figures
          in a table beneath for anyone who cannot read the colour or wants
          the number. Only the open stages are open value; won and lost are
          shown as what they are, beside. */}
      <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm font-medium">Pipeline value by stage</p>
        <p className="text-[12.5px] text-muted">
          The sum of deal values in each stage{filtering ? ', matching the filters' : ''}, in {currency}. Won and lost are the settled ends of the same line.
        </p>
        {opportunities.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No deals yet, so nothing to sum.</p>
        ) : (
          <>
            <div className="mt-2">
              <BarChart
                data={OPPORTUNITY_STAGES.map((st) => ({ label: STAGE_LABEL[st], value: Math.round((valueByStage.get(st) ?? 0) / 100) }))}
                colors={OPPORTUNITY_STAGES.map((st) => (isOpenOpportunity(st) ? 'var(--brand)' : st === 'won' ? 'var(--success)' : 'var(--muted)'))}
                currency={currency}
                height={200}
              />
            </div>
            <details className="text-[12.5px]">
              <summary className="cursor-pointer text-muted">The figures as a table</summary>
              <table className="mt-2 w-full max-w-md text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
                    <th className="py-1">Stage</th>
                    <th className="py-1 text-right">Deals</th>
                    <th className="py-1 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {OPPORTUNITY_STAGES.map((st) => (
                    <tr key={st} className="border-t border-line">
                      <td className="py-1">{STAGE_LABEL[st]}</td>
                      <td className="py-1 text-right tabular">{opportunities.filter((o) => o.stage === st).length}</td>
                      <td className="py-1 text-right tabular">{money(valueByStage.get(st) ?? 0, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <TodayCard clock={clock} now={now} meetings={todayMeetings} dueToday={dueToday} overdueCount={overdueMine} paymentsToVerify={null} />

        <Card>
          <CardHeader title="Upcoming meetings" description="Agreed or requested, soonest first." actions={<Link href="/meetings?window=week" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">All meetings</Link>} />
          <ul className="divide-y divide-line">
            {upcoming.length === 0 ? (
              <li className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing agreed or requested ahead.</li>
            ) : (
              upcoming.map((m) => (
                <li key={m.id}>
                  <Link href={`/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="min-w-0 flex-1 truncate text-foreground">{m.leadTitle}</span>
                    <span className="shrink-0 text-xs text-muted">{humanize(m.mode)}</span>
                    <span className="shrink-0 text-xs tabular text-muted">{clock.dateTime(m.at)}{m.agreed ? '' : ' (requested)'}</span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </Card>

        <Card>
          <CardHeader title="Recent sales activity" description="The newest rows on any lead: notes, status changes, messages, calls, agent runs, assignments." />
          <ul className="divide-y divide-line">
            {activity.length === 0 ? (
              <li className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing recorded on any lead yet.</li>
            ) : (
              activity.map((a) => (
                <li key={a.id}>
                  <Link href={`/leads/${a.leadId}`} className="flex flex-col gap-0.5 px-4 py-2 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="flex items-center gap-2">
                      <StatusBadge status={a.kind} dot={false} />
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{a.leadTitle}</span>
                      <span className="shrink-0 text-[11px] text-faint">{clock.dateTime(a.occurredAt)}</span>
                    </span>
                    {a.body ? <span className="truncate text-xs text-muted">{a.body}</span> : null}
                  </Link>
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm font-medium">Open pipeline</p>
        <p className="text-[12.5px] text-muted">
          Every deal currently open, grouped by stage.{' '}
          {canWritePipeline ? 'Drag a card to move it to the next stage.' : ''} {open.length} open deal
          {open.length === 1 ? '' : 's'}{filtering ? ' matching the filters' : ''}.
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
