import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { blockerSummary, buildBlockers } from '@/lib/p13/phase-blockers';
import { readPhaseBlockerSources } from '@/lib/p13/phase-blockers-queries';
import { Badge, Card, CardHeader, EmptyState, PageHeader, PermissionDenied, Stat } from '@/ui';

export const metadata: Metadata = { title: 'Phase blockers' };

/**
 * P2-FLOW-028 / P2-PLAN-027: one list of every Phase 2 and Phase 3 project that is waiting, across all projects: who it waits on, why, and for how many
 * days. The states are read as the phases report them; this page assigns nobody and changes nothing. Open the project to act.
 */
export default async function PhaseBlockersPage() {
  const context = await requireInternal('/operations/phase-blockers');
  if (!can(context, 'project.read')) return <PermissionDenied />;
  const src = await readPhaseBlockerSources();
  const blockers = buildBlockers({ phaseTwo: src.phaseTwo, phaseThree: src.phaseThree, dependencies: src.dependencies, projects: src.projects, now: new Date() });
  const summary = blockerSummary(blockers);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Phase blockers" description="Everything waiting in Phases 2 and 3, and the planning dependencies that are blocked, oldest first." />
      {src.capped ? <p className="text-sm text-warning">Showing the 500 longest-waiting rows of at least one list; there are more.</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Waiting" value={String(summary.total)} />
        <Stat label="Needs a person" value={String(summary.needsPerson)} />
        <Stat label="Longest wait (days)" value={String(summary.oldestDays)} />
      </div>
      <Card>
        <CardHeader title="Waiting now" description={Object.entries(summary.byWaitingOn).map(([k, n]) => `${n} on ${k}`).join('; ') || 'Nothing is waiting.'} />
        <div className="px-4 pb-4 sm:px-5">
          {blockers.length === 0 ? (
            <EmptyState title="Nothing is blocked" description="No project is waiting in Phase 2 or Phase 3." action={<Link href="/projects" className="text-sm underline">Open projects</Link>} />
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {blockers.map((b, i) => (
                <li key={`${b.source}:${b.projectId}:${i}`} className="flex flex-wrap items-center gap-2 py-2">
                  <Link href={`/projects/${b.projectId}`} className="font-medium underline">
                    {b.projectName}
                  </Link>
                  <Badge tone="neutral">{b.source === 'phase_two' ? 'Phase 2' : b.source === 'phase_three' ? 'Phase 3' : 'Plan'}</Badge>
                  <Badge tone={b.needsPerson ? 'warning' : 'info'}>{b.state.replace(/_/g, ' ')}</Badge>
                  <span className="text-muted">waiting on {b.waitingOn}</span>
                  <span className="text-muted">{b.waitingDays}d</span>
                  <span className="w-full text-xs text-muted">{b.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
