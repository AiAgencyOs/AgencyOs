import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readProjectMargin } from '@/modules/finance/margin-queries';
import { gstLine, lastPaymentAt, methodsUsed, receivedPayments, transactionStatus } from '@/modules/finance/project-finance';
import { readProjectPayments } from '@/modules/finance/project-finance-queries';
import { listProjectInvoices } from '@/modules/finance/queries';
import { owedOn, verifiedOn } from '@/modules/finance/verified-basis';
import { listProjectNotes } from '@/modules/projects/project-notes-queries';
import { getProject, listPaymentPlan } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, cx, EmptyState, IconCalendar, IconCheck, IconClock, IconFile, IconInvoices, IconRupee, PermissionDenied, ProgressBar, QuickActions, Stat, StatGrid, StatusBadge, ViewAll } from '@/ui';

import { ProjectNotesPanel } from '../project-notes-panel';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Project finance' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

/**
 * SCR-016 / SCR-050 — the project's money on one screen, laid out as the
 * reference: figures, payment milestones, the invoices table, payment
 * progress and summary in the rail, and the internal profitability card.
 * Every figure is a sum over the project's own invoices and payment plan;
 * a figure the data cannot state (payment method, GST treatment, last
 * payment date) is not drawn.
 */
export default async function ProjectFinancePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/finance`);
  if (!can(context, 'project.read') || !can(context, 'invoice.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [plan, invoices, clock, clientName, margin, { payments, taxMinor }, notes] = await Promise.all([
    listPaymentPlan(projectId),
    listProjectInvoices(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    readProjectMargin(projectId),
    readProjectPayments(projectId),
    listProjectNotes(projectId, 4),
  ]);
  const transactions = receivedPayments(payments).slice(0, 5);
  const lastPaid = lastPaymentAt(payments);

  const currency = project.currency;
  const live = invoices.filter((i) => i.status !== 'void');
  const invoiced = live.reduce((n, i) => n + i.total_minor, 0);
  // The ONE basis (verified-basis.ts): received is what was VERIFIED, not what was recorded.
  const received = live.reduce((n, i) => n + verifiedOn(i), 0);
  const pending = Math.max(0, invoiced - received);
  const budget = project.budget_minor ?? 0;
  const value = budget > 0 ? budget : invoiced;
  const percentReceived = value > 0 ? Math.min(100, Math.round((received / value) * 100)) : 0;
  const unpaid = live.filter((i) => owedOn(i) > 0 && i.due_at).sort((a, b) => (a.due_at ?? '').localeCompare(b.due_at ?? ''));
  const nextDue = unpaid[0] ?? null;
  const paidCount = live.filter((i) => i.total_minor > 0 && owedOn(i) === 0).length;
  const invoiceForMilestone = (milestoneId: string) => live.find((i) => i.milestone_id === milestoneId) ?? null;
  const canCreateInvoice = can(context, 'invoice.create');

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        actions={
          canCreateInvoice ? (
            <Link href="/invoices" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background shadow-xs hover:opacity-90">
              <IconInvoices size={14} />
              Generate Invoice
            </Link>
          ) : null
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat label="Total Project Value" value={<span className="text-xl">{money(value, currency)}</span>} caption={budget > 0 ? 'Project budget' : 'Sum of invoices — no budget set'} tone="success" icon={<IconRupee size={16} />} />
        <Stat label="Amount Received" value={<span className="text-xl">{money(received, currency)}</span>} caption={`${percentReceived}% of value`} tone="info" icon={<IconCheck size={16} />} />
        <Stat label="Pending Amount" value={<span className="text-xl">{money(pending, currency)}</span>} caption="Invoiced, not yet received" tone="warning" icon={<IconClock size={16} />} />
        <Stat label="Total Invoices" value={String(live.length)} caption={`${paidCount} paid, ${live.length - paidCount} pending`} tone="brand" icon={<IconFile size={16} />} href="/invoices" />
        <Stat label="Next Payment Due" value={<span className="text-xl">{nextDue ? money(owedOn(nextDue), currency) : '—'}</span>} caption={nextDue?.due_at ? `Due on ${clock.date(nextDue.due_at)}` : 'Nothing due'} tone={nextDue?.due_at && clock.dayKey(nextDue.due_at) < clock.dayKey(new Date()) ? 'danger' : 'accent'} icon={<IconCalendar size={16} />} />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(19rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Payment Milestones" description="Track project payments as per agreement" actions={<ViewAll href={`/projects/${projectId}/plan`} label="Edit Milestones" />} />
            {plan.length === 0 ? (
              <EmptyState icon={<IconCalendar size={22} />} title="No payment plan yet" description="The payment plan on the project overview sets the milestones." action={<Link href={`/projects/${projectId}`} className="text-[13px] text-brand hover:underline">Open the project</Link>} />
            ) : (
              <ol className="divide-y divide-line">
                {plan.map((m, i) => {
                  const inv = invoiceForMilestone(m.id);
                  const amount = m.amount_minor ?? (m.payment_percent !== null && budget > 0 ? Math.round((budget * Number(m.payment_percent)) / 100) : null);
                  const paid = inv !== null && inv.total_minor > 0 && owedOn(inv) === 0;
                  return (
                    <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                      <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', paid ? 'bg-success text-white' : 'border border-line-strong bg-surface text-muted')}>
                        {paid ? <IconCheck size={14} /> : i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-semibold text-foreground">{i + 1}. {m.name}</span>
                        <span className="block text-xs text-muted">{m.payment_percent !== null ? `${Number(m.payment_percent)}% of the plan` : 'No share set'}{m.due_on ? ` · due ${clock.date(m.due_on)}` : ''}</span>
                      </span>
                      <span className="w-24 text-right">
                        <span className="block text-[11px] text-muted">Amount</span>
                        <span className="tabular text-[13px] font-semibold">{amount !== null ? money(amount, m.currency ?? currency) : '—'}</span>
                      </span>
                      <span className="w-24"><StatusBadge status={paid ? 'paid' : m.met_at ? 'due' : 'pending'} dot={false} /></span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          <Card>
            <CardHeader title="Invoices" description="Track and manage all project invoices" actions={<ViewAll href="/invoices" label="Create Invoice" />} />
            {live.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No invoice has been raised against this project.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-y border-line bg-surface-sunken text-[11px] uppercase tracking-wider text-muted">
                      <th scope="col" className="px-4 py-2 font-semibold sm:px-5">#</th>
                      <th scope="col" className="py-2 font-semibold">Invoice No.</th>
                      <th scope="col" className="py-2 font-semibold">Milestone</th>
                      <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                      <th scope="col" className="py-2 pl-4 font-semibold">Status</th>
                      <th scope="col" className="py-2 font-semibold">Issue Date</th>
                      <th scope="col" className="px-4 py-2 font-semibold sm:px-5">Due Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {live.map((inv, i) => (
                      <tr key={inv.id}>
                        <td className="px-4 py-2.5 text-muted sm:px-5">{i + 1}</td>
                        <td className="py-2.5"><Link href={`/invoices/${inv.id}`} className="font-medium text-brand hover:underline">{inv.number ?? 'Draft'}</Link></td>
                        <td className="py-2.5 text-muted">{plan.find((m) => m.id === inv.milestone_id)?.name ?? '—'}</td>
                        <td className="tabular py-2.5 text-right">{money(inv.total_minor, inv.currency)}</td>
                        <td className="py-2.5 pl-4"><StatusBadge status={inv.total_minor > 0 && owedOn(inv) === 0 ? 'paid' : inv.status} dot={false} /></td>
                        <td className="py-2.5 text-muted">{inv.issued_at ? clock.date(inv.issued_at) : '—'}</td>
                        <td className="px-4 py-2.5 text-muted sm:px-5">{inv.due_at ? clock.date(inv.due_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Payment Progress" />
            <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
              <ProgressBar value={percentReceived} tone="success" label="Payment received" />
              <div className="flex items-end justify-between">
                <div>
                  <p className="tabular text-lg font-bold text-foreground">{money(received, currency)}</p>
                  <p className="text-xs text-muted">Received</p>
                </div>
                <div className="text-right">
                  <p className="tabular text-lg font-bold text-foreground">{money(pending, currency)}</p>
                  <p className="text-xs text-muted">Pending</p>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Payment Summary" />
            <dl className="flex flex-col divide-y divide-line px-4 pb-3 text-[13px] sm:px-5">
              <div className="flex justify-between py-2"><dt className="text-muted">Total Project Value</dt><dd className="tabular font-medium">{money(value, currency)}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">Total Invoiced</dt><dd className="tabular font-medium">{money(invoiced, currency)}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">Total Received</dt><dd className="tabular font-medium text-success">{money(received, currency)}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">Pending Amount</dt><dd className="tabular font-medium text-danger">{money(pending, currency)}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">Last Payment Date</dt><dd className="font-medium">{lastPaid ? clock.date(lastPaid) : '—'}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">Next Payment Due</dt><dd className={cx('font-medium', nextDue?.due_at && clock.dayKey(nextDue.due_at) < clock.dayKey(new Date()) ? 'text-danger' : '')}>{nextDue?.due_at ? clock.date(nextDue.due_at) : '—'}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">Payment Method</dt><dd className="text-right font-medium">{methodsUsed(payments)}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-muted">GST</dt><dd className="text-right font-medium">{gstLine(taxMinor, (m) => money(m, currency))}</dd></div>
            </dl>
          </Card>

          <QuickActions
            title="Quick Actions"
            actions={[
              ...(canCreateInvoice ? [{ label: 'Generate Invoice', icon: <IconInvoices size={13} />, href: '/invoices' }] : []),
              { label: 'Record Payment', icon: <IconRupee size={13} />, href: '/finance/payments' },
              { label: 'Expenses', icon: <IconFile size={13} />, href: '/finance/expenses' },
              { label: 'Project report', icon: <IconCalendar size={13} />, href: `/projects/${projectId}/reports` },
            ]}
          />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
    <Card>
      <CardHeader title="Recent Transactions" actions={<ViewAll href="/finance/payments" />} />
      {transactions.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No payment has been received against this project.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-y border-line bg-surface-sunken text-[11px] uppercase tracking-wider text-muted">
                <th scope="col" className="px-4 py-2 font-semibold sm:px-5">Date</th>
                <th scope="col" className="py-2 font-semibold">Description</th>
                <th scope="col" className="py-2 text-right font-semibold">Amount</th>
                <th scope="col" className="py-2 pl-4 font-semibold">Type</th>
                <th scope="col" className="px-4 py-2 font-semibold sm:px-5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {transactions.map((t) => {
                const st = transactionStatus(t.status);
                return (
                  <tr key={t.id}>
                    <td className="px-4 py-2.5 text-muted sm:px-5">{clock.date(t.capturedAt ?? t.createdAt)}</td>
                    <td className="py-2.5">Payment received{t.invoiceNumber ? <> · <Link href={`/invoices/${t.invoiceId}`} className="text-brand hover:underline">{t.invoiceNumber}</Link></> : null}</td>
                    <td className="tabular py-2.5 text-right">{money(t.amountMinor, t.currency)}</td>
                    <td className="py-2.5 pl-4 text-muted">Credit</td>
                    <td className="px-4 py-2.5 sm:px-5"><Badge tone={st.tone}>{st.label}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>

    <Card>
      <CardHeader title="Project Profitability (Internal)" description={`Cash-basis estimate: paid − (expenses + AI cost + time cost).`} />
      <dl className="flex flex-col divide-y divide-line px-4 pb-3 text-[13px] sm:px-5">
        <div className="flex justify-between py-2"><dt className="text-muted">Total Revenue (received)</dt><dd className="tabular font-medium">{money(margin.paidMinor, currency)}</dd></div>
        <div className="flex justify-between py-2"><dt className="text-muted">Total Expenses</dt><dd className="tabular font-medium">{money(margin.costMinor, currency)}</dd></div>
        <div className="flex justify-between py-2"><dt className="text-muted">Estimated Profit</dt><dd className={cx('tabular font-semibold', margin.marginMinor < 0 ? 'text-danger' : 'text-success')}>{money(margin.marginMinor, currency)}</dd></div>
        <div className="flex justify-between py-2"><dt className="text-muted">Profit Margin</dt><dd className="tabular font-semibold">{margin.marginPercent === null ? '—' : `${margin.marginPercent}%`}</dd></div>
      </dl>
    </Card>
    <Card>
      <CardHeader title="Notes" />
      <ProjectNotesPanel
        projectId={projectId}
        editable={can(context, 'task.write')}
        notes={notes.map((n) => ({ id: n.id, title: n.title, body: n.body, whenLabel: clock.dateTime(n.createdAt), byName: n.createdByName }))}
      />
    </Card>
      </div>
    </div>
  );
}
