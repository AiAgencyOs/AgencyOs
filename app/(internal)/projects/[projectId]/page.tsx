import type { Metadata } from 'next';
import Link from 'next/link';

import { ProjectSubNav } from './project-subnav';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import {
  ActivityFeed,
  Avatar,
  Badge,
  buttonClass,
  Card,
  CardHeader,
  DataTable,
  DetailPanel,
  EntityHeader,
  HeaderFigure,
  IconAlert,
  IconArrowUpRight,
  IconCalendar,
  IconCheck,
  IconClock,
  IconEdit,
  IconFile,
  IconFlag,
  IconGrid,
  IconInvoices,
  IconList,
  IconPlus,
  IconUpload,
  IconUser,
  IconUsers,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  StatusStepper,
  Timeline,
  ViewAll,
  humanize,
  statusTone,
  type ActivityItem,
  type Column,
  type TimelineStep,
} from '@/ui';
import { readClientName } from '@/lib/admin/clients';

import { TrailLabel } from '../../trail-label';
import { can } from '@/lib/authz/permissions';
import {
  listDeliverables,
  listDevelopmentBreakdown,
  listInternalRoster,
  listOnboardingItems,
  listProjectFiles,
  listProjectTeam,
  readCompletionSummary,
  readMissingInfoMessage,
  readNextQuestions,
  readDesignTrail,
  readPlanBoard,
  type DevelopmentTask,
} from '@/modules/projects/queries';
import { listTestRuns } from '@/modules/qa/queries';
import { readHandoverPackage } from '@/modules/qa/release-queries';
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
import { getProject, listPaymentPlan, readGroupSetup, readPhaseTwo, readPhaseFourOverview, readProjectGroupName } from '@/modules/projects/queries';
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
import { DefectTriageForm, ProductionReadyForm, RaiseDefectForm, SettleDefectForm } from './qa-panel';
import { RecordClaimForm, VerifyClaimForm } from './claims-panel';
import { ProjectGroupPanel } from './group-panel';
import { PhaseTwoPanel } from './phase-two-panel';
import { PhaseFourPanel } from './phase-four-panel';
import { ONBOARDING_MARK, OnboardingItemForm } from './onboarding-panel';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}`);

  const clock = await agencyClock();
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

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
  const phaseFour = await readPhaseFourOverview(projectId);
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

  /**
   * The reference overview's header, KPI row, timeline, task table and right
   * rail — every figure from readers the workspace's own tabs already use
   * (Development, Team, Files, Activity), so the overview can never disagree
   * with the tab it summarises.
   */
  // SCR-019 — the phase evidence the PDF asks the overview to show: design
  // (Phase 3), plan (Phase 5), QA (Phase 6) and handover (Phase 7), each the
  // tab's own reader, summarised into one figure and a link.
  const [designTrail, planBoard, testRuns, handover] = await Promise.all([
    readDesignTrail(projectId),
    readPlanBoard(projectId),
    listTestRuns(projectId, 50),
    readHandoverPackage(projectId),
  ]);
  const latestRun = testRuns[0] ?? null;
  const [{ tasks }, team, files, roster, clientName] = await Promise.all([
    listDevelopmentBreakdown(projectId),
    listProjectTeam(projectId),
    listProjectFiles(projectId),
    listInternalRoster(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const nameByUser = new Map(team.map((m) => [m.userId, m.fullName]));
  const todayKey = new Date().toISOString().slice(0, 10);
  const taskCounts = {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    pending: tasks.filter((t) => t.status === 'todo').length,
    overdue: tasks.filter((t) => t.status !== 'done' && t.dueOn !== null && t.dueOn < todayKey).length,
  };
  const pctOf = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  const daysLeft = project.ends_on
    ? Math.ceil((new Date(`${project.ends_on}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000)
    : null;
  const overallProgress = plan.length > 0 ? pctOf(summary.milestones_met, summary.milestones_total) : pctOf(taskCounts.done, taskCounts.total);
  const healthy = quality.open_blockers === 0 && taskCounts.overdue === 0 && status !== 'on_hold';

  // The current milestone is the first one not yet met; everything before it
  // is done, everything after it is upcoming. `met_at` is the only fact read.
  let currentSeen = false;
  const timelineSteps: TimelineStep[] = plan.map((m) => {
    if (m.met_at) return { label: m.name, caption: `Met ${clock.date(m.met_at)}`, state: 'done' };
    if (!currentSeen) {
      currentSeen = true;
      return { label: m.name, caption: m.due_on ? `Due ${clock.date(m.due_on)}` : 'In progress', state: 'current' };
    }
    return { label: m.name, caption: m.due_on ? clock.date(m.due_on) : undefined, state: 'upcoming' };
  });

  const recentTasks = [...tasks].reverse().slice(0, 5);
  const taskColumns: Column<DevelopmentTask>[] = [
    { key: 'title', header: 'Task name', primary: true, cell: (t) => t.title },
    {
      key: 'assignee',
      header: 'Assignee',
      desktopOnly: true,
      cell: (t) =>
        t.assigneeId ? (
          <span className="flex items-center gap-2">
            <Avatar name={nameByUser.get(t.assigneeId) ?? t.assigneeId} size="sm" />
            <span className="truncate text-muted">{nameByUser.get(t.assigneeId) ?? 'Unknown'}</span>
          </span>
        ) : (
          <span className="text-muted">Unassigned</span>
        ),
    },
    { key: 'status', header: 'Status', badge: true, cell: (t) => <StatusBadge status={t.status} dot={false} /> },
    { key: 'due', header: 'Due date', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (t) => (t.dueOn ? clock.date(t.dueOn) : '—') },
    {
      key: 'priority',
      header: 'Priority',
      align: 'right',
      cell: (t) => (
        <Badge tone={t.priority === 'p0' ? 'danger' : t.priority === 'p1' ? 'warning' : t.priority === 'p2' ? 'info' : 'neutral'}>
          {t.priority === 'p0' ? 'Critical' : t.priority === 'p1' ? 'High' : t.priority === 'p2' ? 'Medium' : 'Low'}
        </Badge>
      ),
    },
  ];

  const activity: ActivityItem[] = [
    ...tasks.filter((t) => t.completedAt).map((t) => ({ id: `task-${t.id}`, at: t.completedAt as string, title: `Task completed — ${t.title}`, detail: t.assigneeId ? nameByUser.get(t.assigneeId) : undefined, tone: 'success' as const, icon: <IconCheck size={13} /> })),
    ...plan.filter((m) => m.met_at).map((m) => ({ id: `ms-${m.id}`, at: m.met_at as string, title: `Milestone met — ${m.name}`, tone: 'brand' as const, icon: <IconFlag size={13} /> })),
    ...deliverables.map((d) => ({ id: `del-${d.id}`, at: d.created_at, title: `${humanize(d.kind)} v${d.version} — ${d.title}`, detail: humanize(d.status), tone: statusTone(d.status), icon: <IconFile size={13} /> })),
    ...files.map((f) => ({ id: `file-${f.id}`, at: f.createdAt, title: `File added — ${f.title}`, detail: f.uploadedByName ?? undefined, tone: 'info' as const, icon: <IconUpload size={13} /> })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 6)
    .map(({ at, ...rest }) => ({ ...rest, when: clock.dateTime(at), href: `/projects/${projectId}/activity` }));

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name={project.name} />
      <EntityHeader
        name={project.name}
        status={<StatusBadge status={project.status} />}
        subtitle={
          project.description ??
          (quotation
            ? `Accepted quotation · ${quotation.title} (v${quotation.version})`
            : 'No accepted quotation is linked to this project.')
        }
        facts={[
          { label: 'Client', value: clientName ?? 'Internal project', icon: <IconUser size={14} /> },
          { label: 'Project code', value: <span className="font-mono">{project.code}</span>, icon: <IconList size={14} /> },
          { label: 'Start date', value: project.starts_on ? clock.date(project.starts_on) : 'Not set', icon: <IconCalendar size={14} /> },
          { label: 'Due date', value: project.ends_on ? clock.date(project.ends_on) : 'Not set', icon: <IconCalendar size={14} /> },
          ...(project.budget_minor !== null ? [{ label: 'Budget', value: money(project.budget_minor, project.currency), icon: <IconInvoices size={14} /> }] : []),
        ]}
        actions={
          <>
            {project.opportunity_id ? (
              <Link href={`/handoffs/${project.opportunity_id}`} className={buttonClass('secondary', 'sm')}>
                Handoff packet
                <IconArrowUpRight size={13} />
              </Link>
            ) : null}
            <Link href={`/projects/${projectId}/board`} className={buttonClass('secondary', 'sm')}>
              <IconGrid size={14} />
              Board
            </Link>
            {mayWriteProject ? (
              <Link href={`/projects/${projectId}/settings`} className={buttonClass('primary', 'sm')}>
                <IconEdit size={14} />
                Edit project
              </Link>
            ) : null}
          </>
        }
        aside={
          <HeaderFigure value={`${overallProgress}%`} label="Overall progress">
            <ProgressBar value={overallProgress} showValue={false} label="Overall progress" tone="brand" />
          </HeaderFigure>
        }
      >
        <div className="mt-4 border-t border-line pt-4">
          <StatusStepper
            status={status}
            happyPath={['planning', 'onboarding', 'active', 'completed']}
            offRamps={['on_hold', 'cancelled']}
          />
        </div>
      </EntityHeader>

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat label="Total tasks" href={`/projects/${projectId}/development`} value={String(taskCounts.total)} caption={`${taskCounts.done} completed · ${pctOf(taskCounts.done, taskCounts.total)}%`} tone="brand" icon={<IconList size={16} />} />
        <Stat label="In progress" href={`/projects/${projectId}/board`} value={String(taskCounts.inProgress)} caption={`${pctOf(taskCounts.inProgress, taskCounts.total)}%`} tone="info" icon={<IconClock size={16} />} />
        <Stat label="Pending" href={`/projects/${projectId}/board`} value={String(taskCounts.pending)} caption={`${pctOf(taskCounts.pending, taskCounts.total)}%`} tone="warning" icon={<IconClock size={16} />} />
        <Stat label="Overdue" href={`/projects/${projectId}/board`} value={String(taskCounts.overdue)} caption={`${pctOf(taskCounts.overdue, taskCounts.total)}%`} tone={taskCounts.overdue > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat label="Days left" href={`/projects/${projectId}/calendar`} value={daysLeft === null ? '—' : String(daysLeft)} caption={project.ends_on ? `Due ${clock.date(project.ends_on)}` : 'No due date set'} tone={daysLeft !== null && daysLeft < 0 ? 'danger' : 'accent'} icon={<IconCalendar size={16} />} />
        <Stat
          label="Project health"
          href={`/projects/${projectId}/qa`}
          value={healthy ? 'On track' : 'At risk'}
          caption={
            healthy
              ? 'No blockers, nothing overdue'
              : [quality.open_blockers > 0 ? `${quality.open_blockers} blocker${quality.open_blockers === 1 ? '' : 's'}` : null, taskCounts.overdue > 0 ? `${taskCounts.overdue} overdue` : null, status === 'on_hold' ? 'on hold' : null].filter(Boolean).join(' · ')
          }
          tone={healthy ? 'success' : 'danger'}
          icon={<IconCheck size={16} />}
        />
      </StatGrid>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: 'Phase 3 · Design',
            href: `/projects/${projectId}/design`,
            value: designTrail.phase ? humanize(designTrail.phase.state) : 'Not started',
            caption: designTrail.phase
              ? `${designTrail.themes.length} theme option${designTrail.themes.length === 1 ? '' : 's'} · ${designTrail.phase.revisionCount} of ${designTrail.phase.revisionLimit} revisions${designTrail.baseline ? ` · ${designTrail.baseline.screenCount} screens` : ''}`
              : 'No design phase opened',
            tone: designTrail.phase ? statusTone(designTrail.phase.state) : 'neutral',
          },
          {
            label: 'Phase 5 · Plan',
            href: `/projects/${projectId}/plan`,
            value: planBoard.plan ? `v${planBoard.plan.version} ${humanize(planBoard.plan.status)}` : 'No plan',
            caption: planBoard.plan ? `${planBoard.deliverables.length} deliverables · ${planBoard.milestones.length} milestones` : 'The kickoff gate waits on one',
            tone: planBoard.plan ? statusTone(planBoard.plan.status) : 'neutral',
          },
          {
            label: 'Phase 6 · QA',
            href: `/projects/${projectId}/qa`,
            value: latestRun ? `${latestRun.passed}/${latestRun.total} passed` : quality.total > 0 ? `${quality.total} defect${quality.total === 1 ? '' : 's'}` : 'No runs',
            caption: latestRun ? `${testRuns.length} run${testRuns.length === 1 ? '' : 's'} · latest ${clock.date(latestRun.executedAt)} · ${quality.open_blockers} blocker${quality.open_blockers === 1 ? '' : 's'}` : 'Nothing executed yet',
            tone: latestRun ? (latestRun.failed > 0 ? 'warning' : 'success') : 'neutral',
          },
          {
            label: 'Phase 7 · Handover',
            href: `/projects/${projectId}/release`,
            value: handover ? humanize(handover.status) : 'Not prepared',
            caption: handover ? `${handover.items.length} package item${handover.items.length === 1 ? '' : 's'}${handover.accepted_at ? ` · accepted ${clock.date(handover.accepted_at)}` : handover.delivered_at ? ` · delivered ${clock.date(handover.delivered_at)}` : ''}` : 'Prepared on the Release tab',
            tone: handover ? statusTone(handover.status) : 'neutral',
          },
        ].map((tile) => (
          <Link key={tile.label} href={tile.href} className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:bg-surface-hover">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{tile.label}</span>
            <span className="flex items-center gap-2">
              <span className="text-base font-semibold">{tile.value}</span>
              <Badge tone={tile.tone as never} dot>{tile.tone === 'neutral' ? 'pending' : 'evidence'}</Badge>
            </span>
            <span className="text-xs text-muted">{tile.caption}</span>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
      <div className="flex min-w-0 flex-col gap-4 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">
      <Card>
        <CardHeader title="Project timeline" description={plan.length === 0 ? 'No milestones planned yet.' : `${summary.milestones_met} of ${summary.milestones_total} milestones met.`} actions={<ViewAll href={`/projects/${projectId}/plan`} label="View full plan" />} />
        {timelineSteps.length > 0 ? (
          <div className="p-4 sm:p-5">
            <Timeline steps={timelineSteps} />
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Recent tasks"
          actions={
            <>
              <ViewAll href={`/projects/${projectId}/development`} />
              {can(context.role, 'task.write') ? (
                <Link href={`/projects/${projectId}/development`} className={buttonClass('primary', 'sm')}>
                  <IconPlus size={14} />
                  Add task
                </Link>
              ) : null}
            </>
          }
        />
        <div className="px-4 pb-4 sm:px-5">
          {recentTasks.length === 0 ? (
            <p className="py-3 text-[13px] text-muted">No tasks yet. Tasks are created on the Development tab.</p>
          ) : (
            <DataTable dense rows={recentTasks} columns={taskColumns} getKey={(t) => t.id} href={() => `/projects/${projectId}/development`} />
          )}
        </div>
      </Card>


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

      <PhaseFourPanel view={phaseFour} projectId={projectId} />

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
              <span className="text-foreground">{billing.missing.join(', ')}</span>
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

      <section id="billing" className="flex flex-col gap-3">
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

                {d.assignee_id ? <p className="mt-1 text-xs text-muted">Assigned to {roster.find((r) => r.userId === d.assignee_id)?.fullName ?? 'a member'}</p> : null}
                {mayWriteProject ? <DefectTriageForm projectId={projectId} defect={d} roster={roster.map((r) => ({ userId: r.userId, fullName: r.fullName }))} /> : null}
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

      {/* ── Right rail ────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-4">
        <DetailPanel
          title="Project details"
          actions={mayWriteProject ? <ViewAll href={`/projects/${projectId}/settings`} label="Edit" /> : undefined}
          rows={[
            { label: 'Project name', value: project.name },
            { label: 'Client', value: project.client_account_id ? <Link href={`/clients/${project.client_account_id}`} className="text-brand hover:underline">{clientName ?? 'Client'}</Link> : 'Internal project' },
            { label: 'Code', value: <span className="font-mono">{project.code}</span> },
            { label: 'Start date', value: project.starts_on ? clock.date(project.starts_on) : 'Not set' },
            { label: 'Due date', value: project.ends_on ? clock.date(project.ends_on) : 'Not set' },
            { label: 'Status', value: <StatusBadge status={project.status} /> },
            { label: 'Budget', value: project.budget_minor === null ? 'Not set' : money(project.budget_minor, project.currency) },
            ...(can(context.role, 'invoice.read')
              ? [
                  { label: 'Invoiced', value: money(summary.invoiced_minor, project.currency) },
                  { label: 'Amount received', value: `${money(summary.paid_minor, project.currency)}${summary.invoiced_minor > 0 ? ` (${pctOf(summary.paid_minor, summary.invoiced_minor)}%)` : ''}` },
                  { label: 'Balance', value: money(summary.outstanding_minor, project.currency) },
                ]
              : []),
            { label: 'Team size', value: `${team.length} member${team.length === 1 ? '' : 's'}` },
            { label: 'Visibility', value: humanize(project.visibility) },
            { label: 'Quotation', value: quotation ? `${quotation.title} (v${quotation.version})` : 'None linked' },
            ...(project.description ? [{ label: 'Description', value: <span className="font-normal text-muted">{project.description}</span> }] : []),
          ]}
        />

        <Card>
          <CardHeader title={`Team members (${team.length})`} actions={<ViewAll href={`/projects/${projectId}/team`} label="Manage" />} />
          {team.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No one assigned yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {team.slice(0, 5).map((m) => (
                <li key={m.userId} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                  <Avatar name={m.fullName} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">{m.fullName}</span>
                    <span className="block truncate text-xs text-muted">{humanize(m.role)}</span>
                  </span>
                  <Badge tone="info">{m.tasksDone}/{m.tasksTotal} tasks</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent files" actions={<ViewAll href={`/projects/${projectId}/files`} />} />
          {files.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No files yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {files.slice(0, 5).map((f) => (
                <li key={f.id}>
                  <a href={f.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <IconFile size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">{f.title}</span>
                      <span className="block truncate text-xs text-muted">
                        {humanize(f.category)}
                        {f.uploadedByName ? ` · ${f.uploadedByName}` : ''} · {clock.date(f.createdAt)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ActivityFeed items={activity} viewAllHref={`/projects/${projectId}/activity`} emptyTitle="No activity yet" emptyDescription="Completed tasks, met milestones, versions and files appear here." compact />

        {team.length > 0 ? (
          <div className="flex items-center gap-2 px-1 text-xs text-muted">
            <IconUsers size={14} />
            Everyone with a task on this project.
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}
