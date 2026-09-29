import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listEligibleMilestones } from '@/modules/finance/eligible-milestones-queries';
import { getProject, listPaymentPlan, readPlanBoard } from '@/modules/projects/queries';
import { Badge, PageHeader, StatusBadge, type Tone } from '@/ui';

import { ProjectSubNav } from '../project-subnav';

import {
  ActivatePlanForm,
  AddDependencyForm,
  AddDeliverableForm,
  AddMilestoneForm,
  AddNoteForm,
  ClarificationRow,
  GateMilestoneForm,
  DraftPlanForm,
  RaiseClarificationForm,
} from './plan-forms';
import { MarkMilestoneMetForm, TriggerFinanceMilestoneForm } from './milestone-forms';

export const metadata: Metadata = { title: 'Operational plan' };

/**
 * The Operational Project Blueprint — Project Planning §7; G-274.
 *
 * G-256 built the plan, G-257 the clarification loop, G-262 the milestone map,
 * G-265 the validator — and **nothing called any of it.** `planning.ts` had no
 * caller anywhere in `src` or `app`, so a project plan could not be created in
 * this product at all: G-263's Phase 2 panel read plan *counts* off a plan
 * only a database client could have made.
 *
 * §7 asks for eighteen registers. This page is six of them plus the doors that
 * fill them — identity, objective, scope reference, deliverables, milestones,
 * dependencies, risks and assumptions, open clarifications, version and
 * status. The rest are derived or belong to Phase 3.
 *
 * **Its own page rather than another panel on the project.** The project page
 * is already a status board, a payment plan, an onboarding checklist, a group
 * card and a billing ladder; the blueprint is a working surface somebody sits
 * with, and nesting it would make both worse.
 */

const PHASE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  active: 'success',
  superseded: 'neutral',
};

export default async function ProjectPlanPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const context = await requireInternal(`/projects/${projectId}/plan`);
  if (!can(context.role, 'project.read')) redirect('/dashboard');

  const project = await getProject(projectId);
  if (!project) notFound();

  const [board, paymentPlan, eligible, clock] = await Promise.all([
    readPlanBoard(projectId),
    listPaymentPlan(projectId),
    listEligibleMilestones([projectId]),
    agencyClock(),
  ]);
  // Planning is project work, so it takes the same capability that changes a
  // project. The doors check it again — this only decides what to render.
  const mayPlan = can(context.role, 'project.write');
  // SCR-023: the payment milestones' two doors, gated the way their services are.
  const mayMarkMet = can(context.role, 'milestone.write');
  const mayInvoice = can(context.role, 'invoice.create');
  const nextToBill = eligible[0] ?? null;
  const { plan } = board;
  const openQuestions = board.clarifications.filter(
    (c) => c.status !== 'resolved' && c.status !== 'routed_to_change_request',
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Operational plan"
        description={`${project.name} — the blueprint Phase 2 hands to Phase 3.`}
      />

      <ProjectSubNav projectId={projectId} />

      <p className="max-w-2xl text-[13px] text-muted">
        Operational, never technical. Tables, APIs, coding tasks and UI belong to the Phase 5
        Development Planning Agent, and there is nowhere here to put them (Project Planning §5, §6).{' '}
        <Link href={`/projects/${projectId}`} className="underline hover:text-fg">
          Back to the project
        </Link>
        .
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Payment milestones <span className="text-muted">({paymentPlan.length})</span>
        </h2>
        <p className="max-w-2xl text-[13px] text-muted">
          The project’s payment plan. A milestone unlocks when the stage before it is paid; marking it
          met records the moment delivery was complete and freezes the plan. The next one to bill is
          the first priced milestone not yet paid for.
        </p>
        {paymentPlan.length === 0 ? (
          <p className="text-[13px] text-muted">
            No payment plan yet — it is configured on{' '}
            <Link href={`/projects/${projectId}#billing`} className="underline hover:text-fg">
              the project page
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {paymentPlan.map((m) => {
              const isNext = nextToBill?.milestoneId === m.id;
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.name}</span>
                      <StatusBadge status={m.status} />
                      {isNext ? <Badge tone="brand">next to bill</Badge> : null}
                    </span>
                    <span className="text-muted">
                      {m.payment_percent !== null ? `${Number(m.payment_percent)}% · ` : 'unpriced · '}
                      {m.due_on ? `due ${clock.date(`${m.due_on}T00:00:00`)}` : 'no due date'}
                      {m.met_at ? ` · met ${clock.dateTime(m.met_at)}` : ''}
                      {isNext && nextToBill?.reason ? ` · ${nextToBill.reason}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {mayMarkMet && (m.status === 'in_progress' || m.status === 'submitted') ? (
                      <MarkMilestoneMetForm projectId={projectId} milestoneId={m.id} />
                    ) : null}
                    {isNext && nextToBill?.eligible ? (
                      mayInvoice ? (
                        <TriggerFinanceMilestoneForm projectId={projectId} milestoneId={m.id} />
                      ) : (
                        <span className="text-xs text-muted">No permission to raise invoices.</span>
                      )
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!plan ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-semibold tracking-tight">No plan yet</h2>
          <p className="max-w-2xl text-[13px] text-muted">
            Nothing has been planned for this project. A plan is versioned from the moment it opens,
            and the kickoff gate waits on one being active.
          </p>
          {mayPlan ? (
            <DraftPlanForm projectId={projectId} hasPlan={false} />
          ) : (
            <p className="text-[13px] text-muted">You do not have permission to plan this project.</p>
          )}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Version {plan.version}
              </h2>
              <Badge tone={PHASE_TONE[plan.status] ?? 'neutral'}>{plan.status}</Badge>
            </div>
            {plan.objective ? (
              <p className="max-w-2xl text-[13px]">{plan.objective}</p>
            ) : (
              <p className="max-w-2xl text-[13px] text-muted">No objective recorded.</p>
            )}
            {plan.status === 'draft' && mayPlan ? (
              <ActivatePlanForm projectId={projectId} planId={plan.id} />
            ) : null}
            {plan.status === 'active' && mayPlan ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer text-muted">Open the next version</summary>
                <div className="pt-2">
                  <DraftPlanForm projectId={projectId} hasPlan />
                </div>
              </details>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Deliverables <span className="text-muted">({board.deliverables.length})</span>
            </h2>
            {board.deliverables.length === 0 ? (
              <p className="text-[13px] text-muted">
                None yet. A plan with no deliverables cannot go live.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.deliverables.map((d) => (
                  <li key={d.id} className="flex flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{d.name}</span>
                      <span className="text-muted">
                        {d.applicablePhase.replace('_', ' ')} · {d.status}
                        {d.ownerRole ? ` · ${d.ownerRole}` : ''}
                      </span>
                    </div>
                    <p className="text-muted">Ready when: {d.readinessCriteria}</p>
                    <p className="text-muted">Evidence: {d.evidenceRequired}</p>
                    {d.ambiguityNote ? (
                      <p className="text-fg">Unclear: {d.ambiguityNote}</p>
                    ) : null}
                    {!d.scopeItemId ? (
                      <p className="text-muted">
                        Not linked to approved scope — validation will flag it.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddDeliverableForm projectId={projectId} planId={plan.id} scopeItems={board.scopeItems} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Milestones <span className="text-muted">({board.milestones.length})</span>
            </h2>
            {board.milestones.length === 0 ? (
              <p className="text-[13px] text-muted">No milestone map yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.milestones.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span>
                      <span className="font-medium">{m.name}</span>{' '}
                      <span className="text-muted">— {m.gateCriteria}</span>
                    </span>
                    <span className="text-muted">
                      {m.kind.replace('_', ' ')} · {m.phase.replace('_', ' ')} · {m.status}
                    </span>
                    {(() => {
                      // §15: which dependency gates which milestone. Shown as
                      // the dependency's own words rather than an id, because
                      // "waits on the client's brand assets" is the fact and
                      // a UUID is a lookup.
                      const gated = board.gates
                        .filter((g) => g.milestoneId === m.id)
                        .map((g) => board.dependencies.find((d) => d.id === g.dependencyId))
                        .filter((d) => d !== undefined);
                      return gated.length === 0 ? null : (
                        <span className="w-full text-muted">
                          Waits on: {gated.map((d) => d.description).join('; ')}
                        </span>
                      );
                    })()}
                    {mayPlan && plan.status === 'draft' ? (
                      <GateMilestoneForm
                        projectId={projectId}
                        milestone={m}
                        dependencies={board.dependencies}
                        gatedDependencyIds={board.gates
                          .filter((g) => g.milestoneId === m.id)
                          .map((g) => g.dependencyId)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddMilestoneForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Dependencies <span className="text-muted">({board.dependencies.length})</span>
            </h2>
            {board.dependencies.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing recorded as waited on.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.dependencies.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span className="font-medium">{d.description}</span>
                    <span className="text-muted">
                      {d.kind.replace('_', ' ')} · by {d.neededByPhase.replace('_', ' ')} · {d.ownerRole} ·{' '}
                      {d.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddDependencyForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Risks and assumptions <span className="text-muted">({board.notes.length})</span>
            </h2>
            {board.notes.length === 0 ? (
              <p className="text-[13px] text-muted">Nothing on the register.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {board.notes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-line p-3 text-[13px]">
                    <span>{n.statement}</span>
                    <span className="text-muted">
                      {n.kind}
                      {n.ownerRole ? ` · ${n.ownerRole}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {mayPlan && plan.status === 'draft' ? (
              <AddNoteForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Open questions <span className="text-muted">({openQuestions.length})</span>
            </h2>
            <p className="max-w-2xl text-[13px] text-muted">
              §10: the plan never guesses an unclear requirement. A plan cannot be activated while a
              question is unsettled.
            </p>
            {board.clarifications.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {board.clarifications.map((c) => (
                  <ClarificationRow
                    key={c.id}
                    projectId={projectId}
                    clarification={c}
                    changeRequests={board.changeRequests}
                  />
                ))}
              </ul>
            ) : null}
            {mayPlan && plan.status === 'draft' ? (
              <RaiseClarificationForm projectId={projectId} planId={plan.id} />
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
