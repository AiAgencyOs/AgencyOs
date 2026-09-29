import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { readBlockersAcrossProjects } from '@/modules/projects/blockers-queries';
import { listOpenTechnicalDependencies } from '@/modules/projects/dependency-status-queries';
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
  type Column,
} from '@/ui';

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
 */
export default async function DevelopmentPortfolioPage() {
  const context = await requireInternal('/development');
  if (!can(context.role, 'project.read')) return <PermissionDenied />;

  const [portfolio, coverage, blockers, openTechnical] = await Promise.all([readDevelopmentPortfolio(), readPlanCoverageByProject(), readBlockersAcrossProjects(), listOpenTechnicalDependencies()]);
  // SCR-043: the technical register's open rows, grouped per project beside
  // the plan's own register — a person closes them on the Builds tab.
  const technicalByProject = new Map<string, { projectName: string; items: typeof openTechnical }>();
  for (const d of openTechnical) {
    const entry = technicalByProject.get(d.projectId) ?? { projectName: d.projectName, items: [] };
    entry.items.push(d);
    technicalByProject.set(d.projectId, entry);
  }
  const technicalOnlyProjects = [...technicalByProject.entries()].filter(([projectId]) => !blockers.some((b) => b.projectId === projectId));
  const rows: Row[] = portfolio.map((r) => ({ ...r, coverage: coverage.get(r.id) ?? { planStatus: null, planVersion: null, hasTestPlan: false } }));
  const inBuild = rows.filter((r) => r.tasks.total > 0 && r.tasks.done < r.tasks.total);
  const blocked = rows.reduce((n, r) => n + r.tasks.blocked, 0);
  const inReview = rows.reduce((n, r) => n + r.tasks.inReview, 0);
  const blockedProjects = rows.filter((r) => r.tasks.blocked > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Development"
        title="Development dashboard"
        description="Phase 5 implementation across every project — plan, task execution, repositories and builds. Open a project for its board."
        actions={<LiveRefresh topics={['tasks', 'deliverables', 'projects']} />}
      />

      {rows.length > 0 ? (
        <StatGrid cols={6}>
          <Stat label="Projects in build" value={String(inBuild.length)} tone="brand" icon={<IconCode size={16} />} caption="tasks planned and not all done" />
          <Stat label="Blocked tasks" value={String(blocked)} tone={blocked > 0 ? 'danger' : 'neutral'} caption={blockedProjects > 0 ? `across ${blockedProjects} project${blockedProjects === 1 ? '' : 's'}` : 'nothing blocked'} />
          <Stat label="Tasks in review" value={String(inReview)} tone={inReview > 0 ? 'info' : 'neutral'} caption="awaiting QA or a reviewer" />
          <Stat label="Builds recorded" value={String(rows.reduce((n, r) => n + r.builds.total, 0))} tone="neutral" caption="build deliverables across projects" />
          <Stat label="Without an active plan" value={String(rows.filter((r) => r.coverage.planStatus !== 'active').length)} tone={rows.some((r) => r.coverage.planStatus !== 'active') ? 'warning' : 'success'} caption="Phase 2 blueprint not active" />
          <Stat label="Without a test plan" value={String(rows.filter((r) => !r.coverage.hasTestPlan).length)} tone={rows.some((r) => !r.coverage.hasTestPlan) ? 'warning' : 'success'} caption="QA handoff not drafted" />
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
          description="Unmet plan dependencies, open technical dependencies and blocked tasks. Escalate to the PM on the plan; mark a technical dependency supplied on the Builds tab; start the QA handoff on the QA tab."
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
                    <Link href={`/projects/${p.projectId}/plan`} className={buttonClass('secondary', 'sm')}>
                      Escalate to the PM
                    </Link>
                    <Link href={`/projects/${p.projectId}/qa`} className={buttonClass('ghost', 'sm')}>
                      Start QA handoff
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
                    <li key={t.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger">task blocked</Badge>
                      <Link href={`/projects/${p.projectId}/development/tasks/${t.id}`} className="hover:underline">
                        {t.title}
                      </Link>
                      <span className="text-xs text-muted">{t.priority}</span>
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

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconCode size={22} />}
          title="No projects yet"
          description="Development tracking starts when a project's plan is activated and tasks are created from it."
          action={<Link href="/projects" className="text-brand hover:underline">Open projects</Link>}
        />
      ) : (
        <DataTable rows={rows} columns={COLUMNS} getKey={(r) => r.id} href={(r) => `/projects/${r.id}/development`} />
      )}
    </div>
  );
}
