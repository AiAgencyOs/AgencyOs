'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { completePhaseAction } from '@/modules/projects/phase-completion-actions';
import { PHASE_COMPLETION_COPY } from '@/modules/projects/phase-completion-schema';
import type { PhaseCompletionReading } from '@/modules/projects/phase-completion-queries';
import { Badge, buttonClass, Card, CardHeader, FormMessage } from '@/ui';

function PhaseRow({ projectId, reading, mayComplete, when }: { projectId: string; reading: PhaseCompletionReading; mayComplete: boolean; when: string | null }) {
  const [state, action, pending] = useActionState(completePhaseAction, IDLE_STATE);
  const copy = PHASE_COMPLETION_COPY[reading.phase];
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">{copy.name}</span>
        <Badge tone={reading.state === 'completed' ? 'success' : reading.state === 'ready' ? 'info' : 'neutral'} dot>
          {reading.state === 'completed' ? 'Complete' : reading.state === 'ready' ? 'Ready to complete' : 'In progress'}
        </Badge>
        {when ? <span className="text-xs text-muted">{when}</span> : null}
      </div>
      <p className="text-[13px] text-muted">{copy.rule} {copy.raises}</p>
      {reading.state === 'not_ready' && reading.missing.length > 0 ? (
        <ul className="list-disc pl-5 text-[13px]">
          {reading.missing.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      {reading.state === 'ready' && mayComplete ? (
        <form action={action} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="phase" value={reading.phase} />
          <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
            {pending ? 'Completing…' : `Complete Phase ${reading.phase}`}
          </button>
          <FormMessage status={state.status} message={state.message} />
        </form>
      ) : null}
    </li>
  );
}

/** Q-PH56 — Phase 5 and Phase 6 completion, read from Development and QA data. */
export function PhaseCompletionPanel({ projectId, readings, mayComplete, whenOf }: { projectId: string; readings: PhaseCompletionReading[]; mayComplete: boolean; whenOf: Record<number, string | null> }) {
  return (
    <Card>
      <CardHeader title="Phases 5 And 6" description="Each one completes from the Development and QA data, and raises its invoice and the PM’s message." />
      <ul className="divide-y divide-line">
        {readings.map((r) => (
          <PhaseRow key={r.phase} projectId={projectId} reading={r} mayComplete={mayComplete} when={whenOf[r.phase] ?? null} />
        ))}
      </ul>
    </Card>
  );
}
