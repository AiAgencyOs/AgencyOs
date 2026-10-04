import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listOutreachProspects, listB2bOpportunities, listB2bProfiles, readB2bOutcomes, readB2bSetup, listLandingPages, listPortfolioChoices, listAdCampaigns, listCampaignHealth, readAdOutcomes, readAdRecommendations, listActiveBlocks, listContentQueue, listRecentQualifications, listSocialStrategies, listTargetServices, readSocialPerformance, readChannelSettings, readEmailFunnel, readQualificationModel } from '@/modules/acquisition/queries';
import { AD_PLATFORM_LABEL, CHANGE_LABEL, HEALTH_WORDS, RECOMMENDATION_WORDS, VERSION_STATE_WORDS, planProblemWords, type AdPlatform } from '@/modules/acquisition/ad-vocabulary';
import { OBJECTIVE_LABEL, FORMAT_LABEL, PLATFORM_LABEL, STATUS_WORDS, reviewWords, type SocialPlatform } from '@/modules/acquisition/social-vocabulary';
import { disqualifierWords, FACTOR_LABEL, FUNNEL_LABEL, FUNNEL_STAGES, QUALIFICATION_FACTORS } from '@/modules/acquisition/qualification-vocabulary';
import { CHANNEL_LABEL, ENGINE_STATUS, channelFromSlug } from '@/modules/acquisition/schema';
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { BlockForm, CheckDraftForm, LiftBlockForm, QualificationModelForm, RecordFactForm, ScoreProspectForm } from '../email-forms';
import { AUTOMATION_LABEL, B2B_PLATFORM_LABEL, OFFPLATFORM_LABEL, OPPORTUNITY_WORDS, PROPOSAL_STATE_WORDS, b2bProblemWords, fitReasonWords } from '@/modules/acquisition/b2b-vocabulary';
import { CheckProfileButton, CheckProposalButton, B2bSettingsForm, ImportOpportunityForm, OutcomeForm, ProfileForm, ProposalForm, RecordProfileAppliedForm, LinkLeadForm, RecordSentForm, RuleForm, SetupB2bButton, ShortlistButton, SkipForm, SubmitProfileButton, SubmitProposalButton } from '../b2b-forms';
import { LANDING_STATE_WORDS, VERIFICATION_CHECK_LABEL, landingProblemWords } from '@/modules/acquisition/landing-vocabulary';
import { CheckLandingButton, LandingForm, RecheckLandingButton, RecordUploadedForm, RetireLandingForm, SubmitLandingButton } from '../landing-forms';
import { AdChangeDoneForm, AdChangeForm, AdFiguresForm, AdPlanForm, CheckAdButton, RecordLaunchForm, SubmitAdButton } from '../ads-forms';
import { ActivateStrategyButton, CancelVersionForm, NewDraftForm, RecordPostedForm, ReviewButton, ScheduleForm, SubmitButton } from '../social-forms';
import { ChannelPauseForm, ChannelSettingsForm } from '../forms';

export const metadata: Metadata = { title: 'Lead generation channel' };

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
  const isAds = channel === 'meta_ads' || channel === 'google_ads';
  const ads = isAds ? await Promise.all([listAdCampaigns(channel), readAdOutcomes(), listCampaignHealth(), readAdRecommendations(), listTargetServices()]) : null;
  const landing = channel === 'google_ads' ? await Promise.all([listLandingPages(), listPortfolioChoices()]) : null;
  const b2b = channel === 'b2b' ? await Promise.all([readB2bSetup(), listB2bOpportunities(), listB2bProfiles(), readB2bOutcomes(), listPortfolioChoices()]) : null;
  const email = channel === 'email' ? await Promise.all([readEmailFunnel(), readQualificationModel(), listActiveBlocks(), listRecentQualifications(), listOutreachProspects()]) : null;

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

          {mayManage ? (
            <>
              <Card>
                <CardHeader title="Score a prospect" description="From what you know, against the weights above. A score you leave empty counts as not known. The rules still outrank any score: the exclusion list, the block list, the target countries, industries and services, and anyone who asked not to be emailed." />
                <CardBody>{email[4].length === 0 ? <p className="text-[13px] text-muted">There is nobody on the email list yet.</p> : <ScoreProspectForm prospects={email[4]} />}</CardBody>
              </Card>
              <Card>
                <CardHeader title="Check a draft against the research" description="Record what you actually know about a person, with its source. A message may then say it - and nothing else about them. No discovery source and no AI writer is connected: the draft is yours or an agent's, and this is what it is held to." />
                <CardBody>
                  {email[4].length === 0 ? <p className="text-[13px] text-muted">There is nobody on the email list yet.</p> : (
                    <div className="flex flex-col gap-6"><RecordFactForm prospects={email[4]} /><CheckDraftForm prospects={email[4]} /></div>
                  )}
                </CardBody>
              </Card>
            </>
          ) : null}

          <Card>
            <CardHeader title="Recent qualification decisions" description="With the rule that decided, and what was missing." />
            <CardBody>
              {email[3].length === 0 ? (
                <EmptyState title="Nothing qualified yet" description="Decisions appear here when a person scores a prospect (above). No agent scores prospects yet." />
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
                            {q.state === 'SCHEDULED' ? <RecordPostedForm versionId={q.versionId} /> : null}
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
                  <tbody>{social[2].map((p, n) => <tr key={n} className="border-t border-line"><td className="py-1.5">{PLATFORM_LABEL[p.platform as SocialPlatform] ?? p.platform}</td><td>{OBJECTIVE_LABEL[p.objective as keyof typeof OBJECTIVE_LABEL] ?? p.objective}</td><td>{FORMAT_LABEL[p.format as keyof typeof FORMAT_LABEL] ?? p.format}</td><td>{p.published}</td><td>{p.impressions || '-'}</td><td>{p.engagements || '-'}</td><td>{p.clicks || '-'}</td></tr>)}</tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </>
      ) : null}


      {ads ? (
        <>
          <Callout tone="info" title="How an ad goes live">
            Draft, then the checks, then an admin approves exactly this plan and budget, then it is applied once. A budget increase or a change of targeting on a live campaign is a new version and needs its own approval. The checks can fail a plan; they can never approve one. No {AD_PLATFORM_LABEL[channel as AdPlatform]} connector is built yet, so an approved plan waits and a person is told to apply it by hand - nothing here is claimed live that the platform has not confirmed.
          </Callout>

          {ads[2].length > 0 ? (
            <Card>
              <CardHeader title="Needs a look" description="What looks wrong, and what a person should check. A finding never changes a campaign." />
              <CardBody>
                <ul className="flex flex-col gap-2 text-[13px]">
                  {ads[2].map((h) => (
                    <li key={h.id}><Badge tone={h.severity === 'critical' ? 'danger' : 'warning'}>{HEALTH_WORDS[h.kind] ?? h.kind}</Badge> {h.recommendedAction} <span className="text-muted">({h.assessedOn})</span></li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Campaigns" description="Newest first, with their versions. The label for a campaign is only LIVE or PAUSED when the platform confirmed it." />
            <CardBody>
              {ads[0].length === 0 ? (
                <EmptyState title="No campaigns yet" description="Write a plan below." />
              ) : (
                <ul className="flex flex-col gap-5">
                  {ads[0].map((camp) => (
                    <li key={camp.id} className="flex flex-col gap-3 border-b border-line pb-5 last:border-0">
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <Badge tone={camp.status === 'live' ? 'success' : camp.status === 'paused' ? 'warning' : 'neutral'}>{camp.status}</Badge>
                        <strong>{camp.name}</strong>
                        {camp.targetService ? <span className="text-muted">{camp.targetService}</span> : null}
                        {camp.pending ? <Badge tone="warning">{camp.pending} requested - waiting for the platform</Badge> : null}
                      </div>
                      <ul className="flex flex-col gap-3">
                        {camp.versions.map((v) => {
                          const words = VERSION_STATE_WORDS[v.state] ?? { label: v.state, tone: 'neutral' as const, meaning: '' };
                          return (
                            <li key={v.id} className="flex flex-col gap-1.5 rounded border border-line p-3 text-[13px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone={words.tone}>{words.label}</Badge>
                                <span>Version {v.version} · {CHANGE_LABEL[v.changeKind as keyof typeof CHANGE_LABEL] ?? v.changeKind} · ₹{(v.budgetDailyMinor / 100).toLocaleString('en-IN')} a day{v.changeAmountMinor > 0 ? ` · adds up to ₹${(v.changeAmountMinor / 100).toLocaleString('en-IN')} over 30 days` : ''}</span>
                              </div>
                              <p className="text-xs text-muted">{words.meaning}</p>
                              {v.problems.length > 0 ? <p className="text-xs text-danger">{v.problems.map(planProblemWords).join(' · ')}</p> : null}
                              {mayManage ? (
                                <div className="flex flex-wrap items-start gap-4">
                                  {v.state === 'DRAFT' || v.state === 'CHECK_FAILED' ? <CheckAdButton versionId={v.id} /> : null}
                                  {v.state === 'CHECKED' ? <SubmitAdButton versionId={v.id} /> : null}
                                  {v.state === 'ADMIN_REVIEW' ? <Link href="/approvals" className="text-[13px] text-brand hover:underline">Open the Approval Center</Link> : null}
                                </div>
                              ) : null}
                              {mayManage && v.state === 'ADMIN_REVIEW' ? <RecordLaunchForm versionId={v.id} platform={channel as AdPlatform} /> : null}
                            </li>
                          );
                        })}
                      </ul>
                      {mayManage && camp.pending ? <AdChangeDoneForm campaignId={camp.id} pending={camp.pending} /> : null}
                      {mayManage && (camp.status === 'live' || camp.status === 'paused') ? <details className="text-[13px]"><summary className="cursor-pointer text-brand">Enter the platform's figures for a day</summary><div className="pt-3"><AdFiguresForm campaignId={camp.id} /></div></details> : null}
                      {mayManage && camp.liveVersionId && camp.status !== 'ended' ? (
                        <div className="flex flex-wrap items-start gap-4">
                          {camp.status === 'live' ? <AdChangeForm campaignId={camp.id} action="pause" /> : null}
                          {camp.status === 'paused' ? <AdChangeForm campaignId={camp.id} action="resume" /> : null}
                          <AdChangeForm campaignId={camp.id} action="end" />
                        </div>
                      ) : null}
                      {mayManage && camp.status !== 'ended' ? (
                        <details className="text-[13px]">
                          <summary className="cursor-pointer text-brand">Write the next version</summary>
                          <div className="pt-3"><AdPlanForm platform={channel as AdPlatform} campaignId={camp.id} services={[]} /></div>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {mayManage ? (
            <Card>
              <CardHeader title="New campaign" description="Saving a plan sends nothing to the platform. An agent's drafts arrive in the same list and are held to the same rules." />
              <CardBody><AdPlanForm platform={channel as AdPlatform} services={ads[4].filter((s) => s.active).map((s) => s.name)} /></CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Results, from the CRM" description="Leads are credited to a campaign only when their FIRST touch was one of its own ads. Cost per result is blank when there is nothing to divide by, and a campaign with fewer than ten leads is marked too thin to judge." />
            <CardBody>
              {ads[1].filter((o) => o.platform === channel).length === 0 ? <p className="text-[13px] text-muted">Nothing to report yet.</p> : (
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-xs text-muted"><th className="py-1">Campaign</th><th>Spend</th><th>Leads</th><th>Qualified</th><th>Meetings</th><th>Quotes</th><th>Won</th><th>Revenue</th><th>Per lead</th><th>Per qualified</th><th>Per win</th></tr></thead>
                  <tbody>
                    {ads[1].filter((o) => o.platform === channel).map((o) => {
                      const inr = (m: number | null) => (m === null ? '-' : `₹${(m / 100).toLocaleString('en-IN')}`);
                      return (
                        <tr key={o.campaignId} className="border-t border-line align-top">
                          <td className="py-1.5">{o.name}{o.insufficientData ? <div className="text-xs text-muted">Too thin to judge</div> : null}</td>
                          <td>{o.spendMinor > 0 ? inr(o.spendMinor) : '-'}</td><td>{o.leads}</td><td>{o.qualified}</td><td>{o.meetings}</td><td>{o.quotes}</td><td>{o.won}</td><td>{inr(o.revenueMinor)}</td>
                          <td>{inr(o.costPerLeadMinor)}</td><td>{inr(o.costPerQualifiedMinor)}</td><td>{inr(o.costPerWonMinor)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {ads[3].length > 0 ? (
                <ul className="mt-4 flex flex-col gap-1 text-[13px]">
                  {ads[3].map((r) => <li key={r.campaignId}><strong>{r.name}:</strong> {RECOMMENDATION_WORDS[r.recommendation] ?? r.recommendation}</li>)}
                </ul>
              ) : null}
            </CardBody>
          </Card>
        </>
      ) : null}


      {landing && ads ? (
        <>
          <Callout tone="info" title="Landing pages">
            A Google ad points only at a landing page that is deployed AND verified. A page is approved as exactly its content, public address and WhatsApp number; deploying is a separate, governed step; verifying fetches the public address and checks it carries the approved version. No Hostinger deployer is built yet, so an approved page is flagged for a person to upload by hand and is never shown as live.
          </Callout>
          <Card>
            <CardHeader title="Pages" description="The label is the latest verification, not the last deploy: a page that stopped matching reads as failed." />
            <CardBody>
              {landing[0].length === 0 ? (
                <EmptyState title="No landing pages yet" description="Write one below." />
              ) : (
                <ul className="flex flex-col gap-5">
                  {landing[0].map((pg) => (
                    <li key={pg.id} className="flex flex-col gap-3 border-b border-line pb-5 last:border-0">
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <Badge tone={pg.status === 'active' ? 'success' : 'neutral'}>{pg.status}</Badge>
                        <strong>{pg.name}</strong>
                        <span className="text-muted">/{pg.slug}{pg.targetService ? ` · ${pg.targetService}` : ''}</span>
                      </div>
                      <ul className="flex flex-col gap-3">
                        {pg.versions.map((v) => {
                          const words = LANDING_STATE_WORDS[v.state] ?? { label: v.state, tone: 'neutral' as const, meaning: '' };
                          return (
                            <li key={v.id} className="flex flex-col gap-1.5 rounded border border-line p-3 text-[13px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge tone={words.tone}>{words.label}</Badge>
                                <span>Version {v.version} · {v.headline}</span>
                                <span className="text-xs text-muted">{v.publicUrl}</span>
                              </div>
                              <p className="text-xs text-muted">{words.meaning}</p>
                              {v.problems.length > 0 ? <p className="text-xs text-danger">{v.problems.map(landingProblemWords).join(' · ')}</p> : null}
                              {v.checks ? (
                                <ul className="text-xs">
                                  {Object.entries(VERIFICATION_CHECK_LABEL).map(([k, label]) => <li key={k}>{v.checks?.[k] ? '✓' : '✗'} {label}</li>)}
                                </ul>
                              ) : null}
                              {mayManage ? (
                                <div className="flex flex-wrap items-start gap-4">
                                  {v.state === 'DRAFT' || v.state === 'CHECK_FAILED' ? <CheckLandingButton versionId={v.id} /> : null}
                                  {v.state === 'CHECKED' ? <SubmitLandingButton versionId={v.id} /> : null}
                                  {v.state === 'ADMIN_REVIEW' ? <Link href="/approvals" className="text-[13px] text-brand hover:underline">Open the Approval Center</Link> : null}
                                  {['DEPLOYED', 'VERIFY_FAILED', 'VERIFIED'].includes(v.state) ? <RecheckLandingButton versionId={v.id} /> : null}
                                </div>
                              ) : null}
                              {mayManage && v.state === 'ADMIN_REVIEW' ? <RecordUploadedForm versionId={v.id} /> : null}
                            </li>
                          );
                        })}
                      </ul>
                      {mayManage && pg.status !== 'retired' ? (
                        <div className="flex flex-wrap items-start gap-4">
                          <RetireLandingForm pageId={pg.id} />
                          <details className="text-[13px]"><summary className="cursor-pointer text-brand">Write the next version</summary><div className="pt-3"><LandingForm pageId={pg.id} services={[]} /></div></details>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          {mayManage ? (
            <Card>
              <CardHeader title="New landing page" description="Proof may only cite the agency's own portfolio items, listed here by id." />
              <CardBody>
                <div className="flex flex-col gap-4">
                  {landing[1].length > 0 ? <ul className="text-xs text-muted">{landing[1].map((i) => <li key={i.id}><code>{i.id}</code> · {i.title} ({i.kind.replaceAll('_', ' ')})</li>)}</ul> : <p className="text-xs text-muted">No portfolio items yet, so a page cannot cite proof.</p>}
                  <LandingForm services={ads[4].filter((x) => x.active).map((x) => x.name)} />
                </div>
              </CardBody>
            </Card>
          ) : null}
        </>
      ) : null}


      {b2b ? (
        <>
          <Callout tone="info" title="How B2B works here">
            You find jobs on the marketplace and record them here; the fit is judged from your own thresholds, and you shortlist. A proposal is checked, approved as exactly these words and this price, then <strong>you send it on the platform yourself</strong> and record it - most marketplaces forbid automation, and no connector is built. Where a marketplace forbids contact off its platform, a proposal may not contain an email, phone, messaging app or link, and no WhatsApp handoff can be made for it. Only a person sets a price.
          </Callout>

          {!b2b[0].ready ? (
            <Card><CardHeader title="Set up B2B" description="Creates a rule for each marketplace (no contact off the platform, a person does everything) and your thresholds." /><CardBody>{mayManage ? <SetupB2bButton /> : <p className="text-[13px] text-muted">An admin needs to set this up.</p>}</CardBody></Card>
          ) : (
            <>
              <Card>
                <CardHeader title="Marketplace rules" description={isOwner ? 'As the owner you may allow contact off a platform or automation. Do so only where the marketplace\'s terms permit it.' : 'You may tighten a rule. Only the owner may allow contact off a platform, or automation.'} />
                <CardBody>
                  <div className="flex flex-col gap-3">
                    {b2b[0].rules.map((r) => mayManage ? <RuleForm key={`${r.platform}-${r.offplatform}-${r.mode}`} platform={r.platform} offplatform={r.offplatform} mode={r.mode} note={r.note} /> : (
                      <p key={r.platform} className="text-[13px]">{B2B_PLATFORM_LABEL[r.platform as keyof typeof B2B_PLATFORM_LABEL] ?? r.platform}: {OFFPLATFORM_LABEL[r.offplatform as keyof typeof OFFPLATFORM_LABEL]} · {AUTOMATION_LABEL[r.mode as keyof typeof AUTOMATION_LABEL]}</p>
                    ))}
                  </div>
                </CardBody>
              </Card>

              {b2b[0].settings && mayManage ? (
                <Card>
                  <CardHeader title="Your thresholds" description="Read every time a job is scored or a proposal is sent." />
                  <CardBody><B2bSettingsForm key={JSON.stringify(b2b[0].settings)} minBudgetMajor={b2b[0].settings.minBudgetMinor === null ? null : b2b[0].settings.minBudgetMinor / 100} excluded={b2b[0].settings.excludedTerms} threshold={b2b[0].settings.scoreThreshold} cap={b2b[0].settings.monthlyConnectsCap} /></CardBody>
                </Card>
              ) : null}

              <Card>
                <CardHeader title="Jobs" description="Newest first. The facts are kept exactly as recorded; the fit says why." />
                <CardBody>
                  {b2b[1].length === 0 ? <EmptyState title="No jobs yet" description="Record one below." /> : (
                    <ul className="flex flex-col gap-5">
                      {b2b[1].map((o) => {
                        const st = OPPORTUNITY_WORDS[o.status] ?? { label: o.status, tone: 'neutral' as const };
                        return (
                          <li key={o.id} className="flex flex-col gap-2 border-b border-line pb-5 last:border-0">
                            <div className="flex flex-wrap items-center gap-2 text-[13px]">
                              <Badge tone={st.tone}>{st.label}</Badge>
                              <strong>{o.title}</strong>
                              <span className="text-muted">{B2B_PLATFORM_LABEL[o.platform as keyof typeof B2B_PLATFORM_LABEL] ?? o.platform}{o.score !== null ? ` · fit ${o.score}` : ''}{o.budgetMaxMinor !== null ? ` · up to ${o.currency} ${(o.budgetMaxMinor / 100).toLocaleString('en-IN')}` : ''}</span>
                              {o.url ? <a href={o.url} rel="noopener noreferrer" className="text-xs text-brand hover:underline">Open on the platform</a> : null}
                            </div>
                            <p className="text-xs text-muted">{o.reasons.map(fitReasonWords).join(' · ')}{o.skipReason ? ` · skipped: ${o.skipReason}` : ''}</p>
                            {mayManage && ['scored', 'below_threshold'].includes(o.status) ? <div className="flex flex-wrap items-start gap-4"><ShortlistButton opportunityId={o.id} /><SkipForm opportunityId={o.id} /></div> : null}
                            <ul className="flex flex-col gap-2">
                              {o.proposals.map((p) => {
                                const w = PROPOSAL_STATE_WORDS[p.state] ?? { label: p.state, tone: 'neutral' as const, meaning: '' };
                                return (
                                  <li key={p.id} className="flex flex-col gap-1 rounded border border-line p-3 text-[13px]">
                                    <div className="flex flex-wrap items-center gap-2"><Badge tone={w.tone}>{w.label}</Badge><span>Version {p.version}{p.priceMinor !== null ? ` · ${p.currency} ${(p.priceMinor / 100).toLocaleString('en-IN')}` : ''} · {p.connects} connects{p.externalRef ? ` · platform ref ${p.externalRef}` : ''}</span></div>
                                    <p className="text-xs text-muted">{p.bodyPreview}…</p>
                                    <p className="text-xs text-muted">{w.meaning}</p>
                                    {p.problems.length > 0 ? <p className="text-xs text-danger">{p.problems.map(b2bProblemWords).join(' · ')}</p> : null}
                                    {mayManage ? (
                                      <div className="flex flex-wrap items-start gap-4">
                                        {p.state === 'DRAFT' || p.state === 'CHECK_FAILED' ? <CheckProposalButton versionId={p.id} /> : null}
                                        {p.state === 'CHECKED' ? <SubmitProposalButton versionId={p.id} /> : null}
                                        {p.state === 'ADMIN_REVIEW' ? <><Link href="/approvals" className="text-[13px] text-brand hover:underline">Open the Approval Center</Link><RecordSentForm versionId={p.id} /></> : null}
                                      </div>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                            {mayManage && o.status === 'shortlisted' ? <details className="text-[13px]"><summary className="cursor-pointer text-brand">Write a proposal</summary><div className="pt-3"><ProposalForm opportunityId={o.id} portfolio={b2b[4]} /></div></details> : null}
                            {mayManage && o.status === 'submitted' ? <OutcomeForm opportunityId={o.id} /> : null}
                            {mayManage && !o.leadId && ['submitted', 'won'].includes(o.status) ? <LinkLeadForm opportunityId={o.id} /> : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>

              {mayManage ? <Card><CardHeader title="Record a job" description="Paste in a job you found. Nothing is read from a marketplace automatically." /><CardBody><ImportOpportunityForm /></CardBody></Card> : null}

              <Card>
                <CardHeader title="Profiles" description="What a marketplace profile should say. Changing it on the platform is your act; you record it here with a link as evidence." />
                <CardBody>
                  <div className="flex flex-col gap-4">
                    {b2b[2].length === 0 ? <p className="text-[13px] text-muted">No profile versions yet.</p> : (
                      <ul className="flex flex-col gap-3">
                        {b2b[2].map((p) => {
                          const w = PROPOSAL_STATE_WORDS[p.state] ?? { label: p.state, tone: 'neutral' as const, meaning: '' };
                          return (
                            <li key={p.id} className="flex flex-col gap-1 rounded border border-line p-3 text-[13px]">
                              <div className="flex flex-wrap items-center gap-2"><Badge tone={w.tone}>{w.label}</Badge><span>{B2B_PLATFORM_LABEL[p.platform as keyof typeof B2B_PLATFORM_LABEL] ?? p.platform} · version {p.version} · {p.headline}</span></div>
                              {p.problems.length > 0 ? <p className="text-xs text-danger">{p.problems.map(b2bProblemWords).join(' · ')}</p> : null}
                              {mayManage ? (
                                <div className="flex flex-wrap items-start gap-4">
                                  {p.state === 'DRAFT' || p.state === 'CHECK_FAILED' ? <CheckProfileButton versionId={p.id} /> : null}
                                  {p.state === 'CHECKED' ? <SubmitProfileButton versionId={p.id} /> : null}
                                  {p.state === 'ADMIN_REVIEW' ? <><Link href="/approvals" className="text-[13px] text-brand hover:underline">Open the Approval Center</Link><RecordProfileAppliedForm versionId={p.id} /></> : null}
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {mayManage ? <ProfileForm /> : null}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Results" description="From the records themselves. Fewer than ten decided jobs is too thin to judge." />
                <CardBody>
                  {b2b[3].length === 0 ? <p className="text-[13px] text-muted">Nothing to report yet.</p> : (
                    <table className="w-full text-[13px]">
                      <thead><tr className="text-left text-xs text-muted"><th className="py-1">Marketplace</th><th>Found</th><th>Shortlisted</th><th>Sent</th><th>Won</th><th>Lost</th><th>Win rate</th><th>Revenue</th><th>Connects</th></tr></thead>
                      <tbody>{b2b[3].map((r) => <tr key={r.platform} className="border-t border-line"><td className="py-1.5">{B2B_PLATFORM_LABEL[r.platform as keyof typeof B2B_PLATFORM_LABEL] ?? r.platform}{r.insufficientData ? <div className="text-xs text-muted">Too thin to judge</div> : null}</td><td>{r.found}</td><td>{r.shortlisted}</td><td>{r.submitted}</td><td>{r.won}</td><td>{r.lost}</td><td>{r.winRatePct === null ? '-' : `${r.winRatePct}%`}</td><td>{r.revenueMinor === 0 ? '-' : (r.revenueMinor / 100).toLocaleString('en-IN')}</td><td>{r.connectsSpent}</td></tr>)}</tbody>
                    </table>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </>
      ) : null}

    </div>
  );
}
