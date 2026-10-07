import {
  P4UI_DETAIL_PROMPT,
  P4UI_PLAN_PROMPT,
  detailUiVersion,
  p4uiPrototypePlanJsonSchema,
  p4uiScreenSpecsJsonSchema,
  planPrototypeBuild,
  type P4uiAdmin,
  type P4uiAsk,
  type P4uiOutcome,
} from '@/modules/projects/p4ui';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * Phase 4 UI Designer / Prototype gap work. Two drafting workflows (work class `draft`: they propose, a person or a later gate decides):
 *
 *   ui_designer:detailUIVersion   job kind `ui.design_detail`   a drafted UI version -> per-screen specs (purpose, entry/exit, data, actions, validation,
 *                                                                states, variants, role differences) + derived lineage. Subscribed to project.ui_version_drafted
 *                                                                (in ADDITION to quality_assurance:reviewUIVersion). Writes nothing about Design QA.
 *   ui_prototype:planBuild        job kind `prototype.plan`     a LOCKED UI version -> the build plan recorded BEFORE review, then input validation (which may
 *                                                                BLOCK on a missing platform, asset or credential). Subscribed to project.ui_version_locked
 *                                                                (in ADDITION to ui_prototype:build).
 *
 * NOT YET WIRED: the parent adds `...P4UI_WORKFLOWS` to RUNNABLE_WORKFLOWS in workflows.ts and the subscriptions in src/lib/events/catalog.ts (see
 * docs/phase-4-ui-prototype-gaps-log.md, "Wiring"). UNPROVEN against a real model: the order, the refusals and the writes are proved against a stand-in
 * model (tests/p4ui-orchestration.test.ts) and the doors against a real Postgres (scripts/verify-p4ui-*.sql). A job that finds nothing to do settles succeeded.
 */
function subjectOf(job: { payload?: Record<string, unknown> | null }): string | null {
  const id = job.payload?.subjectId;
  return typeof id === 'string' ? id : null;
}

type Base = Pick<AgentWorkflow, 'jobKind' | 'agentKey' | 'systemPrompt' | 'schemaName' | 'jsonSchema'>;

function makeWorkflow(
  base: Base,
  subjectType: string,
  run: (admin: P4uiAdmin, organizationId: string, subjectId: string, ask: P4uiAsk) => Promise<P4uiOutcome>,
): AgentWorkflow {
  const workflow: AgentWorkflow = {
    ...base,
    workClass: 'draft',
    async run(ctx) {
      const { admin, job } = ctx;
      const subjectId = subjectOf(job as never);
      if (!subjectId) {
        await failJob(admin, job, 'job payload has no subjectId');
        return { status: 'failed', reason: 'bad payload' };
      }
      let runId: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, costMinor: 0 };
      let steps = 0;
      let modelFailure: { kind: string; detail: string } | null = null;

      const outcome = await run(admin as unknown as P4uiAdmin, job.organization_id, subjectId, async (prompt) => {
        runId = await openRun(ctx, { type: subjectType, id: subjectId, input: { subjectId } as never });
        const call = await callModel(ctx, workflow, [{ role: 'user', content: prompt }], runId);
        steps = call.stepCount;
        if (!call.ok) {
          modelFailure = { kind: call.kind, detail: call.detail };
          return { ok: false as const, detail: call.detail };
        }
        usage = call.usage;
        return { ok: true as const, json: call.json };
      });

      if (outcome.status === 'done') {
        if (runId) await succeedRun(admin, runId, { subjectId, detail: outcome.detail } as never, usage, steps);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: outcome.detail, runId };
      }
      if (outcome.status === 'skipped') {
        if (runId) await finishRun(admin, runId, 'failed', outcome.reason, steps, usage);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: outcome.reason, runId };
      }
      if (runId) await finishRun(admin, runId, 'failed', outcome.reason, steps, usage);
      await failJob(admin, job, outcome.reason);
      const failure = modelFailure as { kind: string; detail: string } | null;
      return { status: 'failed', reason: failure?.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : outcome.reason, detail: outcome.reason, runId };
    },
  };
  return workflow;
}

const DETAIL = makeWorkflow(
  { jobKind: 'ui.design_detail', agentKey: 'ui_designer', systemPrompt: P4UI_DETAIL_PROMPT, schemaName: 'P4uiScreenSpecs', jsonSchema: p4uiScreenSpecsJsonSchema },
  'projects.ui_version',
  (admin, organizationId, uiVersionId, ask) => detailUiVersion(admin, { organizationId, uiVersionId }, ask),
);

const PLAN = makeWorkflow(
  { jobKind: 'prototype.plan', agentKey: 'ui_prototype', systemPrompt: P4UI_PLAN_PROMPT, schemaName: 'P4uiPrototypePlan', jsonSchema: p4uiPrototypePlanJsonSchema },
  'projects.ui_version',
  (admin, organizationId, uiVersionId, ask) => planPrototypeBuild(admin, { organizationId, uiVersionId }, ask),
);

export const P4UI_WORKFLOWS: readonly AgentWorkflow[] = [DETAIL, PLAN];
