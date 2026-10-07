import {
  DESIGN_REVISION_PROMPT,
  designRevisionJsonSchema,
  resolveRevisionId,
  reviseDesignDirection,
  type RevisionAdmin,
} from '@/modules/projects/design-revision';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * P3-UID-015: `ui_designer:reviseDesignDirection` (job kind `design.revise`). Answers a Phase 3 revision round - a client's design change, an Admin EDIT or an
 * internal changes_required - with a NEW version of the direction, written through `projects.deliver_design_revision`.
 *
 * NOT YET WIRED: the parent adds `...DESIGN_REVISION_WORKFLOWS` to RUNNABLE_WORKFLOWS in workflows.ts and the three subscriptions in
 * src/lib/events/catalog.ts (see docs/phase-1-3-implementation-traceability.md, "Wiring"). UNPROVEN against a real model: the order, the refusals and the
 * writes are proved against a stand-in model (tests/design-revision.test.ts) and the doors against a real Postgres
 * (scripts/verify-phase-three-design-revision.sql). Drafting work at L2: it proposes, a person reviews, an Admin approves, the client picks.
 */
const DESIGN_REVISE: AgentWorkflow = {
  jobKind: 'design.revise',
  agentKey: 'ui_designer',
  workClass: 'draft',
  systemPrompt: DESIGN_REVISION_PROMPT,
  schemaName: 'DesignRevision',
  jsonSchema: designRevisionJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const subjectId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
    const eventType = typeof job.payload?.eventType === 'string' ? job.payload.eventType : null;
    if (!subjectId || !eventType) {
      await failJob(admin, job, 'job payload has no subjectId or eventType');
      return { status: 'failed', reason: 'bad payload' };
    }
    const settle = async () => {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
    };

    const resolved = await resolveRevisionId(admin as unknown as RevisionAdmin, { organizationId: job.organization_id, eventType, subjectId });
    if ('skip' in resolved) {
      await settle();
      return { status: 'succeeded', reason: resolved.skip };
    }

    let runId: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, costMinor: 0 };
    let steps = 0;
    let modelFailure: { kind: string; detail: string } | null = null;

    const outcome = await reviseDesignDirection(admin as unknown as RevisionAdmin, { organizationId: job.organization_id, revisionId: resolved.revisionId }, async (prompt, subject) => {
      runId = await openRun(ctx, { type: 'design_revision', id: resolved.revisionId, input: { revisionId: resolved.revisionId, projectId: subject.projectId } as never });
      const call = await callModel(ctx, this, [{ role: 'user', content: prompt }], runId);
      if (!call.ok) {
        modelFailure = { kind: call.kind, detail: call.detail };
        steps = call.stepCount;
        return { ok: false, detail: call.detail };
      }
      usage = call.usage;
      steps = call.stepCount;
      return { ok: true, json: call.json };
    });

    if (outcome.status === 'delivered' || outcome.status === 'already_delivered') {
      if (runId) await succeedRun(admin, runId, { revisionId: resolved.revisionId, themeOptionId: outcome.themeOptionId } as never, usage, steps);
      await settle();
      return { status: 'succeeded', reason: outcome.status, runId };
    }
    if (outcome.status === 'skipped') {
      if (runId) await finishRun(admin, runId, 'failed', outcome.reason, steps, usage);
      await settle();
      return { status: 'succeeded', reason: outcome.reason, runId };
    }
    if (runId) await finishRun(admin, runId, 'failed', outcome.reason, steps, usage);
    await failJob(admin, job, outcome.reason);
    const failure = modelFailure as { kind: string; detail: string } | null;
    return {
      status: 'failed',
      reason: failure?.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : outcome.reason,
      detail: outcome.reason,
      runId,
    };
  },
};

export const DESIGN_REVISION_WORKFLOWS: readonly AgentWorkflow[] = [DESIGN_REVISE];
