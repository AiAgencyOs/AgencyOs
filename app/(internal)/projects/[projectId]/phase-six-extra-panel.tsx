import type { PhaseSixExtra } from '@/modules/projects/phase-six-extra-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

/**
 * Read-only Phase 6 dashboards: the evidence per category for the current candidate, defect aging, the retest queue, exceptions by expiry, and the
 * clarification history. These show stored facts. A result recorded against another commit is labelled stale and is not evidence for this candidate.
 */

const STATUS_TONE: Record<string, Tone> = { pass: 'success', fail: 'danger', blocked: 'danger', no_result: 'neutral' };
const EXCEPTION_TONE: Record<string, Tone> = { expired: 'danger', expiring_soon: 'warning', current: 'success', not_approved: 'neutral' };
const EXCEPTION_WORDS: Record<string, string> = { expired: 'Expired', expiring_soon: 'Expires within 7 days', current: 'Approved and current', not_approved: 'Not approved' };

export function PhaseSixExtraPanel({ extra }: { extra: PhaseSixExtra }) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <span className="text-sm font-medium text-foreground">Phase 6 dashboards</span>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Evidence per category{extra.candidate ? ` (candidate v${extra.candidate.version})` : ''}</h3>
        {extra.candidate === null ? (
          <p className="text-[13px] text-muted">No release candidate exists, so no category has a result to show.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {extra.matrix.map((m) => (
              <li key={m.category} className="flex flex-wrap items-center gap-2">
                <span className="w-28 text-foreground">{humanize(m.category)}</span>
                <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{m.status === 'no_result' ? 'No result' : humanize(m.status)}</Badge>
                {m.stale ? <Badge tone="warning">Stale: another commit</Badge> : null}
                <span className="text-muted">
                  {m.cases.total === 0 ? 'no cases planned' : `${m.cases.passed} of ${m.cases.total} cases passed${m.cases.failed > 0 ? `, ${m.cases.failed} failed` : ''}`}
                  {m.evidenceRef ? `; evidence ${m.evidenceRef}` : m.status === 'pass' ? '' : m.reason ? `; ${m.reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Defect aging (not yet fixed)</h3>
        {extra.aging.length === 0 ? (
          <p className="text-[13px] text-muted">No unfixed defect.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {extra.aging.map((d) => (
              <li key={d.id}>
                <span className="text-foreground">{d.title}</span> <Badge tone={d.ageDays >= 14 ? 'danger' : d.ageDays >= 7 ? 'warning' : 'neutral'}>{`${d.ageDays} days open`}</Badge>{' '}
                <span className="text-muted">{d.sLevel === null ? 'not triaged' : `S${d.sLevel}`}, {humanize(d.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Retest queue (fixed, waiting for verification)</h3>
        {extra.retestQueue.length === 0 ? (
          <p className="text-[13px] text-muted">Nothing is waiting for a retest.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {extra.retestQueue.map((d) => (
              <li key={d.id}>
                <span className="text-foreground">{d.title}</span> <Badge tone={d.retesterId ? 'neutral' : 'warning'}>{d.retesterId ? 'Retester assigned' : 'No retester assigned'}</Badge>{' '}
                <span className="text-muted">waiting {d.waitingDays} days{d.assignmentNote ? `; ${d.assignmentNote}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Exceptions by expiry</h3>
        {extra.exceptions.length === 0 ? (
          <p className="text-[13px] text-muted">No exception has been requested for this candidate.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {extra.exceptions.map((e) => (
              <li key={e.id}>
                <span className="text-foreground">{humanize(e.gate)}</span> <Badge tone={EXCEPTION_TONE[e.state] ?? 'neutral'}>{EXCEPTION_WORDS[e.state] ?? humanize(e.state)}</Badge>{' '}
                <span className="text-muted">owner {e.owner}; {humanize(e.status)}; expires {new Date(e.expiresAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-foreground">Clarification history</h3>
        {extra.clarifications.length === 0 ? (
          <p className="text-[13px] text-muted">No clarification was asked.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {extra.clarifications.map((c) => (
              <li key={c.id}>
                <span className="text-foreground">{c.question}</span> <Badge tone={c.status === 'answered' ? 'success' : 'warning'}>{humanize(c.status)}</Badge>
                <span className="block text-muted">
                  Asked {new Date(c.askedAt).toLocaleDateString()}
                  {c.answer ? `; answered ${c.answeredAt ? new Date(c.answeredAt).toLocaleDateString() : ''}: ${c.answer}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
