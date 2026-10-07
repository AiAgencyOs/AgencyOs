import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { formatAge, readIncidentQueue, type IncidentRow } from '@/lib/p1s/incident-queries';
import { INCIDENT_RUNBOOKS, runbookFor } from '@/lib/p1s/incident-runbooks';
import { readTaskBoard } from '@/modules/orchestrator/p1o-coordination';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat, StatGrid, buttonClass, type Tone } from '@/ui';

import { TaskControls } from '../task-board/task-controls';

export const metadata: Metadata = { title: 'Incidents and recovery' };

const SEVERITY_TONE: Record<IncidentRow['severity'], Tone> = { critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral' };
const SOURCE_LABEL: Record<IncidentRow['source'], string> = { task: 'Agent task', security: 'Security', escalation: 'Escalation', job: 'Background job', outage: 'Provider outage' };

function linkFor(row: IncidentRow): { href: string; label: string } {
  switch (row.source) {
    case 'task':
      return { href: `/operations/task-board/${row.sourceId}`, label: 'Open the task' };
    case 'security':
      return { href: '/security/incidents', label: 'Open the incident' };
    case 'escalation':
      return { href: '/notifications', label: 'Open the escalation' };
    case 'job':
      return { href: '/operations', label: 'Open the dead letters' };
    case 'outage':
      return { href: '/operations', label: 'Open system health' };
  }
}

/**
 * Admin Panel A29, Incidents and recovery (P1-BLUEPRINT-035). One list of what needs a person after something went wrong: agent tasks that failed for good,
 * were refused or may have had an effect nobody can see, open security incidents, escalations, dead background jobs and an open provider outage. It is a READ
 * of those records (`ai.p1s_incident_queue`), so it cannot disagree with them; every action stays behind the door that owns it (the task controls call the
 * same retry / reassign / reconcile / pause doors as the task board, a security incident is closed on its own screen and only by an Admin). Each row names
 * its severity, its age, its owner and the runbook to follow.
 */
export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ severity?: string; source?: string; closed?: string }> }) {
  const context = await requireInternal('/operations/incidents');
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const params = await searchParams;
  const includeClosed = params.closed === '1';
  const rows = await readIncidentQueue(includeClosed);
  const severity = params.severity && ['critical', 'high', 'medium', 'low'].includes(params.severity) ? params.severity : null;
  const source = params.source && Object.keys(SOURCE_LABEL).includes(params.source) ? params.source : null;
  const shown = rows.filter((r) => (!severity || r.severity === severity) && (!source || r.source === source));
  const admin = can(context, 'agent.configure');
  // The task controls need the board's view of each task (its state, whether it is paused, whether its effect is uncertain).
  const board = admin && rows.some((r) => r.source === 'task') ? await readTaskBoard({}) : [];
  const boardOf = new Map(board.map((t) => [t.handoffId, t]));
  const open = rows.filter((r) => r.state === 'open');
  const outages = open.filter((r) => r.source === 'outage');
  const uncertain = open.filter((r) => r.uncertainSideEffect);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents and recovery"
        description="Everything that needs a person after something went wrong, most severe first. Nothing here is closed by the product: a failed task is retried, reassigned or escalated by someone, and an incident is closed by an Admin."
        actions={
          <>
            <Link href="/operations/task-board" className={buttonClass('secondary', 'sm')}>Task board</Link>
            <Link href="/operations" className={buttonClass('secondary', 'sm')}>System health</Link>
          </>
        }
      />

      <StatGrid>
        <Stat label="Open" value={open.length} tone={open.length > 0 ? 'warning' : 'success'} />
        <Stat label="Critical or high" value={open.filter((r) => r.severity === 'critical' || r.severity === 'high').length} tone={open.some((r) => r.severity === 'critical' || r.severity === 'high') ? 'danger' : 'neutral'} />
        <Stat label="May have had an effect" value={uncertain.length} caption="do not retry before checking" tone={uncertain.length > 0 ? 'danger' : 'neutral'} />
        <Stat label="Provider outages" value={outages.length} caption={outages.map((o) => o.outageProvider).filter(Boolean).join(', ') || undefined} tone={outages.length > 0 ? 'danger' : 'neutral'} />
      </StatGrid>

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter the queue">
        <label className="flex flex-col gap-1 text-xs text-muted">Severity
          <select name="severity" defaultValue={severity ?? ''} className="h-8 rounded-md border border-line bg-surface px-2 text-sm">
            <option value="">Any</option>
            {['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">Source
          <select name="source" defaultValue={source ?? ''} className="h-8 rounded-md border border-line bg-surface px-2 text-sm">
            <option value="">Any</option>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1 text-xs text-muted"><input type="checkbox" name="closed" value="1" defaultChecked={includeClosed} /> Include closed and older than 14 days</label>
        <button type="submit" className={buttonClass('primary', 'sm')}>Filter</button>
        <Link href="/operations/incidents" className={buttonClass('secondary', 'sm')}>Clear</Link>
      </form>

      {shown.length === 0 ? (
        <EmptyState title={rows.length === 0 ? 'Nothing needs recovery' : 'Nothing matches that filter'} description={rows.length === 0 ? 'No failed or uncertain tasks, open incidents, escalations, dead jobs or outages.' : 'Clear the filter to see the rest.'} />
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((r) => {
            const runbook = runbookFor(r.runbookKey);
            const link = linkFor(r);
            const task = boardOf.get(r.sourceId);
            return (
              <li key={r.key}>
                <Card>
                  <CardHeader
                    title={r.title}
                    description={`${SOURCE_LABEL[r.source]} · ${r.owner || 'no owner'} · opened ${formatAge(r.ageMinutes)} ago`}
                    actions={
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone={SEVERITY_TONE[r.severity]} dot>{r.severity}</Badge>
                        {r.state === 'closed' ? <Badge tone="success">closed</Badge> : null}
                        {r.uncertainSideEffect ? <Badge tone="danger">may have had an effect</Badge> : null}
                        {r.outageProvider ? <Badge tone="danger">{r.outageProvider} unavailable</Badge> : null}
                      </span>
                    }
                  />
                  <CardBody>
                    <div className="flex flex-col gap-3 text-sm">
                      {r.detail ? <p className="text-muted">{r.detail}</p> : null}
                      <div className="flex flex-wrap items-center gap-3">
                        <Link href={link.href} className={buttonClass('secondary', 'sm')}>{link.label}</Link>
                        {r.correlationId ? <Link href={`/audit?correlation=${r.correlationId}`} className="text-xs underline-offset-2 hover:underline">History</Link> : null}
                      </div>
                      {admin && r.source === 'task' && task ? (
                        <TaskControls handoffId={task.handoffId} boardState={task.boardState} paused={task.paused} uncertain={task.sideEffectUncertain} toAgent={task.toAgent} />
                      ) : null}
                      <details>
                        <summary className="cursor-pointer text-[13px] font-medium">Runbook: {runbook ? runbook.title : 'no runbook written for this kind'}</summary>
                        {runbook ? (
                          <ol className="mt-2 list-decimal pl-5 text-[13px]">
                            {runbook.steps.map((s) => <li key={s} className="mb-1">{s}</li>)}
                          </ol>
                        ) : (
                          <p className="mt-2 text-[13px] text-muted">The queue reported the kind &quot;{r.runbookKey}&quot; and no runbook is written for it. Escalate to an Admin.</p>
                        )}
                      </details>
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted">Runbooks exist for: {INCIDENT_RUNBOOKS.map((r) => r.title.toLowerCase()).join('; ')}.</p>
    </div>
  );
}
