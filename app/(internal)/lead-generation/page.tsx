import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listKillSwitches } from '@/lib/observability/kill-switches';
import { listTargetServices, readAutopilot, readChannelSettings, readCurrentIcp, readLeadsBySource } from '@/modules/acquisition/queries';
import { CHANNEL_LABEL, CHANNEL_SLUG, ENGINE_STATUS } from '@/modules/acquisition/schema';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { AutopilotForm, GlobalPauseForm, SeedButton } from './forms';

export const metadata: Metadata = { title: 'Lead generation' };

const BUILD_TONE = { not_built: 'neutral', partial: 'warning', built: 'success' } as const;
const BUILD_LABEL = { not_built: 'Not built yet', partial: 'Partly built', built: 'Built' } as const;

/**
 * The Lead Generation overview. Every number is read from the database; an engine that does not exist yet
 * says so in words instead of showing a zero that looks like a result.
 */
export default async function LeadGenerationPage() {
  const context = await requireInternal('/lead-generation');
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const isOwner = hasRole(context, 'owner');
  const mayManage = can(context, 'acquisition.manage');

  const [{ seeded, channels }, services, { current }, bySource, switches, autopilot] = await Promise.all([
    readChannelSettings(),
    listTargetServices(),
    readCurrentIcp(),
    readLeadsBySource(),
    listKillSwitches(),
    readAutopilot(),
  ]);
  const global = switches.find((s) => s.switch === 'acquisition_paused');
  const active = services.filter((s) => s.active);
  const totalLeads = bySource.total;
  const qualified = bySource.rows.reduce((n, r) => n + r.qualified, 0);
  const won = bySource.rows.reduce((n, r) => n + r.won, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Lead generation"
        title="Lead generation & outbound"
        description="Five engines feed one CRM. You decide what is targeted, how much each channel may do, and when it stops."
      />

      {global?.active ? (
        <Callout tone="danger" title="All lead generation is paused">
          {global.reason ?? 'No reason recorded.'} No engine takes a new external action until the owner resumes it.
        </Callout>
      ) : null}

      {!seeded ? (
        <Callout tone="info" title="Lead generation is not set up yet">
          {mayManage ? (
            <div className="mt-2 flex flex-col gap-2">
              <span>Setting up creates the five channel records (all off) and the default target services: Website, App and General Development. You can change or replace them afterwards.</span>
              <SeedButton />
            </div>
          ) : 'An owner or ops admin needs to set this up.'}
        </Callout>
      ) : null}

      <StatGrid>
        <Stat label="Leads in the CRM" value={String(totalLeads)} caption={bySource.truncated ? 'most recent 5,000' : 'all sources'} tone="neutral" />
        <Stat label="Qualified or converted" value={String(qualified)} caption={`${won} converted`} tone="info" />
        <Stat label="Target services" value={String(active.length)} caption={active.slice(0, 2).map((s) => s.name).join(', ') || 'none active'} tone={active.length > 0 ? 'success' : 'warning'} />
        <Stat label="Ideal customer profile" value={current ? `v${current.version}` : 'Not set'} caption={current ? 'current version' : 'set it under Settings'} tone={current ? 'success' : 'warning'} />
      </StatGrid>

      <Card>
        <CardHeader title="The five engines" description="What each channel is set to, and how much of it exists." />
        <CardBody>
          <ul className="divide-y divide-line">
            {channels.map((c) => {
              const engine = ENGINE_STATUS[c.channel];
              return (
                <li key={c.channel} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-0.5">
                    <Link href={`/lead-generation/${CHANNEL_SLUG[c.channel]}`} className="text-[14px] font-medium text-brand hover:underline">{CHANNEL_LABEL[c.channel]}</Link>
                    <span className="text-xs text-muted">{engine.summary}</span>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Badge tone={BUILD_TONE[engine.build]}>{BUILD_LABEL[engine.build]}</Badge>
                    <Badge tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'In the plan' : 'Off'}</Badge>
                    {c.paused ? <Badge tone="danger">Paused</Badge> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Leads by source" description="From the CRM as it stands today. Revenue, cost per lead and the rest arrive with the engines that produce them." />
        <CardBody>
          {bySource.rows.length === 0 ? (
            <EmptyState title="No leads yet" description="Leads appear here as they are recorded, by the source they came in through." action={<Link href="/leads" className="text-[13px] text-brand hover:underline">Open the leads list</Link>} />
          ) : (
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-xs text-muted"><th className="py-1">Source</th><th>Leads</th><th>Qualified or converted</th><th>Converted</th></tr></thead>
              <tbody>
                {bySource.rows.map((r) => (
                  <tr key={r.source} className="border-t border-line"><td className="py-1.5">{r.source.replace('_', ' ')}</td><td>{r.leads}</td><td>{r.qualified}</td><td>{r.won}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {seeded ? (
        <Card>
          <CardHeader title="Weekly autopilot" description={autopilot.enabled ? 'On. From Monday 09:00 (the agency timezone) each enabled agent whose channel is in the plan and not stopped is given one standing task: read the results, then draft for approval. Nothing is launched, published, sent or priced; every exact version still waits for a person.' : 'Off. When on, each enabled agent starts its week on its own with a standing task that only drafts for approval. The emergency stop, a channel pause, the tool permissions and the cost ceilings all still apply.'} />
          <CardBody>{mayManage ? <AutopilotForm key={String(autopilot.enabled)} enabled={autopilot.enabled} /> : <p className="text-[13px] text-muted">Only an admin changes this.</p>}</CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Emergency stop" description="Stops every engine from taking a new external action. Records and replies already received are kept." />
        <CardBody>
          <GlobalPauseForm active={global?.active ?? false} reason={global?.reason ?? null} isOwner={isOwner} />
        </CardBody>
      </Card>
    </div>
  );
}
