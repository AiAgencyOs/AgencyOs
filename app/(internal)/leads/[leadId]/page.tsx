import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getLatestConversation,
  getLeadHeader,
  getLeadPipeline,
  getLeadReactivation,
  listLeadActivities,
  listMessages,
  listRequirementVersions,
} from '@/modules/crm/queries';
import {
  leadQualificationSchema,
  requirementPayloadSchema,
  LEAD_TRANSITIONS,
  type LeadStatus,
} from '@/modules/crm/schema';
import { getOpportunityForLead, listProposalsForOpportunity } from '@/modules/sales/queries';
import {
  hasLapsed,
  isLiveProposal,
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
  FollowUpForm,
  LeadNoteForm,
  LeadStatusForm,
  OpenDealForm,
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
  const mayWrite = can(context.role, 'lead.write');
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
  const activities = await listLeadActivities(leadId);
  const opportunity = await getOpportunityForLead(leadId);
  const proposals = opportunity ? await listProposalsForOpportunity(opportunity.id) : [];
  // At most one, and the database is what makes that true:
  // `proposals_live_version_key` is a partial unique index over exactly these
  // states, so this is a lookup rather than a choice between candidates.
  const liveProposal = proposals.find((p) => isLiveProposal(p.status as ProposalStatus)) ?? null;

  const leadStatus = (pipeline?.status ?? 'new') as LeadStatus;
  const dealStage = (opportunity?.stage ?? 'discovery') as OpportunityStage;
  // The stored value is jsonb; only render what the current schema recognises.
  const qualification = leadQualificationSchema.safeParse(pipeline?.qualification ?? {});

  const clock = await agencyClock();
  const now = new Date();
  const awaitingDecision = versions.filter((v) => v.status === 'proposed').length;

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

          {activities.length > 0 ? (
            <ol className="flex flex-col gap-2 border-t border-line pt-3">
              {activities.slice(0, 8).map((a) => (
                <li key={a.id} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Badge mono>{a.kind}</Badge>
                    <span className="shrink-0 text-[11px] text-faint">
                      {clock.date(a.occurred_at)}
                    </span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">{a.body}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </CardBody>
      </Card>

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

      {/* ── Extracted requirements ───────────────────────────────────── */}
      {conversation ? (
        <Card>
          <CardHeader
            title="Extracted requirements"
            icon={<IconSparkle size={16} />}
            actions={
              awaitingDecision > 0 ? (
                <Badge tone="warning" dot>
                  {awaitingDecision} awaiting you
                </Badge>
              ) : null
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

                      {/* The approval gate. The agent is L1: it proposes, a
                          human decides, and nothing downstream may treat a
                          proposal as agreed scope until it does. */}
                      {mayWrite && v.status === 'proposed' ? (
                        <RequirementDecisionForm versionId={v.id} leadId={leadId} />
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
