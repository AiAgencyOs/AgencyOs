'use client';

import { useActionState } from 'react';

import {
  activateProjectPlanAction,
  addPlanDeliverableAction,
  addPlanDependencyAction,
  addPlanMilestoneAction,
  addPlanNoteAction,
  answerClarificationAction,
  draftProjectPlanAction,
  raiseClarificationAction,
  resolveClarificationAction,
} from '@/modules/projects/actions';
import { PLAN_MILESTONE_KINDS, PLAN_PHASES } from '@/modules/projects/plan-vocabulary';
import type { PlanBoard } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * Making an operational plan — Project Planning §7; G-274.
 *
 * G-256, G-257, G-262 and G-265 built the whole blueprint — deliverables,
 * dependencies, milestones, risks, the clarification loop and a validator —
 * and **nothing ever called any of it**. `planning.ts` had no caller at all,
 * so a project plan could not be created in the product: the operational
 * blueprint existed only for somebody with database access.
 *
 * Three things these forms refuse to do.
 *
 * **They do not offer free text where the specification closed a vocabulary.**
 * Phases and milestone kinds come from `plan-vocabulary.ts`, so an eighth
 * phase cannot be typed into a plan.
 *
 * **They do not let a deliverable name scope by hand.** §8 requires every
 * deliverable to reference approved scope, and the choices are this plan's own
 * scope version — a text box invites the wrong UUID, and G-256's foreign key
 * would then refuse it with a message about a constraint.
 *
 * **They do not pre-judge activation.** The validator runs in the database
 * (G-265) and its findings come back as the refusal. Nothing here decides
 * whether a plan is ready; a client-side copy would disagree with the database
 * the moment somebody added a deliverable in another tab.
 */

const field = 'rounded-md border border-line bg-surface px-2 py-1 text-[13px]';
const label = 'flex flex-col gap-1 text-[13px]';
const hint = 'text-xs text-muted';

function Feedback({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'error') return <span className="text-[13px] text-danger">{state.message}</span>;
  if (state.status === 'success') return <span className="text-[13px] text-muted">{state.message}</span>;
  return null;
}

export function DraftPlanForm({ projectId, hasPlan }: { projectId: string; hasPlan: boolean }) {
  const [state, action, pending] = useActionState(draftProjectPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className={label}>
        <span className={hint}>The approved objective, in the client’s terms</span>
        <input name="objective" className={field} placeholder="Ship the storefront and the admin console" />
      </label>
      {hasPlan ? (
        <label className={label}>
          {/*
            §15: "track why a version changed and which approved source caused
            the change", and "do not silently rewrite historical plans." From
            v2 the door requires this, so the form asks for it.
          */}
          <span className={hint}>Why a new version — required from v2</span>
          <input name="changeReason" className={field} placeholder="Client approved the extra module" />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Opening…' : hasPlan ? 'Open the next version' : 'Start the operational plan'}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AddDeliverableForm({
  projectId,
  planId,
  scopeItems,
}: {
  projectId: string;
  planId: string;
  scopeItems: PlanBoard['scopeItems'];
}) {
  const [state, action, pending] = useActionState(addPlanDeliverableAction, IDLE_STATE);
  const included = scopeItems.filter((item) => item.inclusion === 'included');

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-wrap gap-2">
        <label className={label}>
          <span className={hint}>Deliverable</span>
          <input name="name" required className={field} />
        </label>
        <label className={label}>
          <span className={hint}>Phase</span>
          <select name="applicablePhase" required className={field} defaultValue="">
            <option value="" disabled>
              choose
            </option>
            {PLAN_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase.replace('_', ' ')}
              </option>
            ))}
            <option value="not_applicable">not applicable</option>
          </select>
        </label>
        <label className={label}>
          {/*
            §8, and G-256's constraint: a deliverable references approved scope
            or an approved proposal item. Only INCLUDED items are offered —
            excluded scope is not work, and G-265 does not expect a deliverable
            for it.
          */}
          <span className={hint}>Approved scope it comes from</span>
          <select name="scopeItemId" className={field} defaultValue="">
            <option value="">— none yet —</option>
            {included.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className={hint}>Owner role</span>
          <input name="ownerRole" className={field} placeholder="project_manager" />
        </label>
      </div>
      <label className={label}>
        <span className={hint}>Readiness criteria — how anybody knows this is done</span>
        <input name="readinessCriteria" required className={field} />
      </label>
      <label className={label}>
        <span className={hint}>Evidence required — what gets shown as proof</span>
        <input name="evidenceRequired" required className={field} />
      </label>
      <label className={label}>
        {/*
          §5: "must not convert an ambiguous requirement into an invented
          requirement." Where the scope is unclear, this records THAT rather
          than a guess, and G-265 refuses a `not_applicable` deliverable with
          no note.
        */}
        <span className={hint}>Anything unclear about it (optional)</span>
        <input name="ambiguityNote" className={field} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          {pending ? 'Adding…' : 'Add deliverable'}
        </button>
        {included.length === 0 ? (
          <span className={hint}>No approved scope on this plan’s version — a deliverable can still be added without one.</span>
        ) : null}
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AddMilestoneForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(addPlanMilestoneAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-wrap gap-2">
        <label className={label}>
          <span className={hint}>Milestone</span>
          <input name="name" required className={field} />
        </label>
        <label className={label}>
          {/* §7's three maps. A fourth kind would be a lifecycle invented here. */}
          <span className={hint}>Kind</span>
          <select name="kind" required className={field} defaultValue="operational">
            {PLAN_MILESTONE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className={hint}>Phase</span>
          <select name="phase" required className={field} defaultValue="">
            <option value="" disabled>
              choose
            </option>
            {PLAN_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={label}>
        <span className={hint}>Gate criteria — what must be true to pass it</span>
        <input name="gateCriteria" required className={field} />
      </label>
      <div className="flex flex-wrap gap-2">
        <label className={label}>
          <span className={hint}>Window start</span>
          <input type="date" name="windowStart" className={field} />
        </label>
        <label className={label}>
          <span className={hint}>Window end</span>
          <input type="date" name="windowEnd" className={field} />
        </label>
        <label className={label}>
          {/*
            §5: "must not promise dates that are not supported by approved
            commitments/planning assumptions." A dated window carries its
            basis, and the door refuses a date without one.
          */}
          <span className={hint}>What the dates rest on — required if dated</span>
          <input name="timingBasis" className={field} placeholder="client approved the start date on 12 Sep" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          {pending ? 'Adding…' : 'Add milestone'}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AddDependencyForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(addPlanDependencyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-wrap gap-2">
        <label className={label}>
          {/* §9's six kinds, closed by the door's own check. */}
          <span className={hint}>Kind</span>
          <select name="kind" required className={field} defaultValue="client">
            {['client', 'internal', 'external_provider', 'approval', 'timeline', 'other'].map((kind) => (
              <option key={kind} value={kind}>
                {kind.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className={hint}>Needed by phase</span>
          <select name="neededByPhase" required className={field} defaultValue="">
            <option value="" disabled>
              choose
            </option>
            {PLAN_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className={hint}>Owner role</span>
          <input name="ownerRole" required className={field} placeholder="client" />
        </label>
      </div>
      <label className={label}>
        <span className={hint}>What is needed</span>
        <input name="description" required className={field} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          {pending ? 'Recording…' : 'Record dependency'}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AddNoteForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(addPlanNoteAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <label className={label}>
        <span className={hint}>Kind</span>
        <select name="kind" className={field} defaultValue="risk">
          <option value="risk">risk</option>
          <option value="assumption">assumption</option>
        </select>
      </label>
      <label className={`${label} grow`}>
        <span className={hint}>Statement</span>
        <input name="statement" required className={field} />
      </label>
      <label className={label}>
        {/* §4.7: "assign owner/escalation path WHERE KNOWN" — so optional. */}
        <span className={hint}>Owner (optional)</span>
        <input name="ownerRole" className={field} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        {pending ? 'Recording…' : 'Record'}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function RaiseClarificationForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(raiseClarificationAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <label className={label}>
        <span className={hint}>The question — asked, not guessed (§10)</span>
        <input name="question" required className={field} />
      </label>
      <label className={label}>
        <span className={hint}>What it affects if the answer goes either way</span>
        <input name="impact" required className={field} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          {pending ? 'Raising…' : 'Raise a question'}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function ClarificationRow({
  projectId,
  clarification,
}: {
  projectId: string;
  clarification: PlanBoard['clarifications'][number];
}) {
  const [answerState, answerAction, answering] = useActionState(answerClarificationAction, IDLE_STATE);
  const [resolveState, resolveAction, resolving] = useActionState(resolveClarificationAction, IDLE_STATE);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{clarification.question}</span>
        <span className="text-muted">{clarification.status.replace(/_/g, ' ')}</span>
      </div>
      {clarification.answer ? <p className="text-muted">{clarification.answer}</p> : null}

      {clarification.status === 'answered' ? (
        <form action={resolveAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="clarificationId" value={clarification.id} />
          <button type="submit" disabled={resolving} className={buttonClass('secondary', 'sm')}>
            {resolving ? 'Settling…' : 'Settle it'}
          </button>
          <Feedback state={resolveState} />
        </form>
      ) : clarification.status === 'resolved' || clarification.status === 'routed_to_change_request' ? null : (
        <form action={answerAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="clarificationId" value={clarification.id} />
          <label className={`${label} grow`}>
            <span className={hint}>What the client said</span>
            <input name="answer" required className={field} />
          </label>
          <label className={label}>
            <span className={hint}>Where they said it</span>
            <input name="answeredVia" required className={field} placeholder="WhatsApp, 14 Sep" />
          </label>
          <button type="submit" disabled={answering} className={buttonClass('secondary', 'sm')}>
            {answering ? 'Recording…' : 'Record the answer'}
          </button>
          <Feedback state={answerState} />
        </form>
      )}
    </li>
  );
}

export function ActivatePlanForm({ projectId, planId }: { projectId: string; planId: string }) {
  const [state, action, pending] = useActionState(activateProjectPlanAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="planId" value={planId} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Validating…' : 'Validate and activate'}
        </button>
        {/*
          The validator runs in the database (G-265) and the findings come back
          as the refusal. Nothing here decides whether the plan is ready — a
          client-side copy would disagree with the database the moment somebody
          added a deliverable in another tab.
        */}
        <Feedback state={state} />
      </div>
    </form>
  );
}
