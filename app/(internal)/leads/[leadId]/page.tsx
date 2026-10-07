import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock, clockFor, getAgencyTimeZone, type AgencyClock } from '@/lib/admin/agency-clock';
import { readRequirementLinks, readRequirementLinkTargets } from '@/lib/admin/requirement-links';
import { readRequirementSets } from '@/lib/admin/requirement-set';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getLatestConversation,
  getLeadFacts,
  getLeadHeader,
  getLeadPipeline,
  getLeadReactivation,
  listLeadTimeline,
  listMeetingsForLead,
  listMessages,
  listRequirementVersions,
} from '@/modules/crm/queries';
import { readConversationWindow, readProjectGroupForLead } from '@/modules/crm/window-queries';
import { listLeadServiceSuggestions, readLeadService } from '@/modules/crm/lead-service-queries';
import { heatTitle } from '@/modules/crm/lead-heat';
import { LeadHeatBadge } from '@/modules/crm/lead-heat-badge';
import { readLeadHeatReading } from '@/modules/crm/lead-heat-queries';
import { describeBudget } from '@/modules/crm/budget-bands';
import { readBudgetBands } from '@/modules/crm/budget-bands-queries';
import { listSequencesForLead } from '@/modules/crm/lead-sequence-queries';
import { readRequirementQuestionSends } from '@/modules/crm/requirement-question-queries';
import { readProjectsForRequirementVersions } from '@/modules/projects/requirements-tab-queries';
import { situationFor } from '@/modules/crm/follow-up-situations';
import { readRetryHistory } from '@/lib/observability/retry-queries';
import {
  leadQualificationSchema,
  requirementPayloadSchema,
  LEAD_TRANSITIONS,
  type LeadStatus,
} from '@/modules/crm/schema';
import { timezonePair, whenOf } from '@/modules/crm/meetings-view';
import { readLeadFiles } from '@/modules/crm/lead-files-service';
import { listContracts } from '@/modules/sales/contract-service';
import {
  listDisqualificationHistory,
  listRequirementSourceRefs,
  readQualificationCoverage,
} from '@/modules/crm/lead-insight-queries';
import { handoffHeaderValue, requirementHeaderValue } from '@/modules/crm/requirement-header';
import { readDealBillingMode, readOpportunityOwner } from '@/modules/sales/composer-queries';

import { SalesOwnerForm } from './composer-extras';
import { LeadTabs } from './lead-tabs';
import { LeadStageStrip } from './stage-strip';
import { listTasksForLead } from '@/modules/crm/lead-task-queries';
import { listInternalRoster } from '@/modules/projects/queries';

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
  ActivityFeed,
  Avatar,
  Badge,
  buttonClass,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ChatBubble,
  DetailPanel,
  EntityHeader,
  HeaderFigure,
  IconCalendar,
  IconClock,
  IconFlag,
  IconInvoices,
  IconMessage,
  IconPhone,
  IconPlus,
  IconRupee,
  IconUser,
  IconChevronDown,
  QuickActions,
  ChatCanvas,
  ChatHeader,
  ComposerBar,
  DayDivider,
  IconArrowLeft,
  IconArrowUpRight,
  IconInfo,
  IconLock,
  IconSparkle,
  IconActivity,
  IconAttach,
  IconEdit,
  IconFile,
  IconList,
  IconTarget,
  StatusBadge,
  SystemNote,
  humanize,
  PermissionDenied,
  RowActionsMenu,
} from '@/ui';

import { ExtractionForm, MessageForm, SendToClientForm } from './message-form';
import { SendTemplateForm } from './template-send-form';
import { AddLeadFileForm, RemoveLeadFileButton } from './lead-files-forms';
import { ContractsTable } from '../../contracts/contracts-list';
import { NewContractForm } from '../../contracts/contract-forms';
import { listWhatsAppTemplates } from '@/modules/crm/template-queries';
import { RequirementDecisionForm } from './requirement-decision-form';
import { RequirementSetPanel } from './requirement-set-panel';
import { RequirementReviseForm } from './requirement-revise-form';
import { LeadServiceForm } from './service-form';
import { HeatOverrideForm } from './heat-override-form';
import { SequenceControls } from '../../follow-ups/sequence-controls';
import { RetryDeliveryForm } from '../../operations/retry-delivery-form';
import {
  AssignOwnerForm,
  ConvertForm,
  DealStageForm,
  LeadTagsForm,
  PauseAgentForm,
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
import { TrailLabel } from '../../trail-label';

export const metadata: Metadata = { title: 'Requirement collection' };


/** Minor units → display string, in the currency the quotation was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Who a bubble says wrote it. A reply the AI agent composed is stored with the
 * staff author type (it goes out as the agency) but names the agent in
 * `authored_by_agent`; showing it as "Staff" told an owner reading the chat
 * that a person had written something a model had.
 */
function authorOf(m: { author_type: string; authored_by_agent?: string | null }): string {
  if (m.authored_by_agent) return `AI · ${m.authored_by_agent}`;
  return AUTHOR_LABEL[m.author_type] ?? m.author_type;
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
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const lead = await getLeadHeader(leadId);
  if (!lead) notFound();
  const facts = await getLeadFacts(leadId);
  const roster = await listInternalRoster();
  // SCR-006 — the service the lead asked about, and the values already in use.
  const [service, serviceSuggestions] = await Promise.all([readLeadService(leadId), listLeadServiceSuggestions()]);
  // Owner decision 1 (round 2, ADM-88): Hot / Warm / Cold from recorded reasons; the stored score is never read.
  const heatReading = await readLeadHeatReading({ id: leadId, status: lead.status });
  // Q-BAND: the owner's budget bands.
  const budgetBands = await readBudgetBands();

  const conversation = await getLatestConversation(leadId);
  const messages = conversation ? await listMessages(conversation.id) : [];
  // SCR-060 — what became of each retry of a failed send on this thread.
  const retryHistory = await readRetryHistory(messages.filter((m) => m.delivery === 'failed').map((m) => m.id));
  // SCR-058: the window Meta will honour, asked of the same function the
  // sender asks (`crm.window_state`), and the project group behind this lead
  // when its deal became a project that has one.
  const windowState = conversation ? await readConversationWindow(conversation.id) : null;
  const projectGroup = await readProjectGroupForLead(leadId);
  const groupMessages = projectGroup ? await listMessages(projectGroup.conversationId) : [];
  const versions = conversation ? await listRequirementVersions(conversation.id) : [];
  // SCR-009 — what each version was read from; SCR-007 — coverage and the
  // disqualification history. All three are reads of rows that already
  // existed and were shown nowhere on this page.
  const sourceRefs = conversation ? await listRequirementSourceRefs(conversation.id) : new Map();
  const coverage = await readQualificationCoverage(leadId);
  const disqualifications = await listDisqualificationHistory(leadId);
  // SCR-029 — what downstream cites each version, and how far it was carried.
  const requirementSets = await readRequirementSets(versions.map((v) => v.id));
  const mayWrite = can(context, 'lead.write');
  const mayAssign = can(context, 'lead.assign');
  // Owner decision 2026-09-29 — the composer's template picker: only the
  // templates Meta approved and an Admin left active; the door checks again.
  const approvedTemplates = mayWrite && conversation
    ? (await listWhatsAppTemplates()).filter((t) => t.status === 'approved' && t.active)
    : [];
  // The capability triple ADM-07 describes. Re-checked here for rendering only;
  // the service checks it again and RLS refuses the rows regardless.
  const mayDraft = can(context, 'proposal.draft');
  const maySend = can(context, 'proposal.send');
  // Reactivation cohort is owner-operated at the app layer — the same gate the
  // Settings pilot toggle uses; the database independently admits owner or
  // ops_admin. Only read the state when the control will render.
  const mayManageReactivation = can(context, 'organization.settings');
  const reactivation = mayManageReactivation ? await getLeadReactivation(leadId) : null;

  const pipeline = await getLeadPipeline(leadId);
  const timeline = await listLeadTimeline(leadId);
  const opportunity = await getOpportunityForLead(leadId);
  const proposals = opportunity ? await listProposalsForOpportunity(opportunity.id) : [];
  // SCR-029 (bucket G-3) — per-question clarification sends, the links a
  // person declared from each version, and what the "Link…" form may point at.
  const versionIds = versions.map((v) => v.id);
  const [questionSends, requirementLinks, linkTargets] = await Promise.all([
    readRequirementQuestionSends(versionIds),
    readRequirementLinks(versionIds),
    versionIds.length > 0 ? readRequirementLinkTargets({ opportunityId: opportunity?.id ?? null, projectIds: projectGroup ? [projectGroup.projectId] : [] }) : Promise.resolve({ quotations: [], designs: [], tasks: [] }),
  ]);
  // SCR-029: the project scope(s) frozen from these versions — the way to the project's requirement list.
  const requirementProjects = await readProjectsForRequirementVersions(versionIds);
  const leadTasks = await listTasksForLead(opportunity?.id ?? null);
  const openObjections = await listOpenObjectionsForLead(leadId);
  const meetings = await listMeetingsForLead(leadId);
  // Decision 11: the links kept on this lead. Decision 10: the contracts on its won deal.
  const leadFiles = await readLeadFiles(leadId);
  const dealContracts = opportunity ? await listContracts({ opportunityIds: [opportunity.id] }) : [];
  // SCR-007 — the follow-up sequences running against this lead, its proposals and its meetings.
  const sequences = await listSequencesForLead({ leadId, proposalIds: proposals.map((p) => p.id), meetingIds: meetings.map((m) => m.id) });
  // SCR-012 — the composer's owner select and GST pre-fill. The billing mode
  // exists only once the deal has a project with a confirmed profile.
  const dealOwner = opportunity ? await readOpportunityOwner(opportunity.id) : null;
  const dealBilling = opportunity ? await readDealBillingMode(opportunity.id) : null;
  const agencyZone = await getAgencyTimeZone();
  // At most one, and the database is what makes that true:
  // `proposals_live_version_key` is a partial unique index over exactly these
  // states, so this is a lookup rather than a choice between candidates.
  // The same invariant one level up: `plan_sets_live_key` allows one live SET
  // per deal, and `draft_plan_set` and `draft_proposal` each supersede the
  // other kind, so a deal is offering either one quotation or one ladder.
  const planSet = opportunity ? await readLivePlanSet(opportunity.id, proposals) : null;
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
    <div id="conversation" className="scroll-mt-24 flex h-[68dvh] min-h-[420px] flex-col overflow-hidden rounded-xl border border-line shadow-sm lg:sticky lg:top-[4.75rem] lg:h-[calc(100dvh-11.5rem)]">
      <ChatHeader
        name={lead.title}
        status={
          <>
            {humanize(lead.status)} · via {humanize(lead.source)}
            {conversation ? ` · ${messages.length} message${messages.length === 1 ? '' : 's'}` : ''}
          </>
        }
        actions={
          conversation ? (
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              <Badge tone={conversation.agent_paused_at ? 'warning' : 'success'} dot>
                {conversation.agent_paused_at ? 'with a person' : 'agent replying'}
              </Badge>
              {windowState ? (
                <Badge
                  tone={windowState === 'open' ? 'success' : windowState === 'group' ? 'neutral' : windowState === 'unreadable' ? 'danger' : 'warning'}
                  dot
                >
                  {windowState === 'open'
                    ? '24h window open'
                    : windowState === 'closed'
                      ? 'window closed — template only'
                      : windowState === 'never'
                        ? 'never wrote — template only'
                        : windowState === 'group'
                          ? 'group — no window'
                          : 'window unreadable'}
                </Badge>
              ) : null}
            </span>
          ) : undefined
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
                    {/* SCR-009 — an anchor per message, so a requirement version can point at what it read. */}
                    <div id={`message-${m.id}`} className="contents scroll-mt-24">
                    <ChatBubble
                      outgoing={!incoming}
                      author={
                        startsRun && !incoming
                          ? authorOf(m)
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
                      footer={
                        // SCR-057/060 — a failed send can be retried from the
                        // bubble, and says how its retries went. The retry is a
                        // new send through the same door, so the window and
                        // consent rules decide it again.
                        !incoming && m.delivery === 'failed' ? (
                          <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-muted">
                              {m.retry_count === 0
                                ? 'Not retried yet.'
                                : `Retried ${m.retry_count} time${m.retry_count === 1 ? '' : 's'}${
                                    retryHistory.get(m.id)?.last
                                      ? ` · last attempt ${retryHistory.get(m.id)!.last!.delivery ?? 'unrecorded'} ${clock.dateTime(retryHistory.get(m.id)!.last!.at)}${
                                          retryHistory.get(m.id)!.last!.error ? ` — ${retryHistory.get(m.id)!.last!.error}` : ''
                                        }`
                                      : ''
                                  }`}
                            </span>
                            {m.retry_of ? <span className="text-[11px] text-faint">This was itself a retry.</span> : null}
                            {mayWrite ? <RetryDeliveryForm messageId={m.id} leadId={leadId} /> : null}
                          </div>
                        ) : undefined
                      }
                    />
                    </div>
                  </div>
                );
              })
            )}
          </ChatCanvas>

          {mayWrite ? (
            <ComposerBar id="composer">
              <MessageForm conversationId={conversation.id} leadId={leadId} />
              <SendTemplateForm
                conversationId={conversation.id}
                leadId={leadId}
                proposalId={liveProposal?.id ?? null}
                templates={approvedTemplates.map((t) => ({
                  id: t.id,
                  label: `${t.templateName} · ${t.languageCode} (${t.situationKey.replace(/_/g, ' ')})`,
                  parameters: t.parameters,
                }))}
                windowShut={windowState === 'closed' || windowState === 'never'}
              />
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

  /* ── The rail's actions and the information pane ────────────────────── */

  const phoneDigits = facts?.contactPhone?.replace(/[^\d]/g, '') ?? null;
  // SCR-007 — last contact is the THREAD's last message, not the row's
  // updated_at (which moves on a tag edit). Both directions, and the client's
  // own last reply beside it.
  const isIncoming = (m: { direction: string | null; author_type: string }) => m.direction === 'inbound' || (m.direction === null && m.author_type === 'client');
  const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : null;
  const lastInbound = [...messages].reverse().find(isIncoming) ?? null;
  const budget = qualification.success && qualification.data.budgetMinor !== undefined ? money(qualification.data.budgetMinor, 'INR') : null;
  // Q-BAND: the band the budget falls in, then the figure; "Not recorded" when there is none.
  const budgetShown = describeBudget(qualification.success ? qualification.data.budgetMinor : undefined, budgetBands.bands, (m) => money(m, 'INR'));

  const quickActions = (
    <QuickActions
      actions={[
        ...(facts?.contactPhone ? [{ label: 'Call now', icon: <IconPhone size={13} />, href: `tel:${facts.contactPhone}` }] : []),
        ...(phoneDigits ? [{ label: 'Open in WhatsApp', icon: <IconMessage size={13} />, href: `https://wa.me/${phoneDigits}`, tone: 'whatsapp' as const }] : []),
        ...(mayDraft && opportunity ? [{ label: 'Create quote', icon: <IconInvoices size={13} />, href: '#quotations' }] : []),
        ...(mayWrite ? [{ label: 'Schedule follow-up', icon: <IconCalendar size={13} />, href: '#sales' }, { label: 'Add note', icon: <IconPlus size={13} />, href: '#sales' }] : []),
        { label: 'Meetings', icon: <IconClock size={13} />, href: '#meetings' },
        ...(opportunity && dealStage === 'won' ? [{ label: 'Handoff packet', icon: <IconFlag size={13} />, href: `/handoffs/${opportunity.id}` }] : []),
        { label: 'All leads', icon: <IconUser size={13} />, href: '/leads' },
      ]}
    />
  );

  const side = (
    <div id="overview" className="scroll-mt-24 flex flex-col gap-4">
      <DetailPanel
        title="Lead information"
        actions={mayWrite ? <a href="#sales" className="text-xs font-medium text-brand hover:underline">Edit</a> : undefined}
        rows={[
          { label: 'Name', value: facts?.contactName ?? lead.title },
          { label: 'Phone', value: facts?.contactPhone ? <span className="font-mono">{facts.contactPhone}</span> : 'Not on file' },
          ...(facts?.contactEmail ? [{ label: 'Email', value: facts.contactEmail }] : []),
          ...(facts?.contactCompany ? [{ label: 'Company', value: facts.contactCompany }] : []),
          { label: 'Source', value: humanize(lead.source) },
          // SCR-006 — free text, through its own door; the list filters on it.
          { label: 'Service', value: mayWrite ? <LeadServiceForm leadId={leadId} service={service} suggestions={serviceSuggestions} /> : (service ?? 'Not recorded') },
          { label: 'Status', value: <StatusBadge status={leadStatus} /> },
          ...(opportunity ? [{ label: 'Deal stage', value: <StatusBadge status={dealStage} /> }] : []),
          { label: 'Assigned to', value: facts?.assignedEmail ? facts.assignedEmail.split('@')[0] : 'Unassigned' },
          { label: 'Budget', value: budgetShown.text },
          ...(qualification.success && qualification.data.timelineNote ? [{ label: 'Timeline', value: qualification.data.timelineNote }] : []),
          ...(qualification.success && qualification.data.isDecisionMaker !== undefined ? [{ label: 'Decision maker', value: qualification.data.isDecisionMaker ? 'Yes' : 'No' }] : []),
          ...(facts ? [{ label: 'Created on', value: clock.dateTime(facts.createdAt) }] : []),
          { label: 'Last contact', value: lastMessage ? `${clock.dateTime(lastMessage.occurred_at)} · ${isIncoming(lastMessage) ? 'they wrote' : 'we wrote'}` : 'No message on the thread yet' },
          ...(lastInbound ? [{ label: 'Last client reply', value: clock.dateTime(lastInbound.occurred_at) }] : []),
          ...(facts ? [{ label: 'Row last updated', value: clock.dateTime(facts.updatedAt) }] : []),
        ]}
      />
      {/* Owner decision 1 (round 2): a Hot / Warm / Cold label with its reasons — never a number. */}
      <Card>
        <CardHeader title="Lead Heat" description="Worked out from the stage, the last reply and whether a budget is recorded. A person may set the label beside it, with a reason." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <div className="flex items-center gap-2">
            <LeadHeatBadge label={heatReading.label} title={heatTitle(heatReading)} />
            <span className="text-xs text-muted">{heatReading.override ? 'Set by a person; the computed label is kept below.' : heatReading.label === 'Hot' ? 'Qualified or beyond, and replied in the last 7 days.' : heatReading.label === 'Warm' ? 'At least one good sign, not yet hot.' : 'No good sign on record.'}</span>
          </div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {heatReading.reasons.map((r) => (
              <li key={r} className="px-3 py-1.5 text-[13px]">{r}</li>
            ))}
          </ul>
          {heatReading.override ? (
            <p className="rounded-lg border border-line bg-surface-hover px-3 py-2 text-[13px]">
              Set by a person to <span className="font-medium">{heatReading.override.label}</span> on {clock.dateTime(heatReading.override.at)}; the computed label is <span className="font-medium">{heatReading.computed}</span>. Reason: {heatReading.override.reason}
            </p>
          ) : null}
          {mayWrite ? <HeatOverrideForm leadId={leadId} current={heatReading.override?.label ?? null} /> : null}
        </div>
      </Card>
      {facts && (facts.tags.length > 0 || mayWrite) ? (
        <Card>
          <CardHeader title="Tags" />
          <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
            {facts.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {facts.tags.map((t) => (
                  <Badge key={t} tone="info">{t}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted">No tags yet.</p>
            )}
            {mayWrite ? <LeadTagsForm leadId={leadId} tags={facts.tags} /> : null}
          </div>
        </Card>
      ) : null}
      {/* Tasks belong to projects; a lead's are the open tasks of the project its deal became. */}
      <Card>
        <CardHeader title={`Tasks (${leadTasks.length})`} />
        {leadTasks.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">
            {opportunity ? 'No open task yet. Tasks appear here once the deal becomes a project.' : 'No deal yet, so no project and no tasks.'}
          </p>
        ) : (
          <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
            {leadTasks.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2 py-2.5 text-[13px]">
                <span className="min-w-0">
                  <Link href={`/projects/${t.projectId}`} className="block truncate font-medium text-foreground hover:text-brand">{t.title}</Link>
                  <span className="block truncate text-xs text-muted">{t.projectName}{t.dueOn ? ` · due ${clock.date(`${t.dueOn}T12:00:00Z`)}` : ''}</span>
                </span>
                <Badge tone={t.priority === 'p0' || t.priority === 'p1' ? 'danger' : 'neutral'} dot={false}>{t.priority.toUpperCase()}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div id="activity" className="scroll-mt-24">
      <ActivityFeed
        title="Recent activity"
        compact
        emptyTitle="Nothing recorded yet"
        items={timeline.slice(0, 6).map((e) => ({
          id: `${e.evidence_type}:${e.evidence_id}:${e.occurred_at}`,
          title: e.event_type.split('.').map((part) => humanize(part)).join(' · '),
          detail: e.summary,
          when: clock.date(e.occurred_at),
          tone: /lost|disqualif|fail|reject/.test(e.event_type) ? ('danger' as const) : /won|convert|accept|approv/.test(e.event_type) ? ('success' as const) : ('brand' as const),
        }))}
      />
      </div>
    </div>
  );

  /* ── The project group, in the same pane (SCR-058) ──────────────────── */

  const groupPane = projectGroup ? (
    <div className="flex max-h-[40dvh] min-h-[220px] flex-col overflow-hidden rounded-xl border border-line shadow-sm">
      <ChatHeader
        name={projectGroup.title ?? 'Project group'}
        status={
          <>
            WhatsApp group · {groupMessages.length} message{groupMessages.length === 1 ? '' : 's'} ·{' '}
            <Link href={`/projects/${projectGroup.projectId}`} className="underline underline-offset-2">
              open project
            </Link>
          </>
        }
      />
      <ChatCanvas>
        {groupMessages.length === 0 ? (
          <SystemNote>Nothing recorded in the group yet.</SystemNote>
        ) : (
          groupMessages.slice(-30).map((m) => {
            const incoming = m.direction === 'inbound' || (m.direction === null && m.author_type === 'client');
            return (
              <ChatBubble
                key={m.id}
                outgoing={!incoming}
                author={!incoming ? (AUTHOR_LABEL[m.author_type] ?? m.author_type) : undefined}
                body={m.body}
                time={clock.clock(new Date(m.occurred_at))}
                delivery={m.delivery}
                wire={m.wire}
                media={m.mediaKind}
                mediaCaption={m.caption}
                mediaDescription={m.media_description}
                tail
              />
            );
          })
        )}
      </ChatCanvas>
    </div>
  ) : null;

  /* ── Pane two: what the business knows ──────────────────────────────── */

  const details = (
    <div className="flex flex-col gap-4">
      {quickActions}

      {/* ── Sales pipeline ───────────────────────────────────────────── */}
      <Card id="sales">
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

          {/* SCR-007 — every time this lead was disqualified, and why. The
              row's own reason column holds only the latest and is cleared on
              reopen; the activity rows are the history. */}
          {disqualifications.length > 0 ? (
            <div className="rounded-lg border border-line bg-surface-sunken p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                Disqualification history · {disqualifications.length}
              </p>
              <ol className="flex flex-col gap-1.5">
                {disqualifications.map((d) => (
                  <li key={d.id} className="flex flex-col gap-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-danger">{d.reason}</span>
                      <span className="shrink-0 text-[11px] text-faint">{clock.dateTime(d.occurredAt)}</span>
                    </div>
                    <p className="text-xs text-muted">
                      {d.from ? `from ${humanize(d.from)}` : 'status change'}
                      {d.actorId ? ` · by ${roster.find((m) => m.userId === d.actorId)?.fullName ?? d.actorId.slice(0, 8)}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {/* SCR-007 — which of Document 09 §9's areas the conversation has
              already answered, in the client's own words. Read only by project
              onboarding until now. A count of facts, not a judgement (ADM-88):
              no score is derived and none is shown. */}
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Qualification coverage</p>
              <Badge tone={coverage.covered.length === coverage.total ? 'success' : 'neutral'}>
                {coverage.covered.length} of {coverage.total} areas
              </Badge>
            </div>
            {coverage.covered.length === 0 ? (
              <p className="text-[13px] text-muted">
                Nothing recorded yet. Coverage rows are written as the conversation answers an area; none has.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
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
              <p className="mt-2 text-xs text-faint">Still open: {coverage.missing.map((a) => humanize(a)).join(', ')}.</p>
            ) : null}
          </div>

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
              <AssignOwnerForm leadId={leadId} current={facts?.assignedTo ?? null} roster={roster.map((r) => ({ userId: r.userId, fullName: r.fullName }))} />
              {conversation && !conversation.agent_paused_at ? <PauseAgentForm conversationId={conversation.id} leadId={leadId} /> : null}

              <details id="qualification" className="scroll-mt-24 rounded-lg border border-line bg-surface px-3 py-2">
                <summary className="cursor-pointer text-[13px] font-semibold">
                  Qualification
                </summary>
                <p className="pt-2 text-xs text-muted">
                  <Link href={`/leads/${leadId}/qualification`} className="font-medium text-brand hover:underline">Open the full Qualification screen</Link>
                </p>
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

              <div id="notes" className="scroll-mt-24">
                <LeadNoteForm leadId={leadId} />
              </div>
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
        <Card id="quotations">
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
                        className="text-[11px] text-muted underline underline-offset-2 hover:text-foreground"
                      >
                        PDF
                      </a>
                    </div>
                    {/* Why this version was sent back — the owner's own note,
                        kept on the version so the history says it (it used to
                        live only on the approval, which is cleared). */}
                    {p.sent_back_note ? (
                      <p className="text-[11px] text-muted">
                        Sent back{p.sent_back_at ? ` ${clock.date(p.sent_back_at)}` : ''}: {p.sent_back_note}
                      </p>
                    ) : null}
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
                Sales owner: {dealOwner.ownerId ? (roster.find((m) => m.userId === dealOwner.ownerId)?.fullName ?? dealOwner.ownerId.slice(0, 8)) : 'nobody'}
              </p>
            ) : null}

            {mayDraft ? (
              <>
                {/* SCR-007 — "create quotation after requirements are
                    accepted": the FIRST quotation on a deal waits for an
                    accepted requirement version, which the draft then cites
                    (§12). A deal that already has quotations keeps drafting
                    the next version — that is how every change is made once
                    a version leaves draft — and cites the accepted version
                    when there is one. */}
                {proposals.length === 0 && acceptedVersions.length === 0 ? (
                  <Callout tone="info" icon={<IconInfo size={15} />}>
                    A quotation is drafted once a requirement version is accepted. {versions.length === 0 ? 'None has been extracted yet — run the extraction below and decide on it.' : awaitingDecision > 0 ? `${awaitingDecision} version${awaitingDecision === 1 ? ' is' : 's are'} awaiting your decision below.` : 'No version is accepted; decide on one below or extract a new one.'}
                  </Callout>
                ) : (
                  <DraftQuotationForm
                    leadId={leadId}
                    opportunityId={opportunity.id}
                    defaultTitle={lead.title}
                    supersedes={liveProposal?.version ?? null}
                    requirementVersionId={acceptedVersions[0]?.id ?? null}
                  />
                )}

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
                  opportunityId={opportunity?.id ?? null}
                  lapsed={hasLapsed(liveProposal.valid_until)}
                />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ── Meetings (A08/A09, G-234) ────────────────────────────────── */}
      <Card id="meetings">
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

      {/* ── Files (decision 11): links kept on the lead; they carry over to the project when the deal is won ── */}
      <Card id="files">
        <CardHeader
          title="Files"
          description="Links to what the lead has shared or you have promised — brand guidelines, briefs, references. When the deal is won they appear on the project."
        />
        <CardBody>
          <div className="flex flex-col gap-3">
            {leadFiles.length === 0 ? (
              <p className="text-[13px] text-muted">No file has been kept on this lead yet.{mayWrite ? ' Add a link below.' : ''}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {leadFiles.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 text-[13px]">
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 max-w-full truncate font-medium text-brand hover:underline">
                      {f.title}
                    </a>
                    <span className="text-xs text-muted">
                      {f.addedByName ?? 'Someone'} · {clock.dateTime(f.addedAt)}
                    </span>
                    {f.carriedToProjectId ? (
                      <Link href={`/projects/${f.carriedToProjectId}/files`} className="text-xs text-success hover:underline">
                        On the project
                      </Link>
                    ) : null}
                    {mayWrite ? (
                      <span className="ml-auto">
                        <RemoveLeadFileButton leadId={leadId} fileId={f.id} title={f.title} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {mayWrite ? <AddLeadFileForm leadId={leadId} /> : null}
          </div>
        </CardBody>
      </Card>

      {/* ── Contracts (decision 10): only a won deal has one ───────────── */}
      {opportunity && dealStage === 'won' ? (
        <Card id="contracts">
          <CardHeader
            title="Contracts"
            description="The contract for this won deal: where the file is kept, who signed it and when."
            actions={
              <Link href="/contracts" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">
                All contracts
              </Link>
            }
          />
          <CardBody>
            <div className="flex flex-col gap-4">
              {dealContracts.length === 0 ? <p className="text-[13px] text-muted">No contract has been recorded for this deal.</p> : <ContractsTable rows={dealContracts} clock={clock} mayWrite={mayWrite} showDeal={false} showClient={false} />}
              {mayWrite ? <NewContractForm deals={[]} fixedOpportunityId={opportunity.id} leadId={leadId} clientId={opportunity.client_account_id ?? null} /> : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ── Follow-up sequences (SCR-007) ────────────────────────────── */}
      <Card id="sequences">
        <CardHeader
          title="Follow-up sequences"
          description="The rhythms the worker runs against this lead, its quotations and its meetings. A decision here is a person's, with a reason, and audited."
          actions={
            <Link href="/follow-ups" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">
              All follow-ups
            </Link>
          }
        />
        <CardBody>
          {sequences.length === 0 ? (
            <p className="text-[13px] text-muted">No sequence has started on this lead. One starts by itself when a tracked situation is observed — a quotation with no reply, a missed meeting.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {sequences.map((sq) => (
                <li key={sq.id} className="flex flex-col gap-1.5 py-2 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium">{situationFor(sq.situationKey)?.name ?? humanize(sq.situationKey)}</span>
                    <StatusBadge status={sq.status} dot={false} />
                    <span className="text-xs text-muted">on the {humanize(sq.subjectType)} · {sq.attemptsSent} sent</span>
                    <span className="ml-auto text-xs text-muted">
                      {sq.nextDueAt ? `next ${clock.dateTime(sq.nextDueAt)}` : sq.lastSentAt ? `last ${clock.dateTime(sq.lastSentAt)}` : ''}
                    </span>
                  </div>
                  {sq.stopReason ? <p className="text-xs text-muted">{sq.stopReason}</p> : null}
                  {sq.lastBlockReason && sq.status === 'active' ? <p className="text-xs text-warning">Last attempt blocked: {sq.lastBlockReason}</p> : null}
                  {mayWrite ? <SequenceControls sequenceId={sq.id} status={sq.status} leadId={leadId} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ── Extracted requirements ───────────────────────────────────── */}
      {conversation ? (
        <Card id="requirements">
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
            {requirementProjects.length > 0 ? (
              <p className="text-[13px] text-muted">
                Frozen as project scope:{' '}
                {requirementProjects.map((p, i) => (
                  <span key={p.projectId}>
                    {i > 0 ? ', ' : ''}
                    <Link href={`/projects/${p.projectId}/requirements`} className="font-medium text-brand hover:underline">
                      {p.projectName} (scope v{p.scopeVersion})
                    </Link>
                  </span>
                ))}
              </p>
            ) : null}
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
                          {(() => {
                            const set = requirementSets.get(v.id);
                            return set ? (
                              <RequirementSetPanel
                                payload={parsed.data}
                                set={set}
                                clock={clock}
                                version={v.version}
                                versionId={v.id}
                                leadId={leadId}
                                status={v.status}
                                mayWrite={mayWrite}
                                questionSends={questionSends.get(v.id) ?? new Map()}
                                links={requirementLinks.get(v.id) ?? []}
                                targets={linkTargets}
                              />
                            ) : null;
                          })()}
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
                        // SCR-009 — the transcript it read: the messages that
                        // existed when the version was written, the Nth of
                        // them being the last one read. Links go to the
                        // bubbles' own anchors in the pane beside this one.
                        const readSoFar = messages.filter((m) => m.occurred_at <= v.created_at);
                        const lastRead = ref.sourceMessageCount !== null && ref.sourceMessageCount > 0 ? (readSoFar[Math.min(ref.sourceMessageCount, readSoFar.length) - 1] ?? null) : null;
                        const confirmation = ref.confirmationMessageId ? messages.find((m) => m.id === ref.confirmationMessageId) ?? null : null;
                        const hasAny = ref.sourceMessageCount !== null || ref.sourceJobId || ref.confirmationMessageId;
                        return hasAny ? (
                          <p className="mt-2 font-mono text-[11px] text-faint">
                            Source:{' '}
                            {ref.sourceMessageCount !== null ? (
                              lastRead ? (
                                <a href={`#message-${lastRead.id}`} className="underline underline-offset-2 hover:text-foreground">
                                  read {ref.sourceMessageCount} message{ref.sourceMessageCount === 1 ? '' : 's'} — up to {clock.dateTime(lastRead.occurred_at)}
                                </a>
                              ) : (
                                `read ${ref.sourceMessageCount} message${ref.sourceMessageCount === 1 ? '' : 's'}`
                              )
                            ) : null}
                            {ref.sourceJobId ? ` · job ${ref.sourceJobId.slice(0, 8)}` : ''}
                            {ref.confirmationMessageId ? (
                              <>
                                {' · '}
                                {confirmation ? (
                                  <a href={`#message-${confirmation.id}`} className="underline underline-offset-2 hover:text-foreground">
                                    sent to client {clock.dateTime(confirmation.occurred_at)}
                                  </a>
                                ) : (
                                  `sent to client as message ${ref.confirmationMessageId.slice(0, 8)}`
                                )}
                              </>
                            ) : null}
                          </p>
                        ) : null;
                      })()}

                      {/* SCR-009 — "Edit as new version". The row itself stays
                          append-only (the guard trigger refuses any payload
                          change): the edit is written as version n+1, proposed,
                          and this one becomes superseded. */}
                      {mayWrite && parsed.success && (v.status === 'proposed' || v.status === 'accepted') ? (
                        <RequirementReviseForm versionId={v.id} leadId={leadId} version={v.version} status={v.status} payload={parsed.data} />
                      ) : null}

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
      <TrailLabel name={lead.title} />
      <EntityHeader
        name={lead.title}
        tile={<Avatar name={facts?.contactName ?? lead.title} size="xl" />}
        status={<StatusBadge status={leadStatus} />}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {facts?.contactPhone ? (
              <span className="inline-flex items-center gap-1 font-mono">
                <IconPhone size={12} />
                {facts.contactPhone}
              </span>
            ) : null}
            <span>via {humanize(lead.source)}</span>
            {facts ? <span>Added {clock.dateTime(facts.createdAt)}</span> : null}
          </span>
        }
        facts={[
          ...(facts?.contactCompany ? [{ label: 'Company', value: facts.contactCompany, icon: <IconUser size={14} /> }] : []),
          ...(budget ? [{ label: 'Budget', value: budgetShown.text, icon: <IconInvoices size={14} /> }] : []),
          { label: 'Assigned to', value: facts?.assignedEmail ? facts.assignedEmail.split('@')[0] : 'Unassigned', icon: <IconUser size={14} /> },
          ...(opportunity ? [{ label: 'Deal', value: humanize(dealStage), icon: <IconFlag size={14} /> }, { label: 'Deal value', value: money(opportunity.value_minor, opportunity.currency), icon: <IconRupee size={14} /> }] : []),
          // SCR-007's header: the requirement version that stands, and who is answering the thread.
          ...(conversation ? [{ label: 'Requirements', value: requirementHeaderValue(versions), icon: <IconFile size={14} /> }] : []),
          ...(handoffHeaderValue(conversation) ? [{ label: 'Hand-off', value: handoffHeaderValue(conversation) as string, icon: <IconUser size={14} /> }] : []),
        ]}
        actions={
          <>
            {mayWrite ? (
              <a href="#sales" className={buttonClass('secondary', 'sm')}>
                <IconUser size={14} />
                Assign
              </a>
            ) : null}
            {mayWrite ? (
              <a href="#sales" className={buttonClass('secondary', 'sm')}>
                Move to
                <IconChevronDown size={14} />
              </a>
            ) : null}
            <Link href="/leads" className={buttonClass('secondary', 'sm')}>
              <IconArrowLeft size={14} />
              Leads
            </Link>
            {mayWrite && conversation ? (
              <a href="#composer" className={buttonClass('whatsapp', 'sm')}>
                <IconMessage size={14} />
                Send message
              </a>
            ) : null}
            {/* The context header's overflow: where else this lead's work lives. */}
            <RowActionsMenu
              label="More actions for this lead"
              actions={[
                { key: 'qualification', label: 'Open the qualification screen', href: `/leads/${leadId}/qualification` },
                { key: 'meetings', label: 'Meetings', href: `/leads/${leadId}?tab=meetings` },
                { key: 'quotations', label: 'Quotations', href: `/leads/${leadId}?tab=quotations` },
                { key: 'followups', label: 'Follow-ups', href: `/leads/${leadId}?tab=sequences` },
                { key: 'activity', label: 'Activity', href: `/leads/${leadId}?tab=activity` },
                { key: 'search', label: 'Find related records', href: `/search?q=${encodeURIComponent(lead.title)}` },
              ]}
            />
          </>
        }
        aside={
          <HeaderFigure
            value={pipeline?.next_follow_up_at ? clock.dateTime(pipeline.next_follow_up_at) : 'None set'}
            label="Next follow-up"
          >
            {mayWrite ? (
              <a href="#sales" className="text-[11px] font-medium text-brand hover:underline">
                {pipeline?.next_follow_up_at ? 'Change' : 'Schedule'}
              </a>
            ) : null}
          </HeaderFigure>
        }
      >
        <div className="mt-4 border-t border-line pt-4">
          <LeadStageStrip leadStatus={leadStatus} dealStage={opportunity ? dealStage : null} />
        </div>
      </EntityHeader>

      <LeadTabs
        initial="conversation"
        tabs={[
          { id: 'overview', label: 'Overview', icon: <IconList size={14} /> },
          { id: 'conversation', label: 'Conversation', icon: <IconMessage size={14} /> },
          { id: 'qualification', label: 'Qualification', icon: <IconTarget size={14} /> },
          { id: 'requirements', label: 'Requirements', icon: <IconFile size={14} /> },
          { id: 'quotations', label: 'Quote', icon: <IconInvoices size={14} /> },
          { id: 'meetings', label: 'Meetings', icon: <IconCalendar size={14} /> },
          { id: 'sequences', label: 'Follow-ups', icon: <IconCalendar size={14} /> },
          { id: 'files', label: 'Files', icon: <IconAttach size={14} /> },
          { id: 'activity', label: 'Activity', icon: <IconActivity size={14} /> },
          { id: 'notes', label: 'Notes', icon: <IconEdit size={14} /> },
        ]}
      />

      <LeadWorkspace
        chat={
          groupPane ? (
            <div className="flex flex-col gap-4">
              {chat}
              {groupPane}
            </div>
          ) : (
            chat
          )
        }
        details={details}
        side={side}
        detailsCount={awaitingDecision}
      />
    </div>
  );
}
