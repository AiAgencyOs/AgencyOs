import type { Json } from '@/lib/db/types';
import { validateExecutionEnvelope, type ExecutionEnvelope } from '@/modules/orchestrator/development-route';
import {
  DEVELOPMENT_SPECIALIST_KEYS,
  developmentSpecialistJobKind,
  doorDetail,
  proposalJsonSchema,
  proposalSchema,
  proposalSystemPrompt,
  renderProposalBrief,
  validateProposal,
  type DevelopmentSpecialistKey,
} from '@/modules/projects/specialist-proposals';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * Phase 5 development specialist workflows: frontend, backend, database, mobile, integration, devops/build, security review, bug fix and
 * refactor/performance, all from ONE factory.
 *
 * UNPROVEN AGAINST A REAL MODEL, and none of them has repository access. They are proven against a stand-in model and a stand-in database
 * (tests/development-specialist-workflows.test.ts, scripts/verify-phase5-specialists.sql). What is proved is the order, the refusals and where they write.
 *
 * A run can only PROPOSE. It reads, for the JOB's organization: the task, the routed handoff (which carries the Execution Envelope the Orchestrator
 * built) and, where the role needs it, the project's NOT_REQUIRED record and the defects linked to the task. It asks the model for JSON, validates the
 * answer strictly (shape, then the agent's profile against the task's affected paths and the envelope's required evidence) and writes through ONE
 * service-only door, `record_specialist_proposal`. It never writes code into a repository, never records a test result, never approves anything.
 * A task that was not routed to the agent (no handoff: held, refused or not yet routed) is not worked on at all.
 *
 * Not subscribed to an event: an Admin asks (src/modules/projects/specialist-actions.ts).
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
type Loose = { schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

async function settle(ctx: AgentContext): Promise<void> {
  await ctx.admin.schema('core').from('jobs').update(settledSucceeded).eq('id', ctx.job.id);
}

function proposeWorkflow(agentKey: DevelopmentSpecialistKey): AgentWorkflow {
  return {
    jobKind: developmentSpecialistJobKind(agentKey),
    agentKey,
    workClass: 'draft',
    systemPrompt: proposalSystemPrompt(agentKey),
    schemaName: 'ImplementationProposal',
    jsonSchema: proposalJsonSchema,

    async run(ctx) {
      const { admin, job } = ctx;
      const taskId = str(job.payload?.taskId) ?? str(job.payload?.subjectId);
      if (!taskId) {
        await failJob(admin, job, 'job payload has no taskId');
        return { status: 'failed', reason: 'bad payload' };
      }
      const db = loose(ctx).schema('projects');
      const org = job.organization_id;

      // every read is for THIS job's organization (the payload names which row, never which tenant)
      const task = await db
        .from('tasks')
        .select('id, project_id, title, description, acceptance_criteria, status, required_capability, risk_level, affected_paths')
        .eq('id', taskId)
        .eq('organization_id', org)
        .maybeSingle();
      if (task.error) {
        await failJob(admin, job, `could not read the task: ${task.error.message}`);
        return { status: 'failed', reason: task.error.message };
      }
      if (!task.data || task.data.status === 'cancelled') {
        await settle(ctx);
        return { status: 'succeeded', outcome: 'gone', reason: 'the task no longer exists or was cancelled' };
      }
      if (task.data.required_capability !== agentKey) {
        await failJob(admin, job, `the task is assigned to ${String(task.data.required_capability ?? 'no specialist')}, not ${agentKey}`);
        return { status: 'failed', reason: 'wrong agent' };
      }
      const projectId = str(task.data.project_id) ?? '';

      // the task must have been ROUTED to this agent: a held or refused task has no handoff and is not worked on
      const handoffs = await loose(ctx)
        .schema('ai')
        .from('handoffs')
        .select('id, to_agent, context')
        .eq('organization_id', org)
        .eq('subject_type', 'development_task')
        .eq('subject_id', taskId)
        .eq('to_agent', agentKey)
        .order('created_at', { ascending: false })
        .limit(1);
      if (handoffs.error) {
        await failJob(admin, job, `could not read the routed handoff: ${handoffs.error.message}`);
        return { status: 'failed', reason: handoffs.error.message };
      }
      const handoff = (handoffs.data ?? [])[0];
      if (!handoff) {
        await failJob(admin, job, 'the task has not been routed to this specialist: nothing to work on');
        return { status: 'failed', reason: 'not routed' };
      }
      // the envelope is rejected, not repaired: a specialist is only ever given a complete, secret-free one that names this task and this agent
      const envelope = ((handoff.context as { envelope?: unknown } | null)?.envelope ?? null) as ExecutionEnvelope | null;
      const problems = envelope ? validateExecutionEnvelope(envelope) : ['the handoff carries no execution envelope'];
      if (envelope && (envelope.taskId !== taskId || envelope.destination !== agentKey)) problems.push('the envelope is for a different task or agent');
      if (problems.length > 0) {
        await failJob(admin, job, `the execution envelope was refused: ${problems.join('; ')}`);
        return { status: 'failed', reason: 'bad envelope' };
      }
      if (!envelope) return { status: 'failed', reason: 'bad envelope' };

      const [state, defects] = await Promise.all([
        db.from('phase_five_agent_state').select('state').eq('project_id', projectId).eq('organization_id', org).eq('agent_key', agentKey).maybeSingle(),
        agentKey === 'bug_fix'
          ? loose(ctx).schema('qa').from('defects').select('id, title').eq('task_id', taskId).eq('organization_id', org).limit(20)
          : Promise.resolve({ data: [] as Row[], error: null }),
      ]);
      if (state.error || defects.error) {
        const message = state.error?.message ?? defects.error?.message ?? 'unreadable';
        await failJob(admin, job, `could not read the task's context: ${message}`);
        return { status: 'failed', reason: message };
      }
      const recordedNotRequired = state.data?.state === 'not_required';
      const linkedDefects = (defects.data ?? []).map((d) => ({ id: String(d.id), title: String(d.title ?? '') }));
      const affectedPaths = strings(task.data.affected_paths);
      const requiredEvidence = strings(envelope.requiredEvidence);

      const runId = await openRun(ctx, { type: 'projects.specialist_proposal', id: taskId, input: { taskId, projectId, agentKey } as unknown as Json });
      const brief = renderProposalBrief({
        title: String(task.data.title ?? ''),
        description: str(task.data.description),
        acceptanceCriteria: String(task.data.acceptance_criteria ?? ''),
        affectedPaths,
        requiredEvidence,
        riskClass: str(task.data.risk_level),
        linkedDefects,
        recordedNotRequired,
      });
      const call = await callModel(ctx, this, [{ role: 'user', content: brief }], runId);
      if (!call.ok) {
        await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
        await failJob(admin, job, call.detail);
        return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
      }

      // strict, before anything is written: the shape, then the agent's profile against the task and the envelope
      const parsed = proposalSchema.safeParse(call.json);
      const verdict = parsed.success
        ? validateProposal(parsed.data, { agentKey, affectedPaths, requiredCapability: str(task.data.required_capability), requiredEvidence, linkedDefectIds: linkedDefects.map((d) => d.id), recordedNotRequired })
        : null;
      if (!parsed.success || (verdict && !verdict.ok)) {
        const why = !parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : verdict && !verdict.ok ? verdict.messages.join('; ') : 'unchecked';
        const detail = `the model's answer was refused: ${why}`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: detail, runId };
      }
      const p = parsed.data;

      const { data, error } = await db.rpc('record_specialist_proposal', {
        p_organization_id: org,
        p_task_id: taskId,
        p_agent_key: agentKey,
        p_handoff_id: String(handoff.id),
        p_outcome: p.outcome,
        p_summary: p.summary,
        p_planned_files: p.plannedFiles,
        p_planned_tests: p.plannedTests,
        p_risks: p.risks,
        p_evidence_plan: p.evidencePlan,
        p_detail: doorDetail(p) as unknown as Json,
        p_run_id: runId,
      });
      if (error) {
        await finishRun(admin, runId, 'failed', error.message, call.stepCount);
        await failJob(admin, job, `the door did not answer: ${error.message}`);
        return { status: 'failed', reason: error.message, runId };
      }
      const outcome = door(data);
      // 'already_proposed' is a good answer: the same plan is already on record and is never stored twice
      if (outcome !== 'recorded' && outcome !== 'already_proposed') {
        await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
        await failJob(admin, job, `the door answered ${outcome}`);
        return { status: 'failed', reason: `the door answered ${outcome}`, runId };
      }
      await succeedRun(admin, runId, p as unknown as Json, call.usage, call.stepCount);
      await settle(ctx);
      return { status: 'succeeded', reason: outcome, runId, proposalOutcome: p.outcome };
    },
  };
}

export const DEVELOPMENT_SPECIALIST_WORKFLOWS: readonly AgentWorkflow[] = DEVELOPMENT_SPECIALIST_KEYS.map(proposeWorkflow);
