import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listClients } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProposals } from '@/modules/sales/queries';
import {
  Badge,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChips,
  humanize,
  IconInvoices,
  PageHeader,
  statusTone,
  type Column,
} from '@/ui';

import { VersionHistoryButton, type VersionRow } from './version-drawer';

export const metadata: Metadata = { title: 'Quotations' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(
    minor / 100,
  );
}

const STATUS_FILTERS = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Awaited<ReturnType<typeof listProposals>>[number];

const columnsFor = (
  clock: AgencyClock,
  clientName: (id: string | null) => string | null,
  versionsOf: (opportunityId: string) => VersionRow[],
): Column<Row>[] => [
  {
    key: 'title',
    header: 'Quotation',
    primary: true,
    cell: (p) => (
      <>
        <Link href={`/leads/${p.leadId}`} className="block font-medium text-foreground hover:underline">
          {p.title} <span className="text-muted">v{p.version}</span>
        </Link>
        <span className="block text-xs text-muted">
          {p.leadTitle}
          {clientName(p.clientAccountId) ? ` · ${clientName(p.clientAccountId)}` : ''}
        </span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    badge: true,
    cell: (p) => <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>,
  },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cellClassName: 'tabular font-medium',
    cell: (p) => money(p.total_minor, p.currency),
  },
  {
    key: 'valid_until',
    header: 'Valid until',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => (p.valid_until ? clock.date(p.valid_until) : '—'),
  },
  {
    key: 'created',
    header: 'Raised',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (p) => clock.date(p.created_at),
  },
  {
    key: 'versions',
    header: 'History',
    align: 'right',
    cell: (p) => <VersionHistoryButton dealName={p.opportunityName} leadId={p.leadId} versions={versionsOf(p.opportunity_id)} />,
  },
];

/**
 * Every quotation across every deal — SCR-011. The per-lead quotation panel
 * (`leads/[leadId]/quotation-panel.tsx`) has always been where a version is
 * drafted and sent; this is the first place to see them all at once, which
 * the traceability sweep confirmed did not exist anywhere in the admin panel.
 *
 * The version-history drawer groups the rows this page already holds by
 * deal, newest first; the client filter reads the deal's account. No
 * standalone quotation page exists (SCR-012 stays a per-lead panel — a
 * quote is drafted in the context of one deal, not created from nothing),
 * so every row links back to its lead rather than to a page of its own.
 */
export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; client?: string }>;
}) {
  const context = await requireInternal('/quotations');
  const clock = await agencyClock();
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const { status, client: clientParam } = await searchParams;
  const client = UUID.test(clientParam ?? '') ? clientParam : undefined;
  const all = await listProposals({ status, limit: 200 });
  const quotations = client ? all.filter((p) => p.clientAccountId === client) : all;

  // Clients are read only when the role may see them; the chips then name
  // the accounts that actually have a quotation in this list.
  const clients = can(context.role, 'project.read') ? await listClients() : [];
  const clientName = (id: string | null) => (id ? (clients.find((c) => c.id === id)?.name ?? null) : null);
  const clientIds = [...new Set(all.map((p) => p.clientAccountId).filter((id): id is string => id !== null))];

  // Every version on a deal, from the unfiltered read, so the drawer shows the
  // whole chain even when the status filter hides some of it.
  const byDeal = new Map<string, VersionRow[]>();
  for (const p of all) {
    const list = byDeal.get(p.opportunity_id) ?? [];
    list.push({
      id: p.id,
      version: p.version,
      title: p.title,
      status: p.status,
      total: money(p.total_minor, p.currency),
      raised: clock.date(p.created_at),
      sentAt: p.sent_at ? clock.date(p.sent_at) : null,
      decidedAt: p.decided_at ? clock.date(p.decided_at) : null,
      planLabel: p.plan_label,
    });
    byDeal.set(p.opportunity_id, list);
  }
  for (const list of byDeal.values()) list.sort((a, b) => b.version - a.version);
  const versionsOf = (opportunityId: string) => byDeal.get(opportunityId) ?? [];

  const href = (over: Partial<{ status: string; client: string }>) => {
    const next = { status: status ?? '', client: client ?? '', ...over };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    const qs = q.toString();
    return `/quotations${qs ? `?${qs}` : ''}`;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Quotations"
        description={
          quotations.length === 0
            ? 'No quotations match this filter.'
            : `${quotations.length} quotation${quotations.length === 1 ? '' : 's'}${client ? ` for ${clientName(client) ?? 'this client'}` : ''}.`
        }
      />

      <FilterBar>
        <FilterChips
          options={[
            { key: 'all', label: 'All', href: href({ status: '' }), active: !status },
            ...STATUS_FILTERS.map((s) => ({
              key: s,
              label: humanize(s),
              href: href({ status: s }),
              active: status === s,
            })),
          ]}
        />
        {clientIds.length > 0 ? (
          <FilterChips
            options={[
              { key: 'any-client', label: 'Any client', href: href({ client: '' }), active: !client },
              ...clientIds.map((id) => ({
                key: id,
                label: clientName(id) ?? id.slice(0, 8),
                href: href({ client: id }),
                active: client === id,
              })),
            ]}
          />
        ) : null}
      </FilterBar>

      {quotations.length > 0 ? (
        <DataTable rows={quotations} columns={columnsFor(clock, clientName, versionsOf)} getKey={(p) => p.id} />
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title={status || client ? 'No matching quotations' : 'No quotations yet'}
          description={
            status || client
              ? 'Nothing matches these filters. That is a count of rows, not a guess.'
              : 'A quotation is drafted from a lead once its opportunity is open.'
          }
        />
      )}
    </div>
  );
}
