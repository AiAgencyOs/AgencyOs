import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listActiveBlocks, listContentQueue, listRecentQualifications, listSocialStrategies, listTargetServices, readSocialPerformance, readChannelSettings, readEmailFunnel, readQualificationModel } from '@/modules/acquisition/queries';
import { OBJECTIVE_LABEL, FORMAT_LABEL, PLATFORM_LABEL, STATUS_WORDS, reviewWords, type SocialPlatform } from '@/modules/acquisition/social-vocabulary';
import { disqualifierWords, FACTOR_LABEL, FUNNEL_LABEL, FUNNEL_STAGES, QUALIFICATION_FACTORS } from '@/modules/acquisition/qualification-vocabulary';
import { CHANNEL_LABEL, ENGINE_STATUS, channelFromSlug } from '@/modules/acquisition/schema';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { BlockForm, LiftBlockForm, QualificationModelForm } from '../email-forms';
import { ActivateStrategyButton, CancelVersionForm, NewDraftForm, ReviewButton, ScheduleForm, SubmitButton } from '../social-forms';
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
  const social = channel === 'social' ? await Promise.all([listContentQueue(), listSocialStrategies(), readSocialPerformance(), listTargetServices()]) : null;
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

      {social ? (
        <>
          <Callout tone="info" title="How a post goes out">
            Draft, then the automated review, then an admin approves it, then you schedule it, then it is published once. The approval is for exactly these words and this image: change anything and it is a new version that needs approving again. The automated review can fail a draft; it can never approve one. Nothing can be published to LinkedIn, Instagram or Facebook from here yet - a due post is flagged for a person to post by hand.
          </Callout>

          <Card>
            <CardHeader title="Content queue" description="Newest work first. The label comes from the approval engine, so it cannot disagree with the decision it reports." />
            <CardBody>
              {social[0].length === 0 ? (
                <EmptyState title="No content yet" description="Write a draft below." />
              ) : (
                <ul className="flex flex-col gap-4">
                  {social[0].map((q) => {
                    const words = STATUS_WORDS[q.status] ?? { label: q.status, tone: 'neutral' as const, meaning: '' };
                    return (
                      <li key={q.versionId} className="flex flex-col gap-2 border-b border-line pb-4 last:border-0">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <Badge tone={words.tone}>{words.label}</Badge>
                          <strong>{q.title}</strong>
                          <span className="text-muted">{PLATFORM_LABEL[q.platform as SocialPlatform] ?? q.platform} · {OBJECTIVE_LABEL[q.objective as keyof typeof OBJECTIVE_LABEL] ?? q.objective} · {FORMAT_LABEL[q.format as keyof typeof FORMAT_LABEL] ?? q.format} · version {q.version}{q.scheduledFor ? ` · ${new Date(q.scheduledFor).toLocaleString('en-IN')}` : ''}</span>
                        </div>
                        <p className="text-[13px] text-muted">{q.bodyPreview}</p>
                        <p className="text-xs text-muted">{words.meaning}</p>
                        {q.blocking.length > 0 ? <p className="text-xs text-danger">{q.blocking.map(reviewWords).join(' · ')}</p> : null}
                        {q.warnings.length > 0 ? <p className="text-xs text-muted">Worth a look: {q.warnings.map(reviewWords).join(' · ')}</p> : null}
                        {mayManage ? (
                          <div className="flex flex-wrap items-start gap-4">
                            {q.state === 'DRAFT' ? <ReviewButton versionId={q.versionId} /> : null}
                            {q.state === 'AI_REVIEWED' ? <SubmitButton versionId={q.versionId} /> : null}
                            {q.status === 'APPROVED' ? <ScheduleForm versionId={q.versionId} /> : null}
                            {q.state === 'ADMIN_REVIEW' && q.status !== 'APPROVED' ? <Link href="/approvals" className="text-[13px] text-brand hover:underline">Open the Approval Center</Link> : null}
                            {['DRAFT', 'AI_REVIEWED', 'AI_REVIEW_FAILED', 'ADMIN_REVIEW', 'SCHEDULED'].includes(q.state) ? <CancelVersionForm versionId={q.versionId} /> : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {mayManage ? (
            <Card>
              <CardHeader title="New draft" description="Written by a person here; an agent's drafts arrive in the same queue and are held to the same rules." />
              <CardBody><NewDraftForm services={social[3].filter((s) => s.active).map((s) => s.name)} /></CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Strategies" description="3, 6 and 9 month plans per platform. A revision is a new version; activating one supersedes the previous." />
            <CardBody>
              {social[1].length === 0 ? <p className="text-[13px] text-muted">No strategy yet.</p> : (
                <ul className="flex flex-col gap-3 text-[13px]">
                  {social[1].map((st) => (
                    <li key={st.id} className="flex flex-col gap-1 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
                      <span><Badge tone={st.status === 'active' ? 'success' : 'neutral'}>{st.status}</Badge> {PLATFORM_LABEL[st.platform as SocialPlatform] ?? st.platform} · {st.horizon} months · version {st.version}{st.rationale ? ` - ${st.rationale}` : ''}</span>
                      {mayManage && st.status === 'draft' ? <ActivateStrategyButton strategyId={st.id} /> : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Performance by what the content was for" description="Reach and engagement are diagnostic. Success is qualified conversations and won clients, which come from the lead records." />
            <CardBody>
              {social[2].length === 0 ? <p className="text-[13px] text-muted">Nothing published yet.</p> : (
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-xs text-muted"><th className="py-1">Platform</th><th>Objective</th><th>Format</th><th>Posts</th><th>Impressions</th><th>Engagements</th><th>Clicks</th></tr></thead>
                  <tbody>{social[2].map((p, n) => <tr key={n} className="border-t border-line"><td className="py-1.5">{PLATFORM_LABEL[p.platform as SocialPlatform] ?? p.platform}</td><td>{OBJECTIVE_LABEL[p.objective as keyof typeof OBJECTIVE_LABEL] ?? p.objective}</td><td>{FORMAT_LABEL[p.format as keyof typeof FORMAT_LABEL] ?? p.format}</td><td>{p.published}</td><td>{p.impressions}</td><td>{p.engagements}</td><td>{p.clicks}</td></tr>)}</tbody>
                </table>
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
