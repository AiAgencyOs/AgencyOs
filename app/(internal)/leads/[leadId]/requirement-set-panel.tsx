import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { RequirementSet } from '@/lib/admin/requirement-set';
import type { requirementPayloadSchema } from '@/modules/crm/schema';
import { Badge, humanize, statusTone } from '@/ui';

import type { z } from 'zod';

type Payload = z.infer<typeof requirementPayloadSchema>;

/**
 * The requirement set as a whole — SCR-029. The lead page already showed
 * the summary and the scope-item titles, then folded everything else in the
 * payload to a count ("3 assumptions"). This spells the rest out: what the
 * client ruled out, what was assumed on their behalf, what is nice-to-have,
 * what they pointed at, what is still open — and then what downstream has
 * done with the version: which quotation prices it, which baseline froze
 * it, how far the baseline has been carried into screens and a test plan,
 * and which of the PM Agent's questions are still unanswered on that
 * project.
 *
 * The payload has no `objectives`, `businessRules` or `nonFunctional` keys
 * (`requirementPayloadSchema` is the whole vocabulary), so those sections
 * are not drawn — the extractor records `constraints`, which is where a
 * rule or a non-functional need lands, and it is labelled as such rather
 * than split three ways by guesswork.
 */

function List({ title, items, muted }: { title: string; items: readonly string[]; muted?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
        {muted ? <span className="ml-1 font-normal normal-case tracking-normal">— {muted}</span> : null}
      </p>
      <ul className="flex flex-col gap-0.5 text-[13px]">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RequirementSetPanel({
  payload,
  set,
  clock,
}: {
  payload: Payload;
  set: RequirementSet;
  clock: AgencyClock;
}) {
  const { links, coverage, questions } = set;
  const openQuestions = questions.filter((q) => q.status === 'open');
  const hasLinks =
    links.quotations.length > 0 ||
    links.scopeVersions.length > 0 ||
    links.breakdown.modules + links.breakdown.features + links.breakdown.tasks > 0;

  return (
    <details className="mt-2 rounded-md border border-line bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">
        The full set
        <span className="ml-2 text-xs font-normal text-muted">
          {coverage && coverage.percent !== null ? `${coverage.percent}% covered · ` : ''}
          {links.quotations.length} quotation{links.quotations.length === 1 ? '' : 's'} ·{' '}
          {links.scopeVersions.length} baseline{links.scopeVersions.length === 1 ? '' : 's'}
          {openQuestions.length > 0 ? ` · ${openQuestions.length} open question${openQuestions.length === 1 ? '' : 's'}` : ''}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-3 py-3">
        {/* SCR-009 (bucket F-B) — the four fields the PDF lists as part of the
            versioned requirement: who uses it, on what, what it talks to,
            and what the client said about time and money. Drawn from the
            payload itself, never from coverage quotes. */}
        <List title="User roles" items={payload.userRoles} muted="who uses it" />
        <List title="Platforms" items={payload.platforms} muted="where it runs" />
        <List title="Integrations" items={payload.integrations} muted="what it must talk to" />
        {payload.timelineBudgetNotes ? (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Timeline and budget notes<span className="ml-1 font-normal normal-case tracking-normal">— in the client&rsquo;s words</span>
            </p>
            <p className="whitespace-pre-wrap text-[13px]">{payload.timelineBudgetNotes}</p>
          </div>
        ) : null}
        {payload.userRoles.length + payload.platforms.length + payload.integrations.length === 0 && !payload.timelineBudgetNotes ? (
          <p className="text-[13px] text-muted">No user roles, platforms, integrations or timeline/budget notes recorded on this version — edit it as a new version to add them.</p>
        ) : null}
        <List title="Constraints and rules" items={payload.constraints} muted="what it must respect" />
        <List title="Excluded" items={payload.exclusions} muted="ruled out, in the client's words" />
        <List title="Assumptions" items={payload.assumptions} muted="not confirmed by the client" />
        <List title="Nice to have" items={payload.niceToHaves} muted="not committed scope" />
        <List title="Design references" items={payload.designReferences} />
        <List title="Open questions in the requirement" items={payload.openQuestions} />

        {/* ── coverage ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Coverage</p>
          {!coverage ? (
            <p className="text-[13px] text-muted">
              No scope baseline cites this version yet, so there is nothing to measure screens or tests against.
            </p>
          ) : coverage.percent === null ? (
            <p className="text-[13px] text-muted">
              Baseline v{coverage.scopeVersion} on {coverage.projectName} has no included item yet.
            </p>
          ) : (
            <div className="flex flex-col gap-1 text-[13px]">
              <div
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={coverage.percent}
                aria-label="Coverage of included scope items"
                className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-surface-sunken"
              >
                <div className="h-full rounded-full bg-brand" style={{ width: `${coverage.percent}%` }} />
              </div>
              <p>{coverage.percent}% of included items have both a screen and a test-plan item.</p>
              <p className="text-muted">
                Baseline v{coverage.scopeVersion} on{' '}
                <Link href={`/projects/${coverage.projectId}/scope`} className="underline underline-offset-2">
                  {coverage.projectName}
                </Link>
                : {coverage.withScreen} of {coverage.includedItems} items mapped to a screen, {coverage.withTest} of{' '}
                {coverage.includedItems} in the test plan.
              </p>
            </div>
          )}
        </div>

        {/* ── the PM Agent's questions on the linked project ───────────── */}
        {questions.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Questions raised on the project
            </p>
            <ul className="flex flex-col gap-1 text-[13px]">
              {questions.map((q) => (
                <li key={q.id} className="flex flex-col gap-0.5 rounded-md border border-line px-2 py-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={q.status === 'open' ? 'warning' : 'success'}>{q.status}</Badge>
                    <span className="text-xs text-muted">{clock.dateTime(q.createdAt)}</span>
                  </span>
                  <span>{q.question}</span>
                  {q.answer ? <span className="text-muted">Answer: {q.answer}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* ── what cites this version ──────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Cited by</p>
          {!hasLinks ? (
            <p className="text-[13px] text-muted">
              Nothing downstream cites this version yet — no quotation, no scope baseline, no development breakdown.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {links.quotations.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">Quotation</span>
                  <Link href={`/quotations?status=${encodeURIComponent(q.status)}`} className="underline underline-offset-2">
                    {q.title} v{q.version}
                  </Link>
                  <Badge tone={statusTone(q.status)}>{humanize(q.status)}</Badge>
                </li>
              ))}
              {links.scopeVersions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">Scope baseline</span>
                  <Link href={`/projects/${v.projectId}/scope`} className="underline underline-offset-2">
                    {v.projectName} v{v.version}
                  </Link>
                  <Badge tone={statusTone(v.status)}>{humanize(v.status)}</Badge>
                  <Link href={`/projects/${v.projectId}/design`} className="text-xs text-muted underline underline-offset-2">
                    design
                  </Link>
                  <Link href={`/projects/${v.projectId}/development`} className="text-xs text-muted underline underline-offset-2">
                    tasks
                  </Link>
                </li>
              ))}
              {links.breakdown.modules + links.breakdown.features + links.breakdown.tasks > 0 ? (
                <li className="text-muted">
                  Development breakdown: {links.breakdown.modules} module{links.breakdown.modules === 1 ? '' : 's'},{' '}
                  {links.breakdown.features} feature{links.breakdown.features === 1 ? '' : 's'}, {links.breakdown.tasks} task
                  {links.breakdown.tasks === 1 ? '' : 's'} cite it.
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
