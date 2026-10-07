import type { Json } from '@/lib/db/types';
import {
  checkFeedbackSignal,
  feedbackSignalJsonSchema,
  feedbackSignalSchema,
  feedbackSignalSystemPrompt,
  renderFeedbackFacts,
  type FeedbackFacts,
} from '@/modules/projects/p789-feedback-signal-proposals';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * The Customer Success agent's workflow `customer_success.draft_feedback_signal` (P7-CS-05).
 *
 * UNPROVEN AGAINST A REAL MODEL. Proven against a stand-in model and a stand-in database (tests/p789-feedback-signal-workflow.test.ts): the ORDER (read for the
 * JOB's organization, ask, validate, then write), the REFUSALS and WHERE it writes: exactly ONE service-role door, projects.p789_record_feedback_signal_draft,
 * which stores a DRAFT citing the feedback rows it read. It opens no ticket, schedules no check-in, contacts nobody and prices nothing. The payload names a
 * PROJECT, never a tenant. It is not in RUNNABLE_WORKFLOWS and nothing enqueues it; the parent appends `...P789_FEEDBACK_SIGNAL_WORKFLOWS`. Running it needs a
 * funded model key (without one it fails honestly with AI_PROVIDER_NOT_CONFIGURED).
 */

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };
type Query = PromiseLike<Answer> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
};
type Loose = {
  schema(name: string): {
    from(table: string): Query;
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
};
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

async function settle(ctx: AgentContext): Promise<void> {
  await ctx.admin.schema('core').from('jobs').update(settledSucceeded).eq('id', ctx.job.id);
}

const feedbackSignalWorkflow: AgentWorkflow = {
  jobKind: 'customer_success.draft_feedback_signal',
  agentKey: 'customer_success',
  workClass: 'draft',
  systemPrompt: feedbackSignalSystemPrompt,
  schemaName: 'FeedbackSignal',
  jsonSchema: feedbackSignalJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const projectId = str(job.payload?.projectId) ?? str(job.payload?.subjectId);
    if (!projectId) {
      await failJob(admin, job, 'job payload has no projectId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const projects = loose(ctx).schema('projects');
    const org = job.organization_id;
    const fail = async (reason: string) => {
      await failJob(admin, job, reason);
      return { status: 'failed' as const, reason };
    };

    // every read below is for THIS job's organization
    const project = await projects.from('projects').select('name').eq('id', projectId).eq('organization_id', org).maybeSingle();
    if (project.error) return fail(`could not read the project: ${project.error.message}`);
    const feedback = await projects.from('client_feedback').select('id, sentiment, source, body').eq('project_id', projectId).eq('organization_id', org).eq('kind', 'feedback').order('created_at', { ascending: false }).limit(20);
    if (feedback.error) return fail(`could not read the feedback: ${feedback.error.message}`);
    if (!project.data || (feedback.data ?? []).length === 0) {
      await settle(ctx);
      return { status: 'succeeded' as const, outcome: 'gone', reason: 'the project no longer exists or has no feedback to read' };
    }

    const facts: FeedbackFacts = {
      projectName: String(project.data.name ?? ''),
      feedback: (feedback.data ?? []).map((f) => ({ id: String(f.id), sentiment: str(f.sentiment), source: String(f.source ?? ''), body: String(f.body ?? '') })),
    };

    const runId = await openRun(ctx, { type: 'project.feedback_signal', id: projectId, input: { projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderFeedbackFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    // strict, before anything is written: the shape, then the rules against the facts
    const parsed = feedbackSignalSchema.safeParse(call.json);
    const verdict = parsed.success ? checkFeedbackSignal(parsed.data, facts) : null;
    if (!parsed.success || (verdict && !verdict.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    const s = parsed.data;

    const { data, error } = await projects.rpc('p789_record_feedback_signal_draft', {
      p_organization_id: org,
      p_project_id: projectId,
      p_agent_key: 'customer_success',
      p_signal: s.signal,
      p_summary: s.summary,
      p_cited_feedback_ids: [...new Set(s.citedFeedbackIds)],
    });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'already_recorded' is a good answer: a retried run records no second draft
    if (outcome !== 'drafted' && outcome !== 'already_recorded') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, s as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId };
  },
};

export const P789_FEEDBACK_SIGNAL_WORKFLOWS: readonly AgentWorkflow[] = [feedbackSignalWorkflow];
