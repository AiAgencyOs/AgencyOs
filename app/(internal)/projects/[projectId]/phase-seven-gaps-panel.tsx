import type { PhaseSevenGapsView } from '@/modules/projects/phase-seven-gaps-parse';
import { Badge, Card, humanize } from '@/ui';

/**
 * Phase 7 derived views: exception states (read from the records that cause them), linked future work, the follow-up tasks scheduled after completion
 * and the latest production health snapshot. STORED or DERIVED state only. The snapshot is always shown with its source and age; no monitoring source is
 * connected, so it is a person's note and the panel says so. NOT mounted on a page yet (wiring lines are in docs/phase-5-6-7-gaps-log.md).
 */

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2 border-t border-line pt-3">
    <span className="text-xs font-medium uppercase tracking-wide text-faint">{title}</span>
    {children}
  </section>
);

export function PhaseSevenGapsPanel({ view }: { view: PhaseSevenGapsView }) {
  const { exceptionStates, futureWork, followUps, health } = view;
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Phase 7: exceptions, follow-ups and production health</span>
        <Badge tone={exceptionStates.length > 0 ? 'warning' : 'neutral'}>{exceptionStates.length > 0 ? `${exceptionStates.length} exception reason(s)` : 'No exception state'}</Badge>
      </div>
      <Section title="Exception states (derived, never stored)">
        {exceptionStates.length === 0 ? (
          <p className="text-xs text-muted">Nothing blocks the handover, waits on the client, or is disputed.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {exceptionStates.map((e, i) => (
              <li key={`${e.state}-${i}`} className="flex flex-wrap items-center gap-2">
                <Badge tone="warning">{humanize(e.state)}</Badge>
                <span>{e.reason}</span>
                <span className="text-faint">from {e.source}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Linked future work">
        {futureWork.length === 0 ? (
          <p className="text-xs text-muted">No open feedback, limitation or code change is carried forward.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {futureWork.map((w) => (
              <li key={`${w.kind}-${w.refId}`}>
                <span className="font-medium text-foreground">{humanize(w.kind)}</span> {w.summary} {w.route ? `(${humanize(w.route)})` : ''}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Follow-up tasks after handover">
        {followUps.length === 0 ? (
          <p className="text-xs text-muted">None scheduled.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {followUps.map((f) => (
              <li key={f.taskId}>
                {humanize(f.kind)} due {f.dueOn}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Latest production health snapshot">
        {health ? (
          <p className="text-xs text-muted">
            <Badge tone={health.status === 'healthy' ? 'success' : health.status === 'unknown' ? 'neutral' : 'warning'}>{humanize(health.status)}</Badge> recorded by a person ({health.source}) {health.ageMinutes} minute(s) ago. No monitoring source is connected.
          </p>
        ) : (
          <p className="text-xs text-muted">No snapshot recorded. No monitoring source is connected, so none is read automatically.</p>
        )}
      </Section>
    </Card>
  );
}
