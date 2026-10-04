import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listActiveBlocks, listRecentQualifications, readChannelSettings, readEmailFunnel, readQualificationModel } from '@/modules/acquisition/queries';
import { disqualifierWords, FACTOR_LABEL, FUNNEL_LABEL, FUNNEL_STAGES, QUALIFICATION_FACTORS } from '@/modules/acquisition/qualification-vocabulary';
import { CHANNEL_LABEL, ENGINE_STATUS, channelFromSlug } from '@/modules/acquisition/schema';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { BlockForm, LiftBlockForm, QualificationModelForm } from '../email-forms';
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
  const isOwner = hasRole(context, 'owner');
  const email = channel === 'email' ? await Promise.all([readEmailFunnel(), readQualificationModel(), listActiveBlocks(), listRecentQualifications()]) : null;

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

      {email ? (
        <>
          <Card>
            <CardHeader title="Funnel" description="Counted from the records themselves: prospects, qualification decisions, meeting and quotation requests, and lead outcomes." />
            <CardBody>
              <StatGrid>
                {FUNNEL_STAGES.map((st) => <Stat key={st} label={FUNNEL_LABEL[st]} value={String(email[0][st] ?? 0)} caption="" tone={st === 'won' ? 'success' : st === 'opted_out' || st === 'lost' ? 'warning' : 'neutral'} />)}
              </StatGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="How prospects are scored" description={email[1].current ? `Version ${email[1].current.version} of ${email[1].versions}. A change is saved as the next version; earlier decisions keep the one they were made under. A strong score never overrides a rule: the exclusion list, the block list, the target countries, industries and services, and anyone who asked not to be emailed.` : 'No weights saved yet, so every factor counts equally. Set them below.'} />
            <CardBody>
              {mayManage ? <QualificationModelForm key={email[1].current?.version ?? 0} weights={email[1].current?.weights ?? {}} /> : (
                <ul className="text-[13px]">{QUALIFICATION_FACTORS.map((f) => <li key={f}>{FACTOR_LABEL[f]}: {email[1].current?.weights[f] ?? 'equal'}</li>)}</ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Never prospect" description="People, domains and companies the agency will not approach. Lifting a block is the owner's decision and the record is kept." />
            <CardBody>
              <div className="flex flex-col gap-4">
                {mayManage ? <BlockForm /> : null}
                {email[2].length === 0 ? <p className="text-[13px] text-muted">Nothing blocked.</p> : (
                  <ul className="flex flex-col gap-2 text-[13px]">
                    {email[2].map((b) => (
                      <li key={b.id} className="flex flex-col gap-1 border-b border-line pb-2 sm:flex-row sm:items-center sm:justify-between">
                        <span><Badge tone="danger">{b.kind}</Badge> {b.value} - {b.reason}</span>
                        {mayManage ? <LiftBlockForm blockId={b.id} isOwner={isOwner} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Recent qualification decisions" description="With the rule that decided, and what was missing." />
            <CardBody>
              {email[3].length === 0 ? (
                <EmptyState title="Nothing qualified yet" description="Decisions appear here when a person or an agent scores a prospect." />
              ) : (
                <ul className="flex flex-col gap-2 text-[13px]">
                  {email[3].map((q) => (
                    <li key={q.id} className="flex flex-col gap-0.5 border-b border-line pb-2">
                      <span><strong>{q.prospectEmail}</strong> · <Badge tone={q.decision === 'qualified' ? 'success' : q.decision === 'disqualified' ? 'danger' : 'warning'}>{q.decision.replaceAll('_', ' ')}</Badge> · score {q.score} (needs {q.threshold})</span>
                      {q.disqualifiers.length > 0 ? <span className="text-muted">{q.disqualifiers.map(disqualifierWords).join(' · ')}</span> : null}
                      {q.missing.length > 0 ? <span className="text-muted">Still needed: {q.missing.join(', ').replaceAll('_', ' ')}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
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
