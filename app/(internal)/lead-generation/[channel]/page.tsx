import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readChannelSettings } from '@/modules/acquisition/queries';
import { CHANNEL_LABEL, ENGINE_STATUS, channelFromSlug } from '@/modules/acquisition/schema';
import { Badge, Callout, Card, CardBody, CardHeader, PageHeader, PermissionDenied } from '@/ui';

import { ChannelPauseForm, ChannelSettingsForm } from '../forms';

export const metadata: Metadata = { title: 'Lead generation channel' };

const SOON = ['Connected accounts', 'Strategy', 'Plans', 'Active runs', 'Prospects', 'Conversations', 'Approvals', 'Analytics', 'Failures', 'Audit history'];

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel: slug } = await params;
  const channel = channelFromSlug(slug);
  if (!channel) notFound();
  const context = await requireInternal(`/lead-generation/${slug}`);
  if (!can(context, 'acquisition.read')) return <PermissionDenied />;
  const mayManage = can(context, 'acquisition.manage');

  const { seeded, channels } = await readChannelSettings();
  const c = channels.find((x) => x.channel === channel)!;
  const engine = ENGINE_STATUS[channel];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Lead generation" title={CHANNEL_LABEL[channel]} description={engine.summary} />

      {c.paused ? <Callout tone="danger" title="This channel is paused">{c.pauseReason}</Callout> : null}
      {engine.link ? (
        <Callout tone="info" title="Already live">
          <Link href={engine.link.href} className="text-brand hover:underline">{engine.link.label}</Link>
        </Callout>
      ) : null}
      {!seeded ? <Callout tone="warning" title="Not set up">Set up lead generation from the Overview first; these settings cannot be saved until then.</Callout> : null}

      <Card>
        <CardHeader title="Plan, goal and limits" description="Read by the engine every time it acts, so a change applies to work that is already queued." />
        <CardBody>
          {mayManage && seeded ? (
            <ChannelSettingsForm
              key={`${channel}-${c.enabled}-${c.monthlyQualifiedTarget}-${c.monthlyBudgetMinor}-${c.dailyLimit}`}
              channel={channel}
              initial={{ enabled: c.enabled, target: c.monthlyQualifiedTarget, budgetMajor: c.monthlyBudgetMinor === null ? null : Math.round(c.monthlyBudgetMinor / 100), daily: c.dailyLimit }}
            />
          ) : (
            <dl className="grid gap-2 text-[13px] sm:grid-cols-4">
              <div><dt className="text-xs text-muted">In the plan</dt><dd>{c.enabled ? 'Yes' : 'No'}</dd></div>
              <div><dt className="text-xs text-muted">Monthly goal</dt><dd>{c.monthlyQualifiedTarget ?? 'None'}</dd></div>
              <div><dt className="text-xs text-muted">Monthly budget</dt><dd>{c.monthlyBudgetMinor === null ? 'None' : `₹${(c.monthlyBudgetMinor / 100).toLocaleString('en-IN')}`}</dd></div>
              <div><dt className="text-xs text-muted">Daily limit</dt><dd>{c.dailyLimit ?? 'None'}</dd></div>
            </dl>
          )}
        </CardBody>
      </Card>

      {mayManage && seeded ? (
        <Card>
          <CardHeader title="Pause" description="The emergency brake for this channel. It is checked when work runs, not when it is queued." />
          <CardBody><ChannelPauseForm key={`${channel}-${c.paused}`} channel={channel} paused={c.paused} reason={c.pauseReason} /></CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Still to come on this tab" description="Shown so nothing here is mistaken for working automation." />
        <CardBody>
          <div className="flex flex-wrap gap-2">{SOON.map((s) => <Badge key={s} tone="neutral">{s}</Badge>)}</div>
        </CardBody>
      </Card>
    </div>
  );
}
