import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { DataTable, StatusBadge } from '@/ui';
import { can } from '@/lib/authz/permissions';
import { listDeliverables, listOnboardingItems, readCompletionSummary } from '@/modules/projects/queries';
import { listProjectInvoices } from '@/modules/finance/queries';
import {
  nextUnlockedMilestone,
  paidThrough,
  type InvoiceStatus,
  type MilestoneBillingEntry,
} from '@/modules/finance/schema';
import { getProject, listPaymentPlan } from '@/modules/projects/queries';
import { getProposal } from '@/modules/sales/queries';
import { PROJECT_TRANSITIONS, type ProjectStatus } from '@/modules/projects/schema';

import { GenerateInvoiceButton } from './billing-panel';
import { PaymentPlanForm, ProjectStatusForm } from './delivery-panel';

export const metadata: Metadata = { title: 'Project' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

import { AddDeliverableForm, SubmitDeliverableForm } from './deliverables-panel';
import { OnboardingItemForm } from './onboarding-panel';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}`);

  const clock = await agencyClock();
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

  // Read only when one is linked. A project raised without a quotation is
  // legitimate under ADM-72, so its absence is an answer rather than a miss.
  const quotation = project.proposal_id ? await getProposal(project.proposal_id) : null;
  const deliverables = await listDeliverables(projectId);
  const onboarding = await listOnboardingItems(projectId);
  const summary = await readCompletionSummary(projectId);
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
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Project</p>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{project.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={project.status} />
          {project.budget_minor !== null ? (
            <span className="tabular text-[13px] text-muted">
              budget {money(project.budget_minor, project.currency)}
            </span>
          ) : null}
        </div>
        {/*
          G-114, ADM-72. An accepted quotation is *not* required to create a
          project — the owner ruled that Document 10 §2's "should not be
          created" governs a moment ADM-13 never gated, and that projects
          predating quotations stay valid. But the decision also requires the
          absence to be visible as well as auditable, and until this it was
          only auditable: conversion wrote `proposal_id` since G-017 and
          nothing read it.

          Both branches state a fact. Saying nothing when there is no
          quotation would leave a reader to guess whether one exists and was
          not shown, or does not exist — which is the ambiguity the decision
          asked to remove.
        */}
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
          {quotation
            ? `Accepted quotation · ${quotation.title} (v${quotation.version})`
            : 'No accepted quotation is linked to this project.'}
        </p>
      </header>

      {/* ── Onboarding (G-017, ADM-06) ───────────────────────────────── */}
      {onboarding.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Onboarding{' '}
            <span className="text-muted">
              ({onboarding.filter((i) => i.status !== 'pending').length} of {onboarding.length})
            </span>
          </h2>

          {/*
            Said plainly, because a list of seventeen things beside a project
            looks like a gate and is not one. ADM-06: the checklist blocks
            nothing. Every item is a reminder.
          */}
          <p className="text-xs text-muted">
            Every item is a reminder. None of them blocks the project from starting — the
            conditions for that are the advance, an approved requirement version and the
            WhatsApp group.
          </p>

          <ol className="flex flex-col gap-1">
            {onboarding.map((item) =>
              mayWriteProject ? (
                <OnboardingItemForm
                  key={item.id}
                  projectId={projectId}
                  itemId={item.id}
                  label={item.label}
                  status={item.status}
                />
              ) : (
                <li key={item.id} className="flex gap-2 text-sm">
                  <span className="w-4 text-center font-mono text-muted">
                    {item.status === 'pending' ? '·' : item.status === 'done' ? '✓' : '—'}
                  </span>
                  <span className={item.status === 'pending' ? '' : 'text-muted line-through'}>
                    {item.label}
                  </span>
                </li>
              ),
            )}
          </ol>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Delivery status</h2>
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
        <h2 className="text-[13px] font-semibold tracking-tight">
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
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            {paidCount === 0
              ? 'No milestone is paid for yet. '
              : `${paidCount} milestone${paidCount === 1 ? '' : 's'} paid for. `}
            Next stage unlocked: <span className="font-medium">{unlockedName}</span>.
          </p>
        ) : billingEntries.some((e) => e.paymentPercent !== null) ? (
          <p className="text-sm text-muted">Every priced milestone on this plan is paid.</p>
        ) : null}

        {plan.length > 0 ? (
          <DataTable
            rows={plan}
            columns={[
              {
                key: 'position',
                header: '#',
                width: '3rem',
                desktopOnly: true,
                cellClassName: 'font-mono text-xs text-muted',
                cell: (m) => m.position + 1,
              },
              { key: 'name', header: 'Milestone', primary: true, cell: (m) => m.name },
              {
                key: 'status',
                header: 'Status',
                badge: true,
                cell: (m) => <StatusBadge status={m.status} />,
              },
              {
                key: 'share',
                header: 'Share',
                align: 'right',
                cellClassName: 'tabular',
                cell: (m) => (m.payment_percent === null ? '—' : `${m.payment_percent}%`),
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                cellClassName: 'tabular font-medium',
                cell: (m) => money(m.amount_minor, m.currency),
              },
              {
                key: 'due',
                header: 'Due',
                align: 'right',
                cellClassName: 'text-muted',
                cell: (m) => (m.due_on ? clock.date(m.due_on) : '—'),
              },
              {
                key: 'invoice',
                header: 'Invoice',
                align: 'right',
                cell: (m) => {
                  const invoice = liveInvoiceByMilestone.get(m.id) ?? null;
                  const priced = m.payment_percent !== null && m.amount_minor > 0;
                  return invoice ? (
                    <Link
                      href={`/invoices/${invoice.id}`}
                      className="font-mono text-xs text-brand hover:underline"
                    >
                      {invoice.number} <span className="text-muted">· {invoice.status}</span>
                    </Link>
                  ) : !priced ? (
                    <span className="text-xs text-muted">no payment</span>
                  ) : mayInvoice ? (
                    <GenerateInvoiceButton milestoneId={m.id} projectId={projectId} />
                  ) : (
                    <span className="text-xs text-muted">not invoiced</span>
                  );
                },
              },
            ]}
            getKey={(m) => m.id}
          />
        ) : (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            No payment plan yet. Any split totalling 100% works — 30/20/30/20, 5/10/30/20/35, or
            whatever this deal agreed.
          </p>
        )}

        {mayWritePlan ? (
          <details className="rounded-lg border border-line bg-surface px-3 py-2">
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
        <h2 className="text-[13px] font-semibold tracking-tight">Deliverables</h2>

        {deliverables.length === 0 ? (
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
            Nothing has been shown to the client yet. Designs, prototypes and builds appear here,
            every version of them.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deliverables.map((d) => (
              <li key={d.id} className="rounded-lg border border-line bg-surface px-4 py-3">
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
          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Add a version</summary>
            <div className="pt-3">
              <AddDeliverableForm projectId={projectId} />
            </div>
          </details>
        ) : null}
      </section>

      {/*
        Directive §23 — how the project actually went, assembled from five
        tables that already held every fact. A read: nothing here closes a
        project or refuses anything on the outstanding balance, because what
        these numbers imply about closing is ADM-13/ADM-14 and ADM-19.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Summary</h2>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Invoiced', money(summary.invoiced_minor, project.currency)],
            ['Paid', money(summary.paid_minor, project.currency)],
            ['Outstanding', money(summary.outstanding_minor, project.currency)],
            ['Milestones', `${summary.milestones_met}/${summary.milestones_total}`],
            ['Versions', String(summary.deliverables)],
            ['Revisions', String(summary.revisions)],
            ['Defects open', `${summary.defects_open}/${summary.defects_total}`],
            [
              'Duration',
              summary.duration_days === null ? 'running' : `${summary.duration_days} days`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="text-sm font-semibold tabular">{value}</div>
              <div className="text-xs text-muted">{label}</div>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted">
          {summary.final_version
            ? `Final approved version: ${summary.final_version}.`
            : 'No version has been approved yet.'}{' '}
          {summary.handover_status
            ? `Handover ${summary.handover_status}.`
            : 'No handover prepared.'}
        </p>
      </section>
    </div>
  );
}
