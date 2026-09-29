import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { listEligibleMilestones } from '@/modules/finance/eligible-milestones-queries';
import { listPlanVersions } from '@/modules/projects/plan-versions-queries';
import { getProject, listMilestoneTaskCounts, listPaymentPlan, readPlanBoard } from '@/modules/projects/queries';
import { Badge, Card, CardHeader, cx, Gantt, IconCalendar, IconCheck, IconClock, IconFlag, PermissionDenied, ProgressBar, Stat, StatGrid, StatusBadge, ViewAll, type GanttRow, type Tone } from '@/ui';

import { MilestoneDueForm } from '../milestone-controls';
import { MarkMilestoneMetForm, TriggerFinanceMilestoneForm } from './milestone-forms';

import { WorkspaceHeader } from '../workspace-header';

import { ProjectSubNav } from '../project-subnav';
import { PlanBreakdownForm } from './plan-breakdown-form';

import {
  ActivatePlanForm,
  AddDependencyForm,
  AddDeliverableForm,
  AddMilestoneForm,
  AddNoteForm,
  ClarificationRow,
  GateMilestoneForm,
  DraftPlanForm,
  RaiseClarificationForm,
} from './plan-forms';

export const metadata: Metadata = { title: 'Operational plan' };

/**
 * The Operational Project Blueprint — Project Planning §7; G-274.
 *
 * G-256 built the plan, G-257 the clarification loop, G-262 the milestone map,
 * G-265 the validator — and **nothing called any of it.** `planning.ts` had no
 * caller anywhere in `src` or `app`, so a project plan could not be created in
 * this product at all: G-263's Phase 2 panel read plan *counts* off a plan
 * only a database client could have made.
 *
 * §7 asks for eighteen registers. This page is six of them plus the doors that
 * fill them — identity, objective, scope reference, deliverables, milestones,
 * dependencies, risks and assumptions, open clarifications, version and
 * status. The rest are derived or belong to Phase 3.
 *
 * **Its own page rather than another panel on the project.** The project page
 * is already a status board, a payment plan, an onboarding checklist, a group
 * card and a billing ladder; the blueprint is a working surface somebody sits
 * with, and nesting it would make both worse.
 */

const PHASE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  active: 'success',
  superseded: 'neutral',
};

export default async function ProjectPlanPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/plan`);
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const project = await getProject(projectId);
  if (!project) notFound();

  const [board, milestones, taskCounts, clock, clientName, eligible, versions] = await Promise.all([
    readPlanBoard(projectId),
    listPaymentPlan(projectId),
    listMilestoneTaskCounts(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
    listEligibleMilestones([projectId]),
    listPlanVersions(projectId),
  ]);
  // SCR-023: the two doors on a payment milestone, gated the way their
  // services are. `nextToBill` is the same rule the project page applies.
  const mayMarkMet = can(context, 'milestone.write');
  const mayInvoice = can(context, 'invoice.create');
  const nextToBill = eligible[0] ?? null;

  /**
   * The milestone timeline — the reference's Gantt. `projects.milestones`
   * stores a due date and the day it was met, never a start, so each bar is
   * the window from the previous milestone's due date (or the project's
   * start, or its creation) to this one's due date: the planned window in
   * which it had to happen. The bar says exactly that in its caption;
   * nothing here estimates a duration. A milestone with no due date has no
   * bar and is listed as undated.
   */
  const today = clock.dayKey(new Date());
  let previousEnd = project.starts_on ?? project.created_at.slice(0, 10);
  let currentSeen = false;
  const gantt: GanttRow[] = [];
  const undated: typeof milestones = [];
  for (const m of milestones) {
    if (!m.due_on) {
      undated.push(m);
      continue;
    }
    const start = previousEnd < m.due_on ? previousEnd : m.due_on;
    const state: GanttRow['state'] = m.met_at ? 'done' : m.due_on < today ? 'late' : currentSeen ? 'upcoming' : 'current';
    if (!m.met_at && state !== 'late') currentSeen = true;
    gantt.push({
      id: m.id,
      label: m.name,
      caption: `${clock.date(start)} – ${clock.date(m.due_on)}${m.met_at ? ` · met ${clock.date(m.met_at)}` : ''}`,
      start,
      end: m.due_on,
      state,
      progress: m.met_at ? 100 : undefined,
    });
    previousEnd = m.due_on;
  }
  const met = milestones.filter((m) => m.met_at).length;
  const late = gantt.filter((g) => g.state === 'late').length;
  const next = milestones.find((m) => !m.met_at) ?? null;
  const finalDue = milestones.length > 0 ? (milestones[milestones.length - 1]?.due_on ?? null) : null;
  const daysLeft = finalDue ? Math.ceil((Date.parse(`${finalDue}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  const upcoming = milestones.filter((m) => !m.met_at && m.due_on).slice(0, 5);
  // Planning is project work, so it takes the same capability that changes a
  // project. The doors check it again — this only decides what to render.
  const mayPlan = can(context, 'project.write');
  const mayDate = can(context, 'milestone.write');
  const tasksFor = (id: string) => taskCounts.find((t) => t.milestoneId === id) ?? { milestoneId: id, total: 0, done: 0 };
  const { plan } = board;
  const openQuestions = board.clarifications.filter(
    (c) => c.status !== 'resolved' && c.status !== 'routed_to_change_request',
  );
  // The breakdown door goes through createModule / createFeature / createTask,
  // which take milestone.write and task.write; offered only to a role that
  // holds both, and the doors decide again.
  const mayBreakDown = can(context, 'milestone.write') && can(context, 'task.write');
  // SCR-040 — coverage of approved scope: how many of the plan's scope
  // version's INCLUDED items at least one deliverable cites. The validator
  // flags the reverse (a deliverable citing nothing); this is the other
  // direction, which nothing measured.
  const includedScope = board.scopeItems.filter((s) => s.inclusion === 'included');
  const citedScope = new Set(board.deliverables.map((d) => d.scopeItemId).filter((id): id is string => id !== null));
  const coveredScope = includedScope.filter((s) => citedScope.has(s.id)).length;
  const coveragePercent = includedScope.length === 0 ? null : Math.round((coveredScope / includedScope.length) * 100);
  const unlinkedDeliverables = board.deliverables.filter((d) => d.scopeItemId === null).length;

  return (
    <div className="flex flex-col gap-6">
      <WorkspaceHeader project={project} clock={clock} clientName={clientName} canEdit={mayPlan} />

      <ProjectSubNav projectId={projectId} />

      {milestones.length > 0 ? (
        <StatGrid cols={5}>
          <Stat label="Total milestones" value={String(milestones.length)} caption={undated.length > 0 ? `${undated.length} undated` : 'All dated'} tone="brand" icon={<IconFlag size={16} />} />
          <Stat label="Completed" value={String(met)} caption={`${Math.round((met / milestones.length) * 100)}%`} tone="success" icon={<IconCheck size={16} />} />
          <Stat label="In progress" value={String(gantt.filter((g) => g.state === 'current').length)} caption={next ? next.name : 'Nothing pending'} tone="info" icon={<IconClock size={16} />} />
          <Stat label="Late" value={String(late)} caption={late > 0 ? 'Past due and not met' : 'Nothing overdue'} tone={late > 0 ? 'danger' : 'neutral'} icon={<IconClock size={16} />} />
          <Stat label="Final delivery" value={finalDue ? clock.date(finalDue) : '—'} caption={daysLeft === null ? 'No final date' : daysLeft >= 0 ? `${daysLeft} days left` : `${-daysLeft} days overdue`} tone={daysLeft !== null && daysLeft < 0 ? 'danger' : 'accent'} icon={<IconCalendar size={16} />} />
        </StatGrid>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(18rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader
              title="Project milestone timeline"
              description="Each bar is the planned window that ends at the milestone's due date. Green is met, blue is the one in hand, red is past due."
              actions={<ViewAll href={`/projects/${projectId}/calendar`} label="Calendar" />}
            />
            {gantt.length > 0 ? (
              <Gantt rows={gantt} todayKey={today} />
            ) : (
              <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No dated milestones yet — the payment plan on the project overview sets them.</p>
            )}
            {undated.length > 0 ? (
              <p className="border-t border-line px-4 py-2 text-xs text-muted sm:px-5">
                Undated: {undated.map((m) => m.name).join(', ')}
              </p>
            ) : null}
          </Card>

          {milestones.length > 0 ? (
            <Card>
              <CardHeader
                title="Payment milestones"
                description="Each milestone's due date, the work filed under it on the Board, and whether it has been met. Dates drive the timeline above and the calendar."
              />
              <ul className="divide-y divide-line">
                {milestones.map((m) => {
                  const t = tasksFor(m.id);
                  const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
                  return (
                    <li key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">{m.position + 1}. {m.name}</span>
                        <StatusBadge status={m.met_at ? 'completed' : m.due_on && m.due_on < today ? 'overdue' : m.status} />
                        {m.payment_percent !== null ? <Badge mono>{Number(m.payment_percent)}%</Badge> : null}
                        <span className="ml-auto text-xs text-muted">
                          {m.met_at ? `met ${clock.date(m.met_at)}` : m.due_on ? `due ${clock.date(m.due_on)}` : 'no due date'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="w-48">
                          <ProgressBar value={pct} label={`${m.name} tasks done`} />
                        </div>
                        <span className="text-xs text-muted">
                          {t.total === 0 ? 'No tasks filed under this milestone' : `${t.done}/${t.total} tasks done`}
                        </span>
                        {mayDate && !m.met_at ? <MilestoneDueForm projectId={projectId} milestoneId={m.id} dueOn={m.due_on} /> : null}
                      </div>
                      {(mayMarkMet && (m.status === 'in_progress' || m.status === 'submitted')) || nextToBill?.milestoneId === m.id ? (
                        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-2">
                          {nextToBill?.milestoneId === m.id ? (
                            <span className="mr-auto text-xs text-muted">
                              <Badge tone="brand">next to bill</Badge>
                              {nextToBill.reason ? <> {nextToBill.reason}</> : null}
                            </span>
                          ) : null}
                          {mayMarkMet && (m.status === 'in_progress' || m.status === 'submitted') ? (
                            <MarkMilestoneMetForm projectId={projectId} milestoneId={m.id} />
                          ) : null}
                          {nextToBill?.milestoneId === m.id && nextToBill.eligible ? (
                            mayInvoice ? (
                              <TriggerFinanceMilestoneForm projectId={projectId} milestoneId={m.id} />
                            ) : (
                              <span className="text-xs text-muted">No permission to raise invoices.</span>
                            )
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}

          <div className="flex flex-col gap-6 [&>section]:rounded-xl [&>section]:border [&>section]:border-line [&>section]:bg-surface [&>section]:p-4 [&>section]:shadow-xs sm:[&>section]:p-5">

      <p className="max-w-2xl text-[13px] text-muted">
        Operational, never technical. Tables, APIs, coding tasks and UI belong to the Phase 5
        Development Planning Agent, and there is nowhere here to put them (Project Planning §5, §6).{' '}
        <Link href={`/projects/${projectId}`} className="underline hover:text-foreground">
          Back to the project
        </Link>
        .
      </p>

      {!plan ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">No plan yet</h2>
          <p className="max-w-2xl text-[13px] text-muted">
            Nothing has been planned for this project. A plan is versioned from the moment it opens,
            and the kickoff gate waits on one being active.
          </p>
          {mayPlan ? (
            <DraftPlanForm projectId={projectId} hasPlan={false} />
          ) : (
            <p className="text-[13px] text-muted">You do not have permission to plan this project.</p>
          )}
        </section>
      ) : (
        <>
          <StatGrid cols={4}>
            <Stat
              label="Approved scope covered"
              value={coveragePercent === null ? '—' : `${coveragePercent}%`}
              tone={coveragePercent === null ? 'neutral' : coveragePercent === 100 ? 'success' : 'warning'}
              caption={
                coveragePercent === null
                  ? 'the plan names no scope version with included items'
                  : `${coveredScope} of ${includedScope.length} included items have a deliverable`
              }
            />
            <Stat
              label="Deliverables"
              value={String(board.deliverables.length)}
              tone={unlinkedDeliverables > 0 ? 'warning' : 'neutral'}
              caption={unlinkedDeliverables > 0 ? `${unlinkedDeliverables} not linked to scope` : 'every one cites approved scope'}
            />
            <Stat label="Plan versions" value={String(versions.length)} caption={`v${plan.version} is ${plan.status}`} />
            <Stat label="Open questions" value={String(openQuestions.length)} tone={openQuestions.length > 0 ? 'warning' : 'success'} />
          </StatGrid>

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Version {plan.version}
              </h2>
              <Badge tone={PHASE_TONE[plan.status] ?? 'neutral'}>{plan.status}</Badge>
            </div>
            {plan.objective ? (
              <p className="max-w-2xl text-[13px]">{plan.objective}</p>
            ) : (
              <p className="max-w-2xl text-[13px] text-muted">No objective recorded.</p>
            )}
            {plan.status === 'draft' && mayPlan ? (
              <ActivatePlanForm projectId={projectId} planId={plan.id} />
            ) : null}
            {plan.status === 'active' && mayPlan ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer text-muted">Open the next version</summary>
                <div className="pt-2">
                  <DraftPlanForm projectId={projectId} hasPlan />
                </div>
              </details>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Deliverables <span className="text-muted">({board.deliverables.length})</span>
            </h2>
            {board.deliverables.length === 0 ? (
              <p className="text-[13px] text-muted">
                None yet. A plan with no deliverables cannot go live.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.deliverables.map((d) => (
                  <li key={d.id} className="flex flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{d.name}</span>
                      <span className="text-muted">
                        {d.applicablePhase.replace('_', ' ')} · {d.status}
                        {d.ownerRole ? ` · ${d.ownerRole}` : ''}
                      </span>
                    </div>
                    <p className="text-muted">Ready when: {d.readinessCriteria}</p>
                    <p className="text-muted">Evidence: {d.evidenceRequired}</p>
                    {d.ambiguityNote ? (
                      <p className="text-foreground">Unclear: {d.ambiguityNote}</p>
                    ) : null}
                    {!d.scopeItemId ? (
                      <p className="text-muted">
                        Not linked to approved scope — validation will flag it.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddDeliverableForm projectId={projectId} planId={plan.id} scopeItems={board.scopeItems} />
            ) : null}
            {mayBreakDown && plan.status === 'active' && board.deliverables.length > 0 ? (
              <PlanBreakdownForm projectId={projectId} planId={plan.id} deliverables={board.deliverables.length} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Milestones <span className="text-muted">({board.milestones.length})</span>
            </h2>
            {board.milestones.length === 0 ? (
              <p className="text-[13px] text-muted">No milestone map yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.milestones.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span>
                      <span className="font-medium">{m.name}</span>{' '}
                      <span className="text-muted">— {m.gateCriteria}</span>
                    </span>
                    <span className="text-muted">
                      {m.kind.replace('_', ' ')} · {m.phase.replace('_', ' ')} · {m.status}
                    </span>
                    {(() => {
                      // §15: which dependency gates which milestone. Shown as
                      // the dependency's own words rather than an id, because
                      // "waits on the client's brand assets" is the fact and
                      // a UUID is a lookup.
                      const gated = board.gates
                        .filter((g) => g.milestoneId === m.id)
                        .map((g) => board.dependencies.find((d) => d.id === g.dependencyId))
                        .filter((d) => d !== undefined);
                      return gated.length === 0 ? null : (
                        <span className="w-full text-muted">
                          Waits on: {gated.map((d) => d.description).join('; ')}
                        </span>
                      );
                    })()}
                    {mayPlan && plan.status === 'draft' ? (
                      <GateMilestoneForm
                        projectId={projectId}
                        milestone={m}
                        dependencies={board.dependencies}
                        gatedDependencyIds={board.gates
                          .filter((g) => g.milestoneId === m.id)
                          .map((g) => g.dependencyId)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddMilestoneForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Dependencies <span className="text-muted">({board.dependencies.length})</span>
            </h2>
            {board.dependencies.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing recorded as waited on.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.dependencies.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span className="font-medium">{d.description}</span>
                    <span className="text-muted">
                      {d.kind.replace('_', ' ')} · by {d.neededByPhase.replace('_', ' ')} · {d.ownerRole} ·{' '}
                      {d.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddDependencyForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Risks and assumptions <span className="text-muted">({board.notes.length})</span>
            </h2>
            {board.notes.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing on the register.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.notes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span>{n.statement}</span>
                    <span className="text-muted">
                      {n.kind}
                      {n.ownerRole ? ` · ${n.ownerRole}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddNoteForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Open questions <span className="text-muted">({openQuestions.length})</span>
            </h2>
            <p className="max-w-2xl text-[13px] text-muted">
              §10: the plan never guesses an unclear requirement. A plan cannot be activated while a
              question is unsettled.
            </p>
            {board.clarifications.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {board.clarifications.map((c) => (
                  <ClarificationRow
                    key={c.id}
                    projectId={projectId}
                    clarification={c}
                    changeRequests={board.changeRequests}
                  />
                ))}
              </ul>
            ) : null}
            {mayPlan && plan.status === 'draft' ? (
              <RaiseClarificationForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          {versions.length > 1 ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Plan versions <span className="text-muted">({versions.length})</span>
              </h2>
              <p className="max-w-2xl text-[13px] text-muted">
                §4.8: a superseded plan is history, never rewritten. Each later version says why it exists.
              </p>
              <ul className="flex flex-col gap-1">
                {versions.map((v) => (
                  <li key={v.id} className="flex flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">Version {v.version}</span>
                        <Badge tone={PHASE_TONE[v.status] ?? 'neutral'}>{v.status}</Badge>
                        <span className="text-muted">
                          {v.deliverables} deliverable{v.deliverables === 1 ? '' : 's'}
                          {v.scopeVersion !== null ? ` · scope v${v.scopeVersion}` : ' · no scope version'}
                        </span>
                      </span>
                      <span className="text-xs text-muted">
                        {v.activatedAt ? `activated ${clock.date(v.activatedAt)}` : `drafted ${clock.date(v.createdAt)}`}
                      </span>
                    </div>
                    {v.changeReason ? <p className="text-muted">Why: {v.changeReason}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {next ? (
            <Card>
              <CardHeader title="Milestone details" description="The next one to meet." />
              <div className="flex flex-col gap-2 px-4 pb-4 text-[13px] sm:px-5">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-white"><IconFlag size={13} /></span>
                  {next.name}
                </p>
                <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-muted">
                  <dt>Due</dt>
                  <dd className="text-foreground">{next.due_on ? clock.date(next.due_on) : 'Not dated'}</dd>
                  <dt>Status</dt>
                  <dd><StatusBadge status={next.status} dot={false} /></dd>
                  <dt>Payment</dt>
                  <dd className="text-foreground">{next.payment_percent === null ? 'None attached' : `${next.payment_percent}% of the plan`}</dd>
                </dl>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Upcoming deadlines" />
            {upcoming.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing dated ahead.</p>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((m) => {
                  const d = m.due_on ? Math.ceil((Date.parse(`${m.due_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
                  return (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{m.name}</span>
                        <span className="block text-xs text-muted">{m.due_on ? clock.date(m.due_on) : ''}</span>
                      </span>
                      {d !== null ? (
                        <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', d < 0 ? 'bg-danger-soft text-danger' : d <= 7 ? 'bg-warning-soft text-warning' : 'bg-info-soft text-info')}>
                          {d < 0 ? `${-d} days overdue` : `${d} days left`}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Blueprint status" />
            <div className="px-4 pb-4 text-[13px] sm:px-5">
              {plan ? (
                <p>
                  Version {plan.version} · <Badge tone={PHASE_TONE[plan.status] ?? 'neutral'}>{plan.status}</Badge>
                  <span className="mt-1 block text-xs text-muted">
                    {board.deliverables.length} deliverable{board.deliverables.length === 1 ? '' : 's'} · {board.milestones.length} plan milestone{board.milestones.length === 1 ? '' : 's'} · {openQuestions.length} open question{openQuestions.length === 1 ? '' : 's'}
                  </span>
                </p>
              ) : (
                <p className="text-muted">No operational plan yet.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}