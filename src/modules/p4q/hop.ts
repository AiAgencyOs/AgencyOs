import type { createAdminClient } from '@/lib/db/admin';
import { HANDLER_JOB_KIND } from '@/lib/events/catalog';
import type { HandlerResult } from '@/modules/projects/handlers';

import { runWithEnvelope, type EnvelopeInput } from './envelope';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * W-O2 (P4-ORCH-019/025/026/035): the live dispatch of a Phase 4 hop runs inside its persisted ExecutionEnvelope.
 *
 * `runWithEnvelope` existed, tested, with no caller. This is the caller: one table of which handler is which Phase 4 task type (the same pairs as the
 * `projects.p4q_task_types` rows, drift-tested against them), and the one function the two dispatch paths in `app/api/jobs/run/route.ts` call around the work
 * they were already doing:
 *
 *   - `runEventJobs`      (handlers that are drained as event jobs), and
 *   - `runOneAgentJob`    (agent workflows that call a model).
 *
 * Nothing about the work changes. The envelope adds what the work never had: the exact references it ran on, a retry budget, a classed failure, an
 * escalation for a person when the budget is spent or the specialist is disabled, and one joined trace. A hop whose references cannot be read from its event,
 * or that the envelope door cannot take, runs exactly as it did before (and says so in the log); a disabled specialist is never bypassed.
 */
export const PHASE_FOUR_TASK_TYPES: Readonly<Record<string, string>> = {
  'orchestrator:routeTask2Design': 'phase_four.route_task2_design',
  'ui_designer:draftUIVersion': 'ui.draft',
  'quality_assurance:reviewUIVersion': 'ui.qa_review',
  'orchestrator:requestUIVersionAdminReview': 'ui.admin_review_request',
  'ui_designer:reviseUIVersion': 'ui.revise',
  'project_manager:classifyClientFeedback': 'ui.feedback_classify',
  'ui_prototype:build': 'prototype.build',
  'quality_assurance:reviewPrototypeBuild': 'prototype.qa_review',
  'ui_prototype:reviseBuild': 'prototype.revise',
  'projects:completePhaseFourOnPrototypeApproval': 'phase_four.complete',
  'finance:generateM2Invoice': 'finance.m2_invoice',
};

/** job kind -> task type, built from the catalog so the two tables cannot drift apart silently. */
export function taskTypeForJobKind(kind: string): string | null {
  for (const [handler, taskType] of Object.entries(PHASE_FOUR_TASK_TYPES)) {
    if ((HANDLER_JOB_KIND as Record<string, string>)[handler] === kind) return taskType;
  }
  return null;
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** What the subject of an event is, in the envelope door's vocabulary of exact reference keys. */
const SUBJECT_REF_KEY: Readonly<Record<string, string>> = {
  ui_version: 'uiVersionId',
  prototype_artifact: 'artifactId',
  deliverable: 'deliverableId',
  phase_four: 'phaseFourId',
  ui_version_client_decision: 'decisionId',
  milestone: 'milestoneId',
};

type HopJob = { id: string; payload: unknown };

/**
 * The envelope input a job's own event supports, or null when it does not name a project and at least one exact reference (then the hop runs as before).
 * References are only ever ids the event itself carries: never "latest", never an id looked up by guesswork.
 */
export function envelopeInputFor(job: HopJob, taskType: string): EnvelopeInput | null {
  const payload = (job.payload ?? {}) as { subjectType?: unknown; subjectId?: unknown; event?: Record<string, unknown> | null };
  const event = (payload.event ?? {}) as Record<string, unknown>;
  const projectId = event.projectId;
  if (!isUuid(projectId)) return null;
  const refs: Record<string, string> = {};
  if (isUuid(event.phaseFourId)) refs.phaseFourId = event.phaseFourId;
  if (isUuid(event.uiVersionId)) refs.uiVersionId = event.uiVersionId;
  if (typeof payload.subjectType === 'string' && isUuid(payload.subjectId)) {
    const key = SUBJECT_REF_KEY[payload.subjectType];
    if (key) refs[key] = payload.subjectId;
  }
  if (Object.keys(refs).length === 0) return null;
  return { projectId, taskType, exactRefs: refs, idempotencyKey: job.id };
}

/** The event-job path: `work` is the handler call the runner was already making. */
export async function runPhaseFourHop(admin: Admin, kind: string, job: HopJob, work: () => Promise<HandlerResult>): Promise<HandlerResult> {
  const taskType = taskTypeForJobKind(kind);
  const input = taskType ? envelopeInputFor(job, taskType) : null;
  if (!input) return work();
  return runWithEnvelope(admin, input, work, { onUnopenable: 'run_unwrapped' });
}

type WorkflowOutcome = { status: string; reason?: unknown; detail?: unknown; [key: string]: unknown };

/**
 * The workflow path: `run` is the workflow call the runner was already making; its outcome is returned unchanged unless the envelope spent its budget, in
 * which case `park` settles the job (dead, with the reason) so the escalation a person now holds is not also retried by the queue.
 */
export async function runPhaseFourWorkflowHop<T extends WorkflowOutcome>(
  admin: Admin,
  job: HopJob & { kind: string },
  run: () => Promise<T>,
  park: (detail: string) => Promise<void>,
): Promise<T | { status: 'failed'; reason: string; detail: string }> {
  const taskType = taskTypeForJobKind(job.kind);
  const input = taskType ? envelopeInputFor(job, taskType) : null;
  if (!input) return run();

  const held: { raw: T | null } = { raw: null };
  const wrapped = await runWithEnvelope(
    admin,
    input,
    async () => {
      const outcome = await run();
      held.raw = outcome;
      if (outcome.status === 'succeeded') return { status: 'succeeded', outcome: String(outcome.outcome ?? 'ok'), detail: String(outcome.reason ?? '') };
      return { status: 'failed', permanent: false, detail: String(outcome.detail ?? outcome.reason ?? 'the workflow failed') };
    },
    { onUnopenable: 'run_unwrapped' },
  );

  const raw = held.raw;
  if (raw === null) {
    // The work never ran: the specialist is disabled (an escalation is open). Settle the job instead of leaving it claimed.
    const detail = wrapped.status === 'failed' ? wrapped.detail : 'the envelope stopped the hop';
    await park(detail);
    return { status: 'failed', reason: 'specialist disabled', detail };
  }
  if (wrapped.status === 'failed' && wrapped.permanent) {
    await park(wrapped.detail);
    return { ...raw, status: 'failed', reason: String(raw.reason ?? 'escalated'), detail: wrapped.detail };
  }
  return raw;
}
