import { formatCostMinor } from '@/lib/admin/agent-eval';
import { closeRate, type CommercialReport, type Split } from '@/modules/sales/p1s-commercial-model';
import { Card, CardHeader, EmptyState, Stat, StatGrid } from '@/ui';

const money = (minor: number | null) => (minor === null ? 'n/a' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100));
const pct = (r: number | null) => (r === null ? 'no deals' : `${Math.round(r * 100)}%`);
const counts = (s: Split) => `${s.won} won, ${s.lost} lost`;

function Compare({ title, note, rows }: { title: string; note: string; rows: Array<{ label: string; split: Split }> }) {
  return (
    <Card>
      <CardHeader title={title} description={note} />
      <div className="px-4 pb-4 sm:px-5">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr><th className="py-1 pr-3 font-medium">Group</th><th className="py-1 pr-3 font-medium">Closed deals</th><th className="py-1 font-medium">Won</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-line">
                <td className="py-1.5 pr-3">{r.label}</td>
                <td className="py-1.5 pr-3 text-muted">{counts(r.split)}</td>
                <td className="py-1.5 font-medium tabular">{pct(closeRate(r.split))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Commercial results (P1-CRM-045, P1-CRM-063): average deal value, what discounts cost and whether they won deals, trust-offer, repeat-client and nurture
 * conversion, the objections that come up most, which source turns into deals, and what each agent did. Every number is a count of rows that already exist
 * (`sales.p1s_commercial_report`); a rate is the share of deals that CLOSED in the window, and is "no deals" rather than 0% when none closed. It says what
 * happened, not why: a discounted deal winning more often is not evidence that the discount caused it.
 */
export function CommercialReport({ report }: { report: CommercialReport | null }) {
  if (!report) return null;
  const d = report.discount;
  const decided = Object.entries(d.decisions);
  return (
    <section className="flex flex-col gap-4" aria-labelledby="commercial-results">
      <h2 id="commercial-results" className="text-base font-semibold">Commercial results, last {report.days} days</h2>
      <StatGrid>
        <Stat label="Deals won" value={report.deals.won} caption={`${report.deals.lost} lost · ${pct(closeRate({ won: report.deals.won, lost: report.deals.lost }))} won`} />
        <Stat label="Average won deal" value={money(report.deals.avgWonValueMinor)} caption={report.deals.won === 0 ? 'no deal won in this window' : `${money(report.deals.wonValueMinor)} in total`} />
        <Stat label="Discount given" value={money(d.takenEffectMinor)} caption={d.avgPct === null ? 'none took effect' : `average ${d.avgPct}% of the quote`} />
        <Stat label="Nurtured leads won" value={`${report.nurture.converted} of ${report.nurture.leads}`} caption="leads with a nurture reason that now have a won deal" />
      </StatGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Compare
          title="Discount impact"
          note={decided.length === 0 ? 'No discount was asked for in this window.' : `Decisions: ${decided.map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}. Only a discount that took effect counts here.`}
          rows={[{ label: 'Deals with a discount', split: d.discounted }, { label: 'Deals without one', split: d.plain }]}
        />
        <Compare
          title="Trust offers"
          note="A trust offer is a payment structure with a lower advance, prototype first, a split or a deferral."
          rows={[{ label: 'Trust offer', split: report.trustOffer.trust }, { label: 'Standard structure', split: report.trustOffer.standard }]}
        />
        <Compare
          title="Repeat clients"
          note="Renewals and upsells against first-time deals."
          rows={[{ label: 'Renewal or upsell', split: report.repeat.repeat }, { label: 'First deal', split: report.repeat.fresh }]}
        />
        <Card>
          <CardHeader title="Top objections" description="What clients push back on, and how it ended." />
          <div className="px-4 pb-4 sm:px-5">
            {report.objections.length === 0 ? (
              <EmptyState title="No objection raised" />
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="py-1 pr-3 font-medium">Kind</th><th className="py-1 pr-3 font-medium">Raised</th><th className="py-1 pr-3 font-medium">Still open</th><th className="py-1 font-medium">Ended in a lost deal</th></tr></thead>
                <tbody>
                  {report.objections.map((o) => (
                    <tr key={o.kind} className="border-t border-line"><td className="py-1.5 pr-3 capitalize">{o.kind}</td><td className="py-1.5 pr-3 tabular">{o.raised}</td><td className="py-1.5 pr-3 tabular">{o.open}</td><td className="py-1.5 tabular">{o.lost}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Lead source to deal" description="Leads created in the window and how many have a won deal." />
          <div className="px-4 pb-4 sm:px-5">
            {report.sources.length === 0 ? (
              <EmptyState title="No lead created in this window" />
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="py-1 pr-3 font-medium">Source</th><th className="py-1 pr-3 font-medium">Leads</th><th className="py-1 pr-3 font-medium">With a won deal</th><th className="py-1 font-medium">Share</th></tr></thead>
                <tbody>
                  {report.sources.map((s) => (
                    <tr key={s.source} className="border-t border-line"><td className="py-1.5 pr-3">{s.source.replace('_', ' ')}</td><td className="py-1.5 pr-3 tabular">{s.leads}</td><td className="py-1.5 pr-3 tabular">{s.won}</td><td className="py-1.5 tabular">{s.leads === 0 ? 'n/a' : `${Math.round((s.won / s.leads) * 100)}%`}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Agent performance" description="Runs in the window, from the agent run log. Cost is as the Usage screen shows it." />
          <div className="px-4 pb-4 sm:px-5">
            {report.agents.length === 0 ? (
              <EmptyState title="No agent ran in this window" />
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted"><tr><th className="py-1 pr-3 font-medium">Agent</th><th className="py-1 pr-3 font-medium">Runs</th><th className="py-1 pr-3 font-medium">Failed</th><th className="py-1 pr-3 font-medium">Average time</th><th className="py-1 font-medium">Cost</th></tr></thead>
                <tbody>
                  {report.agents.map((a) => (
                    <tr key={a.agent} className="border-t border-line"><td className="py-1.5 pr-3">{a.agent.replace(/_/g, ' ')}</td><td className="py-1.5 pr-3 tabular">{a.runs}</td><td className="py-1.5 pr-3 tabular">{a.failed}</td><td className="py-1.5 pr-3 tabular">{a.avgLatencyMs === null ? 'n/a' : `${(a.avgLatencyMs / 1000).toFixed(1)} s`}</td><td className="py-1.5 tabular">₹{formatCostMinor(a.costMinor) ?? '0.00'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </section>
  );
}
