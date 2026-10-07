import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { BOARD_STATES, buildBoard, queueSummary, type BoardState } from '@/lib/p13/task-board';
import { readTaskBoardSources } from '@/lib/p13/task-board-queries';
import { Badge, Card, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat } from '@/ui';

export const metadata: Metadata = { title: 'Workflow task board' };

const LABEL: Record<BoardState, string> = {
  created: 'Created',
  ready: 'Ready',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  retrying: 'Retrying',
  failed: 'Failed',
  escalated: 'Escalated',
  closed: 'Closed',
};
const TONE: Record<BoardState, 'neutral' | 'info' | 'warning' | 'danger' | 'success'> = {
  created: 'neutral',
  ready: 'info',
  in_progress: 'info',
  waiting: 'warning',
  blocked: 'danger',
  retrying: 'warning',
  failed: 'danger',
  escalated: 'danger',
  closed: 'success',
};

/**
 * A16 Workflow Task Board (P1-BLUEPRINT-022). The nine blueprint states, derived from the real queues (jobs and agent handoffs); the backend state is
 * authoritative and a result received is not "closed" until the source row says so. Retry and cancel stay where they live (Operations); this board reads.
 * Filter with ?state= and ?stale=1.
 */
export default async function TaskBoardPage({ searchParams }: { searchParams: Promise<{ state?: string; stale?: string }> }) {
  const context = await requireInternal('/operations/task-board');
  if (!can(context, 'agent.run') && !can(context, 'audit.read')) return <PermissionDenied />;
  const { state, stale } = await searchParams;
  const src = await readTaskBoardSources();
  const all = buildBoard({ jobs: src.jobs, handoffs: src.handoffs, escalatedJobIds: src.escalatedJobIds, now: new Date() });
  const summary = queueSummary(all);
  const wanted = (BOARD_STATES as readonly string[]).includes(state ?? '') ? (state as BoardState) : null;
  const shown = all.filter((i) => (wanted ? i.state === wanted : true) && (stale === '1' ? i.stale : true)).slice(0, 200);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Workflow task board" description="Every job and agent handoff of the last 14 days, in the nine states the blueprint names. Retry and cancel are in Operations." />
      {src.capped ? <p className="text-sm text-warning">Showing the newest 500 jobs and 500 handoffs; older ones are not counted here.</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {BOARD_STATES.map((s) => (
          <Link key={s} href={`/operations/task-board?state=${s}`}>
            <Stat label={LABEL[s]} value={String(summary[s])} />
          </Link>
        ))}
        <Link href="/operations/task-board?stale=1">
          <Stat label="Stale (open over 24h)" value={String(summary.stale)} />
        </Link>
      </div>
      <Card>
        <CardHeader title={wanted ? `${LABEL[wanted]}` : 'All tasks'} description={`${shown.length} shown. Oldest first.`} />
        <div className="px-4 pb-4 sm:px-5">
          {shown.length === 0 ? (
            <EmptyState title="Nothing here" description="No task is in this state." action={<Link href="/operations/task-board" className="text-sm underline">Show every task</Link>} />
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {shown.map((i) => (
                <li key={`${i.source}:${i.id}`} className="flex flex-wrap items-center gap-2 py-2">
                  <Badge tone={TONE[i.state]}>{LABEL[i.state]}</Badge>
                  <span className="font-medium">{i.label}</span>
                  {i.agent ? <span className="text-muted">{i.agent}</span> : null}
                  <span className="text-muted">{i.stateReason}</span>
                  <span className="text-muted">{i.ageHours}h old</span>
                  {i.stale ? <Badge tone="warning">Stale</Badge> : null}
                  {i.detail ? <span className="w-full truncate text-xs text-muted">{i.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
