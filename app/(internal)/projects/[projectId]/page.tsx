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
  DonutChart,
  QuickActions,
  TrendChart,
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
import { listAssignedAgents } from '@/modules/agents/permissions-queries';
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
import { listPhaseFourEscalations, getProject, listPaymentPlan, readGroupSetup, readPhaseTwo, readPhaseFourOverview, readProjectGroupName } from '@/modules/projects/queries';
import { readBuildBlockers, readBuildRuns, readDevClarifications, readFeedbackSuggestions, readPhaseFiveRecords, readOpenEscalations, readPhaseFiveOverview, readTaskBoard, readPmOverview, readPmMessageHistory, readProjectRepositories } from '@/modules/projects/phase-five-queries';
import { readPhaseSixOverview } from '@/modules/projects/phase-six-queries';
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
import { WatchProjectButton } from './watch-button';
import { SaveTemplateButton } from './save-template-button';
import { getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { listClientLeads } from '@/lib/admin/client-leads';
import { listProjectMeetings } from '@/modules/projects/calendar-queries';
import { listProjectLinks } from '@/modules/projects/project-links-queries';
import { listProjectUpdates } from '@/modules/projects/project-updates-queries';
import { ProposeMeetingOnDayForm } from './calendar/propose-meeting-form';
import { QuickTaskForm } from './create-in-place';
import { AddProjectFileForm } from './files-panel';
import { ProjectLinksPanel } from './links-panel';
import { ProjectNotesPanel } from './project-notes-panel';
import { listProjectNotes } from '@/modules/projects/project-notes-queries';
import { progressSeries, topLevelTasks } from '@/modules/projects/project-view-derive';
import { healthOfProject, overallProgress, overallProgressLabel } from '@/modules/projects/project-health';
import { readProjectLifecycles } from '@/modules/projects/project-lifecycle-queries';
import { LIFECYCLE_PHASE_LABEL } from '@/modules/projects/project-archive-schema';
import { countPeriods, periodDelta, trendOf } from '@/lib/admin/period-delta';
import { ProjectUpdatePanel } from './project-update-form';
import { readMyWatch } from '@/modules/projects/project-defaults-queries';
import { RecordClaimForm, VerifyClaimForm } from './claims-panel';
import { ProjectGroupPanel } from './group-panel';
import { RevealClientSecretForm, RevokeClientSecretForm, StoreClientSecretForm } from './client-secrets-panel';
import { CLIENT_SECRET_KIND_LABELS, listClientSecrets } from '@/modules/projects/client-secrets-service';
import { PhaseTwoPanel } from './phase-two-panel';
import { PhaseFourPanel } from './phase-four-panel';
import { DevClarificationsPanel, EscalationsPanel, PhaseFivePanel, PmMessageHistoryPanel, RecordsPanel, WorkboardPanel } from './phase-five-panel';
import { PhaseSixPanel } from './phase-six-panel';
import { PhaseCompletionPanel } from './phase-completion-panel';
import { readPhaseCompletions } from '@/modules/projects/phase-completion-queries';
import { ONBOARDING_MARK, OnboardingItemForm } from './onboarding-panel';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}`);

  const clock = await agencyClock();
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [plan, invoices] = await Promise.all([
    listPaymentPlan(projectId),
    // RLS decides whether these come back at all, so a role without invoice
    // access simply sees an empty billing column rather than an error.
    can(context, 'invoice.read') ? listProjectInvoices(projectId) : Promise.resolve([]),
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
  const claims = can(context, 'invoice.read') ? await listPaymentClaims(projectId) : [];
  const defects = await listDefects(projectId);
  const quality = await readProjectQuality(projectId);
  // G-188. The name the group must carry, composed from the rows rather than
  // typed — and what is still missing when it cannot be.
  const group = await readProjectGroupName(projectId);
  const groupCard = await readGroupSetup(projectId);
  const phaseTwo = await readPhaseTwo(projectId);
  const phaseFour = await readPhaseFourOverview(projectId);
  const phaseFive = await readPhaseFiveOverview(projectId);
  const phaseSix = await readPhaseSixOverview(projectId);
  const pmMessages = await readPmMessageHistory(projectId);
  const repositories = await readProjectRepositories(projectId);
  const escalations = await readOpenEscalations(projectId);
  const pmOverview = await readPmOverview(projectId);
  const taskBoard = await readTaskBoard(projectId);
  const buildRuns = await readBuildRuns(projectId);
  const buildBlockers = await readBuildBlockers(projectId);
  const records = await readPhaseFiveRecords(projectId);
  const feedbackSuggestions = await readFeedbackSuggestions(projectId);
  const devClarifications = await readDevClarifications(projectId);
  // Q-PH56: where Phase 5 and Phase 6 stand, read from Development and QA data.
  const phaseCompletions = await readPhaseCompletions(projectId);
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
  const progress = can(context, 'invoice.read') ? await readPaymentLadder(projectId) : null;
  // G-269, Finance §9 — maintenance that came with the project rather than
  // being sold. Empty for every project that has none, which is most of them.
  const freeMaintenance = can(context, 'invoice.read')
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
  const billing = can(context, 'invoice.read') ? await readProjectBilling(projectId) : null;
  const mayWriteProject = can(context, 'project.write');
  const clientSecretsRead = await listClientSecrets(projectId);
  const clientSecrets = clientSecretsRead.ok ? clientSecretsRead.data : [];
  // ADM-19's own role set, deliberately NOT delivery_lead: a delivery lead
  // declaring their own work production ready is the review signing its own
  // homework.
  const maySignOff = can(context, 'project.sign_off');
  const mayWritePlan = can(context, 'milestone.write');
  const mayInvoice = can(context, 'invoice.create');

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
  // SCR-019 (20261001120000): links, updates sent, and upcoming events
  // (milestones AND the meetings booked on the deal this project came from).
  const [links, updates, meetings, clientLeads, agencyZone] = await Promise.all([
    listProjectLinks(projectId),
    listProjectUpdates(projectId, 5),
    listProjectMeetings(projectId),
    project.client_account_id ? listClientLeads(project.client_account_id) : Promise.resolve([]),
    getAgencyTimeZone(),
  ]);
  const [{ tasks: allTasks, modules }, team, files, roster, clientName, assignedAgents, myWatch, notes] = await Promise.all([
    listDevelopmentBreakdown(projectId, { excludeCancelled: true }),
    listProjectTeam(projectId),
    listProjectFiles(projectId),
    listInternalRoster(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    // SCR-063 — the agents the owner assigned here (a policy record, not yet read by the runner).
    listAssignedAgents(projectId),
    // SCR-027 — whether this person watches the project's phase changes.
    readMyWatch(projectId, context.userId),
    // The Project Notes card (20261004100000).
    listProjectNotes(projectId, 4),
  ]);
  // A subtask is counted and drawn under its parent (task page), never as a task of its own.
  const tasks = topLevelTasks(allTasks);
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
  // One progress figure for every project screen (milestones met, else tasks done).
  const overall = overallProgress({ milestonesTotal: plan.length, milestonesMet: plan.filter((m) => m.met_at).length, tasksTotal: taskCounts.total, tasksDone: taskCounts.done });
  const totalTasksTrend = trendOf(periodDelta(countPeriods(tasks.map((t) => t.createdAt), new Date())));
  const seriesDay = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const progressData = progressSeries(tasks, { start: project.starts_on, end: project.ends_on }, todayKey).map((p) => ({ day: seriesDay(p.key), Actual: p.actual, Planned: p.planned }));
  // One health rule: the same facts and the same function as the projects list and Reports.
  const [lifecycles, escalationRows] = await Promise.all([readProjectLifecycles(todayKey), listPhaseFourEscalations()]);
  const life = lifecycles.get(projectId);
  const health = healthOfProject(
    { status: project.status, endsOn: project.ends_on },
    life ?? { blockedTasks: 0, unmetDependencies: 0, overdueTasks: taskCounts.overdue, overdueMilestones: 0, blockingDefects: quality.open_blockers },
    { escalated: escalationRows.some((e) => e.projectId === projectId), pendingClaims: claims.filter((c) => c.status === 'pending').length, todayKey },
  );
  const healthy = health.level === 'healthy';

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
    { key: 'index', header: '#', width: '2.5rem', desktopOnly: true, cellClassName: 'tabular text-muted', cell: (t) => recentTasks.indexOf(t) + 1 },
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
          { label: 'Project ID', value: <span className="font-mono">{project.project_code}</span>, icon: <IconList size={14} /> },
          ...(project.code ? [{ label: 'Reference', value: <span className="font-mono">{project.code}</span>, icon: <IconList size={14} /> }] : []),
          { label: 'Start date', value: project.starts_on ? clock.date(project.starts_on) : 'Not set', icon: <IconCalendar size={14} /> },
          { label: 'Due date', value: project.ends_on ? clock.date(project.ends_on) : 'Not set', icon: <IconCalendar size={14} /> },
          // SCR-019 header: the lifecycle phase beside the status, and the milestone payment status
          // (verified share of the plan, from the same ladder the billing section prints).
          ...(life ? [{ label: 'Phase', value: LIFECYCLE_PHASE_LABEL[life.phase], icon: <IconFlag size={14} /> }] : []),
          ...(progress
            ? [{
                label: 'Milestone payments',
                value: progress.measurable
                  ? `${progress.verifiedPercent ?? 0}% verified · ${progress.verifiedMilestones} of ${progress.milestones} paid`
                  : 'No payment plan',
                icon: <IconInvoices size={14} />,
              }]
            : []),
          ...(project.budget_minor !== null ? [{ label: 'Budget', value: money(project.budget_minor, project.currency), icon: <IconInvoices size={14} /> }] : []),
          // SCR-018: why it is paused or cancelled, beside the status it explains.
          ...(project.status_reason && (project.status === 'on_hold' || project.status === 'cancelled')
            ? [{ label: `${project.status === 'on_hold' ? 'On hold' : 'Cancelled'}${project.status_changed_at ? ` since ${clock.date(project.status_changed_at)}` : ''}`, value: <span title={project.status_reason}>{project.status_reason}</span>, icon: <IconAlert size={14} /> }]
            : []),
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
            <WatchProjectButton projectId={projectId} watching={myWatch !== null} />
            {/* Decision: reversed by the owner on 2026-09-29 — a project can be saved as a template. */}
            {mayWriteProject ? <SaveTemplateButton projectId={projectId} projectName={project.name} /> : null}
            {mayWriteProject ? (
              <Link href={`/projects/${projectId}/settings`} className={buttonClass('primary', 'sm')}>
                <IconEdit size={14} />
                Edit project
              </Link>
            ) : null}
          </>
        }
        aside={
          <HeaderFigure value={`${overall}%`} label={overallProgressLabel({ milestonesTotal: plan.length, tasksTotal: taskCounts.total })}>
            <ProgressBar value={overall} showValue={false} label="Overall progress" tone="brand" />
          </HeaderFigure>
        }
      >
      </EntityHeader>

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={6}>
        <Stat compact label="Total tasks" href={`/projects/${projectId}/tasks`} value={String(taskCounts.total)} caption={`${taskCounts.done} completed · ${pctOf(taskCounts.done, taskCounts.total)}%`} tone="brand" icon={<IconList size={16} />} trend={totalTasksTrend} />
        <Stat compact label="In progress" href={`/projects/${projectId}/board`} value={String(taskCounts.inProgress)} caption={`${pctOf(taskCounts.inProgress, taskCounts.total)}%`} tone="info" icon={<IconClock size={16} />} />
        <Stat compact label="Pending" href={`/projects/${projectId}/board`} value={String(taskCounts.pending)} caption={`${pctOf(taskCounts.pending, taskCounts.total)}%`} tone="warning" icon={<IconClock size={16} />} />
        <Stat compact label="Overdue" href={`/projects/${projectId}/board`} value={String(taskCounts.overdue)} caption={`${pctOf(taskCounts.overdue, taskCounts.total)}%`} tone={taskCounts.overdue > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
        <Stat compact label="Days left" href={`/projects/${projectId}/calendar`} value={daysLeft === null ? '—' : String(daysLeft)} caption={project.ends_on ? `Due ${clock.date(project.ends_on)}` : 'No due date set'} tone={daysLeft !== null && daysLeft < 0 ? 'danger' : 'accent'} icon={<IconCalendar size={16} />} />
        <Stat
          compact
          label="Project health"
          href={`/projects/${projectId}/reports`}
          value={health.label}
          caption={healthy ? 'No blocked work, nothing overdue' : health.reasons.join(' · ')}
          tone={health.level === 'healthy' ? 'success' : health.level === 'at_risk' ? 'warning' : 'danger'}
          icon={<IconCheck size={16} />}
        />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
      <div className="flex min-w-0 flex-col gap-4 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">
      <Card>
        <CardHeader title="Project timeline" actions={<ViewAll href={`/projects/${projectId}/plan`} label="View full plan" />} />
        {timelineSteps.length > 0 ? (
          <div className="p-4 sm:p-5">
            <Timeline steps={timelineSteps} />
            <p className="mt-3 text-xs text-muted">{summary.milestones_met} of {summary.milestones_total} milestones met.</p>
          </div>
        ) : (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No milestones planned yet.</p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent tasks"
          actions={
            <>
              <ViewAll href={`/projects/${projectId}/development`} />
              {/* SCR-019: create a task in place — the same createTaskAction the Development page uses. */}
              {can(context, 'task.write') ? <QuickTaskForm projectId={projectId} modules={modules.map((m) => ({ id: m.id, name: m.name }))} /> : null}
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


      <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Progress overview" description="Share of the project's tasks completed, against the share due by each day." />
        <div className="px-4 pb-4 sm:px-5">
          {progressData.length === 0 ? (
            <p className="text-[13px] text-muted">No tasks yet, so there is no progress to plot.</p>
          ) : (
            <TrendChart
              data={progressData}
              xKey="day"
              height={190}
              yDomain={[0, 100]}
              unit="%"
              series={[
                { key: 'Actual', label: 'Actual progress', color: 'var(--brand)' },
                { key: 'Planned', label: 'Planned progress', color: 'var(--faint)', dashed: true },
              ]}
            />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Task status" actions={<ViewAll href={`/projects/${projectId}/board`} label="Board" />} />
        <div className="px-4 pb-4 sm:px-5">
          {taskCounts.total === 0 ? (
            <p className="text-[13px] text-muted">No tasks yet.</p>
          ) : (
            <DonutChart
              data={[
                { label: 'Completed', value: taskCounts.done },
                { label: 'In progress', value: taskCounts.inProgress },
                { label: 'To do', value: taskCounts.pending },
                { label: 'Other (review, blocked)', value: taskCounts.total - taskCounts.done - taskCounts.inProgress - taskCounts.pending },
              ]}
              height={150}
              totalLabel="Total tasks"
            />
          )}
        </div>
      </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
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
                    <span className="block truncate text-xs text-muted">{m.tasksDone}/{m.tasksTotal} tasks</span>
                  </span>
                  <Badge tone="info">{humanize(m.role)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent files"
            actions={<ViewAll href={`/projects/${projectId}/files`} />}
          />
          {/* SCR-019: link a file in place — the Files tab's own door. */}
          {mayWriteProject ? (
            <details className="border-b border-line px-4 py-2 sm:px-5">
              <summary className="cursor-pointer text-xs text-muted hover:underline">+ Link a file</summary>
              <div className="pt-2 [&>section]:border-0 [&>section]:p-0 [&>section]:shadow-none">
                <AddProjectFileForm projectId={projectId} />
              </div>
            </details>
          ) : null}
          {files.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No files yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              <li className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)] gap-3 bg-surface-sunken px-4 py-1.5 text-[11px] font-semibold text-muted sm:grid sm:px-5">
                <span>Name</span>
                <span>Uploaded by</span>
                <span>Date</span>
              </li>
              {files.slice(0, 5).map((f) => (
                <li key={f.id}>
                  <a href={f.url} target="_blank" rel="noreferrer noopener" className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)] sm:px-5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                        <IconFile size={15} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-foreground">{f.title}</span>
                        <span className="block truncate text-xs text-muted sm:hidden">
                          {humanize(f.category)}{f.uploadedByName ? ` · ${f.uploadedByName}` : ''} · {clock.date(f.createdAt)}
                        </span>
                        <span className="hidden truncate text-xs text-muted sm:block">{humanize(f.category)}</span>
                      </span>
                    </span>
                    <span className="hidden truncate text-[13px] text-muted sm:block">{f.uploadedByName ?? '—'}</span>
                    <span className="hidden truncate text-[13px] text-muted sm:block">{clock.date(f.createdAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Project notes" />
        <ProjectNotesPanel
          projectId={projectId}
          editable={can(context, 'task.write')}
          notes={notes.map((n) => ({ id: n.id, title: n.title, body: n.body, whenLabel: clock.dateTime(n.createdAt), byName: n.createdByName }))}
        />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: 'Phase 1 · Lead to Close',
            href: project.opportunity_id ? `/handoffs/${project.opportunity_id}` : `/projects/${projectId}`,
            value: project.opportunity_id ? 'Won deal' : 'No deal',
            caption: project.opportunity_id ? (quotation ? `Accepted quotation · ${quotation.title} v${quotation.version}` : 'Handoff packet on file') : 'Created without a lead or a won deal',
            tone: project.opportunity_id ? 'success' : 'neutral',
          },
          {
            label: 'Phase 2 · Onboarding',
            href: `/projects/${projectId}`,
            value: phaseTwo.phase ? humanize(phaseTwo.phase.state) : 'Not started',
            caption: phaseTwo.phase
              ? `${phaseTwo.readiness?.ready ? 'Ready to kick off' : `${phaseTwo.readiness?.unmet.length ?? 0} gate${phaseTwo.readiness?.unmet.length === 1 ? '' : 's'} unmet`}${phaseTwo.phase.kickoffAt ? ` · kicked off ${clock.date(phaseTwo.phase.kickoffAt)}` : ''} · ${onboarding.filter((i) => i.status !== 'pending').length}/${onboarding.length} checklist items`
              : 'Phase 2 has not opened',
            tone: phaseTwo.phase ? statusTone(phaseTwo.phase.state) : 'neutral',
          },
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
            label: 'Phase 4 · UI and Prototype',
            href: phaseFour.uiVersion ? `/projects/${projectId}/ui-versions/${phaseFour.uiVersion.id}` : `/projects/${projectId}/prototype`,
            value: phaseFour.workspace ? humanize(phaseFour.workspace.state) : 'Not started',
            caption: phaseFour.workspace
              ? `${phaseFour.uiVersion ? `UI v${phaseFour.uiVersion.version} ${humanize(phaseFour.uiVersion.status)}` : 'No UI version yet'} · ${phaseFour.workspace.uiRevisionCount} of ${phaseFour.workspace.uiRevisionLimit} UI rounds${phaseFour.prototype ? ' · prototype built' : ''}`
              : 'No UI or prototype phase opened',
            tone: phaseFour.workspace ? statusTone(phaseFour.workspace.state) : 'neutral',
          },
          {
            label: 'Phase 5 · Development',
            href: `/projects/${projectId}/plan`,
            value: planBoard.plan ? `v${planBoard.plan.version} ${humanize(planBoard.plan.status)}` : 'No plan',
            caption: planBoard.plan ? `${planBoard.deliverables.length} deliverables · ${planBoard.milestones.length} milestones · ${taskCounts.done}/${taskCounts.total} tasks done` : 'The kickoff gate waits on one',
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
            label: 'Phase 7 · Handover and Deployment',
            href: `/projects/${projectId}/release`,
            value: handover ? humanize(handover.status) : 'Not prepared',
            caption: handover ? `${handover.items.length} package item${handover.items.length === 1 ? '' : 's'}${handover.accepted_at ? ` · accepted ${clock.date(handover.accepted_at)}` : handover.delivered_at ? ` · delivered ${clock.date(handover.delivered_at)}` : ''}` : 'Deployment readiness and handover are prepared on the Release tab',
            tone: handover ? statusTone(handover.status) : 'neutral',
          },
          {
            label: 'Phase 8 · Customer Success',
            href: project.client_account_id ? `/clients/${project.client_account_id}` : `/projects/${projectId}`,
            value: freeMaintenance.length > 0 ? `${freeMaintenance.length} maintenance item${freeMaintenance.length === 1 ? '' : 's'}` : project.status === 'completed' ? 'Completed' : 'Not started',
            caption: freeMaintenance.length > 0 ? 'Maintenance that came with the project' : 'Begins once the project is handed over',
            tone: freeMaintenance.length > 0 ? 'info' : 'neutral',
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

      {can(context, 'audit.read') ? (
        <section aria-labelledby="client-secrets-heading" className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <div>
            <h2 id="client-secrets-heading" className="text-base font-semibold">
              Client secrets
            </h2>
            <p className="text-xs text-muted">
              Logins and keys the client sent through a secure channel — never the project group. Stored encrypted; the owner and ops admins can open
              one, and every opening is recorded against their name.
            </p>
          </div>
          {!clientSecretsRead.ok ? (
            <p role="alert" className="text-sm text-danger">The stored secrets could not be read — {clientSecretsRead.error.message}</p>
          ) : clientSecrets.length === 0 ? (
            <p className="text-sm text-muted">Nothing stored for this project.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {clientSecrets.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 rounded border border-line px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">
                      {s.label} <span className="text-xs font-normal text-muted">· {CLIENT_SECRET_KIND_LABELS[s.kind as keyof typeof CLIENT_SECRET_KIND_LABELS] ?? s.kind}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {s.revokedAt
                        ? `Revoked ${clock.dateTime(s.revokedAt)}${s.revokedByName ? ` by ${s.revokedByName}` : ''} — value deleted`
                        : `Stored ${clock.dateTime(s.createdAt)}${s.storedByName ? ` by ${s.storedByName}` : ''}${s.hint ? ` · ends …${s.hint}` : ''}`}
                    </p>
                  </div>
                  {s.revokedAt ? null : (
                    <div className="flex items-start gap-2">
                      <RevealClientSecretForm secretId={s.id} />
                      <RevokeClientSecretForm projectId={projectId} secretId={s.id} label={s.label} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Store a client secret</summary>
            <div className="pt-3">
              <StoreClientSecretForm projectId={projectId} />
            </div>
          </details>
        </section>
      ) : null}

      <PhaseTwoPanel view={phaseTwo} projectId={projectId} />

      <PhaseFourPanel view={phaseFour} projectId={projectId} />

      <PhaseFivePanel view={phaseFive} projectId={projectId} repositories={repositories} suggestions={feedbackSuggestions} />

      <PhaseSixPanel view={phaseSix} projectId={projectId} />

      <WorkboardPanel board={taskBoard} runs={buildRuns} projectId={projectId} blockers={buildBlockers} />

      <RecordsPanel view={records} />

      <DevClarificationsPanel rows={devClarifications} projectId={projectId} />

      <EscalationsPanel rows={escalations} projectId={projectId} />

      <PmMessageHistoryPanel rows={pmMessages} overview={pmOverview} />

      <PhaseCompletionPanel
        projectId={projectId}
        readings={phaseCompletions}
        mayComplete={mayWriteProject}
        whenOf={Object.fromEntries(phaseCompletions.map((r) => [r.phase, r.completedAt ? `Completed ${clock.dateTime(r.completedAt)}` : null]))}
      />

      <ProjectGroupPanel group={group} card={groupCard} projectId={projectId} />

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Delivery status</h2>
        <StatusStepper
          status={status}
          happyPath={['planning', 'onboarding', 'active', 'completed']}
          offRamps={['on_hold', 'cancelled']}
        />
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
                canOverride={can(context, 'organization.settings')}
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

                  {/* Confirming that money arrived is the owner's alone (separation of duties). */}
                  {can(context, 'payment.verify') ? (
                    <VerifyClaimForm projectId={projectId} claim={c} />
                  ) : (
                    <p className="mt-1 text-xs text-muted">The owner verifies this claim.</p>
                  )}
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
                {/* SCR-047: the task the defect is about, set at triage. */}
                {d.task_id ? (
                  <p className="mt-1 text-xs text-muted">
                    Task:{' '}
                    <Link href={`/projects/${projectId}/development/tasks/${d.task_id}`} className="underline underline-offset-2 hover:text-foreground">
                      {tasks.find((t) => t.id === d.task_id)?.title ?? 'open task'}
                    </Link>
                  </p>
                ) : null}
                {mayWriteProject ? (
                  <DefectTriageForm
                    projectId={projectId}
                    defect={d}
                    roster={roster.map((r) => ({ userId: r.userId, fullName: r.fullName }))}
                    tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }))}
                  />
                ) : null}
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
            { label: 'Project ID', value: <span className="font-mono">{project.project_code}</span> },
            { label: 'Reference', value: project.code ? <span className="font-mono">{project.code}</span> : 'Not set' },
            { label: 'Start date', value: project.starts_on ? clock.date(project.starts_on) : 'Not set' },
            { label: 'Due date', value: project.ends_on ? clock.date(project.ends_on) : 'Not set' },
            { label: 'Status', value: <StatusBadge status={project.status} /> },
            { label: 'Project type', value: project.project_type ? <Badge tone="brand">{project.project_type}</Badge> : <span className="font-normal text-muted">Not set</span> },
            { label: 'Technology', value: project.technology.length > 0 ? <span className="flex flex-wrap gap-1.5">{project.technology.map((c) => <Badge key={c} tone="info">{c}</Badge>)}</span> : <span className="font-normal text-muted">Not set</span> },
            { label: 'Tags', value: project.tags.length > 0 ? <span className="flex flex-wrap gap-1.5">{project.tags.map((c) => <Badge key={c} tone="neutral">{c}</Badge>)}</span> : <span className="font-normal text-muted">None</span> },
            ...(project.status_reason ? [{ label: 'Status reason', value: <span className="whitespace-pre-wrap">{project.status_reason}</span> }] : []),
            { label: 'Budget', value: project.budget_minor === null ? 'Not set' : money(project.budget_minor, project.currency) },
            ...(can(context, 'invoice.read')
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

        <ActivityFeed items={activity} viewAllHref={`/projects/${projectId}/activity`} emptyTitle="No activity yet" emptyDescription="Completed tasks, met milestones, versions and files appear here." compact />

        <QuickActions
          actions={[
            ...(can(context, 'task.write') ? [{ label: 'Add task', href: `/projects/${projectId}/board`, icon: <IconList size={14} /> }] : []),
            { label: 'Upload file', href: `/projects/${projectId}/files`, icon: <IconUpload size={14} /> },
            { label: 'Schedule meeting', href: `/projects/${projectId}/calendar`, icon: <IconCalendar size={14} /> },
            { label: 'View plan', href: `/projects/${projectId}/plan`, icon: <IconFlag size={14} /> },
          ]}
        />

        <Card>
          <CardHeader title={`Assigned agents (${assignedAgents.length})`} description="The owner's record on each agent's page; the runner does not read it yet." />
          {assignedAgents.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-5">No agent assigned.</p>
          ) : (
            <ul className="divide-y divide-line">
              {assignedAgents.map((a) => (
                <li key={a.agentKey} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px] sm:px-5">
                  <Link href={`/agents/${a.agentKey}`} className="min-w-0 truncate font-medium text-foreground hover:underline">{a.displayName}</Link>
                  <Badge tone={a.enabled ? 'success' : 'neutral'}>{a.enabled ? 'enabled' : 'disabled'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* SCR-019 (20261001120000): project links — the repo, the design file, the staging site. */}
        <Card>
          <CardHeader title={`Project links (${links.length})`} />
          <ProjectLinksPanel projectId={projectId} links={links} editable={mayWriteProject} />
        </Card>

        {/* SCR-019: upcoming events — milestones AND the meetings booked on this project's deal, dated ahead. */}
        <Card>
          <CardHeader title="Upcoming events" actions={<ViewAll href={`/projects/${projectId}/calendar`} label="Calendar" />} />
          {(() => {
            const upcoming = [
              ...plan.filter((m) => !m.met_at && m.due_on && m.due_on >= todayKey).map((m) => ({ key: `m-${m.id}`, date: m.due_on as string, time: null as string | null, label: m.name, kind: 'milestone', href: `/projects/${projectId}/plan?milestone=${m.id}` })),
              ...meetings
                .filter((m) => m.startAt && clock.dayKey(m.startAt) >= todayKey)
                .map((m) => ({ key: `mt-${m.id}`, date: clock.dayKey(m.startAt as string), time: clock.clock(m.startAt as string), label: `${humanize(m.mode ?? 'meeting')} · ${humanize(m.status)}`, kind: 'meeting', href: `/meetings/${m.id}` })),
            ]
              .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''))
              .slice(0, 6);
            return upcoming.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing dated ahead — no open milestone with a due date and no meeting booked.</p>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((e) => (
                  <li key={e.key}>
                    <Link href={e.href} className="flex items-center gap-3 px-4 py-2 text-[13px] hover:bg-surface-hover sm:px-5">
                      <span className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-soft text-brand">
                        <span className="text-[9px] font-semibold uppercase leading-none">{clock.date(`${e.date}T00:00:00`).split(' ')[1]}</span>
                        <span className="tabular text-sm font-semibold leading-tight">{e.date.slice(8, 10)}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{e.label}</span>
                        <span className="block text-xs text-muted">{e.kind}{e.time ? ` · ${e.time}` : ''}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            );
          })()}
          {/* SCR-019: create a meeting in place — the calendar's own propose-a-meeting door, on today. */}
          {can(context, 'lead.write') && clientLeads.length > 0 ? (
            <div className="border-t border-line px-4 py-2 sm:px-5">
              <ProposeMeetingOnDayForm projectId={projectId} date={todayKey} leads={clientLeads.map((l) => ({ id: l.id, title: l.title }))} agencyZone={agencyZone} />
            </div>
          ) : null}
        </Card>

        {/* SCR-019: send a project update — through the client thread chokepoint, or as an internal note. */}
        <Card id="project-updates">
          <CardHeader title="Project updates" />
          <ProjectUpdatePanel
            projectId={projectId}
            updates={updates}
            labels={Object.fromEntries(updates.map((u) => [u.id, clock.dateTime(u.createdAt)]))}
            mayMessageClient={can(context, 'lead.write')}
            mayPostInternal={mayWriteProject}
            hasClientThread={group.linked !== null}
          />
        </Card>

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
