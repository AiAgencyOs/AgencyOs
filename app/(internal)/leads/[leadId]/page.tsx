import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  getLatestConversation,
  getLeadHeader,
  getLeadPipeline,
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
import { StartConversationForm } from './start-form';

export const metadata: Metadata = { title: 'Requirement collection · AgencyOS' };

const TIME = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const DATE = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });

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
 * Requirement collection for one lead: the transcript, and the requirement
 * versions extracted from it.
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">Requirement collection</p>
        <h1 className="text-xl font-semibold tracking-tight">{lead.title}</h1>
        <p className="text-sm text-muted">
          {lead.status} · {lead.source}
          {lead.summary ? ` · ${lead.summary}` : ''}
        </p>
      </header>

      {/* ── Sales pipeline ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4 rounded-lg border border-black/10 px-4 py-4 dark:border-white/15">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-medium">Sales</h2>
          <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
            lead: {leadStatus}
          </span>
          {opportunity ? (
            <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
              deal: {dealStage}
            </span>
          ) : null}
          {pipeline?.next_follow_up_at ? (
            <span className="text-xs text-muted">
              follow-up {DATE.format(new Date(pipeline.next_follow_up_at))}
            </span>
          ) : null}
        </div>

        {pipeline?.disqualified_reason ? (
          <p className="text-sm text-muted">Disqualified: {pipeline.disqualified_reason}</p>
        ) : null}

        {mayWrite ? (
          <>
            <LeadStatusForm
              leadId={leadId}
              current={leadStatus}
              allowed={(LEAD_TRANSITIONS[leadStatus] ?? []).filter((s) => s !== 'converted')}
            />
            <FollowUpForm leadId={leadId} current={pipeline?.next_follow_up_at ?? null} />

            <details className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
              <summary className="cursor-pointer text-sm font-medium">Qualification</summary>
              <div className="pt-3">
                <QualificationForm
                  leadId={leadId}
                  current={qualification.success ? qualification.data : {}}
                />
              </div>
            </details>

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
          <ol className="flex flex-col gap-1 border-t border-black/10 pt-3 dark:border-white/15">
            {activities.slice(0, 8).map((a) => (
              <li key={a.id} className="flex gap-2 text-sm">
                <span className="font-mono text-xs text-muted">{a.kind}</span>
                <span className="flex-1">{a.body}</span>
                <span className="font-mono text-xs text-muted">
                  {DATE.format(new Date(a.occurred_at))}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {/* ── Quotations (G-011, ADM-07) ──────────────────────────────────── */}
      {opportunity ? (
        <section className="flex flex-col gap-4 rounded-lg border border-black/10 px-4 py-4 dark:border-white/15">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-medium">Quotations</h2>
            {liveProposal ? (
              <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                v{liveProposal.version}: {liveProposal.status}
              </span>
            ) : (
              <span className="text-xs text-muted">none live</span>
            )}
          </div>

          {/* The history §16 asks for: superseded versions stay readable. */}
          {proposals.length > 0 ? (
            <ol className="flex flex-col gap-1 border-b border-black/10 pb-3 dark:border-white/15">
              {proposals.map((p) => (
                <li key={p.id} className="flex flex-wrap gap-2 text-sm">
                  <span className="font-mono text-xs text-muted">v{p.version}</span>
                  <span className="flex-1">{p.title}</span>
                  <span className="font-mono text-xs">{money(p.total_minor, p.currency)}</span>
                  <span className="font-mono text-xs text-muted">{p.status}</span>
                  {p.valid_until ? (
                    <span className="font-mono text-xs text-muted">
                      until {DATE.format(new Date(p.valid_until))}
                    </span>
                  ) : null}
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
                <div className="flex flex-col gap-3 border-t border-black/10 pt-3 dark:border-white/15">
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
                <p className="border-t border-black/10 pt-3 text-sm text-muted dark:border-white/15">
                  v{liveProposal.version} is with the owner for approval. It cannot be edited or
                  sent until they answer — the next version is how it changes.
                </p>
              ) : null}
            </>
          ) : null}

          {maySend && liveProposal?.status === 'approved' ? (
            <div className="border-t border-black/10 pt-3 dark:border-white/15">
              <SendQuotationForm
                leadId={leadId}
                proposalId={liveProposal.id}
                conversationId={conversation?.id ?? null}
              />
            </div>
          ) : null}

          {maySend && liveProposal?.status === 'sent' ? (
            <div className="border-t border-black/10 pt-3 dark:border-white/15">
              <QuotationResponseForm
                leadId={leadId}
                proposalId={liveProposal.id}
                lapsed={hasLapsed(liveProposal.valid_until)}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {!conversation ? (
        <section className="flex flex-col gap-3 rounded-lg border border-dashed border-black/15 px-4 py-6 dark:border-white/20">
          <p className="text-sm text-muted">No conversation yet for this lead.</p>
          {mayWrite ? <StartConversationForm leadId={leadId} /> : null}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              Transcript{' '}
              <span className="text-muted">
                ({messages.length} message{messages.length === 1 ? '' : 's'} · {conversation.channel})
              </span>
            </h2>

            {messages.length === 0 ? (
              <p className="text-sm text-muted">Nothing recorded yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted">
                        {AUTHOR_LABEL[m.author_type] ?? m.author_type}
                      </span>
                      <span className="flex items-baseline gap-2">
                        {m.delivery ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                              m.delivery === 'failed'
                                ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                                : m.delivery === 'sent'
                                  ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                  : 'bg-black/10 text-muted dark:bg-white/10'
                            }`}
                            title={
                              m.delivery === 'sent'
                                ? 'Accepted by the provider — delivery to the recipient is not yet confirmed'
                                : m.delivery === 'failed'
                                  ? 'The send failed; the reason is in the record'
                                  : 'Written, not yet sent'
                            }
                          >
                            {m.delivery}
                          </span>
                        ) : null}
                        <span className="font-mono text-xs text-muted">
                          {TIME.format(new Date(m.occurred_at))}
                        </span>
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}

            {mayWrite ? <MessageForm conversationId={conversation.id} leadId={leadId} /> : null}
            {mayWrite ? (
              <SendToClientForm conversationId={conversation.id} leadId={leadId} />
            ) : null}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Extracted requirements</h2>

            {versions.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. Extraction runs as a queued job and records a version here.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {versions.map((v) => {
                  const parsed = requirementPayloadSchema.safeParse(v.payload);
                  return (
                    <li
                      key={v.id}
                      className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-xs font-medium">v{v.version}</span>
                        <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                          {v.status}
                        </span>
                        <span className="text-xs text-muted">by {v.source}</span>
                        <span className="ml-auto font-mono text-xs text-muted">
                          {TIME.format(new Date(v.created_at))}
                        </span>
                      </div>

                      {parsed.success ? (
                        <div className="mt-2 flex flex-col gap-2 text-sm">
                          <p>{parsed.data.summary}</p>
                          {parsed.data.scopeItems.length > 0 ? (
                            <ul className="list-inside list-disc text-muted">
                              {parsed.data.scopeItems.map((s) => (
                                <li key={s.title}>{s.title}</li>
                              ))}
                            </ul>
                          ) : null}
                          {parsed.data.openQuestions.length > 0 ? (
                            <p className="text-xs text-muted">
                              {parsed.data.openQuestions.length} open question
                              {parsed.data.openQuestions.length === 1 ? '' : 's'}
                            </p>
                          ) : null}
                        </div>
                      ) : v.status === 'failed' ? (
                        <p className="mt-2 text-sm text-muted">
                          Extraction failed for this transcript. Add more detail or queue it
                          again.
                        </p>
                      ) : (
                        <p className="mt-2 text-sm text-muted">
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
          </section>
        </>
      )}
    </div>
  );
}
