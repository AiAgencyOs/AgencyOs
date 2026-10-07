import { readSmokeView } from '@/modules/projects/maintenance-smoke-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { DecideSmokeFailureForm, ReportSmokeFailureForm } from './maintenance-smoke-forms';

/**
 * Post-deploy smoke failures of released maintenance changes (Phase 8B). A person records the failure with evidence; an Admin who did not report it
 * records what was decided. AgencyOS runs no smoke check, rolls nothing back and deploys nothing. The parent page adds one line to render this panel.
 */

const SEVERITY_TONE: Record<string, Tone> = { minor: 'neutral', major: 'warning', critical: 'danger' };

export async function MaintenanceSmokePanel({ projectId }: { projectId: string }) {
  const view = await readSmokeView(projectId);
  if (view.releasedItems.length === 0 && view.failures.length === 0) return null;
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <h2 className="text-[15px] font-semibold text-foreground">Post-deploy smoke failures</h2>
        <p className="text-[13px] text-muted">Recorded by a person after a release. AgencyOS runs no smoke check and rolls nothing back.</p>
        <ul className="flex flex-col gap-2">
          {view.failures.map((f) => (
            <li key={f.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[f.severity] ?? 'neutral'}>{humanize(f.severity)}</Badge>
                <Badge tone={f.status === 'open' ? 'warning' : 'success'}>{f.status === 'open' ? 'Awaiting decision' : humanize(f.decision ?? 'decided')}</Badge>
                <span className="text-muted">Deployment {f.deploymentRef} - evidence {f.evidenceRef}</span>
              </div>
              <span className="text-foreground">{f.reason}</span>
              {f.decisionNote ? <span className="text-muted">Decision note: {f.decisionNote}</span> : null}
              {f.status === 'open' && f.reportedBy !== view.viewerId ? <DecideSmokeFailureForm projectId={projectId} failureId={f.id} /> : null}
              {f.status === 'open' && f.reportedBy === view.viewerId ? <span className="text-muted">You reported this; another Admin decides it.</span> : null}
            </li>
          ))}
        </ul>
        {view.releasedItems.length > 0 ? <ReportSmokeFailureForm projectId={projectId} items={view.releasedItems} /> : null}
      </div>
    </Card>
  );
}
