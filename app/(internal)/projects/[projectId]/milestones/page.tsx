import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readClientName } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listMilestoneViews } from '@/modules/projects/milestone-view-queries';
import { readMilestoneDependencies } from '@/modules/projects/milestone-dependency-queries';
import { finalDelivery } from '@/modules/projects/project-health';
import { dueLine, inclusiveDays, phaseState, phaseWindow, rollup, topLevelTasks } from '@/modules/projects/project-view-derive';
import { getProject, listDevelopmentBreakdown, listInternalRoster, listProjectFiles } from '@/modules/projects/queries';
import {
  Avatar,
  AvatarStack,
  Badge,
  humanize,
  buttonClass,
  Card,
  CardHeader,
  EmptyState,
  Gantt,
  HeaderFigure,
  IconCalendar,
  IconCheck,
  IconFlag,
  PermissionDenied,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  type GanttRow,
} from '@/ui';

import { MarkMilestoneMetForm } from '../plan/milestone-forms';
import { DraftMilestoneAnnouncementForm } from './draft-announcement-form';
import { listAnnouncements } from '@/modules/crm/announcements-queries';
import { ProjectSubNav } from '../project-subnav';
import { WorkspaceHeader } from '../workspace-header';

export const metadata: Metadata = { title: 'Milestones' };

const STATE_TONE = { done: 'success', current: 'info', late: 'danger', upcoming: 'neutral' } as const;
const STATE_WORD = { done: 'Completed', current: 'In progress', late: 'Overdue', upcoming: 'Pending' } as const;

/**
 * The project's Milestones tab: the phases as cards with their tasks rolled
 * up, a Gantt of them, and the selected milestone's details in the rail. The
 * "Mark as Completed" button is the plan page's own door (`markMilestoneMet`),
 * so the payment rule (a milestone unlocks when the one before it is paid)
 * still decides. Assignees are the people holding tasks filed under it.
 */
export default async function ProjectMilestonesPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ milestone?: string }> }) {
  const { projectId } = await params;
  const { milestone: selectedParam } = await searchParams;

  const context = await requireInternal(`/projects/${projectId}/milestones`);
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const project = await getProject(projectId);
  if (!project) notFound();

  const [milestones, { tasks: allTasks }, roster, files, clock, clientName] = await Promise.all([
    listMilestoneViews(projectId),
    listDevelopmentBreakdown(projectId),
    listInternalRoster(),
    listProjectFiles(projectId),
    agencyClock(),
    project.client_account_id ? readClientName(project.client_account_id) : Promise.resolve(null),
  ]);
  const tasks = topLevelTasks(allTasks);
  const dependencies = await readMilestoneDependencies(projectId, milestones.map((m) => ({ id: m.id, name: m.name, position: m.position, met: m.metAt !== null || m.status === 'met' })));
  const today = clock.dayKey(new Date());
  const nameByUser = new Map(roster.map((r) => [r.userId, r.fullName]));
  const base = `/projects/${projectId}`;
  const mayWritePlan = can(context, 'milestone.write');
  // SCR-059: a met milestone's announcement (the owner drafts one by hand when no template was active).
  const mayAnnounce = can(context, 'organization.settings');
  const announcementsForProject = await listAnnouncements({ projectId, limit: 100 });

  const firstUnmet = milestones.find((m) => !m.metAt && m.status !== 'met')?.id ?? null;
  let previousDue: string | null = null;
  const cards = milestones.map((m, i) => {
    const own = tasks.filter((t) => t.milestoneId === m.id);
    const roll = rollup(own);
    const meta = { id: m.id, name: m.name, dueOn: m.dueOn, metAt: m.metAt, status: m.status };
    const state = phaseState(meta, roll, today, m.id === firstUnmet);
    const window = phaseWindow(meta, previousDue, project.starts_on, own);
    previousDue = m.dueOn ?? previousDue;
    const people = [...new Set(own.map((t) => t.assigneeId).filter((id): id is string => id !== null))].map((id) => nameByUser.get(id) ?? 'Unknown');
    return { m, index: i + 1, own, roll, state, window, people };
  });

  const selected = cards.find((c) => c.m.id === selectedParam) ?? cards.find((c) => c.m.id === firstUnmet) ?? cards[0] ?? null;
  const done = cards.filter((c) => c.state === 'done').length;
  const inProgress = cards.filter((c) => c.state === 'current' || c.state === 'late').length;
  const pending = cards.filter((c) => c.state === 'upcoming').length;
  const overall = cards.length === 0 ? 0 : Math.round((done / cards.length) * 100);
  const { date: finalDue, daysLeft } = finalDelivery(milestones.map((m) => m.dueOn), project.ends_on, today);

  const gantt: GanttRow[] = cards
    .filter((c) => c.window !== null)
    .map((c) => ({
      id: c.m.id,
      index: String(c.index),
      label: c.m.name,
      caption: `${clock.date((c.window as { start: string }).start)} – ${clock.date((c.window as { end: string }).end)}`,
      start: (c.window as { start: string }).start,
      end: (c.window as { end: string }).end,
      state: c.state,
      progress: c.roll.percent,
      href: `${base}/milestones?milestone=${c.m.id}`,
    }));
  const upcoming = cards.filter((c) => c.state !== 'done' && c.m.dueOn !== null).sort((a, b) => (a.m.dueOn as string).localeCompare(b.m.dueOn as string)).slice(0, 4);

  return (
    <div className="flex flex-col gap-5">
      <WorkspaceHeader
        project={project}
        clock={clock}
        clientName={clientName}
        canEdit={can(context, 'project.write')}
        aside={
          <HeaderFigure value={`${overall}%`} label="Milestones met">
            <ProgressBar value={overall} showValue={false} label="Milestones met" tone="brand" />
          </HeaderFigure>
        }
      />

      <ProjectSubNav projectId={projectId} />

      <StatGrid cols={5}>
        <Stat compact label="Total milestones" value={String(cards.length)} caption="On the payment plan" tone="brand" icon={<IconFlag size={16} />} />
        <Stat compact label="Completed" value={String(done)} caption={cards.length ? `${Math.round((done / cards.length) * 100)}%` : '0%'} tone="success" icon={<IconCheck size={16} />} />
        <Stat compact label="In progress" value={String(inProgress)} caption={cards.length ? `${Math.round((inProgress / cards.length) * 100)}%` : '0%'} tone="info" icon={<IconCalendar size={16} />} />
        <Stat compact label="Pending" value={String(pending)} caption={cards.length ? `${Math.round((pending / cards.length) * 100)}%` : '0%'} tone="warning" icon={<IconCalendar size={16} />} />
        <Stat compact label="Final delivery" value={finalDue ? clock.date(finalDue) : '—'} caption={finalDue === null || daysLeft === null ? 'No final date' : dueLine(finalDue, today)} tone="accent" icon={<IconCalendar size={16} />} />
      </StatGrid>

      {cards.length === 0 ? (
        <EmptyState
          title="No milestones planned yet"
          description="Milestones come from the payment plan. Configure it on the project overview or the plan tab."
          action={<Link href={`${base}/plan`} className={buttonClass('secondary', 'sm')}>Open the plan</Link>}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card>
              <CardHeader title="Project milestone timeline" description="Each bar runs from its tasks' first start (or the day after the milestone before it closed) to its due date." />
              <div className="px-2 pb-4 sm:px-3">
                {gantt.length === 0 ? <p className="px-2 text-[13px] text-muted">No milestone has a due date or a dated task yet, so there is nothing to draw.</p> : <Gantt rows={gantt} todayKey={today} />}
              </div>
            </Card>

            <ol className="flex flex-col gap-3">
              {cards.map((c) => (
                <li key={c.m.id}>
                  <Link
                    href={`${base}/milestones?milestone=${c.m.id}`}
                    aria-current={selected?.m.id === c.m.id ? 'true' : undefined}
                    className={`flex flex-col gap-3 rounded-xl border bg-surface p-4 shadow-xs transition-colors hover:bg-surface-hover sm:flex-row sm:items-center ${selected?.m.id === c.m.id ? 'border-brand ring-1 ring-brand' : 'border-line'}`}
                  >
                    <span aria-hidden className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${c.state === 'done' ? 'bg-success text-white' : c.state === 'current' ? 'bg-brand text-white' : 'border-2 border-line-strong text-muted'}`}>
                      {c.state === 'done' ? <IconCheck size={15} /> : c.index}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold text-foreground">{c.m.name}</span>
                        <Badge tone={STATE_TONE[c.state]} dot>{STATE_WORD[c.state]}</Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {c.window ? `${clock.date(c.window.start)} – ${clock.date(c.window.end)} (${inclusiveDays(c.window.start, c.window.end)} days)` : 'No dates yet'}
                      </span>
                      {c.m.description ? <span className="mt-1 line-clamp-2 block text-[13px] text-foreground">{c.m.description}</span> : null}
                      <span className="mt-2 flex items-center gap-3 text-xs text-muted">
                        <span className="whitespace-nowrap">Tasks ({c.roll.done}/{c.roll.total} completed)</span>
                        <span className="w-32"><ProgressBar value={c.roll.percent} showValue={false} size="sm" label={`${c.m.name} tasks`} tone={c.state === 'done' ? 'success' : 'brand'} /></span>
                        <span className="tabular font-semibold text-foreground">{c.roll.percent}%</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
                      {c.people.length > 0 ? <AvatarStack names={c.people} max={3} /> : <span className="text-xs text-faint">No assignees</span>}
                      <span className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-muted">
                        {c.m.metAt ? (
                          <>Completed on<br /><span className="text-[13px] font-semibold text-foreground">{clock.date(c.m.metAt)}</span></>
                        ) : (
                          <>{c.m.dueOn ? 'Due on' : 'No due date'}<br /><span className="text-[13px] font-semibold text-foreground">{c.m.dueOn ? clock.date(c.m.dueOn) : ''}</span>{c.m.dueOn ? <><br />{dueLine(c.m.dueOn, today)}</> : null}</>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title={selected ? `Milestone tasks (${selected.m.name})` : 'Milestone tasks'} actions={selected ? <Link href={`${base}/tasks?phase=${selected.m.id}`} className="text-[13px] font-medium text-brand hover:underline">View All</Link> : undefined} />
                {!selected || selected.own.length === 0 ? (
                  <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No task is filed under this milestone.</p>
                ) : (
                  <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
                    {selected.own.slice(0, 6).map((t, i) => (
                      <li key={t.id} className="flex items-center gap-3 py-2 text-[13px]">
                        <span className="tabular w-4 text-muted">{i + 1}</span>
                        <Link href={`${base}/development/tasks/${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{t.title}</Link>
                        <StatusBadge status={t.status} dot={false} />
                        <span className="hidden whitespace-nowrap text-xs text-muted sm:inline">{t.dueOn ? clock.date(t.dueOn) : '—'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Upcoming deadlines" />
                {upcoming.length === 0 ? (
                  <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No open milestone has a due date.</p>
                ) : (
                  <ul className="divide-y divide-line px-4 pb-2 sm:px-5">
                    {upcoming.map((c) => (
                      <li key={c.m.id} className="flex items-center gap-3 py-2 text-[13px]">
                        <span className="min-w-0 flex-1 truncate font-medium">{c.m.name}</span>
                        <span className="whitespace-nowrap text-xs text-muted">{clock.date(c.m.dueOn as string)}</span>
                        <Badge tone={c.state === 'late' ? 'danger' : 'warning'}>{dueLine(c.m.dueOn, today)}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          {selected ? (
            <aside aria-label="Milestone details" className="flex min-w-0 flex-col gap-4">
              <Card>
                <CardHeader title="Milestone details" actions={mayWritePlan ? <Link href={`${base}/plan?milestone=${selected.m.id}`} className="text-[13px] font-medium text-brand hover:underline">Edit</Link> : undefined} />
                <div className="flex flex-col gap-4 px-4 pb-4 text-[13px] sm:px-5">
                  <div>
                    <p className="text-[15px] font-semibold text-foreground">{selected.m.name}</p>
                    <Badge tone={STATE_TONE[selected.state]} dot className="mt-1">{STATE_WORD[selected.state]}</Badge>
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Timeline</p>
                    <p className="text-muted">{selected.window ? `${clock.date(selected.window.start)} – ${clock.date(selected.window.end)}` : 'Not dated yet'}</p>
                    {selected.window ? <p className="text-muted">{inclusiveDays(selected.window.start, selected.window.end)} days</p> : null}
                  </div>
                  {selected.m.description ? (
                    <div>
                      <p className="font-semibold text-foreground">Description</p>
                      <p className="whitespace-pre-wrap text-muted">{selected.m.description}</p>
                    </div>
                  ) : null}
                  <div>
                    <p className="font-semibold text-foreground">Progress</p>
                    <div className="mt-1 flex items-center gap-3">
                      <span className="flex-1"><ProgressBar value={selected.roll.percent} showValue={false} label="Milestone progress" tone="brand" /></span>
                      <span className="tabular font-semibold">{selected.roll.percent}%</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{selected.roll.done} of {selected.roll.total} tasks completed</p>
                  </div>
                  {/* SCR-023: the dependency list — what this milestone waits on, from stored facts only. */}
                  {(() => {
                    const dep = dependencies.get(selected.m.id);
                    const total = dep ? dep.gates.length + dep.earlierUnmet.length + dep.blockedTasks.length : 0;
                    return (
                      <div>
                        <p className="font-semibold text-foreground">Dependencies{total > 0 ? ` (${total})` : ''}</p>
                        {!dep || total === 0 ? (
                          <p className="text-muted">Nothing is holding this milestone: no earlier milestone is open, no plan dependency gates it and none of its tasks is blocked.</p>
                        ) : (
                          <ul className="mt-1 flex flex-col gap-1.5">
                            {dep.earlierUnmet.map((e) => (
                              <li key={e.id} className="flex flex-wrap items-center gap-1.5">
                                <Badge tone="warning" dot={false}>Earlier milestone</Badge>
                                <Link href={`${base}/milestones?milestone=${e.id}`} className="hover:underline">{e.name}</Link>
                                <span className="text-xs text-muted">not met yet</span>
                              </li>
                            ))}
                            {dep.gates.map((g) => (
                              <li key={g.id} className="flex flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <Badge tone={g.status === 'received' || g.status === 'not_applicable' ? 'success' : g.status === 'blocked' ? 'danger' : 'warning'} dot={false}>{humanize(g.kind)}</Badge>
                                  <span>{g.description}</span>
                                </span>
                                <span className="text-xs text-muted">{humanize(g.status)} · owner {humanize(g.ownerRole)} · needed by {humanize(g.neededByPhase)}</span>
                              </li>
                            ))}
                            {dep.blockedTasks.map((t) => (
                              <li key={t.id} className="flex flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <Badge tone="danger" dot={false}>Blocked task</Badge>
                                  <Link href={`${base}/development/tasks/${t.id}`} className="hover:underline">{t.title}</Link>
                                </span>
                                <span className="text-xs text-muted">{[t.reason, t.owner ? `owner ${t.owner}` : null, t.nextAction ? `next: ${t.nextAction}` : null].filter(Boolean).join(' · ')}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })()}
                  <div>
                    <p className="font-semibold text-foreground">Assignees</p>
                    {selected.people.length === 0 ? <p className="text-muted">Nobody holds a task here yet.</p> : (
                      <ul className="mt-1 flex flex-wrap gap-2">
                        {selected.people.map((n) => (
                          <li key={n} className="flex items-center gap-1.5"><Avatar name={n} size="sm" /><span className="text-xs text-muted">{n}</span></li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Related files</p>
                    <Link href={`${base}/files`} className="mt-1 flex h-9 items-center justify-between rounded-lg border border-line px-3 hover:bg-surface-hover">
                      <span>{files.length} file{files.length === 1 ? '' : 's'} on this project</span>
                      <span aria-hidden>›</span>
                    </Link>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Link href={`${base}/tasks?phase=${selected.m.id}`} className={`${buttonClass('primary', 'md')} justify-center`}>View tasks</Link>
                    {mayWritePlan ? <Link href={`${base}/plan?milestone=${selected.m.id}`} className={`${buttonClass('secondary', 'md')} justify-center`}>Edit milestone</Link> : null}
                    {mayWritePlan && selected.state !== 'done' ? <MarkMilestoneMetForm projectId={projectId} milestoneId={selected.m.id} label="Mark as Completed" /> : null}
                    {selected.state === 'done' ? (
                      (() => {
                        const announced = announcementsForProject.find((a) => a.milestoneId === selected.m.id);
                        if (announced) {
                          return (
                            <p className="rounded-md border border-line px-3 py-2 text-xs text-muted">
                              Announcement: <span className="font-medium text-foreground">{announced.title}</span> ({announced.status}).
                            </p>
                          );
                        }
                        return mayAnnounce ? <DraftMilestoneAnnouncementForm milestoneId={selected.m.id} /> : null;
                      })()
                    ) : null}
                  </div>
                </div>
              </Card>
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}
