import Link from 'next/link';

import { readProjectCloseSummary } from '@/modules/finance/phase-nine-queries';
import { closeModeLabel, resultLabel, resultTone } from '@/modules/finance/phase-nine-view';
import { Badge, Card } from '@/ui';

/**
 * A single line on the project page: where this project's FINANCIAL close stands (Phase 9), with a link to the full view. It is the financial close only;
 * the project is not complete until Phase 7 says so. A role that reads no finance sees nothing (the database answers, not this component).
 *
 * Wiring (the parent adds ONE line to the project page): `<PhaseNinePanel projectId={projectId} />`.
 */
export async function PhaseNinePanel({ projectId }: { projectId: string }) {
  const summary = await readProjectCloseSummary(projectId);
  if (!summary) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <span className="text-sm font-medium text-foreground">Financial close</span>
      {summary.closedMode ? <Badge tone="success">{closeModeLabel(summary.closedMode)}</Badge> : <Badge tone={resultTone(summary.lastResult)}>{resultLabel(summary.lastResult)}</Badge>}
      <Link href={`/finance/close/${projectId}`} className="text-[13px] text-muted underline">Open the financial close</Link>
    </Card>
  );
}
