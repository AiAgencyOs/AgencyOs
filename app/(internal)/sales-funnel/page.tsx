import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getPricingReflex, getSalesFunnel, MIN_LEADS_TO_NAME_A_LEAK } from '@/lib/admin/sales-funnel';
import { requireInternal } from '@/lib/auth/session';
import { isOpenOpportunity, LOST_CATEGORY_LABELS, OPPORTUNITY_STAGES, type OpportunityStage } from '@/modules/sales/schema';
import { listPipelineOpportunities } from '@/modules/sales/pipeline-queries';
import { listInternalRoster } from '@/modules/projects/queries';
import { can } from '@/lib/authz/permissions';
import { FilterChips, PageHeader, Stat, StatGrid, humanize } from '@/ui';

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
 * The open pipeline above it is `listOpportunities()` grouped by stage — a
 * reader with a real test and no caller anywhere in the app until now (SCR-005).
 * A drag-and-drop kanban board is a different UI than this and a real design
 * decision this deployment has not made; a read-only grouped list is not that
 * decision, just the one view of "what is currently in flight, and where" that
 * did not exist at any scope broader than a single lead's own panel.
 *
 * Gated on `lead.read`: this is the sales team's own number.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SalesFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; owner?: string }>;
}) {
  const context = await requireInternal('/sales-funnel');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const { counts, steps, biggestDrop, outOfOrder, lostReasons } = await getSalesFunnel();
  const reflex = await getPricingReflex();
  const widest = Math.max(...steps.map((s) => s.count), 1);

  // SCR-005 — source and owner filters. They apply to the pipeline (rows
  // this page holds, with the lead's source and assignee on each) and to
  // the deal KPIs computed from those rows. The funnel bars below come from
  // `crm.sales_funnel`, a database function that takes only a window; it is
  // shown unfiltered and says so, rather than being re-derived here.
  const params = await searchParams;
  const all = await listPipelineOpportunities();
  const sources = [...new Set(all.map((o) => o.lead?.source).filter((v): v is string => Boolean(v)))].sort();
  const source = sources.includes(params.source ?? '') ? params.source : undefined;
  const owner = params.owner === 'mine' ? context.userId : UUID.test(params.owner ?? '') ? params.owner : undefined;
  const ownerIds = [...new Set(all.map((o) => o.ownerId).filter((v): v is string => Boolean(v)))];
  const roster = await listInternalRoster();
  const nameOf = (id: string) => roster.find((m) => m.userId === id)?.fullName ?? id.slice(0, 8);

  const filtered = all.filter((o) => (!source || o.lead?.source === source) && (!owner || o.ownerId === owner));
  const filtering = Boolean(source || owner);

  const href = (over: Partial<{ source: string; owner: string }>) => {
    const next = { source: source ?? '', owner: params.owner === 'mine' ? 'mine' : (owner ?? ''), ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const qs = q.toString();
    return `/sales-funnel${qs ? `?${qs}` : ''}`;
  };

  const openStages = OPPORTUNITY_STAGES.filter(isOpenOpportunity);
  const open = filtered.filter((o) => isOpenOpportunity(o.stage as OpportunityStage));
  const byStage = new Map(openStages.map((stage) => [stage, open.filter((o) => o.stage === stage)]));
  const won = filtered.filter((o) => o.stage === 'won');
  const lost = filtered.filter((o) => o.stage === 'lost');
  const kpiCurrency = open[0]?.currency ?? won[0]?.currency ?? 'INR';
  const sumMinor = (rows: typeof filtered) => rows.filter((o) => o.currency === kpiCurrency).reduce((n, o) => n + o.value_minor, 0);
  const mixedCurrency = filtered.some((o) => o.currency !== kpiCurrency);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Sales funnel"
        description="Leads created in the last 90 days, and how far each got. Every number is a row somebody wrote."
      />

      <nav aria-label="Pipeline filters" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-subtle bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Source</span>
          <FilterChips
            options={[
              { key: 'any', label: 'Any', href: href({ source: '' }), active: !source },
              ...sources.map((s) => ({ key: s, label: humanize(s), href: href({ source: s }), active: source === s })),
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Owner</span>
          <FilterChips
            options={[
              { key: 'any', label: 'Anyone', href: href({ owner: '' }), active: !owner },
              { key: 'mine', label: 'Mine', href: href({ owner: 'mine' }), active: params.owner === 'mine' },
              ...ownerIds
                .filter((id) => id !== context.userId)
                .map((id) => ({ key: id, label: nameOf(id), href: href({ owner: id }), active: owner === id })),
            ]}
          />
        </div>
      </nav>

      {/* SCR-005's KPI row — counts and sums over the filtered deals, not
          estimates. Values are summed in one currency and the tile says when
          a deal in another currency was left out of the sum. */}
      <StatGrid>
        <Stat label="Open deals" value={String(open.length)} caption={filtering ? 'matching the filters' : 'across every source and owner'} />
        <Stat
          label="Open pipeline value"
          value={money(sumMinor(open), kpiCurrency)}
          caption={mixedCurrency ? `${kpiCurrency} deals only — other currencies are not summed` : `sum of open deal values, ${kpiCurrency}`}
        />
        <Stat label="Won" value={String(won.length)} caption={won.length > 0 ? money(sumMinor(won), kpiCurrency) : 'no won deals in this set'} tone={won.length > 0 ? 'success' : 'neutral'} />
        <Stat label="Lost" value={String(lost.length)} caption={filtered.length > 0 ? `of ${filtered.length} deal${filtered.length === 1 ? '' : 's'}` : 'no deals in this set'} tone={lost.length > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      <section className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface p-4">
        <p className="text-sm font-medium">Open pipeline</p>
        <p className="text-[12.5px] text-muted">
          Every deal currently open, grouped by stage — a read of the same rows the funnel below
          counts, not a board. {open.length} open deal{open.length === 1 ? '' : 's'}
          {filtering ? ' matching the filters' : ''}.
          {filtering ? ' The funnel bars below are the database function’s own count over the window and are not filtered.' : ''}
        </p>
        {open.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No open deals right now.</p>
        ) : (
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {openStages.map((stage) => {
              const rows = byStage.get(stage) ?? [];
              return (
                <div key={stage} className="rounded-md border border-line p-3">
                  <p className="mb-2 flex items-center justify-between text-[12.5px] font-medium text-muted">
                    <span>{STAGE_LABEL[stage]}</span>
                    <span className="tabular">{rows.length}</span>
                  </p>
                  {rows.length === 0 ? (
                    <p className="text-[12.5px] text-faint">Nothing here.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {rows.map((o) => (
                        <li key={o.id}>
                          <Link
                            href={`/leads/${o.lead_id}`}
                            className="block rounded px-1.5 py-1 text-[13px] hover:bg-surface-hover"
                          >
                            <span className="block truncate font-medium">{o.name}</span>
                            <span className="block text-[11.5px] text-muted">
                              {money(o.value_minor, o.currency)}
                              {o.lead ? ` · ${humanize(o.lead.source)}` : ''}
                              {o.ownerId ? ` · ${nameOf(o.ownerId)}` : ''}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {counts.leads === 0 ? (
        <p className="rounded-lg border border-subtle bg-surface p-4 text-sm text-muted">
          No leads were created in this window, so there is nothing to measure yet. This page
          reports what happened; it does not estimate.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface p-4">
            {steps.map((step) => (
              <div key={step.key} className="flex items-center gap-3">
                <div className="w-44 shrink-0">
                  <p className="text-sm font-medium">{step.label}</p>
                  <p className="text-[11.5px] leading-tight text-muted">{step.evidence}</p>
                </div>

                <div className="h-6 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
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
              <div key={label} className="rounded-lg border border-subtle bg-surface p-4">
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
              <p className="rounded-lg border border-subtle bg-surface p-4 text-sm text-muted">
                Not enough leads yet to say where the losses are. Below{' '}
                {MIN_LEADS_TO_NAME_A_LEAK} in the window, the biggest drop is noise — naming a
                stage on that evidence would be a guess wearing a number.
              </p>
            )}

            {/* Not smoothed away. A later stage larger than an earlier one means
                deals are reaching it without the evidence for the one before —
                most often closing outside the quotation system. */}
            {outOfOrder ? (
              <p className="rounded-lg border border-subtle bg-surface p-4 text-sm text-muted">
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
              <div className="rounded-lg border border-subtle bg-surface p-4">
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
              <div className="rounded-lg border border-subtle bg-surface p-4">
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
                      <div className="h-4 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
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
