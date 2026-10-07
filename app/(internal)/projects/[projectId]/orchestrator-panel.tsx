import { readOrchestratorOverview, type CostRow } from '@/modules/orchestrator/orchestrator-queries';
import { Badge, Card, humanize } from '@/ui';

/**
 * The Orchestrator's depth, read-only: which agent holds which files, which fallbacks were taken or refused (and why), and what the runs cost with
 * the source of every number. Reads its own data (a Server Component), so the page wires it with one line: `<OrchestratorPanel projectId={projectId} />`.
 *
 * Cost is shown by source and an unknown total is shown as "unknown", never as $0: "we do not know what this cost" is not "it was free".
 */

function money(row: CostRow): string {
  return row.costUsd === null ? 'unknown' : `$${row.costUsd.toFixed(4)}`;
}

export async function OrchestratorPanel({ projectId }: { projectId: string }) {
  const view = await readOrchestratorOverview(projectId);
  const active = view.leases.filter((l) => l.state === 'active');
  if (view.leases.length === 0 && view.fallbacks.length === 0 && view.costs.length === 0) return null;

  return (
    <Card>
      <h3 className="text-[15px] font-semibold">Orchestrator: files, fallbacks and cost</h3>

      <div className="mt-3 flex flex-col gap-1 text-[13px]">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Files held now ({active.length})</span>
        {active.length === 0 ? (
          <span className="text-muted">No agent holds any files.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {active.map((l) => (
              <li key={l.id}>
                <span className="font-medium">{l.taskTitle ?? 'Task'}</span> <Badge tone="info">{humanize(l.agentKey)}</Badge>{' '}
                <span className="text-muted">{l.filePaths.join(', ')} (until {new Date(l.expiresAt).toLocaleString()})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {view.fallbacks.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1 text-[13px]">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Fallbacks</span>
          <ul className="flex flex-col gap-1">
            {view.fallbacks.map((f) => (
              <li key={f.id}>
                <Badge tone={f.outcome === 'accepted' ? 'success' : 'warning'}>{humanize(f.outcome)}</Badge> {humanize(f.primaryAgent)} to {humanize(f.fallbackAgent)}
                <span className="text-muted">
                  {' '}
                  - {f.reason}
                  {f.violations.length > 0 ? ` (${f.violations.map(humanize).join(', ')})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.costs.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1 text-[13px]">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Cost, by where the number came from</span>
          <ul className="flex flex-col gap-1">
            {view.costs.map((c) => (
              <li key={c.source}>
                <Badge tone={c.source === 'unknown' ? 'warning' : 'neutral'}>{humanize(c.source)}</Badge> {money(c)}
                <span className="text-muted"> across {c.records} run(s)</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
