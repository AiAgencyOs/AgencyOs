import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { readDevelopmentPortfolio } from '@/modules/projects/queries';
import {
  Badge,
  DataTable,
  EmptyState,
  IconCode,
  PageHeader,
  PermissionDenied,
  Stat,
  StatGrid,
  StatusBadge,
  type Column,
} from '@/ui';

export const metadata: Metadata = { title: 'Development' };

type Row = Awaited<ReturnType<typeof readDevelopmentPortfolio>>[number];

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

  const rows = await readDevelopmentPortfolio();
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
        <StatGrid cols={4}>
          <Stat label="Projects in build" value={String(inBuild.length)} tone="brand" icon={<IconCode size={16} />} caption="tasks planned and not all done" />
          <Stat label="Blocked tasks" value={String(blocked)} tone={blocked > 0 ? 'danger' : 'neutral'} caption={blockedProjects > 0 ? `across ${blockedProjects} project${blockedProjects === 1 ? '' : 's'}` : 'nothing blocked'} />
          <Stat label="Tasks in review" value={String(inReview)} tone={inReview > 0 ? 'info' : 'neutral'} caption="awaiting QA or a reviewer" />
          <Stat label="Builds recorded" value={String(rows.reduce((n, r) => n + r.builds.total, 0))} tone="neutral" caption="build deliverables across projects" />
        </StatGrid>
      ) : null}

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
