import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock, clockFor, getAgencyTimeZone, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getLatestConversation,
  getLeadHeader,
  getLeadPipeline,
  getLeadReactivation,
  listLeadTimeline,
  listMeetingsForLead,
  listMessages,
  listRequirementVersions,
} from '@/modules/crm/queries';
import {
  leadQualificationSchema,
  requirementPayloadSchema,
  LEAD_TRANSITIONS,
  type LeadStatus,
} from '@/modules/crm/schema';
import { timezonePair, whenOf } from '@/modules/crm/meetings-view';
import {
  listDisqualificationHistory,
  listRequirementSourceRefs,
  readQualificationCoverage,
} from '@/modules/crm/lead-insight-queries';
import { readDealBillingMode, readOpportunityOwner } from '@/modules/sales/composer-queries';
import { listInternalRoster } from '@/modules/projects/queries';

import { SalesOwnerForm } from './composer-extras';

import { MeetingRequestForm } from './meeting-request-form';
import {
  getOpportunityForLead,
  listOpenObjectionsForLead,
  listProposalsForOpportunity,
  readLivePlanSet,
} from '@/modules/sales/queries';
import {
  hasLapsed,
  isLiveProposal,
  isOpenOpportunity,
  OPPORTUNITY_TRANSITIONS,
  type OpportunityStage,
  type ProposalStatus,
} from '@/modules/sales/schema';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ChatBubble,
  ChatCanvas,
  ChatHeader,
  ComposerBar,
  DayDivider,
  IconArrowLeft,
  IconArrowUpRight,
  IconInfo,
  IconLock,
  IconSparkle,
  StatusBadge,
  SystemNote,
  humanize,
} from '@/ui';

import { ExtractionForm, MessageForm, SendToClientForm } from './message-form';
import { RequirementDecisionForm } from './requirement-decision-form';
import {
  ConvertForm,
  DealStageForm,
  DealTermsForm,
  FollowUpForm,
  LeadNoteForm,
  LeadStatusForm,
  MergeLeadForm,
  OpenDealForm,
  PaymentExceptionForm,
  QualificationForm,
} from './sales-panel';
import {
  DraftQuotationForm,
  QuotationLineForm,
  QuotationPricingForm,
  QuotationResponseForm,
  SendQuotationForm,
  SubmitQuotationForm,
} from './quotation-panel';
import {
  DraftPlanSetForm,
  PlanSetAnswerForm,
  SendPlanSetForm,
  SubmitPlanSetForm,
} from './plan-set-panel';
import { ReactivationPanel } from './reactivation-panel';
import { WaitingForSomebody } from './waiting-banner';
import { StartConversationForm } from './start-form';
import { LeadWorkspace } from './workspace';

export const metadata: Metadata = { title: 'Requirement collection' };


/** Minor units → display string, in the currency the quotation was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

const AUTHOR_LABEL: Record<string, string> = {
  client: 'Customer',
  user: 'Staff',
  agent: 'Agent',
  system: 'System',
};

/**
 * The heading over a day's messages: two relative days, then the date.
 *
 * Compared by the agency's own calendar day rather than by `Date` arithmetic —
 * `toDateString()` answers in the runtime's zone, so on a UTC server two
 * messages either side of local midnight were filed under different headings,
 * and a message sent just after midnight appeared under *yesterday*.
 */
function dayLabel(at: Date, now: Date, clock: AgencyClock): string {
  const key = clock.dayKey(at);
  if (key === clock.dayKey(now)) return 'Today';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (key === clock.dayKey(yesterday)) return 'Yesterday';
  return clock.day(at);
}

/**
 * Requirement collection for one lead: the transcript, and the requirement
 * versions extracted from it.
 *
 * The transcript is drawn as the WhatsApp conversation it actually is —
 * customer on the left, us on the right, in the order it happened. The
 * pipeline, the quotations and the extracted requirements sit in a second pane
 * beside it on a desktop and behind a tab on a phone, because they are what
 * you do *about* the conversation rather than part of it.
 *
 * Same two-layer gate as the leads list — capability re-checked here because
 * a URL can be typed, and RLS refuses the rows regardless.
 */
export default async function LeadConversationPage({
  params,
}: {
  params: Promise<{ leadId: string }>;
}) {
  const { leadId } = await params;

  const context = await requireInternal(`/leads/${leadId}`);
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const lead = await getLeadHeader(leadId);
  if (!lead) notFound();

  const conversation = await getLatestConversation(leadId);
  const messages = conversation ? await listMessages(conversation.id) : [];
  const versions = conversation ? await listRequirementVersions(conversation.id) : [];
  // SCR-009 — what each version was read from; SCR-007 — coverage and the
  // disqualification history. All three are reads of rows that already
  // existed and were shown nowhere on this page.
  const sourceRefs = conversation ? await listRequirementSourceRefs(conversation.id) : new Map();
  const coverage = await readQualificationCoverage(leadId);
  const disqualifications = await listDisqualificationHistory(leadId);
  const mayWrite = can(context.role, 'lead.write');
  const mayAssign = can(context.role, 'lead.assign');
  // The capability triple ADM-07 describes. Re-checked here for rendering only;
  // the service checks it again and RLS refuses the rows regardless.
  const mayDraft = can(context.role, 'proposal.draft');
  const maySend = can(context.role, 'proposal.send');
  // Reactivation cohort is owner-operated at the app layer — the same gate the
  // Settings pilot toggle uses; the database independently admits owner or
  // ops_admin. Only read the state when the control will render.
  const mayManageReactivation = can(context.role, 'organization.settings');
  const reactivation = mayManageReactivation ? await getLeadReactivation(leadId) : null;

  const pipeline = await getLeadPipeline(leadId);
  const timeline = await listLeadTimeline(leadId);
  const opportunity = await getOpportunityForLead(leadId);
  const proposals = opportunity ? await listProposalsForOpportunity(opportunity.id) : [];
  const openObjections = await listOpenObjectionsForLead(leadId);
  const meetings = await listMeetingsForLead(leadId);
  const agencyZone = await getAgencyTimeZone();
  // At most one, and the database is what makes that true:
  // `proposals_live_version_key` is a partial unique index over exactly these
  // states, so this is a lookup rather than a choice between candidates.
  // The same invariant one level up: `plan_sets_live_key` allows one live SET
  // per deal, and `draft_plan_set` and `draft_proposal` each supersede the
  // other kind, so a deal is offering either one quotation or one ladder.
  const planSet = opportunity ? await readLivePlanSet(opportunity.id, proposals) : null;
  // SCR-012 — the composer's owner select and GST pre-fill. The billing mode
  // exists only once the deal has a project with a confirmed profile.
  const dealOwner = opportunity ? await readOpportunityOwner(opportunity.id) : null;
  const dealBilling = opportunity ? await readDealBillingMode(opportunity.id) : null;
  const roster = opportunity && mayAssign ? await listInternalRoster() : [];
  // `liveProposal` means the live STANDALONE quotation. A plan-set member is a
  // live proposal too — slots 1..3 of `proposals_live_version_key` — and
  // without this filter every single-quotation control below would fire on one
  // of the rungs: submitting it alone, sending it alone, recording an answer
  // to it alone. The set is what moves; its members move in lockstep.
  const liveProposal =
    proposals.find((p) => isLiveProposal(p.status as ProposalStatus) && p.plan_set_id === null) ?? null;

  const leadStatus = (pipeline?.status ?? 'new') as LeadStatus;
  const dealStage = (opportunity?.stage ?? 'discovery') as OpportunityStage;
  // The stored value is jsonb; only render what the current schema recognises.
  const qualification = leadQualificationSchema.safeParse(pipeline?.qualification ?? {});

  const clock = await agencyClock();
  const now = new Date();
  const awaitingDecision = versions.filter((v) => v.status === 'proposed').length;
  // SCR-009's KPI chips, derived from versions[].status and the latest
  // still-standing payload. "Client-confirmed" is an accepted version the
  // client was shown (sent_for_confirmation_at) before a person accepted
  // it; "accepted" alone is the agency's decision without that step.
  const acceptedVersions = versions.filter((v) => v.status === 'accepted');
  const clientConfirmed = acceptedVersions.filter((v) => v.sent_for_confirmation_at).length;
  const standing = versions.find((v) => v.status === 'accepted' || v.status === 'proposed');
  const standingPayload = standing ? requirementPayloadSchema.safeParse(standing.payload) : null;
  const openQuestions = standingPayload?.success ? standingPayload.data.openQuestions.length : null;

  /* ── Pane one: the conversation ─────────────────────────────────────── */

  const chat = (
    <div className="flex h-[68dvh] min-h-[420px] flex-col overflow-hidden rounded-xl border border-line shadow-sm lg:sticky lg:top-[4.75rem] lg:h-[calc(100dvh-11.5rem)]">
      <ChatHeader
        name={lead.title}
        status={
          <>
            {humanize(lead.status)} · via {humanize(lead.source)}
            {conversation ? ` · ${messages.length} message${messages.length === 1 ? '' : 's'}` : ''}
          </>
        }
        back={
          <Link
            href="/leads"
            aria-label="Back to leads"
            className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--wa-header-fg)] opacity-85 hover:bg-white/10 hover:opacity-100 lg:hidden"
          >
            <IconArrowLeft size={20} />
          </Link>
        }
      />

      {!conversation ? (
        <ChatCanvas className="flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <SystemNote>No conversation yet for this lead.</SystemNote>
            {mayWrite ? <StartConversationForm leadId={leadId} /> : null}
          </div>
        </ChatCanvas>
      ) : (
        <>
          {/* Above the thread, not inside it. A client told that somebody is
              coming is waiting on this being seen, so it must not be something
              a reader scrolls past. */}
          {conversation.agent_paused_at && conversation.agent_paused_reason ? (
            <WaitingForSomebody
              conversationId={conversation.id}
              leadId={leadId}
              reason={conversation.agent_paused_reason}
              since={clock.dateTime(new Date(conversation.agent_paused_at))}
              mayWrite={mayWrite}
            />
          ) : null}

          <ChatCanvas>
            <SystemNote>
              <span className="inline-flex items-center gap-1.5">
                <IconLock size={12} />
                Messages sent from the composer reach the customer on WhatsApp. Notes added to
                the transcript stay here.
              </span>
            </SystemNote>

            {messages.length === 0 ? (
              <SystemNote>Nothing recorded yet.</SystemNote>
            ) : (
              messages.map((m, i) => {
                // Inbound is the customer; everything else is us. `direction`
                // is authoritative when the ingest recorded it, and author_type
                // is the fallback for rows written before it existed.
                const incoming =
                  m.direction === 'inbound' || (m.direction === null && m.author_type === 'client');
                const at = new Date(m.occurred_at);
                const previous = i > 0 ? messages[i - 1] : undefined;
                const previousAt = previous ? new Date(previous.occurred_at) : null;
                const newDay = !previousAt || clock.dayKey(previousAt) !== clock.dayKey(at);
                const previousIncoming = previous
                  ? previous.direction === 'inbound' ||
                    (previous.direction === null && previous.author_type === 'client')
                  : null;
                // A tail on every bubble makes a run of five look like five
                // separate people; only the first of a run gets one.
                const startsRun = newDay || previousIncoming !== incoming;

                return (
                  <div key={m.id} className="contents">
                    {newDay ? <DayDivider>{dayLabel(at, now, clock)}</DayDivider> : null}
                    <ChatBubble
                      outgoing={!incoming}
                      author={
                        startsRun && !incoming
                          ? (AUTHOR_LABEL[m.author_type] ?? m.author_type)
                          : undefined
                      }
                      body={m.body}
                      time={clock.clock(at)}
                      delivery={m.delivery}
                      wire={m.wire}
                      media={m.mediaKind}
                      mediaCaption={m.caption}
                      mediaDescription={m.media_description}
                      tail={startsRun}
                    />
                  </div>
                );
              })
            )}
          </ChatCanvas>

          {mayWrite ? (
            <ComposerBar>
              <MessageForm conversationId={conversation.id} leadId={leadId} />
              <SendToClientForm conversationId={conversation.id} leadId={leadId} />
            </ComposerBar>
          ) : (
            <ComposerBar>
              <p className="px-2 py-1.5 text-center text-[13px] text-muted">
                Your role can read this conversation but not write to it.
              </p>
            </ComposerBar>
          )}
        </>
      )}
    </div>
  );

  /* ── Pane two: what the business knows ──────────────────────────────── */

  const details = (
    <div className="flex flex-col gap-4">
      {/* ── Sales pipeline ───────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Sales"
          actions={
            <>
              <StatusBadge status={leadStatus} />
              {opportunity ? <Badge tone="info">Deal: {humanize(dealStage)}</Badge> : null}
            </>
          }
          description={lead.summary ?? undefined}
        />
        <CardBody className="flex flex-col gap-4">
          {pipeline?.next_follow_up_at ? (
            <Callout tone="info" icon={<IconInfo size={15} />}>
              Follow-up due {clock.date(pipeline.next_follow_up_at)}
            </Callout>
          ) : null}

          {pipeline?.disqualified_reason ? (
            <Callout tone="danger">Disqualified: {pipeline.disqualified_reason}</Callout>
          ) : null}

          {/* Blueprint §8: the WON state is "Converted + handoff link". The
              packet exists from the moment of the win (G-232), before any
              conversion, so the link does not wait for a project. */}
          {opportunity && dealStage === 'won' ? (
            <Link
              href={`/handoffs/${opportunity.id}`}
              className="inline-flex items-center gap-1 self-start text-[13px] font-medium underline underline-offset-2 hover:text-foreground"
            >
              Handoff packet — what Sales hands to Phase 2
              <IconArrowUpRight size={13} />
            </Link>
          ) : null}

          {mayWrite ? (
            <>
              <LeadStatusForm
                leadId={leadId}
                current={leadStatus}
                allowed={(LEAD_TRANSITIONS[leadStatus] ?? []).filter((s) => s !== 'converted')}
              />
              <FollowUpForm leadId={leadId} current={pipeline?.next_follow_up_at ?? null} />

              <details className="rounded-lg border border-line bg-surface px-3 py-2">
                <summary className="cursor-pointer text-[13px] font-semibold">
                  Qualification
                </summary>
                <div className="pt-3">
                  <QualificationForm
                    leadId={leadId}
                    current={qualification.success ? qualification.data : {}}
                  />
                </div>
              </details>

              {reactivation ? (
                <ReactivationPanel
                  leadId={leadId}
                  inPilot={reactivation.inPilot}
                  consentEligible={reactivation.consentEligible}
                />
              ) : null}

              {mayManageReactivation ? <MergeLeadForm leadId={leadId} /> : null}

              {!opportunity ? (
                <OpenDealForm leadId={leadId} defaultName={lead.title} />
              ) : (
                <>
                  <DealStageForm
                    leadId={leadId}
                    opportunityId={opportunity.id}
                    current={dealStage}
                    allowed={OPPORTUNITY_TRANSITIONS[dealStage] ?? []}
                  />
                  {/* ADM-43: an OPEN deal's terms may be corrected. A settled
                      one may not, and the door refuses it — so the control is
                      not offered on one either. */}
                  {isOpenOpportunity(dealStage) ? (
                    <DealTermsForm
                      leadId={leadId}
                      opportunityId={opportunity.id}
                      name={opportunity.name}
                      valueMinor={opportunity.value_minor}
                      expectedCloseOn={opportunity.expected_close_on}
                      currency={opportunity.currency}
                    />
                  ) : null}
                  {isOpenOpportunity(dealStage) ? (
                    <PaymentExceptionForm leadId={leadId} opportunityId={opportunity.id} />
                  ) : null}
                  {dealStage === 'won' ? (
                    <ConvertForm
                      leadId={leadId}
                      opportunityId={opportunity.id}
                      defaultProjectName={lead.title}
                    />
                  ) : null}
                </>
              )}

              <LeadNoteForm leadId={leadId} />
            </>
          ) : null}

          {/* Doc 09 §28: every recorded event, not only the 7 kinds
              lead_activities holds — quote and objection events merged in
              by crm.lead_timeline, not just the note/status/message feed. */}
          {timeline.length > 0 ? (
            <ol className="flex flex-col gap-2 border-t border-line pt-3">
              {timeline.slice(0, 8).map((e) => (
                <li key={`${e.evidence_type}:${e.evidence_id}:${e.occurred_at}`} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Badge mono>{e.event_type}</Badge>
                    <span className="shrink-0 text-[11px] text-faint">
                      {clock.date(e.occurred_at)}
                    </span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">{e.summary}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </CardBody>
      </Card>

      {/* SCR-007 — which of Document 09 §9's areas the conversation has
          already answered, in the client's own words. Read only by project
          onboarding until now. A count of facts, not a judgement (ADM-88):
          no score is derived and none is shown. */}
      <Card>
        <CardHeader
          title="Qualification coverage"
          description="What the client has already said, by area. What is left to ask is the difference."
          actions={
            <Badge tone={coverage.covered.length === coverage.total ? 'success' : 'neutral'}>
              {coverage.covered.length} of {coverage.total} areas
            </Badge>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {coverage.covered.length === 0 ? (
            <p className="text-[13px] text-muted">
              Nothing recorded yet. Coverage rows are written by the qualifier as the conversation answers an area; none has.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {coverage.covered.map((c) => (
                <li key={c.area} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Badge tone="success" dot>{humanize(c.area)}</Badge>
                    <span className="shrink-0 text-[11px] text-faint">{clock.date(c.createdAt)}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">&ldquo;{c.quote}&rdquo;</p>
                </li>
              ))}
            </ul>
          )}
          {coverage.missing.length > 0 ? (
            <p className="text-xs text-faint">
              Still open: {coverage.missing.map((a) => humanize(a)).join(', ')}.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* SCR-007 — every time this lead was disqualified, and why. The row's
          own reason column holds only the latest and is cleared on reopen;
          the activity rows are the history. */}
      {disqualifications.length > 0 ? (
        <Card>
          <CardHeader
            title="Disqualification history"
            description={`${disqualifications.length} time${disqualifications.length === 1 ? '' : 's'}, from lead_activities.`}
          />
          <CardBody>
            <ol className="flex flex-col gap-2">
              {disqualifications.map((d) => (
                <li key={d.id} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-danger">{d.reason}</span>
                    <span className="shrink-0 text-[11px] text-faint">{clock.dateTime(d.occurredAt)}</span>
                  </div>
                  <p className="text-xs text-muted">
                    {d.from ? `from ${humanize(d.from)}` : 'status change'}
                    {d.actorId ? ` · by ${d.actorId.slice(0, 8)}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      ) : null}

      {/* Brief §23/§24, gap G-157: what the client asked to change, in their
          own words. Until this list existed the objection rows were read only
          by the agent's context file — the person who has to draft the
          revision could not see the ask without opening WhatsApp. Outside the
          Quotations card on purpose: an objection needs only a lead, and a
          concern raised before any deal exists is still work. */}
      {openObjections.length > 0 ? (
        <Card>
          <CardBody className="flex flex-col gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-warning">
              They asked — nobody has answered
            </p>
            <ol className="flex flex-col gap-1">
              {openObjections.map((o) => (
                <li key={o.id} className="text-[13px]">
                  <span className="mr-1.5 font-mono text-[11px] text-faint">
                    {o.round}. {o.kind}
                  </span>
                  “{o.concern}”
                </li>
              ))}
            </ol>
            {liveProposal?.status === 'sent' && mayDraft ? (
              // Only when the draft form actually renders below — a sentence
              // pointing at a form the viewer cannot see is a small lie
              // about their own screen.
              <p className="text-[11px] text-muted">
                A quotation is out with them. Drafting the next version below is what answers a
                change request — the owner approves it before it goes anywhere.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ── Quotations (G-011, ADM-07) ───────────────────────────────── */}
      {opportunity ? (
        <Card>
          <CardHeader
            title="Quotations"
            actions={
              liveProposal ? (
                <Badge tone="info" mono>
                  v{liveProposal.version}
                </Badge>
              ) : (
                <span className="text-xs text-muted">none live</span>
              )
            }
          />
          <CardBody className="flex flex-col gap-4">
            {/* The history §16 asks for: superseded versions stay readable. */}
            {proposals.length > 0 ? (
              <ol className="flex flex-col divide-y divide-line">
                {proposals.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1 py-2 first:pt-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        <span className="mr-1.5 font-mono text-xs text-faint">v{p.version}</span>
                        {p.title}
                      </span>
                      <span className="tabular shrink-0 text-[13px] font-semibold">
                        {money(p.total_minor, p.currency)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={p.status} />
                      {p.valid_until ? (
                        <span className="text-[11px] text-faint">
                          until {clock.date(p.valid_until)}
                        </span>
                      ) : null}
                      {/* Every version, not just the live one — a superseded
                          quotation's document is part of the history §16
                          keeps, and the PDF's own status band says what it
                          is (G-156). */}
                      <a
                        href={`/api/quotations/${p.id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
                      >
                        PDF
                      </a>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}

            {/* ── the plan-set offer (Part H, ADM-97; G-305) ──────────── */}
            {planSet ? (
              <div className="flex flex-col gap-3 border-t border-line pt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium">
                    An offer of {planSet.members.length} plans
                  </span>
                  <StatusBadge status={planSet.status} />
                </div>

                <ul className="flex flex-col gap-2">
                  {planSet.members.map((m) => (
                    <li key={m.id} className="flex flex-col gap-2 rounded-md border border-line p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                          {m.plan_label ?? `Plan ${m.plan_slot ?? ''}`}
                          <span className="ml-1.5 text-muted">{m.title}</span>
                          {m.id === planSet.recommendedProposalId ? (
                            <Badge tone="info" className="ml-1.5">
                              recommended
                            </Badge>
                          ) : null}
                        </span>
                        <span className="tabular shrink-0 text-[13px] font-semibold">
                          {money(m.total_minor, m.currency)}
                        </span>
                      </div>

                      {/* The SAME line and pricing forms a standalone quotation
                          uses: a member is an ordinary draft proposal, and a
                          second pricing path would be a second place for the
                          arithmetic to drift. */}
                      {mayDraft && planSet.status === 'draft' ? (
                        <>
                          <QuotationLineForm leadId={leadId} proposalId={m.id} />
                          <QuotationPricingForm
                            leadId={leadId}
                            proposalId={m.id}
                            discountMinor={m.discount_minor}
                            taxMinor={m.tax_minor}
                            subtotalMinor={m.subtotal_minor}
                            billingMode={dealBilling?.mode ?? null}
                          />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>

                {mayDraft && planSet.status === 'draft' ? (
                  <SubmitPlanSetForm leadId={leadId} planSet={planSet} />
                ) : null}

                {planSet.status === 'pending_approval' ? (
                  <Callout tone="warning">
                    The offer is with the owner, at the recommended plan’s price. It cannot be edited
                    or sent until they answer.
                  </Callout>
                ) : null}

                {maySend && planSet.status === 'approved' ? (
                  <SendPlanSetForm
                    leadId={leadId}
                    planSetId={planSet.id}
                    conversationId={conversation?.id ?? null}
                  />
                ) : null}

                {maySend && planSet.status === 'sent' ? (
                  <PlanSetAnswerForm leadId={leadId} planSet={planSet} />
                ) : null}
              </div>
            ) : null}

            {/* SCR-012 — who owns this deal. The row has carried an owner
                since creation; this is the first place it is shown or changed. */}
            {mayAssign && dealOwner ? (
              <SalesOwnerForm
                leadId={leadId}
                opportunityId={opportunity.id}
                ownerId={dealOwner.ownerId}
                roster={roster.map((m) => ({ userId: m.userId, fullName: m.fullName, role: m.role }))}
              />
            ) : dealOwner ? (
              <p className="text-[12.5px] text-muted">
                Sales owner: {dealOwner.ownerId ? <span className="font-mono">{dealOwner.ownerId.slice(0, 8)}</span> : 'nobody'}
              </p>
            ) : null}

            {mayDraft ? (
              <>
                {/* Drafting is always available: the next version is how every
                    change is made once a version leaves draft. */}
                <DraftQuotationForm
                  leadId={leadId}
                  opportunityId={opportunity.id}
                  defaultTitle={lead.title}
                  supersedes={liveProposal?.version ?? null}
                />

                {/* Part H's other shape, offered only when there is no offer in
                    flight: drafting a set SUPERSEDES whatever is live, and a
                    control that quietly retires a quotation somebody is waiting
                    on an answer to should not sit beside one that does not. */}
                {planSet === null && liveProposal === null ? (
                  <DraftPlanSetForm
                    leadId={leadId}
                    opportunityId={opportunity.id}
                    defaultTitle={lead.title}
                  />
                ) : null}

                {liveProposal?.status === 'draft' ? (
                  <div className="flex flex-col gap-3 border-t border-line pt-3">
                    <p className="text-xs text-muted">
                      v{liveProposal.version} — subtotal{' '}
                      {money(liveProposal.subtotal_minor, liveProposal.currency)}, total{' '}
                      {money(liveProposal.total_minor, liveProposal.currency)}
                    </p>
                    <QuotationLineForm leadId={leadId} proposalId={liveProposal.id} />
                    <QuotationPricingForm
                      leadId={leadId}
                      proposalId={liveProposal.id}
                      discountMinor={liveProposal.discount_minor}
                      taxMinor={liveProposal.tax_minor}
                      subtotalMinor={liveProposal.subtotal_minor}
                      billingMode={dealBilling?.mode ?? null}
                    />
                    <SubmitQuotationForm leadId={leadId} proposalId={liveProposal.id} />
                  </div>
                ) : null}

                {liveProposal?.status === 'pending_approval' ? (
                  <Callout tone="warning" className="mt-1">
                    v{liveProposal.version} is with the owner for approval. It cannot be edited or
                    sent until they answer — the next version is how it changes.
                  </Callout>
                ) : null}
              </>
            ) : null}

            {maySend && liveProposal?.status === 'approved' ? (
              <div className="border-t border-line pt-3">
                <SendQuotationForm
                  leadId={leadId}
                  proposalId={liveProposal.id}
                  conversationId={conversation?.id ?? null}
                />
              </div>
            ) : null}

            {maySend && liveProposal?.status === 'sent' ? (
              <div className="border-t border-line pt-3">
                <QuotationResponseForm
                  leadId={leadId}
                  proposalId={liveProposal.id}
                  lapsed={hasLapsed(liveProposal.valid_until)}
                />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ── Meetings (A08/A09, G-234) ────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Meetings"
          actions={
            <Link href="/meetings" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">
              All meetings
            </Link>
          }
        />
        <CardBody>
          {meetings.length === 0 ? (
            <div className="flex flex-col gap-3">
              {/*
                This said "None can be proposed from here: no calendar provider
                is configured (BLK-005)" — hardcoded, with no check behind it,
                and still saying it on 2026-09-14 with a Google calendar
                configured and verified. What was actually true was narrower and
                nobody had written it down: no door existed to record that a
                client had asked. It does now (Scheduler §3.1, §4).
              */}
              <p className="text-[13px] text-muted">
                No meeting has been requested or booked for this lead. A client who asks for one is recorded here —
                nothing is agreed by recording it, and times are offered from the calendar afterwards.
              </p>
              {mayWrite ? (
                <MeetingRequestForm leadId={leadId} conversationId={conversation?.id ?? null} agencyZone={agencyZone} />
              ) : null}
            </div>
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {meetings.map((m) => {
                const when = whenOf(m);
                const zones = timezonePair(m.timezone, agencyZone);
                const local = clockFor(zones.primary);
                return (
                  <li key={m.id} className="py-2 first:pt-0">
                    <Link href={`/meetings/${m.id}`} className="flex flex-wrap items-center gap-2 text-[13px] hover:text-foreground">
                      <StatusBadge status={m.status} dot={false} />
                      <span className="text-muted">{humanize(m.booked_mode ?? m.requested_mode)}</span>
                      <span className="tabular">
                        {when.kind === 'unscheduled' ? 'no time' : `${local.dateTime(when.start)} ${zones.primary}`}
                      </span>
                      {when.kind === 'requested' ? <span className="text-[11px] text-faint">requested, not agreed</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </CardBody>
      </Card>

      {/* ── Extracted requirements ───────────────────────────────────── */}
      {conversation ? (
        <Card>
          <CardHeader
            title="Extracted requirements"
            icon={<IconSparkle size={16} />}
            actions={
              <>
                {awaitingDecision > 0 ? (
                  <Badge tone="warning" dot>
                    {awaitingDecision} awaiting you
                  </Badge>
                ) : null}
                {/* SCR-009's KPI chips — counts of versions by status, and
                    the open questions on the version that stands. */}
                {versions.length > 0 ? (
                  <>
                    <Badge tone="neutral">{versions.filter((v) => v.status === 'proposed').length} proposed</Badge>
                    <Badge tone={clientConfirmed > 0 ? 'success' : 'neutral'}>{clientConfirmed} client-confirmed</Badge>
                    <Badge tone="neutral">{acceptedVersions.length - clientConfirmed} accepted unconfirmed</Badge>
                    {openQuestions !== null ? (
                      <Badge tone={openQuestions > 0 ? 'warning' : 'success'}>{openQuestions} open question{openQuestions === 1 ? '' : 's'}</Badge>
                    ) : null}
                  </>
                ) : null}
              </>
            }
          />
          <CardBody className="flex flex-col gap-3">
            {versions.length === 0 ? (
              <p className="text-[13px] text-muted">
                None yet. Extraction runs as a queued job and records a version here.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {versions.map((v) => {
                  const parsed = requirementPayloadSchema.safeParse(v.payload);
                  return (
                    <li key={v.id} className="rounded-lg border border-line bg-surface-sunken p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold">v{v.version}</span>
                        <StatusBadge status={v.status} />
                        <span className="text-[11px] text-faint">by {v.source}</span>
                        <span className="ml-auto text-[11px] text-faint">
                          {clock.dateTime(v.created_at)}
                        </span>
                      </div>

                      {parsed.success ? (
                        <div className="mt-2 flex flex-col gap-2 text-[13px]">
                          <p className="leading-relaxed">{parsed.data.summary}</p>
                          {parsed.data.scopeItems.length > 0 ? (
                            <ul className="flex flex-col gap-1">
                              {parsed.data.scopeItems.map((s) => (
                                <li key={s.title} className="flex gap-2 text-muted">
                                  <span aria-hidden className="text-faint">
                                    ·
                                  </span>
                                  <span>{s.title}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {parsed.data.assumptions.length > 0 ? (
                            <p className="text-xs text-faint">
                              {parsed.data.assumptions.length} assumption
                              {parsed.data.assumptions.length === 1 ? '' : 's'} — not confirmed by the client
                            </p>
                          ) : null}
                          {parsed.data.niceToHaves.length > 0 ? (
                            <p className="text-xs text-faint">
                              {parsed.data.niceToHaves.length} nice-to-have
                              {parsed.data.niceToHaves.length === 1 ? '' : 's'} — not committed scope
                            </p>
                          ) : null}
                          {parsed.data.exclusions.length > 0 ? (
                            <p className="text-xs text-faint">
                              {parsed.data.exclusions.length} explicit exclusion
                              {parsed.data.exclusions.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                          {parsed.data.designReferences.length > 0 ? (
                            <p className="text-xs text-faint">
                              {parsed.data.designReferences.length} design reference
                              {parsed.data.designReferences.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                          {parsed.data.openQuestions.length > 0 ? (
                            <p className="text-xs text-faint">
                              {parsed.data.openQuestions.length} open question
                              {parsed.data.openQuestions.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                        </div>
                      ) : v.status === 'failed' ? (
                        <p className="mt-2 text-[13px] text-muted">
                          Extraction failed for this transcript. Add more detail or queue it
                          again.
                        </p>
                      ) : (
                        <p className="mt-2 text-[13px] text-muted">
                          Stored payload does not match the current requirement schema.
                        </p>
                      )}

                      {/* SCR-009 — what this version was read from. The row
                          holds a message count, the job that produced it and
                          the confirmation message it went out in; it holds no
                          list of message ids, so none is invented. */}
                      {(() => {
                        const ref = sourceRefs.get(v.id);
                        if (!ref) return null;
                        const parts = [
                          ref.sourceMessageCount !== null ? `read ${ref.sourceMessageCount} message${ref.sourceMessageCount === 1 ? '' : 's'}` : null,
                          ref.sourceJobId ? `job ${ref.sourceJobId.slice(0, 8)}` : null,
                          ref.confirmationMessageId ? `sent to client as message ${ref.confirmationMessageId.slice(0, 8)}` : null,
                        ].filter((x): x is string => Boolean(x));
                        return parts.length > 0 ? (
                          <p className="mt-2 font-mono text-[11px] text-faint">Source: {parts.join(' · ')}</p>
                        ) : null;
                      })()}

                      {/* Editing a version is not offered: crm.requirement_versions
                          is append-only except for status (a trigger refuses
                          any payload change) and has no draft state — a change
                          is a new extraction, which is the form below. */}

                      {/* The approval gate. The agent is L1: it proposes, a
                          human decides, and nothing downstream may treat a
                          proposal as agreed scope until it does. */}
                      {mayWrite && v.status === 'proposed' ? (
                        <RequirementDecisionForm
                          versionId={v.id}
                          leadId={leadId}
                          sentForConfirmationAt={v.sent_for_confirmation_at ?? null}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}

            {mayWrite ? <ExtractionForm conversationId={conversation.id} leadId={leadId} /> : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="hidden items-center gap-2 text-[13px] text-muted lg:flex">
        <Link href="/leads" className="flex items-center gap-1.5 hover:text-foreground">
          <IconArrowLeft size={15} />
          Leads
        </Link>
        <span className="text-faint">/</span>
        <span className="truncate font-medium text-foreground">{lead.title}</span>
      </div>

      <LeadWorkspace chat={chat} details={details} detailsCount={awaitingDecision} />
    </div>
  );
}
