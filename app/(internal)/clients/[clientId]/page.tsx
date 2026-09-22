import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  Badge,
  Card,
  CardHeader,
  DetailList,
  DetailRow,
  EmptyState,
  humanize,
  IconChevronRight,
  IconInbox,
  IconInvoices,
  IconProjects,
  PageHeader,
  Stat,
  StatGrid,
  StatusBadge,
} from '@/ui';

export const metadata: Metadata = { title: 'Client' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

function when(clock: AgencyClock, value: string): string {
  return clock.date(value);
}

/**
 * Client 360 — projects and invoices in one place, per the PDF's SCR-015/016.
 * Linking out to the real project/invoice detail pages rather than
 * duplicating their forms.
 *
 * Communication (SCR-017), added 2026-09-22: each project's own
 * `project_group` WhatsApp thread (`crm.conversations`, `project_id` not
 * `lead_id`), rolled up the same way Files already is. Deliberately not the
 * client's pre-conversion lead history — a project group has no `lead_id` at
 * all (`conversations_kind_shape`), so this is the client's own ongoing
 * channel, not a reconstruction through `sales.opportunities`.
 */
export default async function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;

  const context = await requireInternal(`/clients/${clientId}`);
  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const client = await getClient(clientId);
  if (!client) notFound();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={client.name}
        description={
          <>
            Client since {when(clock, client.createdAt)}
            {client.billingEmail ? <> · {client.billingEmail}</> : null}
          </>
        }
        meta={<Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{client.status}</Badge>}
      />

      <StatGrid>
        <Stat label="Active projects" value={String(client.projectsActive)} />
        <Stat label="Total projects" value={String(client.projectsTotal)} />
        <Stat label="Invoiced" value={money(client.invoicedMinor, client.currency)} />
        <Stat
          label="Outstanding"
          value={money(client.outstandingMinor, client.currency)}
          tone={client.outstandingMinor > 0 ? 'warning' : 'success'}
        />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Projects" />
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
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconProjects size={20} />} title="No projects yet" />
          )}
        </Card>

        <Card>
          <CardHeader title="Invoices" />
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
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<IconInvoices size={20} />} title="No invoices yet" />
          )}
        </Card>
      </div>

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

      <Card>
        <CardHeader title="Communication" description="Each project's own WhatsApp group, most recent messages first project." />
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

      <Card>
        <CardHeader title="Account" />
        <DetailList className="px-4 sm:px-5">
          <DetailRow label="Name" value={client.name} />
          <DetailRow label="Billing email" value={client.billingEmail ?? '—'} />
          <DetailRow label="Currency" value={client.currency} />
          <DetailRow label="Status" value={<Badge tone={client.status === 'active' ? 'success' : 'neutral'}>{client.status}</Badge>} />
        </DetailList>
      </Card>
    </div>
  );
}
