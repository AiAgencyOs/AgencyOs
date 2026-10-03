import type { Metadata } from 'next';

import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { listSavedViews } from '@/lib/admin/saved-views';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listInvoices, listPendingPaymentClaims } from '@/modules/finance/queries';
import { listBillableMilestones, listBillingClients, listInvoicesFiltered } from '@/modules/finance/overview-queries';
import { INVOICE_STATUSES, milestoneInvoiceability } from '@/modules/finance/schema';
import { readInvoiceMilestones, readInvoiceSendHistory } from '@/modules/finance/invoice-list-queries';
import { readInvoiceSendSummaries } from '@/modules/finance/sends-queries';
import { needsReminder } from '@/modules/finance/sends-schema';
import { INVOICE_KINDS, INVOICE_KIND_LABEL, invoiceKindLabel, isInvoiceKind } from '@/modules/finance/invoice-kind';
import { owedOn, verifiedOn } from '@/modules/finance/verified-basis';
import { listProjects } from '@/modules/projects/queries';
import { SavedViewsBar } from '../saved-views-bar';
import { CreateFromMilestoneForm } from './create-from-milestone-form';
import { PreviewDrawerProvider } from '../preview-drawer';
import { InvoiceRegistryTable, type RegistryRow } from './invoice-registry-table';
import type { ReminderHistoryEntry } from './reminder-history-drawer';
import {
  Callout,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  IconAlert,
  IconInvoices,
  paginate,
  Pagination,
  PageHeader,
  PermissionDenied,
  sortRows,
  type SortDirection,
  Stat,
  StatGrid,
  FilterBar,
  FilterChips,
  IconCheck,
  IconClock,
  humanize,
  cx,
  inputClass,
  buttonClass,
  Card,
  CardHeader,
  selectClass,
} from '@/ui';

export const metadata: Metadata = { title: 'Invoices' };

/** Minor units → display string, in the currency the invoice was raised in. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

type Row = Awaited<ReturnType<typeof listInvoicesFiltered>>[number];

const COMPARATORS: Record<string, (a: Row, b: Row) => number> = {
  total: (a, b) => a.total_minor - b.total_minor,
  paid: (a, b) => verifiedOn(a) - verifiedOn(b),
  issued: (a, b) => (a.issued_at ?? '').localeCompare(b.issued_at ?? ''),
  due: (a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''),
};

/**
 * Invoice list.
 *
 * Same two-layer gate as the leads page: the capability is re-checked because
 * hiding the nav entry is not access control, and RLS refuses the rows
 * independently of both.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; sort?: string; dir?: string; status?: string; q?: string; client?: string; project?: string; gst?: string; milestone?: string; issuedFrom?: string; kind?: string }>;
}) {
  const context = await requireInternal('/invoices');
  const clock = await agencyClock();
  if (!can(context, 'invoice.read')) return <PermissionDenied />;

  const { page: pageParam, sort: sortKey, dir, status, q, client: clientId, project: projectId, gst: gstParam, milestone: milestoneParam, issuedFrom: issuedFromParam, kind: kindParam } = await searchParams;
  // SCR-051: GST filter (with / without tax) and milestone filter, from the URL like every other filter here.
  const gst = gstParam === 'with' || gstParam === 'without' ? gstParam : undefined;
  const milestoneFilter = milestoneParam && /^[0-9a-f-]{36}$/i.test(milestoneParam) ? milestoneParam : milestoneParam === 'none' ? 'none' : undefined;
  const kind = isInvoiceKind(kindParam) ? kindParam : undefined;
  const direction: SortDirection = dir === 'desc' ? 'desc' : 'asc';
  // Bucket F: the Command Center's "Invoices issued in the last N days" tile
  // lands here with `?issuedFrom=YYYY-MM-DD`, so the list is exactly the
  // count the tile showed.
  const issuedFrom = /^\d{4}-\d{2}-\d{2}$/.test(issuedFromParam ?? '') ? issuedFromParam : undefined;
  const keep = [
    status ? `status=${status}` : '',
    issuedFrom ? `issuedFrom=${issuedFrom}` : '',
    q ? `q=${encodeURIComponent(q)}` : '',
    clientId ? `client=${encodeURIComponent(clientId)}` : '',
    projectId ? `project=${encodeURIComponent(projectId)}` : '',
    gst ? `gst=${gst}` : '',
    milestoneFilter ? `milestone=${milestoneFilter}` : '',
    kind ? `kind=${kind}` : '',
  ].filter(Boolean);
  const currentQuery = [...keep, sortKey ? `sort=${sortKey}&dir=${direction}` : ''].filter(Boolean).join('&');
  const qs = (extra: string) => `/invoices?${[...keep, extra].filter(Boolean).join('&')}`;
  const canCreate = can(context, 'invoice.create');
  const mayVoidFromList = can(context, 'invoice.issue');
  // SCR-051: client and project filters are applied by the reader at the
  // database; the milestone picker needs every invoice (to know which
  // milestones are already billed) and every milestone, unfiltered.
  const [allInvoices, pendingClaims, savedViews, clients, projects, milestones, everyInvoice, sendSummaries, sendHistory] = await Promise.all([
    listInvoicesFiltered({ clientId, projectId }),
    can(context, 'invoice.issue') ? listPendingPaymentClaims() : Promise.resolve([]),
    listSavedViews('/invoices'),
    listBillingClients(),
    listProjects(500),
    canCreate ? listBillableMilestones() : Promise.resolve([]),
    canCreate ? listInvoices(2000) : Promise.resolve([]),
    readInvoiceSendSummaries(),
    readInvoiceSendHistory(),
  ]);
  const now = new Date();
  const linkedMilestones = await readInvoiceMilestones(allInvoices.map((i) => i.milestone_id).filter((id): id is string => id !== null));
  const historyViews = new Map<string, ReminderHistoryEntry[]>();
  for (const [invoiceId, rows] of sendHistory) {
    historyViews.set(invoiceId, rows.map((r) => ({ id: r.id, kind: r.kind, channel: r.channel, whenLabel: clock.dateTime(r.sentAt), note: r.note, messageRef: r.messageRef })));
  }
  const reminderCount = allInvoices.filter((i) => needsReminder(i, sendSummaries.get(i.id)?.lastReminderAt ?? null, now)).length;
  const invoicedMilestones = new Set(everyInvoice.map((i) => i.milestone_id).filter((id): id is string => id !== null));
  const eligible = milestones
    .filter((m) => !invoicedMilestones.has(m.id))
    .filter((m) => milestoneInvoiceability({ status: m.status, amountMinor: m.amountMinor, paymentPercent: m.paymentPercent }).ok)
    .map((m) => ({ id: m.id, projectId: m.projectId, name: m.name, position: m.position, amountLabel: money(m.amountMinor, m.currency) }));
  const needle = (q ?? '').trim().toLowerCase();
  const unpaid = (i: Row) => i.status === 'issued' || i.status === 'partially_paid' || i.status === 'overdue';
  const rawInvoices = allInvoices.filter(
    (i) =>
      (!status || (status === 'unpaid' ? unpaid(i) : i.status === status)) &&
      (!needle || i.number.toLowerCase().includes(needle)) &&
      (!kind || i.kind === kind) &&
      (!gst || (gst === 'with' ? i.tax_minor > 0 : i.tax_minor === 0)) &&
      (!milestoneFilter || (milestoneFilter === 'none' ? i.milestone_id === null : i.milestone_id === milestoneFilter)) &&
      (!issuedFrom || (i.issued_at !== null && i.issued_at >= issuedFrom)),
  );
  const invoices = sortRows(rawInvoices, sortKey, direction, COMPARATORS);
  const { page, pageCount, rows: pageRows } = paginate(invoices, Number(pageParam) || 1, DEFAULT_PAGE_SIZE);
  const countBy = (st: string) => allInvoices.filter((i) => i.status === st).length;
  const currency = allInvoices[0]?.currency ?? 'INR';
  // The same verified basis every finance total uses (verified-basis.ts): what
  // is owed is the total less what a person verified.
  const outstanding = allInvoices.filter((i) => i.currency === currency && unpaid(i)).reduce((n, i) => n + owedOn(i), 0);
  const overdueAmount = allInvoices.filter((i) => i.currency === currency && i.status === 'overdue').reduce((n, i) => n + owedOn(i), 0);
  const paidAmount = allInvoices.filter((i) => i.currency === currency && i.status === 'paid').reduce((n, i) => n + i.total_minor, 0);
  const exportQuery = [...keep].join('&');
  const exportHref = `/api/finance/invoices/export?${exportQuery}${exportQuery ? '&' : ''}`;
  const registryRows: RegistryRow[] = pageRows.map((i) => {
    const m = i.milestone_id ? linkedMilestones.get(i.milestone_id) : undefined;
    const s = sendSummaries.get(i.id);
    const awaiting = Math.max(0, Math.min(i.paid_minor, i.total_minor) - verifiedOn(i));
    return {
      id: i.id,
      number: i.number,
      status: i.status,
      needsReminder: needsReminder(i, s?.lastReminderAt ?? null, now),
      kindLabel: invoiceKindLabel(i.kind),
      milestoneLabel: m ? `${m.position + 1}. ${m.name}` : i.milestone_id ? 'milestone' : '—',
      lastSent: s?.lastAt ? `${s.lastKind === 'reminder' ? 'reminded' : 'sent'} ${clock.date(s.lastAt)}` : '—',
      history: historyViews.get(i.id) ?? [],
      totalLabel: money(i.total_minor, i.currency),
      verifiedLabel: money(verifiedOn(i), i.currency),
      awaitingLabel: awaiting > 0 ? money(awaiting, i.currency) : null,
      issuedLabel: i.issued_at ? clock.date(i.issued_at) : '—',
      dueLabel: i.due_at ? clock.date(i.due_at) : '—',
      projectId: i.project_id,
      clientId: i.client_account_id,
      canVoid: mayVoidFromList && i.status !== 'void' && i.status !== 'paid' && i.paid_minor === 0,
    };
  });

  return (
    <PreviewDrawerProvider>
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invoices"
        description={
          invoices.length === 0
            ? 'No invoices raised yet.'
            : `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}.`
        }
        actions={
          <>
            <a href={exportHref.replace(/[?&]$/, '')} className={buttonClass('secondary', 'sm')}>
              Export CSV
            </a>
            {canCreate ? (
              <Link href="/invoices/new" className={buttonClass('primary', 'sm')}>
                New invoice
              </Link>
            ) : null}
          </>
        }
      />

      {allInvoices.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Invoices" value={String(allInvoices.length)} caption={`${countBy('pending_approval')} awaiting approval`} tone="brand" icon={<IconInvoices size={16} />} href="/invoices" />
          {/* SCR-051: draft and issued are counts, each a tile, each opening the list filtered to exactly that number. */}
          <Stat label="Draft" value={String(countBy('draft'))} caption="Not yet issued" tone={countBy('draft') > 0 ? 'warning' : 'neutral'} icon={<IconInvoices size={16} />} href="/invoices?status=draft" />
          <Stat label="Issued" value={String(countBy('issued'))} caption="Awaiting payment" tone="info" icon={<IconClock size={16} />} href="/invoices?status=issued" />
          <Stat label="Paid" value={String(countBy('paid'))} caption={money(paidAmount, currency)} tone="success" icon={<IconCheck size={16} />} href="/invoices?status=paid" />
          <Stat label="Unpaid" value={String(allInvoices.filter(unpaid).length)} caption={`${money(outstanding, currency)} outstanding`} tone={outstanding > 0 ? 'warning' : 'neutral'} icon={<IconClock size={16} />} href="/invoices?status=unpaid" />
          <Stat label="Overdue" value={String(countBy('overdue'))} caption={`${money(overdueAmount, currency)}${countBy('void') > 0 ? ` · ${countBy('void')} void` : ''}`} tone={countBy('overdue') > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} href="/invoices?status=overdue" />
        </StatGrid>
      ) : null}

      <FilterBar clearHref="/invoices" filtered={Boolean(status || q || clientId || projectId || issuedFrom || kind)}>
        <FilterChips
          options={[
            { key: 'all', label: `All (${allInvoices.length})`, href: q ? `/invoices?q=${encodeURIComponent(q)}` : '/invoices', active: !status },
            { key: 'unpaid', label: `Unpaid (${allInvoices.filter(unpaid).length})`, href: `/invoices?status=unpaid${q ? `&q=${encodeURIComponent(q)}` : ''}`, active: status === 'unpaid' },
            ...INVOICE_STATUSES.map((st) => ({ key: st, label: `${humanize(st)} (${countBy(st)})`, href: `/invoices?status=${st}${q ? `&q=${encodeURIComponent(q)}` : ''}`, active: status === st })),
          ]}
        />
        <FilterChips
          options={[
            { key: 'any-kind', label: 'Any type', href: qs(''), active: !kind },
            ...INVOICE_KINDS.map((k) => ({ key: k, label: INVOICE_KIND_LABEL[k], href: `/invoices?${[...keep.filter((x) => !x.startsWith('kind=')), `kind=${k}`].join('&')}`, active: kind === k })),
          ]}
        />
        <form method="get" action="/invoices" className="flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          <input name="q" defaultValue={q ?? ''} placeholder="Invoice number…" aria-label="Search invoices" className={cx(inputClass, 'sm:w-48')} />
          <select name="client" defaultValue={clientId ?? ''} aria-label="Client" className={cx(selectClass, 'sm:w-44')}>
            <option value="">Every client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="project" defaultValue={projectId ?? ''} aria-label="Project" className={cx(selectClass, 'sm:w-44')}>
            <option value="">Every project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select name="gst" defaultValue={gst ?? ''} aria-label="GST" className={cx(selectClass, 'sm:w-36')}>
            <option value="">GST and non-GST</option>
            <option value="with">With GST</option>
            <option value="without">Without GST</option>
          </select>
          <select name="milestone" defaultValue={milestoneFilter ?? ''} aria-label="Milestone" className={cx(selectClass, 'sm:w-48')}>
            <option value="">Every milestone</option>
            <option value="none">No milestone</option>
            {[...linkedMilestones.values()]
              .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.position - b.position)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.position + 1}. {m.name}
                </option>
              ))}
          </select>
          <button type="submit" className={buttonClass('secondary', 'sm')}>
            Apply
          </button>
          {clientId || projectId || gst || milestoneFilter ? (
            <Link href="/invoices" className={buttonClass('ghost', 'sm')}>
              Clear
            </Link>
          ) : null}
        </form>
      </FilterBar>

      {canCreate ? (
        <Card>
          <CardHeader
            title="Create from a milestone"
            description="A draft, from a milestone the payment plan says may be billed and nothing has invoiced yet. Issuing it is a separate step on the invoice."
          />
          <div className="px-4 pb-4 sm:px-5">
            <CreateFromMilestoneForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} milestones={eligible} />
          </div>
        </Card>
      ) : null}

      <SavedViewsBar page="/invoices" currentQuery={currentQuery} views={savedViews} />

      {reminderCount > 0 ? (
        <Callout tone="warning" icon={<IconClock size={16} />}>
          {reminderCount} invoice{reminderCount === 1 ? ' is' : 's are'} past due with no reminder recorded in the last 7 days. Open each one, send the reminder yourself, and record it there.
        </Callout>
      ) : null}

      {pendingClaims.length > 0 ? (
        <Callout tone="warning" icon={<IconAlert size={16} />}>
          <span className="flex flex-wrap items-center gap-2">
            {pendingClaims.length} payment claim{pendingClaims.length === 1 ? '' : 's'} awaiting a decision.
            <Link href="/invoices/verify" className="font-medium underline underline-offset-2">
              Open the verification queue
            </Link>
          </span>
        </Callout>
      ) : null}

      {invoices.length > 0 ? (
        <>
          <InvoiceRegistryTable
            rows={registryRows}
            sortKey={sortKey}
            sortDirection={direction}
            sortHrefPrefix={`/invoices?${keep.join('&')}${keep.length > 0 ? '&' : ''}`}
            exportHref={exportHref}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            makeHref={(p) => qs(`${sortKey ? `sort=${sortKey}&dir=${direction}&` : ''}page=${p}`)}
          />
        </>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No invoices yet"
          description="Invoices raised against project milestones, change requests, maintenance plans or composed by hand will appear here."
          action={canCreate ? <Link href="/invoices/new" className={buttonClass('secondary', 'sm')}>New invoice</Link> : <Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
        />
      )}
    </div>
    </PreviewDrawerProvider>
  );
}
