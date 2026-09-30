import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { agencyClock } from '@/lib/admin/agency-clock';
import { readBlockersAcrossProjects } from '@/modules/projects/blockers-queries';
import { listOpenTechnicalDependencies } from '@/modules/projects/dependency-status-queries';
import { listOpenEscalations } from '@/modules/projects/development-events-queries';
import { listActiveDeveloperTasks, listRecentBuilds } from '@/modules/projects/development-activity-queries';
import { listRecentCommitLinks, listRecentGitActions } from '@/modules/projects/git-queries';
import { readDevelopmentPortfolio, readPlanCoverageByProject, type PlanCoverage } from '@/modules/projects/queries';
import {
  Badge,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  IconCode,
  PageHeader,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  buttonClass,
  DomainSearch,
  cx,
  humanize,
  type Column,
} from '@/ui';

import { AcknowledgeEscalationButton, EscalateBlockerPanel, StartQaHandoffPanel } from '../development-events-panels';

export const metadata: Metadata = { title: 'Development' };

type Row = Awaited<ReturnType<typeof readDevelopmentPortfolio>>[number] & { coverage: PlanCoverage };

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="flex items-center gap-2" title={`${done} of ${total} done`}>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
        <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular text-xs text-muted">{total === 0 ? '—' : `${pct}%`}</span>
    </span>
  );
}

const COLUMNS: Column<Row>[] = [
  {
    key: 'name',
    header: 'Project',
    primary: true,
    cell: (p) => (
      <>
        <span className="block font-medium text-foreground">{p.name}</span>
        <span className="block text-xs text-muted">{p.code}</span>
      </>
    ),
  },
  { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.status} /> },
  {
    key: 'modules',
    header: 'Modules',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => (p.modules.total === 0 ? '—' : `${p.modules.done} / ${p.modules.total}`),
  },
  { key: 'progress', header: 'Tasks done', cell: (p) => <Progress done={p.tasks.done} total={p.tasks.total} /> },
  {
    key: 'active',
    header: 'In progress',
    align: 'right',
    cellClassName: 'tabular text-muted',
    desktopOnly: true,
    cell: (p) => String(p.tasks.inProgress),
  },
  {
    key: 'review',
    header: 'In review',
    align: 'right',
    cellClassName: 'tabular text-muted',
    desktopOnly: true,
    cell: (p) => String(p.tasks.inReview),
  },
  {
    key: 'blocked',
    header: 'Blocked',
    align: 'right',
    cellClassName: 'tabular',
    cell: (p) => (p.tasks.blocked > 0 ? <span className="font-medium text-danger">{p.tasks.blocked}</span> : <span className="text-muted">0</span>),
  },
  {
    key: 'plan',
    header: 'Plan',
    desktopOnly: true,
    cell: (p) =>
      p.coverage.planStatus ? (
        <span className="flex items-center gap-1.5">
          <span className="tabular text-xs text-muted">v{p.coverage.planVersion}</span>
          <StatusBadge status={p.coverage.planStatus} dot={false} />
        </span>
      ) : (
        <Badge tone="neutral">no plan</Badge>
      ),
  },
  {
    key: 'qa',
    header: 'QA handoff',
    desktopOnly: true,
    cell: (p) => (p.coverage.hasTestPlan ? <Badge tone="success">test plan drafted</Badge> : <Badge tone="neutral">no test plan</Badge>),
  },
  {
    key: 'open',
    header: 'Open',
    desktopOnly: true,
    cell: (p) => (
      <span className="flex flex-wrap gap-x-2 text-xs">
        <Link href={`/projects/${p.id}/plan`} className="text-brand hover:underline">Plan</Link>
        <Link href={`/projects/${p.id}/repository`} className="text-brand hover:underline">Repository</Link>
        <Link href={`/projects/${p.id}/builds`} className="text-brand hover:underline">Builds</Link>
      </span>
    ),
  },
  {
    key: 'build',
    header: 'Latest build',
    desktopOnly: true,
    cell: (p) =>
      p.builds.latestStatus ? (
        <span className="flex items-center gap-1.5">
          <span className="tabular text-xs text-muted">v{p.builds.latestVersion}</span>
          <StatusBadge status={p.builds.latestStatus} />
        </span>
      ) : (
        <Badge tone="neutral">none</Badge>
      ),
  },
];

/**
 * Development — the module's front door (screen architecture §2, module 7).
 * The implementation plan, the module→feature→task board, repositories,
 * builds, environments and dependencies all live on the project
 * (`/projects/[id]/{plan,development,repository,builds}`, SCR-039…043); this
 * is the portfolio view over them — where every project's build stands,
 * which are blocked, which have a build waiting — in four reads.
 *
 * Bucket F (migration 20261001130000) — SCR-039: recent commits and Git
 * actions across projects, and the escalation / QA-handoff RECORDS through
 * the same panels the project's Development tab mounts (one door, one
 * component). The handoff gate is the database's.
 */
export default async function DevelopmentPortfolioPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  const { q: qRaw, show: showRaw } = await searchParams;
  const context = await requireInternal('/development');
  if (!can(context, 'project.read')) return <PermissionDenied />;

  const [portfolio, coverage, blockers, openTechnical, escalations, recentCommits, recentActions, clock, activeTasks, recentBuilds] = await Promise.all([
    readDevelopmentPortfolio(),
    readPlanCoverageByProject(),
    readBlockersAcrossProjects(),
    listOpenTechnicalDependencies(),
    listOpenEscalations(),
    listRecentCommitLinks(10),
    listRecentGitActions(10),
    agencyClock(),
    listActiveDeveloperTasks(12),
    listRecentBuilds(8),
  ]);
  const mayManage = can(context, 'project.write');
  const mayWriteTask = can(context, 'task.write');
  const escalatedTaskIds = new Set(escalations.map((e) => e.taskId));
  // Tasks still todo or in progress: the count the handoff gate refuses on.
  const notReadyOf = (projectId: string) => {
    const r = allRows.find((row) => row.id === projectId);
    return r ? Math.max(0, r.tasks.total - r.tasks.done - r.tasks.inReview - r.tasks.blocked) : 0;
  };
  // SCR-043: the technical register's open rows, grouped per project beside
  // the plan's own register — a person closes them on the Builds tab.
  const technicalByProject = new Map<string, { projectName: string; items: typeof openTechnical }>();
  for (const d of openTechnical) {
    const entry = technicalByProject.get(d.projectId) ?? { projectName: d.projectName, items: [] };
    entry.items.push(d);
    technicalByProject.set(d.projectId, entry);
  }
  const technicalOnlyProjects = [...technicalByProject.entries()].filter(([projectId]) => !blockers.some((b) => b.projectId === projectId));
  const allRows: Row[] = portfolio.map((r) => ({ ...r, coverage: coverage.get(r.id) ?? { planStatus: null, planVersion: null, hasTestPlan: false } }));
  const q = (qRaw ?? '').trim().slice(0, 120).toLowerCase();
  const SHOW = { all: 'All projects', build: 'In build', blocked: 'Blocked', noplan: 'No active plan' } as const;
  type Show = keyof typeof SHOW;
  const show: Show = showRaw && showRaw in SHOW ? (showRaw as Show) : 'all';
  const matchesShow = (r: Row) => (show === 'all' ? true : show === 'build' ? r.tasks.total > 0 && r.tasks.done < r.tasks.total : show === 'blocked' ? r.tasks.blocked > 0 : r.coverage.planStatus !== 'active');
  const rows: Row[] = allRows.filter((r) => matchesShow(r) && (!q || `${r.name} ${r.code ?? ''}`.toLowerCase().includes(q)));
  const showHref = (next: Show) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (next !== 'all') sp.set('show', next);
    const str = sp.toString();
    return str ? `/development?${str}` : '/development';
  };
  const inBuild = allRows.filter((r) => r.tasks.total > 0 && r.tasks.done < r.tasks.total);
  const blocked = allRows.reduce((n, r) => n + r.tasks.blocked, 0);
  const inReview = allRows.reduce((n, r) => n + r.tasks.inReview, 0);
  const blockedProjects = allRows.filter((r) => r.tasks.blocked > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Development"
        title="Development dashboard"
        description="Phase 5 implementation across every project — plan, task execution, repositories and builds. Open a project for its board."
        actions={<LiveRefresh topics={['tasks', 'deliverables', 'projects']} />}
      />

      {allRows.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Projects in build" value={String(inBuild.length)} tone="brand" icon={<IconCode size={16} />} caption="tasks planned and not all done" />
          <Stat label="Blocked tasks" value={String(blocked)} tone={blocked > 0 ? 'danger' : 'neutral'} caption={blockedProjects > 0 ? `across ${blockedProjects} project${blockedProjects === 1 ? '' : 's'}` : 'nothing blocked'} />
          <Stat label="Tasks in review" value={String(inReview)} tone={inReview > 0 ? 'info' : 'neutral'} caption="awaiting QA or a reviewer" />
          <Stat label="Builds recorded" value={String(allRows.reduce((n, r) => n + r.builds.total, 0))} tone="neutral" caption="build deliverables across projects" />
          <Stat label="Without an active plan" value={String(allRows.filter((r) => r.coverage.planStatus !== 'active').length)} tone={allRows.some((r) => r.coverage.planStatus !== 'active') ? 'warning' : 'success'} caption="Phase 2 blueprint not active" />
          <Stat label="Without a test plan" value={String(allRows.filter((r) => !r.coverage.hasTestPlan).length)} tone={allRows.some((r) => !r.coverage.hasTestPlan) ? 'warning' : 'success'} caption="QA handoff not drafted" />
        </StatGrid>
      ) : null}

      {/*
        SCR-039 — dependencies and blockers, named rather than counted. The
        plan's dependency register and the tasks marked blocked, per project;
        "escalate" goes to the plan's questions, "QA handoff" to the QA tab.
      */}
      <Card>
        <CardHeader
          title={`Dependencies and blockers (${blockers.length + technicalOnlyProjects.length} project${blockers.length + technicalOnlyProjects.length === 1 ? '' : 's'})`}
          description="Unmet plan dependencies, open technical dependencies and blocked tasks. A blocked task is escalated to the PM here with a reason and recorded; the QA handoff is recorded here and refused while a task is blocked or unfinished; a technical dependency is marked supplied on the Builds tab."
        />
        {blockers.length === 0 && technicalOnlyProjects.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">Nothing is recorded as in the way on any project.</p>
        ) : (
          <ul className="divide-y divide-line">
            {blockers.map((p) => (
              <li key={p.projectId} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/projects/${p.projectId}/development`} className="text-[13px] font-medium hover:underline">
                    {p.projectName}
                  </Link>
                  <span className="flex flex-wrap gap-2">
                    {mayManage ? (
                      <StartQaHandoffPanel projectId={p.projectId} blocked={p.blockedTasks.length} notReady={notReadyOf(p.projectId)} />
                    ) : null}
                    <Link href={`/projects/${p.projectId}/qa`} className={buttonClass('ghost', 'sm')}>
                      QA tab
                    </Link>
                  </span>
                </div>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {p.dependencies.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{d.description}</span>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        {d.kind.replace(/_/g, ' ')} · {d.ownerRole}
                        <Badge tone={d.status === 'blocked' ? 'danger' : 'warning'}>{d.status}</Badge>
                      </span>
                    </li>
                  ))}
                  {(technicalByProject.get(p.projectId)?.items ?? []).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{d.name}{d.version ? <span className="text-muted"> {d.version}</span> : null}</span>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        technical dependency
                        <Badge tone="warning">open</Badge>
                        <Link href={`/projects/${p.projectId}/builds`} className="underline underline-offset-2">mark supplied</Link>
                      </span>
                    </li>
                  ))}
                  {p.blockedTasks.map((t) => (
                    <li key={t.id} className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone="danger">task blocked</Badge>
                        <Link href={`/projects/${p.projectId}/development/tasks/${t.id}`} className="hover:underline">
                          {t.title}
                        </Link>
                        <span className="text-xs text-muted">{t.priority}</span>
                        {escalatedTaskIds.has(t.id) ? <Badge tone="warning">with the PM</Badge> : null}
                      </span>
                      {mayWriteTask && !escalatedTaskIds.has(t.id) ? <EscalateBlockerPanel projectId={p.projectId} taskId={t.id} taskTitle={t.title} /> : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {technicalOnlyProjects.map(([projectId, entry]) => (
              <li key={projectId} className="flex flex-col gap-2 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/projects/${projectId}/development`} className="text-[13px] font-medium hover:underline">
                    {entry.projectName}
                  </Link>
                  <Link href={`/projects/${projectId}/builds`} className={buttonClass('secondary', 'sm')}>
                    Builds tab
                  </Link>
                </div>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {entry.items.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>{d.name}{d.version ? <span className="text-muted"> {d.version}</span> : null}</span>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        technical dependency
                        <Badge tone="warning">open</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* SCR-039 — the developer tasks that are active now, and who holds them. */}
      <Card>
        <CardHeader title={`Active Developer Tasks (${activeTasks.length})`} description="Tasks in progress, in review or blocked across every project, most recently touched first." />
        {activeTasks.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">No task is active on any project.</p>
        ) : (
          <ul className="divide-y divide-line">
            {activeTasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px] sm:px-5">
                <StatusBadge status={t.status} dot={false} />
                <Link href={`/projects/${t.projectId}/development/tasks/${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                  {t.title}
                </Link>
                <span className="text-xs text-muted">{t.projectName}</span>
                <span className="text-xs text-muted">{t.priority}</span>
                <span className={t.assigneeName ? 'text-xs' : 'text-xs text-warning'}>{t.assigneeName ?? 'unassigned'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* SCR-039 — escalations waiting on the PM, and recent commits / builds across projects. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Waiting on the PM (${escalations.length})`} description="Blockers escalated and not yet acknowledged, oldest first." />
          <div className="px-4 pb-4 sm:px-5">
            {escalations.length === 0 ? (
              <p className="text-[13px] text-muted">No open escalation.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {escalations.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <span className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/projects/${e.projectId}/development`} className="font-medium hover:underline">
                          {e.projectName}
                        </Link>
                        {e.taskId ? (
                          <Link href={`/projects/${e.projectId}/development/tasks/${e.taskId}`} className="underline-offset-2 hover:underline">
                            {e.taskTitle ?? 'task'}
                          </Link>
                        ) : null}
                        <span className="text-xs text-muted">{clock.dateTime(e.createdAt)}</span>
                      </span>
                      {e.reason ? <span className="text-muted">{e.reason}</span> : null}
                    </span>
                    {mayManage ? <AcknowledgeEscalationButton projectId={e.projectId} eventId={e.id} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={`Recent commits and builds (${recentCommits.length + recentActions.length + recentBuilds.length})`} description="Commits linked to tasks and what the panel did on GitHub, across every project." />
          <div className="px-4 pb-4 sm:px-5">
            {recentCommits.length === 0 && recentActions.length === 0 && recentBuilds.length === 0 ? (
              <p className="text-[13px] text-muted">No commit linked and no Git action recorded on any project yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recentBuilds.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <Badge tone="brand">build</Badge>
                    <Link href={`/projects/${b.projectId}/builds#builds`} className="min-w-0 flex-1 truncate hover:underline">
                      {b.projectName} · v{b.version} {b.title}
                    </Link>
                    {b.commitRef ? <span className="font-mono text-xs">{b.commitRef}</span> : null}
                    {b.buildNumber ? <span className="text-xs text-muted">#{b.buildNumber}</span> : null}
                    <StatusBadge status={b.status} dot={false} />
                    <span className="text-xs text-muted">{clock.dateTime(b.createdAt)}</span>
                  </li>
                ))}
                {recentActions.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <Badge tone={a.action === 'merged' ? 'success' : 'info'}>{humanize(a.action)}</Badge>
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                        {a.reference}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{a.reference}</span>
                    )}
                    <Link href={`/projects/${a.projectId}/repository`} className="min-w-0 flex-1 truncate text-muted hover:underline">
                      {a.projectName} · {a.repository}
                    </Link>
                    <span className="text-xs text-muted">{clock.dateTime(a.createdAt)}</span>
                  </li>
                ))}
                {recentCommits.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                    <Badge tone="neutral">commit</Badge>
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline-offset-2 hover:underline">
                        {c.shortSha}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{c.shortSha}</span>
                    )}
                    <Link href={`/projects/${c.projectId}/development/tasks/${c.taskId}`} className="min-w-0 flex-1 truncate hover:underline">
                      {c.projectName} · {c.taskTitle}
                    </Link>
                    <span className="text-xs text-muted">{clock.dateTime(c.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {allRows.length === 0 ? (
        <EmptyState
          icon={<IconCode size={22} />}
          title="No projects yet"
          description="Development tracking starts when a project's plan is activated and tasks are created from it."
          action={<Link href="/projects" className="text-brand hover:underline">Open projects</Link>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <DomainSearch action="/development" value={qRaw ?? ''} placeholder="Search projects…" label="Search projects" preserve={{ show: show === 'all' ? undefined : show }} />
            <nav aria-label="Project filter" className="flex flex-wrap gap-1.5">
              {(Object.keys(SHOW) as Show[]).map((k) => (
                <Link key={k} href={showHref(k)} aria-current={k === show ? 'page' : undefined} className={cx('inline-flex items-center rounded-lg border px-2.5 py-1 text-[13px] font-medium', k === show ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-foreground')}>
                  {SHOW[k]}
                </Link>
              ))}
            </nav>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={<IconCode size={22} />} title="No project matches" description="Nothing in the list fits that search or filter." action={<Link href="/development" className={buttonClass('secondary', 'sm')}>Clear filters</Link>} />
          ) : (
            <DataTable rows={rows} columns={COLUMNS} getKey={(r) => r.id} href={(r) => `/projects/${r.id}/development`} />
          )}
        </div>
      )}
    </div>
  );
}
