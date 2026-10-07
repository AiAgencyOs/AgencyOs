import { readMilestoneLifecycle } from '@/modules/finance/phase-nine-b-queries';
import { lifecycleLabel, lifecycleTone } from '@/modules/finance/phase-nine-b-view';
import { Badge, Card } from '@/ui';

/**
 * One line per milestone with its DERIVED financial state (computed by the database from invoices, verified payments, waivers, refunds and open
 * disputes; nothing is stored). A role that reads no finance sees nothing.
 *
 * Wiring (the parent adds ONE line to the project page, beside <PhaseNinePanel />): `<PhaseNineLifecycleLine projectId={projectId} />`
 * (import { PhaseNineLifecycleLine } from './phase-nine-lifecycle-line').
 */
export async function PhaseNineLifecycleLine({ projectId }: { projectId: string }) {
  const lines = await readMilestoneLifecycle(projectId);
  if (lines.length === 0) return null;
  return (
    <Card className="flex flex-col gap-2 p-4">
      <span className="text-sm font-medium text-foreground">Milestone money</span>
      <ul className="flex flex-col gap-1 text-[13px]">
        {lines.map((l) => (
          <li key={l.milestoneId} className="flex flex-wrap items-center gap-2">
            <span className="text-foreground">{l.name}</span>
            <Badge tone={lifecycleTone(l.state)}>{lifecycleLabel(l.state)}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
