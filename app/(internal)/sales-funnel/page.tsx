import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getPricingReflex, getSalesFunnel, MIN_LEADS_TO_NAME_A_LEAK } from '@/lib/admin/sales-funnel';
import { requireInternal } from '@/lib/auth/session';
import { LOST_CATEGORY_LABELS } from '@/modules/sales/schema';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';

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
 * Gated on `lead.read`: this is the sales team's own number.
 */

const hours = (h: number | null): string => {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

export default async function SalesFunnelPage() {
  const context = await requireInternal('/sales-funnel');
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const { counts, steps, biggestDrop, outOfOrder, lostReasons } = await getSalesFunnel();
  const reflex = await getPricingReflex();
  const widest = Math.max(...steps.map((s) => s.count), 1);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Sales funnel"
        description="Leads created in the last 90 days, and how far each got. Every number is a row somebody wrote."
      />

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
