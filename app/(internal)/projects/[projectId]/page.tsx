import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listDeliverables } from '@/modules/projects/queries';
import { listProjectInvoices } from '@/modules/finance/queries';
import {
  nextUnlockedMilestone,
  paidThrough,
  type InvoiceStatus,
  type MilestoneBillingEntry,
} from '@/modules/finance/schema';
import { getProject, listPaymentPlan } from '@/modules/projects/queries';
import { PROJECT_TRANSITIONS, type ProjectStatus } from '@/modules/projects/schema';

import { GenerateInvoiceButton } from './billing-panel';
import { PaymentPlanForm, ProjectStatusForm } from './delivery-panel';

export const metadata: Metadata = { title: 'Project · AgencyOS' };

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

import { AddDeliverableForm, SubmitDeliverableForm } from './deliverables-panel';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [plan, invoices] = await Promise.all([
    listPaymentPlan(projectId),
    // RLS decides whether these come back at all, so a role without invoice
    // access simply sees an empty billing column rather than an error.
    can(context.role, 'invoice.read') ? listProjectInvoices(projectId) : Promise.resolve([]),
  ]);

  const status = project.status as ProjectStatus;
  const deliverables = await listDeliverables(projectId);
  const mayWriteProject = can(context.role, 'project.write');
  const mayWritePlan = can(context.role, 'milestone.write');
  const mayInvoice = can(context.role, 'invoice.create');

  /**
   * A voided invoice is not a bill, so it does not occupy its milestone — the
   * same rule the `invoices_milestone_live_key` index enforces in the
   * database. Reproducing it here keeps the page honest about which milestones
   * are actually billable.
   */
  const liveInvoiceByMilestone = new Map(
    invoices
      .filter((invoice) => invoice.status !== 'void' && invoice.milestone_id !== null)
      .map((invoice) => [invoice.milestone_id as string, invoice]),
  );

  const billingEntries: MilestoneBillingEntry[] = plan.map((milestone) => ({
    milestoneId: milestone.id,
    position: milestone.position,
    paymentPercent: milestone.payment_percent === null ? null : Number(milestone.payment_percent),
    invoiceStatus:
      (liveInvoiceByMilestone.get(milestone.id)?.status as InvoiceStatus | undefined) ?? null,
  }));

  const paidCount = paidThrough(billingEntries);
  const unlocked = nextUnlockedMilestone(billingEntries);
  const unlockedName = plan.find((m) => m.id === unlocked?.milestoneId)?.name ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">Project</p>
        <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
        <p className="text-sm text-muted">
          {status}
          {project.budget_minor !== null
            ? ` · budget ${money(project.budget_minor, project.currency)}`
            : ''}
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Delivery status</h2>
        {mayWriteProject ? (
          <ProjectStatusForm
            projectId={projectId}
            current={status}
            allowed={PROJECT_TRANSITIONS[status] ?? []}
          />
        ) : (
          <p className="text-sm text-muted">You do not have permission to change project status.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Payment plan{' '}
          <span className="text-muted">
            ({plan.filter((m) => m.payment_percent !== null).length} priced milestone
            {plan.filter((m) => m.payment_percent !== null).length === 1 ? '' : 's'})
          </span>
        </h2>

        {/*
          The billing gate, stated rather than enforced. Everything before this
          milestone is paid for; this is the stage the client's money has
          unlocked. Nothing here stops an earlier or later milestone being
          invoiced — an agency bills an advance and a stage together often
          enough that hard-gating it would be inventing policy.
        */}
        {unlockedName ? (
          <p className="text-sm text-muted">
            {paidCount === 0
              ? 'No milestone is paid for yet. '
              : `${paidCount} milestone${paidCount === 1 ? '' : 's'} paid for. `}
            Next stage unlocked: <span className="font-medium">{unlockedName}</span>.
          </p>
        ) : billingEntries.some((e) => e.paymentPercent !== null) ? (
          <p className="text-sm text-muted">Every priced milestone on this plan is paid.</p>
        ) : null}

        {plan.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left dark:border-white/15">
                  {['#', 'Milestone', 'Share', 'Amount', 'Status', 'Due', 'Invoice'].map((h) => (
                    <th key={h} className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.map((m) => {
                  const invoice = liveInvoiceByMilestone.get(m.id) ?? null;
                  const priced = m.payment_percent !== null && m.amount_minor > 0;

                  return (
                    <tr key={m.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                      <td className="px-4 py-3 font-mono text-xs text-muted">{m.position + 1}</td>
                      <td className="px-4 py-3 font-medium">{m.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {m.payment_percent === null ? '—' : `${m.payment_percent}%`}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {money(m.amount_minor, m.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-md border border-black/10 px-2 py-0.5 font-mono text-xs dark:border-white/15">
                          {m.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {m.due_on ? DATE.format(new Date(m.due_on)) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {invoice ? (
                          <Link
                            href={`/invoices/${invoice.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {invoice.number}{' '}
                            <span className="text-muted">· {invoice.status}</span>
                          </Link>
                        ) : !priced ? (
                          <span className="text-xs text-muted">no payment</span>
                        ) : mayInvoice ? (
                          <GenerateInvoiceButton milestoneId={m.id} projectId={projectId} />
                        ) : (
                          <span className="text-xs text-muted">not invoiced</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">
            No payment plan yet. Any split totalling 100% works — 30/20/30/20, 5/10/30/20/35, or
            whatever this deal agreed.
          </p>
        )}

        {mayWritePlan ? (
          <details className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
            <summary className="cursor-pointer text-sm font-medium">Configure payment plan</summary>
            <div className="pt-3">
              <PaymentPlanForm
                projectId={projectId}
                initial={plan.map((m) => ({
                  name: m.name,
                  percent: m.payment_percent === null ? null : Number(m.payment_percent),
                  dueOn: m.due_on,
                }))}
              />
            </div>
          </details>
        ) : null}
      </section>

      {/*
        Phase 12 — G-021, G-022, G-023. Versions of what the client sees, and
        the review each one went through. Nothing here edits a version: an
        approval names one, and rewriting it would make the approval refer to
        something that no longer exists. A revision is v+1.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Deliverables</h2>

        {deliverables.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing has been shown to the client yet. Designs, prototypes and builds appear here,
            every version of them.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deliverables.map((d) => (
              <li key={d.id} className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">
                    {d.kind} v{d.version} — {d.title}
                  </span>
                  <span className="text-xs text-muted">{d.status.replace('_', ' ')}</span>
                </div>

                {d.changelog ? <p className="mt-1 text-sm text-muted">{d.changelog}</p> : null}

                {d.artifact_url ? (
                  <a
                    href={d.artifact_url}
                    className="mt-1 inline-block break-all text-xs underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {d.artifact_url}
                  </a>
                ) : null}

                {mayWriteProject && (d.status === 'draft' || d.status === 'changes_requested') ? (
                  <SubmitDeliverableForm deliverableId={d.id} projectId={projectId} />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {mayWriteProject ? (
          <details className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
            <summary className="cursor-pointer text-sm font-medium">Add a version</summary>
            <div className="pt-3">
              <AddDeliverableForm projectId={projectId} />
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
