import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { RequirementLink } from '@/lib/admin/requirement-links';
import type { RequirementSet } from '@/lib/admin/requirement-set';
import { REQUIREMENT_LINK_TARGET_LABEL } from '@/modules/crm/requirement-link-schema';
import type { RequirementLinkTargetOptions } from '@/modules/crm/requirement-link-types';
import type { RequirementQuestionSend } from '@/modules/crm/requirement-question-queries';
import type { requirementPayloadSchema } from '@/modules/crm/schema';
import { Badge, humanize, statusTone } from '@/ui';

import { RequirementLinkForm } from './requirement-link-form';
import { RequirementQuestionSendForm } from './requirement-question-form';

import type { z } from 'zod';

type Payload = z.infer<typeof requirementPayloadSchema>;

/**
 * The requirement set as a whole — SCR-029.
 *
 * Bucket G-3: the PDF's nine sections drawn as sections, each with its
 * count, an empty one saying "none recorded in v<n>" rather than vanishing:
 * Objectives (every objective, not the summary), User roles, Features
 * (the scope items), Platforms, Integrations, Business rules,
 * Non-functional requirements, Excluded items, Questions. A version written
 * before `businessRules` existed carries `constraints`; it is shown under
 * Business rules with a note saying which version recorded it that way,
 * because the extractor put a rule or a non-functional need there and
 * splitting it by guesswork would be inventing a classification.
 *
 * Then the two actions the PDF names on this screen: "Request client
 * clarification" per question (through `crm.send_requirement_question`,
 * the same outbound chokepoint as every send; the sent question shows when
 * and in which message), and "Link to quotation/design/development task"
 * (`crm.link_requirement`, one row per version and target). "Cited by"
 * stays as the derived, read-only list beside the declared "Linked to".
 */

function Section({
  title,
  items,
  version,
  muted,
  note,
  children,
}: {
  title: string;
  items: readonly string[];
  version: number;
  muted?: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
        <span className="ml-1 font-normal normal-case tracking-normal">({items.length})</span>
        {muted ? <span className="ml-1 font-normal normal-case tracking-normal">— {muted}</span> : null}
      </p>
      {note ? <p className="text-xs text-faint">{note}</p> : null}
      {items.length === 0 && !children ? (
        <p className="text-[13px] text-muted">none recorded in v{version}</p>
      ) : (
        <ul className="flex flex-col gap-0.5 text-[13px]">
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className="flex gap-2">
              <span aria-hidden className="text-faint">
                ·
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

export function RequirementSetPanel({
  payload,
  set,
  clock,
  version,
  versionId,
  leadId,
  status,
  mayWrite,
  questionSends,
  links,
  targets,
}: {
  payload: Payload;
  set: RequirementSet;
  clock: AgencyClock;
  version: number;
  versionId: string;
  leadId: string;
  status: string;
  /** `lead.write` — the roles that may ask the client and declare a link. */
  mayWrite: boolean;
  /** SCR-029 — which of this version's open questions were sent on their own, by index. */
  questionSends: ReadonlyMap<number, RequirementQuestionSend>;
  /** SCR-029 — the links a person declared from this version. */
  links: readonly RequirementLink[];
  /** What the "Link…" form may point at. */
  targets: RequirementLinkTargetOptions;
}) {
  const { links: cited, coverage, questions } = set;
  const openQuestions = questions.filter((q) => q.status === 'open');
  const hasCited = cited.quotations.length > 0 || cited.scopeVersions.length > 0 || cited.breakdown.modules + cited.breakdown.features + cited.breakdown.tasks > 0;
  // A question is asked on a version that still stands; history is not the client's to answer.
  const mayAsk = mayWrite && (status === 'proposed' || status === 'accepted');
  const features = payload.scopeItems.map((s) => (s.detail ? `${s.title} — ${s.detail}` : s.title));
  const businessRules = [...payload.businessRules, ...payload.constraints];
  const constraintsNote = payload.constraints.length > 0 ? `${payload.constraints.length} of these recorded as constraints in v${version}, before business rules had their own section.` : undefined;

  return (
    <details className="mt-2 rounded-md border border-line bg-surface">
      <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">
        The full set
        <span className="ml-2 text-xs font-normal text-muted">
          {coverage && coverage.percent !== null ? `${coverage.percent}% covered · ` : ''}
          {payload.objectives.length} objective{payload.objectives.length === 1 ? '' : 's'} · {features.length} feature{features.length === 1 ? '' : 's'} ·{' '}
          {payload.openQuestions.length} question{payload.openQuestions.length === 1 ? '' : 's'} · {links.length} linked · {cited.quotations.length} quotation
          {cited.quotations.length === 1 ? '' : 's'} · {cited.scopeVersions.length} baseline{cited.scopeVersions.length === 1 ? '' : 's'}
          {openQuestions.length > 0 ? ` · ${openQuestions.length} open on the project` : ''}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-3 py-3">
        {/* ── the nine sections, in the PDF's order ────────────────────── */}
        <Section title="Objectives" items={payload.objectives} version={version} muted="what the client wants to achieve, in full" />
        <Section title="User roles" items={payload.userRoles} version={version} muted="who uses it" />
        <Section title="Features" items={features} version={version} muted="the scope items, as the client said them" />
        <Section title="Platforms" items={payload.platforms} version={version} muted="where it runs" />
        <Section title="Integrations" items={payload.integrations} version={version} muted="what it must talk to" />
        <Section title="Business rules" items={businessRules} version={version} muted="what it must respect" note={constraintsNote} />
        <Section title="Non-functional requirements" items={payload.nonFunctionalRequirements} version={version} muted="performance, security, availability" />
        <Section title="Excluded items" items={payload.exclusions} version={version} muted="ruled out, in the client's words" />
        <Section title="Questions" items={[]} version={version} muted="still open in this version">
          {payload.openQuestions.length === 0 ? (
            <p className="text-[13px] text-muted">none recorded in v{version}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {payload.openQuestions.map((q, i) => {
                const sent = questionSends.get(i);
                return (
                  <li key={`${i}-${q}`} className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5">
                    <span className="flex gap-2">
                      <span aria-hidden className="text-faint">
                        {i + 1}.
                      </span>
                      <span>{q}</span>
                    </span>
                    {sent ? (
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <Badge tone="info">sent to client</Badge>
                        <a href={`#message-${sent.messageId}`} className="underline underline-offset-2 hover:text-foreground">
                          {clock.dateTime(sent.sentAt)} — on this conversation
                        </a>
                        <span>Their answer is on the thread; nothing here reads it for you.</span>
                      </span>
                    ) : mayAsk ? (
                      <RequirementQuestionSendForm versionId={versionId} leadId={leadId} questionIndex={i} question={q} />
                    ) : (
                      <span className="text-xs text-faint">not yet asked</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* ── the rest of the payload, for completeness ────────────────── */}
        {payload.assumptions.length + payload.niceToHaves.length + payload.designReferences.length > 0 || payload.timelineBudgetNotes ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {payload.assumptions.length > 0 ? <Section title="Assumptions" items={payload.assumptions} version={version} muted="not confirmed by the client" /> : null}
            {payload.niceToHaves.length > 0 ? <Section title="Nice to have" items={payload.niceToHaves} version={version} muted="not committed scope" /> : null}
            {payload.designReferences.length > 0 ? <Section title="Design references" items={payload.designReferences} version={version} /> : null}
            {payload.timelineBudgetNotes ? (
              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Timeline and budget notes<span className="ml-1 font-normal normal-case tracking-normal">— in the client&rsquo;s words</span>
                </p>
                <p className="whitespace-pre-wrap text-[13px]">{payload.timelineBudgetNotes}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── coverage ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Coverage</p>
          {!coverage ? (
            <p className="text-[13px] text-muted">No scope baseline cites this version yet, so there is nothing to measure screens or tests against.</p>
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
                : {coverage.withScreen} of {coverage.includedItems} items mapped to a screen, {coverage.withTest} of {coverage.includedItems} in the test plan.
              </p>
            </div>
          )}
        </div>

        {/* ── the PM Agent's questions on the linked project ───────────── */}
        {questions.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Questions raised on the project</p>
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

        {/* ── linked to: what a person declared ────────────────────────── */}
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Linked to<span className="ml-1 font-normal normal-case tracking-normal">({links.length}) — declared by a person, audited</span>
          </p>
          {links.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing linked to this version yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {links.map((l) => {
                const href = l.targetType === 'quotation' ? `/quotations?status=${encodeURIComponent(l.status ?? '')}` : l.targetType === 'design' ? (l.projectId ? `/projects/${l.projectId}/design` : null) : l.projectId ? `/projects/${l.projectId}/development` : null;
                const label = `${l.title ?? `${REQUIREMENT_LINK_TARGET_LABEL[l.targetType]} ${l.targetId.slice(0, 8)}`}${l.version !== null ? ` v${l.version}` : ''}`;
                return (
                  <li key={l.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">{REQUIREMENT_LINK_TARGET_LABEL[l.targetType]}</span>
                    {href ? (
                      <Link href={href} className="underline underline-offset-2">
                        {label}
                      </Link>
                    ) : (
                      <span>{label}</span>
                    )}
                    {l.status ? <Badge tone={statusTone(l.status)}>{humanize(l.status)}</Badge> : <Badge tone="neutral">not readable</Badge>}
                    {l.note ? <span className="text-xs text-muted">— {l.note}</span> : null}
                    <span className="text-xs text-faint">{clock.dateTime(l.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {mayWrite ? <RequirementLinkForm versionId={versionId} leadId={leadId} targets={targets} /> : null}
        </div>

        {/* ── cited by: what the foreign keys say ─────────────────────── */}
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Cited by<span className="ml-1 font-normal normal-case tracking-normal">— derived, read-only</span>
          </p>
          {!hasCited ? (
            <p className="text-[13px] text-muted">Nothing downstream cites this version yet — no quotation, no scope baseline, no development breakdown.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {cited.quotations.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">Quotation</span>
                  <Link href={`/quotations?status=${encodeURIComponent(q.status)}`} className="underline underline-offset-2">
                    {q.title} v{q.version}
                  </Link>
                  <Badge tone={statusTone(q.status)}>{humanize(q.status)}</Badge>
                </li>
              ))}
              {cited.scopeVersions.map((v) => (
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
              {cited.breakdown.modules + cited.breakdown.features + cited.breakdown.tasks > 0 ? (
                <li className="text-muted">
                  Development breakdown: {cited.breakdown.modules} module{cited.breakdown.modules === 1 ? '' : 's'}, {cited.breakdown.features} feature
                  {cited.breakdown.features === 1 ? '' : 's'}, {cited.breakdown.tasks} task{cited.breakdown.tasks === 1 ? '' : 's'} cite it.
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
