import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { FUNNEL_CHANNEL_LABEL, RECOMMENDATION_TITLE, WINDOWS, failureTitle, recommendationLine, revenueLine, windowFrom } from '@/modules/acquisition/analytics-vocabulary';
import { readAcquisitionTrend, readAttributionModels, listAcquisitionFailures, readAcquisitionFunnel, readAcquisitionRecommendations, readGoalProgress } from '@/modules/acquisition/queries';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied } from '@/ui';

export const metadata: Metadata = { title: 'Lead generation performance' };

const inr = (m: number | null): string => (m === null ? '-' : `₹${(m / 100).toLocaleString('en-IN')}`);

/**
 * Performance across the five engines. Everything here is READ from the CRM and the usage ledger by `crm.acquisition_*` functions that
 * cannot write; nothing on this page changes a campaign, a budget or a message. A lead is credited to the channel that FOUND it (its
 * first touch); the other views sit alongside so they can be compared.
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const context = await requireInternal('/lead-generation/performance');
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const days = windowFrom((await searchParams).days);
  const [funnel, goals, failures, advice, models, trend] = await Promise.all([readAcquisitionFunnel(days), readGoalProgress(), listAcquisitionFailures(), readAcquisitionRecommendations(days), readAttributionModels(days), readAcquisitionTrend(12)]);
  const weeks = [...new Set(trend.map((t) => t.weekStart))].sort();
  const critical = failures.filter((f) => f.severity === 'critical');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Lead generation" title="Performance" description="What each channel produced, what it cost, whether it is on pace for the goal you set, and what is broken right now." />

      {critical.length > 0 ? <Callout tone="danger" title={`${critical.length} thing${critical.length === 1 ? '' : 's'} need attention now`}>See "What is wrong" below.</Callout> : null}

      <Card>
        <CardHeader title="What is wrong" description="Critical first. A finding here changes nothing; it tells you where to look." />
        <CardBody>
          {failures.length === 0 ? (
            <EmptyState title="Nothing is failing" description="No failed or unknown actions, no unverified pages, no degraded connections and no unacknowledged worker alerts." />
          ) : (
            <ul className="flex flex-col gap-3">
              {failures.map((f, i) => (
                <li key={`${f.kind}-${f.refId ?? i}`} className="flex flex-col gap-0.5 border-b border-line pb-3 text-[13px] last:border-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={f.severity === 'critical' ? 'danger' : f.severity === 'warning' ? 'warning' : 'neutral'}>{f.severity}</Badge>
                    <strong>{failureTitle(f.kind)}</strong>
                    {f.channel ? <span className="text-muted">{FUNNEL_CHANNEL_LABEL[f.channel] ?? f.channel}</span> : null}
                  </span>
                  <span>{f.summary}</span>
                  <span className="text-xs text-muted">{f.advice}{f.since ? ` · since ${new Date(f.since).toLocaleString('en-IN')}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="This month against your goals" description="The pace projects the month from the days elapsed. A channel with no goal shows none - never a guess." />
        <CardBody>
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1">Channel</th><th>Qualified</th><th>Goal</th><th>Pace</th><th>Spend</th><th>Budget used</th></tr></thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g.channel} className="border-t border-line">
                  <td className="py-1.5">{FUNNEL_CHANNEL_LABEL[g.channel] ?? g.channel}{g.paused ? <Badge tone="warning"> paused</Badge> : null}</td>
                  <td>{g.qualifiedThisMonth}</td><td>{g.target ?? '-'}</td>
                  <td>{g.pacePct === null ? '-' : <Badge tone={g.onPace ? 'success' : 'warning'}>{g.pacePct}% {g.onPace ? 'on pace' : 'behind'}</Badge>}</td>
                  <td>{g.spendThisMonthMinor > 0 ? inr(g.spendThisMonthMinor) : '-'}</td><td>{g.budgetUsedPct === null ? '-' : `${g.budgetUsedPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What each channel produced" description="Leads are credited to the channel that FOUND them (first touch). 'Touched by' and 'last touch' sit alongside so you can see where the views differ. Revenue is kept in the currency it was won in. Under ten leads is too thin to judge." />
        <CardBody>
          <div className="mb-3 flex gap-2 text-[13px]">
            {WINDOWS.map((w) => <Link key={w.days} href={`/lead-generation/performance?days=${w.days}`} className={w.days === days ? 'font-semibold text-brand' : 'text-muted hover:underline'}>{w.label}</Link>)}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-xs text-muted"><th className="py-1">Channel</th><th>Leads</th><th>Qualified</th><th>Meetings</th><th>Quotes</th><th>Won</th><th>Revenue</th><th>Spend</th><th>Per lead</th><th>Per qualified</th><th>Per win</th><th>Touched by</th><th>Last touch</th></tr></thead>
              <tbody>
                {funnel.map((r) => (
                  <tr key={r.channel} className="border-t border-line align-top">
                    <td className="py-1.5">{FUNNEL_CHANNEL_LABEL[r.channel] ?? r.channel}{r.channel !== 'other' && r.insufficientData ? <div className="text-xs text-muted">Too thin to judge</div> : null}</td>
                    <td>{r.leads}</td><td>{r.qualified}</td><td>{r.meetings}</td><td>{r.quotes}</td><td>{r.won}</td><td>{revenueLine(r.revenue)}</td>
                    <td>{r.spendMinor > 0 ? inr(r.spendMinor) : '-'}</td><td>{inr(r.costPerLeadMinor)}</td><td>{inr(r.costPerQualifiedMinor)}</td><td>{inr(r.costPerWonMinor)}</td><td>{r.touchedLeads}</td><td>{r.lastTouchLeads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Credit, four ways" description="The same leads under four rules. First touch credits the channel that found a lead; last touch the one that closed it; linear splits one credit equally among every channel that touched it; position-based gives 40% to the first, 40% to the last and 20% to the middle. Each column adds up to the number of leads, so no view can invent credit. 'Everything else' includes the lead's own WhatsApp arrival." />
        <CardBody>
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1">Channel</th><th>First touch</th><th>Last touch</th><th>Linear</th><th>Position-based</th></tr></thead>
            <tbody>{models.map((m) => <tr key={m.channel} className="border-t border-line"><td className="py-1.5">{FUNNEL_CHANNEL_LABEL[m.channel] ?? m.channel}</td><td>{m.firstTouch}</td><td>{m.lastTouch}</td><td>{m.linear.toFixed(1)}</td><td>{m.positionBased.toFixed(1)}</td></tr>)}</tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Leads by week" description="New leads by the channel that found them, the last twelve weeks." />
        <CardBody>
          {weeks.length === 0 ? <p className="text-[13px] text-muted">No leads in this period.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">Week of</th>{Object.keys(FUNNEL_CHANNEL_LABEL).map((c) => <th key={c}>{FUNNEL_CHANNEL_LABEL[c]?.split(' ')[0]}</th>)}</tr></thead>
                <tbody>{weeks.map((w) => <tr key={w} className="border-t border-line"><td className="py-1.5">{w}</td>{Object.keys(FUNNEL_CHANNEL_LABEL).map((c) => { const t = trend.find((x) => x.weekStart === w && x.channel === c); return <td key={c}>{t ? `${t.leads}${t.qualified ? ` (${t.qualified} qualified)` : ''}` : '-'}</td>; })}</tr>)}</tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Worth a look" description="Advice with the numbers it rests on. It acts on nothing, and says when there is too little data to judge." />
        <CardBody>
          {advice.length === 0 ? <p className="text-[13px] text-muted">Nothing to suggest.</p> : (
            <ul className="flex flex-col gap-2 text-[13px]">
              {advice.map((a, i) => <li key={`${a.channel}-${a.recommendation}-${i}`}><strong>{FUNNEL_CHANNEL_LABEL[a.channel] ?? a.channel}: {RECOMMENDATION_TITLE[a.recommendation] ?? a.recommendation}.</strong> {recommendationLine(a.recommendation, a.basis)}</li>)}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
