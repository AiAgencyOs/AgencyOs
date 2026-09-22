import type { Metadata } from 'next';
import Link from 'next/link';

import { ProjectSubNav } from './project-subnav';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { Badge, DataTable, StatusBadge, IconArrowUpRight } from '@/ui';
import { can } from '@/lib/authz/permissions';
import {
  listDeliverables,
  listOnboardingItems,
  readCompletionSummary,
  readMissingInfoMessage,
  readNextQuestions,
} from '@/modules/projects/queries';
import {
  listFreeMaintenance,
  listPaymentClaims,
  listProjectInvoices,
  readPaymentLadder,
  readProjectBilling,
} from '@/modules/finance/queries';
import { LADDER_CAPTION, describeLadder, ladderRungs } from '@/modules/finance/ladder';
import {
  nextUnlockedMilestone,
  paidThrough,
  type InvoiceStatus,
  type MilestoneBillingEntry,
} from '@/modules/finance/schema';
import { getProject, listPaymentPlan, readGroupSetup, readPhaseTwo, readProjectGroupName } from '@/modules/projects/queries';
import { listApprovalsForSubject } from '@/modules/approvals/queries';
import { listDefects, readProjectQuality } from '@/modules/qa/queries';
import { blocksDelivery, type DefectSeverity, type DefectStatus } from '@/modules/qa/schema';
import { getProposal } from '@/modules/sales/queries';
import { PROJECT_TRANSITIONS, type ProjectStatus } from '@/modules/projects/schema';

import {
  BillingDetailsForm,
  BillingModeForm,
  FreeMaintenanceInvoiceButton,
  GenerateInvoiceButton,
} from './billing-panel';
import { PaymentPlanForm, ProjectStatusForm, StartProjectForm } from './delivery-panel';

export const metadata: Metadata = { title: 'Project' };

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(minor / 100);
}

import { AddDeliverableForm, SubmitDeliverableForm } from './deliverables-panel';
import { ProductionReadyForm, RaiseDefectForm, SettleDefectForm } from './qa-panel';
import { RecordClaimForm, VerifyClaimForm } from './claims-panel';
import { ProjectGroupPanel } from './group-panel';
import { PhaseTwoPanel } from './phase-two-panel';
import { ONBOARDING_MARK, OnboardingItemForm } from './onboarding-panel';

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
  /**
   * G-276 — what is still worth asking this client, and what Phase 1 already
   * answered. G-252 and G-266 each built half of PM-03's "do not re-ask known
   * details" and neither had a caller.
   */
  const questions = await readNextQuestions(projectId);
  // G-309 — the words to copy for whichever item `questions` names as
  // askable. Rendered separately because it can be a permission or a "nothing
  // to ask" refusal even when `questions` itself read cleanly.
  const missingInfoMessage = await readMissingInfoMessage(projectId);
  const summary = await readCompletionSummary(projectId);
  /**
   * G-306 — the defect register and the counts the delivery gate reads.
   * `submit_deliverable` has refused on an open blocker since Phase 12 and
   * `mark_production_ready` reads the same numbers; neither register nor
   * counts had ever been rendered, so the gate was live and the thing behind
   * it could not be written to.
   */
  /**
   * The review each version went through — G-306. The section below has said
   * *"Versions of what the client sees, and the review each one went
   * through"* since Phase 12 and rendered only the current status; the reader
   * that holds the history had no caller at all.
   *
   * §19's point, in the reader's own words: *"a deliverable rejected twice
   * and approved on the third pass has three rows here and one status there,
   * and the three are the story."*
   */
  const deliverableApprovals = new Map(
    await Promise.all(
      deliverables.map(
        async (d) => [d.id, await listApprovalsForSubject('deliverable', d.id)] as const,
      ),
    ),
  );
  /**
   * Doc 15 §11 and §12 — what anybody has SAID they paid, and what is still
   * unchecked. G-272: the table, the guard, the door and §4.7's three
   * decisions were all built and nothing in the application touched any of
   * it, on either side.
   */
  const claims = can(context.role, 'invoice.read') ? await listPaymentClaims(projectId) : [];
  const defects = await listDefects(projectId);
  const quality = await readProjectQuality(projectId);
  // G-188. The name the group must carry, composed from the rows rather than
  // typed — and what is still missing when it cannot be.
  const group = await readProjectGroupName(projectId);
  const groupCard = await readGroupSetup(projectId);
  const phaseTwo = await readPhaseTwo(projectId);
  /**
   * G-268 — where this project is on Finance §12's ladder.
   *
   * Money, so it is behind `invoice.read` like every other figure in this
   * section. A role without it sees no percentage rather than a zero.
   *
   * A read that FAILS throws (G-054), it does not come back as 0%. That is
   * the whole point of the reader living in `queries.ts`: an unreadable
   * project and a project whose client has paid nothing are different facts,
   * and the second one is a page somebody acts on.
   */
  const progress = can(context.role, 'invoice.read') ? await readPaymentLadder(projectId) : null;
  // G-269, Finance §9 — maintenance that came with the project rather than
  // being sold. Empty for every project that has none, which is most of them.
  const freeMaintenance = can(context.role, 'invoice.read')
    ? await listFreeMaintenance(projectId)
    : [];
  /**
   * G-275, Finance §4.1–§4.3 — how this project is billed.
   *
   * G-259 made every invoice refuse until a mode is confirmed, and until now
   * nothing could confirm one: the refusal named an action the product did
   * not offer. Read here so the gate and the way through it are on the same
   * screen.
   */
  const billing = can(context.role, 'invoice.read') ? await readProjectBilling(projectId) : null;
  const mayWriteProject = can(context.role, 'project.write');
  // ADM-19's own role set, deliberately NOT delivery_lead: a delivery lead
  // declaring their own work production ready is the review signing its own
  // homework.
  const maySignOff = can(context.role, 'project.sign_off');
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
        {/* Blueprint §8: the WON state carries a handoff link. The packet is
            keyed by the deal, which a project raised from a win remembers. */}
        {project.opportunity_id ? (
          <Link
            href={`/handoffs/${project.opportunity_id}`}
            className="inline-flex items-center gap-1 self-start text-[13px] font-medium underline underline-offset-2 hover:text-foreground"
          >
            Handoff packet — what Sales handed to this project
            <IconArrowUpRight size={13} />
          </Link>
        ) : null}
      </header>

      <ProjectSubNav projectId={projectId} />

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

          {/*
            G-276. PM §4.2 asks for ONE clear request at a time, and §4.1 for
            the context Phase 1 already confirmed never to be asked again. The
            single `askNext` item comes back from the database (G-266);
            nothing here picks it, because "outstanding" and "askable" are
            different and the page would get the difference wrong.
          */}
          {questions.outstanding.length > 0 ? (
            <div className="flex max-w-2xl flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
              {questions.outstanding.find((q) => q.askNext) ? (
                <>
                  <p>
                    Ask next:{' '}
                    <span className="font-medium">
                      {questions.outstanding.find((q) => q.askNext)!.label}
                    </span>
                  </p>
                  {/*
                    G-309. Rendered from live backend state (never re-templated
                    here) the same way Phase 3's design messages are — a PM has
                    actual words to copy instead of composing this by hand for
                    every project. AgencyOS has no channel configured (BLK-003,
                    BLK-007), so this offers the words; it does not send them.
                  */}
                  {missingInfoMessage.body ? (
                    <div className="flex flex-col gap-1 rounded-md border border-line bg-muted/20 p-2">
                      <p className="whitespace-pre-wrap">{missingInfoMessage.body}</p>
                      <p className="text-xs text-muted">
                        Copy this and send it yourself — AgencyOS has no channel configured.
                      </p>
                    </div>
                  ) : missingInfoMessage.blockedReason ? (
                    <p className="text-xs text-muted">{missingInfoMessage.blockedReason}</p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted">
                  Nothing to ask right now — everything outstanding is either already with the
                  client or waiting on somebody here to check it.
                </p>
              )}
              <p className="text-muted">
                {questions.outstanding.filter((q) => q.withClient).length} with the client ·{' '}
                {questions.outstanding.filter((q) => q.withUs).length} waiting on us
              </p>
              {questions.known === null ? (
                /*
                  Not "nothing was confirmed". A project converted before G-250
                  has no handoff packet to inherit from, and saying the wrong
                  one of those invites somebody to re-ask a client everything.
                */
                <p className="text-muted">
                  Inherited context is not available for this project — it has no WON handoff
                  packet.
                </p>
              ) : (
                <p className="text-muted">
                  {questions.known.length} detail{questions.known.length === 1 ? '' : 's'} already
                  confirmed in Phase 1 — do not ask for {questions.known.length === 1 ? 'it' : 'them'} again.
                </p>
              )}
            </div>
          ) : null}

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
                    {ONBOARDING_MARK[item.status] ?? '·'}
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

      <PhaseTwoPanel view={phaseTwo} projectId={projectId} />

      <ProjectGroupPanel group={group} card={groupCard} projectId={projectId} />

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Delivery status</h2>
        {mayWriteProject ? (
          <>
            {/*
              "active" is deliberately excluded from the generic dropdown
              while onboarding — ADM-13 (G-026) gates that specific move
              behind three conditions this form knows nothing about.
              StartProjectForm below is the only door for it.
            */}
            <ProjectStatusForm
              projectId={projectId}
              current={status}
              allowed={(PROJECT_TRANSITIONS[status] ?? []).filter(
                (s) => !(status === 'onboarding' && s === 'active'),
              )}
            />
            {status === 'onboarding' ? (
              <StartProjectForm
                projectId={projectId}
                canOverride={can(context.role, 'organization.settings')}
              />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">You do not have permission to change project status.</p>
        )}
      </section>

      {billing ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">How this project is billed</h2>
            {billing.mode ? (
              <Badge tone={billing.complete ? 'success' : 'warning'}>
                {billing.mode === 'gst' ? 'GST' : 'Non-GST'}
                {billing.version ? ` · v${billing.version}` : ''}
              </Badge>
            ) : (
              <Badge tone="danger">not confirmed</Badge>
            )}
          </div>
          {/*
            The gate and the way through it on one screen. Finance §16 asks for
            "only missing fields" to be requested, so the list comes back from
            `billingReadiness` rather than the page guessing which of them a
            Non-GST project even needs.
          */}
          {!billing.mode ? (
            <p className="max-w-2xl text-[13px] text-muted">
              No invoice can be raised for this project until somebody records whether the client is
              billed with GST or without it. Every quotation this agency sends says GST is extra, so
              choosing wrongly here is a bill that contradicts a promise in writing.
            </p>
          ) : !billing.complete ? (
            <p className="max-w-2xl text-[13px] text-muted">
              Still needed before an invoice can be raised:{' '}
              <span className="text-fg">{billing.missing.join(', ')}</span>
              {billing.invalid.length > 0
                ? ` · not valid: ${billing.invalid.map((i) => `${i.field} (${i.reason})`).join(', ')}`
                : ''}
              .
            </p>
          ) : (
            <p className="max-w-2xl text-[13px] text-muted">
              Complete. Invoices can be raised.
            </p>
          )}
          {mayInvoice ? (
            <div className="flex flex-col gap-2">
              <BillingModeForm projectId={projectId} billing={billing} />
              {billing.mode === 'gst' || !billing.complete ? (
                <BillingDetailsForm projectId={projectId} />
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

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

        {progress ? (
          <div className="flex max-w-2xl flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              {/*
                The rungs are `cumulativeLadder()`'s — 30/50/80/100, derived
                from ADM-105's locked 30/20/30/20. Writing them here would be
                a second copy of a structure nobody may change.
              */}
              {ladderRungs(progress).map((rung) => (
                <span
                  key={rung.cumulative}
                  className={
                    rung.cleared
                      ? 'rounded-md bg-success/10 px-2 py-0.5 tabular text-success'
                      : 'rounded-md border border-line px-2 py-0.5 tabular text-muted'
                  }
                >
                  {rung.cumulative}%
                </span>
              ))}
            </div>
            <p>{describeLadder(progress).money}</p>
            <p className={progress.gate.open ? 'text-success' : 'text-muted'}>
              {describeLadder(progress).gate}
            </p>
            <p className="text-xs text-muted">{LADDER_CAPTION}</p>
          </div>
        ) : null}

        {freeMaintenance.length > 0 ? (
          <div className="flex max-w-2xl flex-col gap-1">
            {/*
              Finance §9. The gate is in the door, not here: a project that is
              not fully verified gets the button and a refusal naming why,
              rather than a control that vanishes for a reason nobody is told.
            */}
            <p className="text-[13px] text-muted">
              Maintenance included with this project. §9 asks for a ₹0 invoice once the project is
              fully paid — nothing is collected and nobody verifies it, because there is nothing to
              verify.
            </p>
            {freeMaintenance.map((plan) => (
              <FreeMaintenanceInvoiceButton
                key={plan.planId}
                planId={plan.planId}
                projectId={projectId}
                name={plan.name}
                endsOn={plan.endsOn}
                invoiceNumber={plan.invoiceNumber}
              />
            ))}
          </div>
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

                {(deliverableApprovals.get(d.id) ?? []).length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
                    {(deliverableApprovals.get(d.id) ?? []).map((a) => (
                      <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
                        <Link href={`/approvals/${a.id}`} className="underline-offset-2 hover:underline">
                          {a.state.replace(/_/g, ' ')}
                          {a.decided_at ? ` · ${clock.date(a.decided_at)}` : ' · waiting'}
                        </Link>
                        {a.summary ? <span className="min-w-0 flex-1 truncate">{a.summary}</span> : null}
                      </li>
                    ))}
                  </ul>
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
        Doc 15 §11 and §12 — the claim layer. A claim is what somebody SAID;
        it moves no money and unlocks nothing. Confirming one records that a
        person checked it, and the ledger row is still a separate act (G-272).
      */}
      {mayInvoice ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">Payment claims</h2>
          <p className="max-w-2xl text-[13px] text-muted">
            What a client said they paid, before anybody wrote it down. Nothing here moves an
            invoice — verifying a claim records that somebody checked it, and the payment itself is
            recorded on the invoice.
          </p>

          {claims.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing has been claimed.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {claims.map((c) => (
                <li key={c.id} className="rounded-lg border border-line bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium tabular">
                      {money(c.amount_minor, c.currency)}{' '}
                      <span className="text-muted">
                        {c.method.replace('_', ' ')}
                        {c.reference ? ` · ${c.reference}` : ''}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted">
                      {c.status === 'pending_verification' ? (
                        <Badge tone="warning">unchecked</Badge>
                      ) : c.status === 'mismatch' ? (
                        <Badge tone="danger">needs resolution</Badge>
                      ) : null}
                      {c.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                  {c.payer_name ? <p className="mt-1 text-[13px] text-muted">{c.payer_name}</p> : null}
                  {c.verification_evidence ? (
                    <p className="mt-1 text-[13px]">Checked: {c.verification_evidence}</p>
                  ) : null}
                  {c.mismatch_note ? <p className="mt-1 text-[13px]">Mismatch: {c.mismatch_note}</p> : null}
                  {c.rejected_reason ? <p className="mt-1 text-[13px]">Rejected: {c.rejected_reason}</p> : null}
                  {/* Verified and still no ledger row: the distinction the
                      whole layer exists for, said where somebody can act on it. */}
                  {c.status === 'verified' && c.payment_id === null ? (
                    <p className="mt-1 text-[13px] text-warning">
                      Verified, and not yet recorded as a payment — the invoice has not moved.
                    </p>
                  ) : null}

                  <VerifyClaimForm projectId={projectId} claim={c} />
                </li>
              ))}
            </ul>
          )}

          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Record a claim</summary>
            <div className="pt-3">
              <RecordClaimForm
                projectId={projectId}
                invoices={invoices.map((i) => ({ id: i.id, number: i.number, status: i.status }))}
              />
            </div>
          </details>
        </section>
      ) : null}

      {/*
        ARCHITECTURE.md §4.8 and ADM-19 — the register the delivery gate reads.
        `submit_deliverable` refuses while an open blocker or major exists and
        `mark_production_ready` reads the same counts (G-306).
      */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Quality</h2>

        {/*
          The counts come from `project_quality`, and nothing here re-derives
          them: a second copy would disagree the moment somebody verified a
          defect in another tab. `blocksDelivery` decides only which ROWS to
          mark, and it is the module's own rule rather than a repeat of it.
        */}
        <p className="max-w-2xl text-[13px] text-muted">
          {quality.open_blockers + quality.open_majors === 0
            ? `Nothing is blocking a submission. ${quality.open_minors} open minor${quality.open_minors === 1 ? '' : 's'}, ${quality.unverified} awaiting verification.`
            : `${quality.open_blockers} blocker${quality.open_blockers === 1 ? '' : 's'} and ${quality.open_majors} major${quality.open_majors === 1 ? '' : 's'} are open. A version cannot be submitted to the client until they are settled.`}
        </p>

        {defects.length === 0 ? (
          <p className="max-w-2xl text-[13px] text-muted">No defects have been raised.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {defects.map((d) => (
              <li key={d.id} className="rounded-lg border border-line bg-surface px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{d.title}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {blocksDelivery({ status: d.status as DefectStatus, severity: d.severity as DefectSeverity }) ? (
                      <Badge tone="danger">blocks delivery</Badge>
                    ) : null}
                    {d.severity} · {d.status}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted">{d.reproduction}</p>
                {d.resolution ? <p className="mt-1 text-[13px]">{d.resolution}</p> : null}

                {mayWriteProject ? <SettleDefectForm projectId={projectId} defect={d} /> : null}
              </li>
            ))}
          </ul>
        )}

        {mayWriteProject ? (
          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Raise a defect</summary>
            <div className="pt-3">
              <RaiseDefectForm
                projectId={projectId}
                deliverables={deliverables.map((d) => ({
                  id: d.id,
                  kind: d.kind,
                  version: d.version,
                  title: d.title,
                }))}
              />
            </div>
          </details>
        ) : null}

        {maySignOff ? <ProductionReadyForm projectId={projectId} /> : null}
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
