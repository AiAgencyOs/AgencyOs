import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { BOARD_STATES, isBoardState, TASK_PRIORITIES } from '@/modules/orchestrator/p1o-envelope';
import { readHandoffMetrics, readQueueSummary, readTaskBoard } from '@/modules/orchestrator/p1o-coordination';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid, buttonClass, inputClass, type Tone } from '@/ui';

import { TaskControls } from './task-controls';

export const metadata: Metadata = { title: 'Workflow task board' };

const TONE: Record<string, Tone> = { created: 'neutral', ready: 'info', in_progress: 'info', waiting: 'warning', blocked: 'warning', retrying: 'warning', failed: 'danger', escalated: 'danger', closed: 'success' };

function age(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/**
 * Admin Panel A16, the Workflow Task Board (P1-BLUEPRINT-022, P1-COORD-025/026). The state of each task is derived in the database from its row, so the screen
 * and the backend cannot disagree; a result received is not an acceptance. Filters by state, agent, priority and age, the stale ones first-class, the queue
 * summary and the handoff metrics above. Pause, resume, reassign, retry and reconcile are administrator controls and each says why it refused.
 */
export default async function TaskBoardPage({ searchParams }: { searchParams: Promise<{ state?: string; agent?: string; priority?: string; olderThan?: string; stale?: string }> }) {
  const context = await requireInternal('/operations/task-board');
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const params = await searchParams;
  const state = params.state && isBoardState(params.state) ? params.state : null;
  const olderThan = params.olderThan && /^\d{1,6}$/.test(params.olderThan) ? Number(params.olderThan) : null;
  const filters = { state, agent: params.agent?.trim() || null, priority: params.priority && (TASK_PRIORITIES as readonly string[]).includes(params.priority) ? params.priority : null, olderThanMinutes: olderThan, staleOnly: params.stale === '1' };

  const [tasks, summary, metrics] = await Promise.all([readTaskBoard(filters), readQueueSummary(), readHandoffMetrics(30)]);
  const admin = can(context, 'agent.configure');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Workflow task board"
        description="Every handoff between agents, in the states the backend holds. A result received is not an acceptance: a task is closed only when its completion is verified."
        actions={<Link href="/operations" className={buttonClass('secondary', 'sm')}>Jobs and system health</Link>}
      />

      <StatGrid>
        {BOARD_STATES.map((s) => {
          const row = summary.find((x) => x.boardState === s);
          return <Stat key={s} label={s.replace('_', ' ')} value={row?.tasks ?? 0} caption={row && row.stale > 0 ? `${row.stale} stale · oldest ${age(row.oldestAgeMinutes)}` : undefined} tone={(row?.tasks ?? 0) > 0 ? TONE[s] : 'neutral'} href={`/operations/task-board?state=${s}`} />;
        })}
      </StatGrid>

      {metrics ? (
        <Card>
          <CardHeader title="Last 30 days" description="From the handoff rows themselves." />
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-muted">Handoffs</dt><dd className="font-semibold">{metrics.handoffs}</dd></div>
              <div><dt className="text-muted">Completed</dt><dd className="font-semibold">{metrics.completed}</dd></div>
              <div><dt className="text-muted">Failed</dt><dd className="font-semibold">{metrics.failed}</dd></div>
              <div><dt className="text-muted">Needed a retry</dt><dd className="font-semibold">{metrics.retried}</dd></div>
              <div><dt className="text-muted">Escalated</dt><dd className="font-semibold">{metrics.escalated}</dd></div>
              <div><dt className="text-muted">Blocked now</dt><dd className="font-semibold">{metrics.blockedNow}</dd></div>
              <div><dt className="text-muted">Median to complete</dt><dd className="font-semibold">{metrics.medianMinutesToComplete === null ? 'n/a' : age(Math.round(metrics.medianMinutesToComplete))}</dd></div>
              <div><dt className="text-muted">90th percentile</dt><dd className="font-semibold">{metrics.p90MinutesToComplete === null ? 'n/a' : age(Math.round(metrics.p90MinutesToComplete))}</dd></div>
            </dl>
          </CardBody>
        </Card>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter the board">
        <label className="flex flex-col gap-1 text-xs text-muted">State
          <select name="state" defaultValue={state ?? ''} className={`${inputClass} h-8`}>
            <option value="">All</option>
            {BOARD_STATES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Agent
          <input name="agent" defaultValue={filters.agent ?? ''} placeholder="sales, developer…" className={`${inputClass} h-8 w-40`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Priority
          <select name="priority" defaultValue={filters.priority ?? ''} className={`${inputClass} h-8`}>
            <option value="">Any</option>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Older than (minutes)
          <input name="olderThan" inputMode="numeric" defaultValue={olderThan ?? ''} className={`${inputClass} h-8 w-28`} />
        </label>
        <label className="flex items-center gap-2 pb-1 text-xs text-muted"><input type="checkbox" name="stale" value="1" defaultChecked={filters.staleOnly} /> Stale only</label>
        <button type="submit" className={buttonClass('primary', 'sm')}>Filter</button>
        <Link href="/operations/task-board" className={buttonClass('secondary', 'sm')}>Clear</Link>
      </form>

      {tasks.length === 0 ? (
        <EmptyState title="No tasks match" description="Nothing is in that state, or no agent has handed work over yet." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="bg-surface text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-3 py-2">State</th><th className="px-3 py-2">Task</th><th className="px-3 py-2">From → to</th><th className="px-3 py-2">Age</th><th className="px-3 py-2">Retries</th><th className="px-3 py-2">Blocker</th>{admin ? <th className="px-3 py-2">Controls</th> : null}</tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.handoffId} className="border-t border-line align-top">
                  <td className="px-3 py-2"><Badge tone={TONE[t.boardState] ?? 'neutral'} dot>{t.boardState.replace('_', ' ')}</Badge>{t.stale ? <Badge tone="warning" className="ml-1">stale</Badge> : null}</td>
                  <td className="max-w-xs px-3 py-2"><div className="line-clamp-2">{t.objective}</div><div className="mt-0.5 text-xs text-muted">{t.priority} priority · {t.status.replace('_', ' ')}</div></td>
                  <td className="px-3 py-2 text-xs">{t.fromAgent} → {t.toAgent}</td>
                  <td className="px-3 py-2 text-xs">{age(t.ageMinutes)}</td>
                  <td className="px-3 py-2 text-xs">{t.retryCount}</td>
                  <td className="max-w-xs px-3 py-2 text-xs">{t.blocker ?? (t.waitingOn > 0 ? `waiting on ${t.waitingOn} prerequisite(s)` : '')}</td>
                  {admin ? <td className="px-3 py-2"><TaskControls handoffId={t.handoffId} boardState={t.boardState} paused={t.paused} uncertain={t.sideEffectUncertain} toAgent={t.toAgent} /></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
