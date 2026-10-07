import type { FunctionalTestView } from '@/modules/projects/functional-test-parse';
import { Badge, Card, humanize } from '@/ui';

/**
 * P604 Functional Test evidence for the approved Master Test Plan: per-requirement scenario coverage, the definition of done and the handoff to Master QA.
 * It renders what the database derived. The recommendation is about FUNCTIONAL evidence only: this panel never says the product is production-ready,
 * and nothing here records a result or decides anything. NOT mounted on a page yet (wiring lines are in docs/phase-5-6-7-gaps-log.md).
 */

const TONE = { functional_pass_recommended: 'success', incomplete: 'warning', blocked: 'warning', not_recommended: 'danger' } as const;

export function FunctionalTestPanel({ view }: { view: FunctionalTestView }) {
  const { coverage, definitionOfDone, handoff } = view;
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Functional test evidence (P604)</span>
        {handoff ? <Badge tone={TONE[handoff.recommendation]}>{humanize(handoff.recommendation)} (functional only)</Badge> : <Badge tone="neutral">No approved plan</Badge>}
      </div>
      {handoff ? (
        <p className="text-xs text-muted">
          Build {handoff.build.commit} · pass {handoff.totals.pass} · fail {handoff.totals.fail} · blocked {handoff.totals.blocked} · not applicable {handoff.totals.not_applicable} · skipped {handoff.totals.skipped_with_reason} · not run {handoff.totals.not_run}. {handoff.note}
        </p>
      ) : null}
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Requirements and the scenarios that cover them</span>
        {coverage.length === 0 ? (
          <p className="text-xs text-muted">No included requirement to cover.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {coverage.map((c) => (
              <li key={c.scopeItemId} className="flex flex-wrap items-center gap-2">
                <Badge tone={c.coverage === 'minimum_met' ? 'success' : c.coverage === 'excluded' ? 'neutral' : 'warning'}>{humanize(c.coverage)}</Badge>
                <span className="font-medium text-foreground">{c.title}</span>
                <span>{c.directCases} case(s)</span>
                {c.excludedReason ? <span>No direct test: {c.excludedReason}</span> : <span>Missing: {c.kindsMissing.map(humanize).join(', ') || 'none'}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Definition of done (advice; it gates nothing)</span>
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {definitionOfDone.map((d) => (
            <li key={d.item} className="flex flex-wrap items-center gap-2">
              <Badge tone={d.satisfied ? 'success' : 'warning'}>{d.satisfied ? 'Satisfied' : 'Open'}</Badge>
              <span className="font-medium text-foreground">{humanize(d.item)}</span>
              <span>{d.detail}</span>
            </li>
          ))}
        </ul>
      </section>
      {handoff && handoff.unresolvedBlockers.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Unresolved blockers</span>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {handoff.unresolvedBlockers.map((b) => (
              <li key={b.caseId}>
                {b.title}: {b.reason ?? 'no reason stated'} {b.failureClass ? `(${humanize(b.failureClass)})` : '(unclassified)'}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}
