import { readPhaseFourPmState } from '@/modules/projects/pm-state-queries';
import { Badge, Card, humanize } from '@/ui';

/**
 * P4-PM-008/023/024: where Task 2 stands, in the PM spec's own fifteen words, with who owns the next move and (when it is blocked) the exact blocker and
 * how it resumes. Derived on every render by the database from the UI version, prototype, deliverable and M2 rows, so it cannot be stale during review.
 * Renders nothing when the caller may not read it. Mount it beside `PhaseFourPanel` on the project page.
 */
export async function PhaseFourPmState({ projectId }: { projectId: string }) {
  const state = await readPhaseFourPmState(projectId);
  if (!state) return null;
  const blocked = state.pmState === 'BLOCKED';
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Task 2 state</h2>
        <Badge tone={blocked ? 'danger' : state.pmState.startsWith('WAITING') ? 'warning' : state.pmState.startsWith('READY') ? 'success' : 'info'} dot>
          {humanize(state.pmState.toLowerCase())}
        </Badge>
        <span className="text-xs text-muted">Next move belongs to {humanize(state.owner)}</span>
      </div>
      {state.blocker ? <p className="mt-2 text-sm">Blocker: {state.blocker}</p> : null}
      {state.resumeCondition ? <p className="mt-1 text-sm text-muted">{state.resumeCondition}</p> : null}
    </Card>
  );
}
