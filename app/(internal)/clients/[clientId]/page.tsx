import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { readClientCommercialTimeline, type CommercialEvent } from '@/lib/admin/client-commercials';
import { listClientMeetingNotes, readClientUnreadReplies } from '@/lib/admin/client-communication';
import { readClientNextFollowUp } from '@/lib/admin/client-followups';
import { listClientLeads } from '@/lib/admin/client-leads';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listEligibleMilestones } from '@/modules/finance/eligible-milestones-queries';
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  DetailList,
  DetailRow,
  EmptyState,
  LinkButton,
  cx,
  humanize,
  IconChevronRight,
  IconInbox,
  IconInvoices,
  IconProjects,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
  TONE_DOT,
  type Tone,
} from '@/ui';

import { GenerateClientInvoiceButton } from './client-forms';

export const metadata: Metadata = { title: 'Client' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

const TABS = ['overview', 'projects', 'quotations', 'invoices', 'communication', 'files', 'notes', 'activity'] as const;
type Tab = (typeof TABS)[number];

function tabOf(value: string | undefined): Tab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'overview';
}

const EVENT_TONE: Record<CommercialEvent['kind'], Tone> = {
  quotation: 'info',
  milestone: 'brand',
  invoice: 'warning',
  payment: 'success',
};

function eventDate(clock: AgencyClock, at: string | null): string {
  if (!at) return 'undated';
  // A `YYYY-MM-DD` (milestone due_on) is a day, not an instant.
  return at.length === 10 ? clock.date(`${at}T00:00:00`) : clock.dateTime(at);
}

function CommercialTimeline({
  events,
  clock,
  limit,
}: {
  events: CommercialEvent[];
  clock: AgencyClock;
  limit?: number;
}) {
  const shown = limit ? events.slice(0, limit) : events;
  if (shown.length === 0) {
    return (
      <EmptyState
        icon={<IconInvoices size={20} />}
        title="No commercial history yet"
        description="An accepted quotation, a payment milestone, an invoice or a payment will appear here as each happens."
      />
    );
  }
  return (
    <ol className="flex flex-col px-4 py-3 sm:px-5">
      {shown.map((e, index) => (
        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
          {index < shown.length - 1 ? (
            <span aria-hidden className="absolute top-3 left-[5px] bottom-0 w-px bg-line" />
          ) : null}
          <span
            aria-hidden
            className={cx('mt-1.5 size-[11px] shrink-0 rounded-full ring-2 ring-surface', TONE_DOT[EVENT_TONE[e.kind]])}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone={EVENT_TONE[e.kind]}>{e.kind}</Badge>
              {e.href ? (
                <Link href={e.href} className="text-sm font-medium text-foreground underline-offset-2 hover:underline">
                  {e.title}
                </Link>
              ) : (
                <span className="text-sm font-medium text-foreground">{e.title}</span>
              )}
              {e.amountMinor !== null ? (
                <span className="tabular text-[13px] text-muted">{money(e.amountMinor, e.currency)}</span>
              ) : null}
            </div>
            <p className="text-[13px] text-muted">
              {e.detail ? <>{e.detail} · </> : null}
              {eventDate(clock, e.at)}
              {e.projectName ? <> · {e.projectName}</> : null}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Client 360 — SCR-015/016/017, tabbed.
 *
 * `?tab=` rather than client state so a tab is a URL somebody can send. Every
 * tab's data comes from the owning module's tables through lib/admin readers
 * (clients.ts and its new siblings): nothing is restated on the account.
 *
 * The three create buttons deep-link to the flows that exist rather than
 * inventing forms here: a project is created by winning a deal on a lead, a
 * quotation is drafted from a lead's opportunity, and an invoice is generated
 * from a project's next unlocked milestone — which the Invoices tab also
 * offers directly for the milestone `listEligibleMilestones` says is next.
 */
export default async function ClientDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { clientId } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = tabOf(rawTab);

  const context = await requireInternal(`/clients/${clientId}`);
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const client = await getClient(clientId);
  if (!client) notFound();

  const leads = await listClientLeads(clientId);
  const projectIds = client.projects.map((p) => p.id);
  const [nextFollowUp, unread, notes, timeline, eligible] = await Promise.all([
    readClientNextFollowUp(clientId, leads),
    readClientUnreadReplies({ projectIds, leadIds: leads.map((l) => l.id) }),
    listClientMeetingNotes(leads.map((l) => l.id)),
    readClientCommercialTimeline({ clientAccountId: clientId, projects: client.projects }),
    listEligibleMilestones(projectIds),
  ]);

  const mayInvoice = can(context.role, 'invoice.create');
  const latestLead = leads[0] ?? null;
  const invoiceTarget = eligible.find((e) => e.eligible)?.projectId ?? client.projects[0]?.id ?? null;
  const quotations = timeline.filter((e) => e.kind === 'quotation');
  const base = `/clients/${clientId}`;

  const tabLabel = (t: Tab): string => {
    switch (t) {
      case 'communication':
        return unread.total > 0 ? `Communication (${unread.total})` : 'Communication';
      case 'notes':
        return 'Notes';
      default:
        return humanize(t);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={client.name}
        description={
          <>
            Client since {clock.date(client.createdAt)}
            {client.billingEmail ? <> · {client.billingEmail}</> : null}
          </>
        }
        meta={<Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{client.status}</Badge>}
        actions={
          <>
            <LinkButton
              href={latestLead ? `/leads/${latestLead.id}` : '/leads'}
              variant="secondary"
              size="sm"
              title="A project is created by winning a deal on a lead."
            >
              Create project
            </LinkButton>
            <LinkButton
              href={latestLead ? `/leads/${latestLead.id}` : '/leads'}
              variant="secondary"
              size="sm"
              title="A quotation is drafted from a lead's opportunity."
            >
              Create quote
            </LinkButton>
            <LinkButton
              href={invoiceTarget ? `/projects/${invoiceTarget}#billing` : `${base}?tab=invoices`}
              variant="primary"
              size="sm"
              title="An invoice is generated from a project's next unlocked milestone."
            >
              Create invoice
            </LinkButton>
          </>
        }
      />

      <StatGrid>
        <Stat label="Active projects" value={String(client.projectsActive)} />
        <Stat
          label="Outstanding"
          value={money(client.outstandingMinor, client.currency)}
          tone={client.outstandingMinor > 0 ? 'warning' : 'success'}
        />
        <Stat
          label="Next follow-up"
          value={nextFollowUp ? clock.date(nextFollowUp.at) : '—'}
          tone={nextFollowUp && nextFollowUp.at < new Date().toISOString() ? 'danger' : 'neutral'}
          href={nextFollowUp ? `/leads/${nextFollowUp.leadId}` : undefined}
        />
        <Stat
          label="Unread client replies"
          value={String(unread.total)}
          tone={unread.total > 0 ? 'warning' : 'neutral'}
          href={`${base}?tab=communication`}
        />
      </StatGrid>

      <div role="tablist" aria-label="Client sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === 'overview' ? base : `${base}?tab=${t}`}
            role="tab"
            aria-selected={t === tab}
            className={cx(
              'flex min-h-9 items-center justify-center rounded-lg px-3 text-[13px] font-medium transition-colors',
              t === tab ? 'bg-brand text-brand-fg shadow-xs' : 'text-muted hover:bg-surface-hover',
            )}
          >
            {tabLabel(t)}
          </Link>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader
                title="Commercials"
                description="Accepted quotation → milestones → invoices → payments, newest first."
                actions={
                  <Link href={`${base}?tab=activity`} className="text-[13px] text-muted underline-offset-2 hover:underline">
                    Full timeline
                  </Link>
                }
              />
              <CommercialTimeline events={timeline} clock={clock} limit={6} />
            </Card>

            <Card>
              <CardHeader title="Next follow-up" description="The earliest moment anyone is due to contact this client." />
              <div className="px-4 py-3 sm:px-5">
                {nextFollowUp ? (
                  <DetailList>
                    <DetailRow label="When" value={clock.dateTime(nextFollowUp.at)} />
                    <DetailRow
                      label="How"
                      value={
                        nextFollowUp.source === 'sequence'
                          ? `Automated sequence${nextFollowUp.situationKey ? ` · ${humanize(nextFollowUp.situationKey)}` : ''}`
                          : 'Set by hand on the lead'
                      }
                    />
                    <DetailRow
                      label="Lead"
                      value={
                        <Link href={`/leads/${nextFollowUp.leadId}`} className="underline-offset-2 hover:underline">
                          {nextFollowUp.leadTitle}
                        </Link>
                      }
                    />
                  </DetailList>
                ) : (
                  <p className="text-[13px] text-muted">
                    Nothing scheduled — no active sequence and no follow-up date on any of this client’s{' '}
                    {leads.length} lead{leads.length === 1 ? '' : 's'}.
                  </p>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Account" />
            <DetailList className="px-4 sm:px-5">
              <DetailRow label="Name" value={client.name} />
              <DetailRow label="Billing email" value={client.billingEmail ?? '—'} />
              <DetailRow label="Currency" value={client.currency} />
              <DetailRow label="Invoiced" value={money(client.invoicedMinor, client.currency)} />
              <DetailRow label="Paid" value={money(client.paidMinor, client.currency)} />
              <DetailRow label="Status" value={<Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{client.status}</Badge>} />
            </DetailList>
          </Card>
        </>
      ) : null}

      {tab === 'projects' ? (
        <Card>
          <CardHeader title="Projects" description={`${client.projectsActive} active of ${client.projectsTotal}.`} />
          {client.projects.length > 0 ? (
            <ul className="divide-y divide-line">
              {client.projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover sm:px-5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{p.name}</span>
                      <span className="block text-[13px] text-muted">
                        <StatusBadge status={p.status} />
                      </span>
                    </span>
                    {p.budgetMinor !== null ? (
                      <span className="shrink-0 text-sm tabular text-muted">{money(p.budgetMinor, p.currency)}</span>
                    ) : null}
                    <IconChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconProjects size={20} />} title="No projects yet" description="Winning a deal on one of this client's leads creates one." />
          )}
        </Card>
      ) : null}

      {tab === 'quotations' ? (
        <Card>
          <CardHeader
            title="Quotations"
            description="The quotation each project was created from. Every version lives on the lead it was drafted for."
          />
          {quotations.length > 0 ? (
            <ul className="divide-y divide-line">
              {quotations.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{q.title}</span>
                    <span className="block text-[13px] text-muted">
                      <StatusBadge status={q.status} /> · {eventDate(clock, q.at)}
                      {q.projectName ? <> · {q.projectName}</> : null}
                    </span>
                  </span>
                  {q.amountMinor !== null ? (
                    <span className="shrink-0 text-sm tabular text-muted">{money(q.amountMinor, q.currency)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<IconInvoices size={20} />}
              title="No linked quotation"
              description="None of this client's projects records the quotation it came from."
            />
          )}
          {leads.length > 0 ? (
            <div className="border-t border-line px-4 py-3 text-[13px] text-muted sm:px-5">
              Leads this client is reachable from:{' '}
              {leads.map((l, i) => (
                <span key={l.id}>
                  {i > 0 ? ', ' : null}
                  <Link href={`/leads/${l.id}`} className="underline-offset-2 hover:underline">
                    {l.title}
                  </Link>
                </span>
              ))}
              .
            </div>
          ) : null}
        </Card>
      ) : null}

      {tab === 'invoices' ? (
        <>
          <Card>
            <CardHeader
              title="Next milestone to invoice"
              description="Per project: the first priced milestone not yet paid for, with everything before it paid — the same rule the project page applies."
            />
            {eligible.length > 0 ? (
              <ul className="divide-y divide-line">
                {eligible.map((e) => {
                  const project = client.projects.find((p) => p.id === e.projectId);
                  return (
                    <li key={e.milestoneId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">{e.name}</span>
                        <span className="block text-[13px] text-muted">
                          {project?.name ?? 'Project'} · {humanize(e.status)}
                          {e.paymentPercent !== null ? <> · {e.paymentPercent}%</> : null} · {money(e.amountMinor, e.currency)}
                        </span>
                        {e.reason ? <span className="block text-xs text-muted">{e.reason}</span> : null}
                      </span>
                      {e.eligible && mayInvoice ? (
                        <GenerateClientInvoiceButton milestoneId={e.milestoneId} projectId={e.projectId} label="Generate invoice" />
                      ) : e.eligible ? (
                        <span className="text-xs text-muted">No permission to raise invoices.</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">
                Nothing to bill next — every priced milestone is paid, or no project has a payment plan yet.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Invoices" description={`${money(client.outstandingMinor, client.currency)} outstanding.`} />
            {client.invoices.length > 0 ? (
              <ul className="divide-y divide-line">
                {client.invoices.map((i) => (
                  <li key={i.id}>
                    <Link
                      href={`/invoices/${i.id}`}
                      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover sm:px-5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-xs font-medium text-foreground">{i.number}</span>
                        <span className="block text-[13px] text-muted">
                          <StatusBadge status={i.status} />
                        </span>
                      </span>
                      <span className="shrink-0 text-sm tabular text-muted">
                        {money(i.paidMinor, i.currency)} / {money(i.totalMinor, i.currency)}
                      </span>
                      <IconChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" />
            )}
          </Card>
        </>
      ) : null}

      {tab === 'communication' ? (
        <>
          <Card>
            <CardHeader
              title="Unread client replies"
              description="Inbound messages after the last outbound one on each thread — replies nobody has answered."
            />
            {unread.threads.length > 0 ? (
              <ul className="divide-y divide-line">
                {unread.threads.map((t) => (
                  <li key={t.conversationId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{t.title ?? humanize(t.kind)}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {clock.dateTime(t.latestAt)} · {t.latestBody ?? '(media message)'}
                      </span>
                    </span>
                    <Badge tone="warning">{t.unread} unread</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Every client message has been answered.</p>
            )}
          </Card>

          <Callout tone="info">
            Sending a message from here is not built: outbound WhatsApp goes through each thread’s own
            conversation view, where the 24-hour window and template rules are enforced.
          </Callout>

          <Card>
            <CardHeader title="Project groups" description="Each project's own WhatsApp group, oldest message first." />
            {client.communication.length > 0 ? (
              <ul className="flex flex-col gap-4 px-4 py-3 sm:px-5">
                {client.communication.map((thread) => (
                  <li key={thread.conversationId} className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {thread.title ?? thread.projectName}
                      <span className="ml-2 text-xs font-normal text-muted">{thread.projectName}</span>
                    </p>
                    {thread.messages.length === 0 ? (
                      <p className="text-[13px] text-muted">No messages yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
                        {thread.messages.map((m) => (
                          <li key={m.id} className="text-[13px]">
                            <span className="font-medium text-foreground">
                              {m.direction === 'inbound' ? 'Client' : humanize(m.authorType)}
                            </span>{' '}
                            <span className="text-xs text-muted">{clock.dateTime(m.occurredAt)}</span>
                            <p className="text-muted">{m.body ?? '(no text — media message)'}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<IconInbox size={20} />}
                title="No project group linked yet"
                description="A project's WhatsApp group, once linked, shows its messages here."
              />
            )}
          </Card>
        </>
      ) : null}

      {tab === 'files' ? (
        <Card>
          <CardHeader title="Files" description="Rolled up from every project this client has." />
          {client.files.length > 0 ? (
            <ul className="divide-y divide-line">
              {client.files.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      {f.title}
                    </a>
                    <span className="block truncate text-xs text-muted">
                      {f.projectName} · {humanize(f.category)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconInvoices size={20} />} title="No files yet" description="Files linked on any of this client's projects appear here." />
          )}
        </Card>
      ) : null}

      {tab === 'notes' ? (
        <>
          <Card>
            <CardHeader
              title="Meeting notes and decisions"
              description="Typed notes and summaries recorded against meetings on this client's leads, newest first."
            />
            {notes.length > 0 ? (
              <ul className="divide-y divide-line">
                {notes.map((n) => {
                  const lead = leads.find((l) => l.id === n.leadId);
                  return (
                    <li key={n.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={n.kind === 'summary' ? 'brand' : 'neutral'}>{n.kind}</Badge>
                        <Badge tone={n.visibility === 'client_visible' ? 'info' : 'neutral'}>{humanize(n.visibility)}</Badge>
                        <span className="text-xs text-muted">
                          {n.meetingAt ? `Meeting ${clock.dateTime(n.meetingAt)}` : 'Meeting undated'}
                          {n.meetingMode ? ` · ${humanize(n.meetingMode)}` : ''} · {humanize(n.meetingStatus)}
                          {n.meetingOutcome ? ` · ${humanize(n.meetingOutcome)}` : ''}
                        </span>
                      </div>
                      {n.body ? (
                        <p className="whitespace-pre-wrap text-[13px] text-foreground">{n.body}</p>
                      ) : (
                        <p className="text-[13px] text-muted">Stored as a reference{n.artifactRef ? ` (${n.artifactRef})` : ''}, no text.</p>
                      )}
                      <span className="text-xs text-muted">
                        Recorded {clock.dateTime(n.uploadedAt)}
                        {lead ? (
                          <>
                            {' · '}
                            <Link href={`/leads/${lead.id}`} className="underline-offset-2 hover:underline">
                              {lead.title}
                            </Link>
                          </>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon={<IconInbox size={20} />}
                title="No meeting notes"
                description="Notes and summaries added to a meeting on one of this client's leads appear here."
              />
            )}
          </Card>
          <Callout tone="info">
            Attaching a meeting summary to project memory is not offered here: <code>ai.memory_records</code> is
            written only by the sales handoff handlers, and there is no person-facing door for it.
          </Callout>
        </>
      ) : null}

      {tab === 'activity' ? (
        <Card>
          <CardHeader
            title="Commercial timeline"
            description={`${timeline.length} event${timeline.length === 1 ? '' : 's'} across ${client.projectsTotal} project${client.projectsTotal === 1 ? '' : 's'}.`}
          />
          <CommercialTimeline events={timeline} clock={clock} />
        </Card>
      ) : null}
    </div>
  );
}
