/**
 * What each agent is for, as data the runner dispatches on.
 *
 * Before this file, `requirement_collector` was not an agent the runner could
 * reach — it was the shape the runner had. Its key, its job kind, its system
 * prompt and its output schema were four module-level constants, so the
 * twelve other agents ADM-82 defined could be enabled and still do nothing:
 * there was no way to send them work. Flipping `enabled` would have made the
 * Admin screen say twelve agents were running while none of them could be.
 *
 * A workflow is the answer to "what would it even do?", written down: which
 * queue carries its work, which agent performs it, what it is told, and what
 * shape its answer must take. `agent-run.ts` holds everything that is the same
 * whichever agent it is — identity, the autonomy gate, the run record, the
 * step trace, the cost. A workflow cannot bring its own version of any of
 * those, which is the point: an agent that could would be an agent that could
 * skip them.
 */

import type { AiMessage } from '@/lib/ai/types';
import type { Json } from '@/lib/db/types';
import { requirementJsonSchema, requirementPayloadSchema } from '@/modules/crm/schema';
import { MAX_EXTRACTION_MESSAGES } from '@/modules/crm/service';
import { transcriptForModel } from '@/modules/crm/types';
import {
  maintenanceTriageJsonSchema,
  maintenanceTriageSchema,
} from '@/modules/projects/schema';

import {
  callModel,
  failJob,
  finishRun,
  openRun,
  settledSucceeded,
  succeedRun,
  type AgentContext,
} from './agent-run';

/** What the route turns into a response. `status` is the job's, not HTTP's. */
export type WorkflowResult = {
  status: 'succeeded' | 'failed';
  reason: string;
  runId?: string | null;
  [key: string]: unknown;
};

export type AgentWorkflow = {
  /** The `core.jobs.kind` this workflow claims. */
  jobKind: string;
  /** The `ai.agents.key` that performs it. Checked against the registry. */
  agentKey: string;
  systemPrompt: string;
  schemaName: string;
  jsonSchema: () => Record<string, unknown>;
  run: (ctx: AgentContext) => Promise<WorkflowResult>;
};

// ═══════════════════════════════════════════════════════════════════════════
// requirement_collector — the one that already ran
// ═══════════════════════════════════════════════════════════════════════════

const REQUIREMENT_PROMPT = [
  'You extract structured project requirements from a sales conversation.',
  'Use only what the transcript supports. Do not infer budget or pricing.',
  'If something is not stated, leave it out rather than guessing.',
].join(' ');

const REQUIREMENT_EXTRACT: AgentWorkflow = {
  jobKind: 'requirement.extract',
  agentKey: 'requirement_collector',
  systemPrompt: REQUIREMENT_PROMPT,
  schemaName: 'RequirementPayload',
  jsonSchema: requirementJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const conversationId = typeof job.payload?.conversationId === 'string'
      ? job.payload.conversationId
      : null;

    if (!conversationId) {
      await failJob(admin, job, 'job payload has no conversationId');
      return { status: 'failed', reason: 'bad payload' };
    }

    // Hand-scoped by organization: the admin client bypasses RLS, so the
    // tenant predicate is the caller's responsibility here.
    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, organization_id')
      .eq('id', conversationId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!conversation) {
      await failJob(admin, job, 'conversation not found for this organization');
      return { status: 'failed', reason: 'conversation missing' };
    }

    // Already produced? Only a produced version reaches here, so there is one
    // outcome: the work is done and the job closes on it.
    const { data: alreadyProduced } = await admin
      .schema('crm')
      .from('requirement_versions')
      .select('id, version, status')
      .eq('organization_id', job.organization_id)
      .eq('source_job_id', job.id)
      .neq('status', 'failed')
      .maybeSingle();

    if (alreadyProduced) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: 'already produced',
        versionId: alreadyProduced.id,
        version: alreadyProduced.version,
      };
    }

    const { data: messages } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('seq, author_type, body, metadata')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', job.organization_id)
      .order('seq', { ascending: false })
      .limit(MAX_EXTRACTION_MESSAGES);

    const rows = (messages ?? []).slice().reverse();
    const document = transcriptForModel(rows);
    const messageCount = rows.length;

    if (document === '') {
      await admin
        .schema('core')
        .from('jobs')
        .update({
          status: 'dead',
          locked_at: null,
          locked_by: null,
          last_error: 'The conversation has nothing readable to extract from.',
        })
        .eq('id', job.id);
      return { status: 'failed', reason: 'empty transcript', messageCount };
    }

    const { data: sameTranscript } = await admin
      .schema('crm')
      .from('requirement_versions')
      .select('id, version, status')
      .neq('status', 'failed')
      .eq('organization_id', job.organization_id)
      .eq('conversation_id', conversation.id)
      .eq('source_message_count', messageCount)
      .maybeSingle();

    if (sameTranscript) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: 'transcript already extracted',
        versionId: sameTranscript.id,
        version: sameTranscript.version,
        messageCount,
      };
    }

    const transcript: AiMessage[] = [{ role: 'user', content: document }];

    const runId = await openRun(ctx, {
      type: 'crm.conversation',
      id: conversation.id,
      input: { conversationId: conversation.id, messageCount } as unknown as Json,
    });

    const call = await callModel(ctx, this, transcript, runId);

    if (!call.ok) {
      // A queued extraction that cannot run must not look like one that
      // produced an empty result.
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failExtraction(ctx, conversation.id, runId, call.detail, messageCount);
      return {
        status: 'failed',
        reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error',
        detail: call.detail,
        runId,
      };
    }

    // Never trust the provider's claim of schema conformance (§6.6).
    const validated = requirementPayloadSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failExtraction(ctx, conversation.id, runId, detail, messageCount);
      return { status: 'failed', reason: detail, runId };
    }

    const { data: allocated, error: insertError } = await admin
      .schema('crm')
      .rpc('insert_requirement_version', {
        p_organization_id: job.organization_id,
        p_conversation_id: conversation.id,
        p_source: 'agent',
        p_status: 'proposed', // the agent is L1: it proposes, a human decides
        p_payload: validated.data as unknown as Json,
        p_source_job_id: job.id,
        p_source_message_count: messageCount,
        // Optional, not nullable, in the generated Args: an absent run is the
        // function's own default rather than an explicit null.
        ...(runId ? { p_generated_by_run_id: runId } : {}),
      });

    const nextVersion = (Array.isArray(allocated) ? allocated[0] : allocated)?.version ?? null;

    if (insertError) {
      const raced =
        insertError.code === '23505' &&
        (insertError.message.includes('source_job') ||
          insertError.message.includes('transcript_state'));

      if (raced) {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        await finishRun(admin, runId, 'superseded', 'another run wrote this proposal', call.stepCount);
        return { status: 'succeeded', reason: 'raced', runId };
      }

      await finishRun(admin, runId, 'failed', insertError.message, call.stepCount);
      await failExtraction(ctx, conversation.id, runId, insertError.message, messageCount);
      return { status: 'failed', reason: 'persist failed', runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: 'extracted',
      runId,
      version: nextVersion,
      messageCount,
    };
  },
};

/**
 * Settles a failed extraction, and records it where a human will look.
 *
 * A transient failure is not a failed *proposal*. The job is requeued, the
 * next tick may well succeed, and the reason already lives in
 * `core.jobs.last_error` and `ai.agent_runs.error` — which is what those
 * columns are for. Writing a `failed` version for every bad attempt would fill
 * the owner's view with proposals that a retry then contradicts.
 */
async function failExtraction(
  ctx: AgentContext,
  conversationId: string,
  runId: string | null,
  reason: string,
  messageCount: number,
): Promise<void> {
  const { admin, job } = ctx;

  // `job.attempts` is the attempt now in progress: the atomic claim
  // incremented it (G-082). Adding one here would spend the budget an attempt
  // early and write the `failed` marker before it was true.
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    const { error } = await admin
      .schema('crm')
      .rpc('insert_requirement_version', {
        p_organization_id: job.organization_id,
        p_conversation_id: conversationId,
        p_source: 'agent',
        p_status: 'failed',
        p_payload: {} as unknown as Json,
        p_source_job_id: job.id,
        p_source_message_count: messageCount,
        ...(runId ? { p_generated_by_run_id: runId } : {}),
      });

    // 23505 means another run of this job already recorded it. Anything else
    // is logged and swallowed: losing the marker is bad, refusing to settle a
    // job because its marker would not insert is worse.
    if (error && error.code !== '23505') {
      console.error(
        JSON.stringify({ level: 'error', scope: 'failExtraction', detail: error.message }),
      );
    }
  }

  await failJob(admin, job, reason);
}

// ═══════════════════════════════════════════════════════════════════════════
// support — the second agent, and the first that needed this file to exist
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADM-82 defines `support` as the agent that *"answers client questions from
 * approved knowledge and classifies what is reported"*. This is the second
 * half, and only the second half.
 *
 * The prompt says what it is for and, twice, what it is not: it names the type
 * and it does not decide who pays. That is belt-and-braces — the schema has no
 * field for coverage, so a model that wanted to answer the commercial question
 * has nowhere to put the answer. The sentence is here for the human reading
 * the trace, not as the control.
 */
const TRIAGE_PROMPT = [
  'You classify a maintenance ticket by what kind of work it describes.',
  'Choose one type from the list and say what in the report points at it.',
  'Use only what the report says. Do not infer the cause of a bug you cannot see.',
  'You are not deciding whether this is covered by a contract, who pays for it,',
  'or how long it will take. Somebody else decides that from what you name.',
].join(' ');

const MAINTENANCE_TRIAGE: AgentWorkflow = {
  jobKind: 'maintenance.triage',
  agentKey: 'support',
  systemPrompt: TRIAGE_PROMPT,
  schemaName: 'MaintenanceTriage',
  jsonSchema: maintenanceTriageJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    // `subjectId` is what the outbox dispatcher writes (§9.1) — the job
    // arrives from a `support_ticket.created` event, not from a hand-built
    // payload, so it carries the event's subject rather than a field named
    // after this workflow.
    const itemId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!itemId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: item } = await admin
      .schema('projects')
      .from('maintenance_items')
      .select('id, title, description, status, ticket_type')
      .eq('id', itemId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!item) {
      // The ticket is gone. Nothing failed — there is simply nothing to do,
      // and requeuing would retry that answer four more times.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'ticket no longer exists' };
    }

    if (item.ticket_type !== null) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'already triaged', ticketType: item.ticket_type };
    }

    if (item.status === 'resolved' || item.status === 'declined') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'ticket already closed' };
    }

    const report = [item.title, item.description ?? ''].join('\n\n').trim();

    if (report === '') {
      await admin
        .schema('core')
        .from('jobs')
        .update({
          status: 'dead',
          locked_at: null,
          locked_by: null,
          last_error: 'The ticket has nothing readable to classify.',
        })
        .eq('id', job.id);
      return { status: 'failed', reason: 'empty ticket' };
    }

    const runId = await openRun(ctx, {
      type: 'projects.maintenance_item',
      id: item.id,
      input: { maintenanceItemId: item.id } as unknown as Json,
    });

    const call = await callModel(ctx, this, [{ role: 'user', content: report }], runId);

    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return {
        status: 'failed',
        reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error',
        detail: call.detail,
        runId,
      };
    }

    const validated = maintenanceTriageSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // **One column.** `coverage` is not written here and cannot be: the schema
    // has no field for it, and this update names `ticket_type` alone. Who the
    // classification came from is not denormalised onto the ticket either —
    // `ai.agent_runs` already records this run against this subject, and a
    // second copy is a second thing to keep true.
    const { error: writeError } = await admin
      .schema('projects')
      .from('maintenance_items')
      .update({ ticket_type: validated.data.ticketType })
      .eq('id', item.id)
      .eq('organization_id', job.organization_id);

    if (writeError) {
      await finishRun(admin, runId, 'failed', writeError.message, call.stepCount);
      await failJob(admin, job, writeError.message);
      return { status: 'failed', reason: 'persist failed', runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: 'triaged',
      runId,
      ticketType: validated.data.ticketType,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════

export const AGENT_WORKFLOWS: readonly AgentWorkflow[] = [
  REQUIREMENT_EXTRACT,
  MAINTENANCE_TRIAGE,
];

/**
 * The queues the runner claims from.
 *
 * Derived, not listed. A workflow whose kind was left out of a hand-written
 * list would be a queue nothing drains — work accepted and never done, which
 * is a worse failure than work refused.
 */
export const AGENT_JOB_KINDS: readonly string[] = AGENT_WORKFLOWS.map((w) => w.jobKind);

export function workflowFor(jobKind: string): AgentWorkflow | null {
  return AGENT_WORKFLOWS.find((w) => w.jobKind === jobKind) ?? null;
}
