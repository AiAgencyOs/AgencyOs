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

import type { WorkClass } from '@/lib/ai/autonomy';
import type { AiMessage } from '@/lib/ai/types';
import type { Json } from '@/lib/db/types';
import {
  checkInBriefJsonSchema,
  checkInBriefSchema,
  messageIntentJsonSchema,
  messageIntentSchema,
  requirementJsonSchema,
  requirementPayloadSchema,
} from '@/modules/crm/schema';
import { MAX_EXTRACTION_MESSAGES } from '@/modules/crm/service';
import { testPlanJsonSchema, testPlanSchema } from '@/modules/qa/schema';
import { transcriptForModel } from '@/modules/crm/types';
import {
  breakdownJsonSchema,
  breakdownPayloadSchema,
  handoverPackageJsonSchema,
  handoverPackageSchema,
  maintenanceTriageJsonSchema,
  maintenanceTriageSchema,
  screenInventoryJsonSchema,
  screenInventorySchema,
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
  /**
   * What kind of work this is, in ADM-61's vocabulary — §2's four things an L2
   * agent may do alone, or §3's three it must bring to the internal group.
   *
   * Declared per workflow rather than per agent, because the same agent does
   * both kinds: a project manager planning internal work acts alone, and the
   * same project manager sending a client a status update does not.
   */
  workClass: WorkClass;
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
  // ADM-61 §2, "draft anything at all". It produces a PROPOSED version; a
  // person accepts it. Accepting is not on §2's list, which is the distinction
  // the level-only gate was reaching for and could not express.
  workClass: 'draft',
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
  // ADM-61 §2, "update internal work". Naming a ticket's type touches no
  // client and no money; whether the work is COVERED is §3's question and this
  // agent has no field to answer it in.
  workClass: 'internal_plan',
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
// project_manager — the decision that has been waiting for an agent
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ADM-16, granted 2026-08-13: *"The breakdown from approved requirements into
 * modules, features and tasks is **automatic** — the AI does it without
 * proposing it for review."*
 *
 * `projects.break_down_requirement` was written to receive exactly this. Its
 * own comment says an agent sends it — *"a retrying agent is the ordinary
 * case"* — and it validates the plan rather than trusting it, refuses a
 * version that is not accepted, refuses one belonging to another project's
 * lead, and answers rather than duplicating when the same version arrives
 * twice. Everything about it was built for a caller that did not exist.
 *
 * So this workflow is unusually small, and that is the point: **the plan is
 * the only thing the agent contributes.** The transaction, the provenance on
 * every row, the wrong-client refusal and the idempotency are all somebody
 * else's, already written and already tested.
 */
const BREAKDOWN_PROMPT = [
  'You turn an approved requirement into a delivery plan.',
  'Produce modules, the features inside them, and the tasks that build each feature.',
  'Use only what the requirement states. Do not add scope it does not ask for.',
  'Name things the way the client would recognise them, not the way a database would.',
  'You are not deciding who does the work, when it is due, or whether anything is blocked.',
].join(' ');

const PLAN_BREAKDOWN: AgentWorkflow = {
  jobKind: 'plan.breakdown',
  agentKey: 'project_manager',
  // ADM-61 §2's first line, verbatim: "Break approved requirements into
  // modules, features and tasks. The breakdown is automatic (ADM-16) — it is
  // not proposed for review."
  workClass: 'breakdown',
  systemPrompt: BREAKDOWN_PROMPT,
  schemaName: 'RequirementBreakdown',
  jsonSchema: breakdownJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const versionId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!versionId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: version } = await admin
      .schema('crm')
      .from('requirement_versions')
      .select('id, status, payload, conversation_id')
      .eq('id', versionId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!version) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'requirement version no longer exists' };
    }

    // The event fires on acceptance, but a later version can supersede this one
    // before the job is claimed. Nothing failed — the plan is simply no longer
    // wanted, and requeuing would retry that answer four more times.
    if (version.status !== 'accepted') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `version is ${version.status}, not accepted` };
    }

    // Which project is this? Through the engagement, the same way
    // `break_down_requirement`'s own wrong-project check reasons: the
    // version's conversation names a lead, and the project's opportunity names
    // the same lead. Resolved here so the function is called with a project it
    // will accept, rather than being handed a guess to refuse.
    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('lead_id')
      .eq('id', version.conversation_id)
      .maybeSingle();

    const { data: opportunity } = conversation?.lead_id
      ? await admin
          .schema('sales')
          .from('opportunities')
          .select('id')
          .eq('lead_id', conversation.lead_id)
          .eq('organization_id', job.organization_id)
          .maybeSingle()
      : { data: null };

    const { data: project } = opportunity?.id
      ? await admin
          .schema('projects')
          .from('projects')
          .select('id')
          .eq('opportunity_id', opportunity.id)
          .eq('organization_id', job.organization_id)
          .maybeSingle()
      : { data: null };

    if (!project) {
      // The requirement is accepted and the deal has not become a project yet.
      // That is an ordinary state, not a failure: the plan has nowhere to go.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'no project for this requirement yet' };
    }

    const requirement = JSON.stringify(version.payload ?? {}, null, 2);

    const runId = await openRun(ctx, {
      type: 'crm.requirement_version',
      id: version.id,
      input: { requirementVersionId: version.id, projectId: project.id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: `The approved requirement:\n\n${requirement}` }],
      runId,
    );

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

    const validated = breakdownPayloadSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data: written, error: writeError } = await admin
      .schema('projects')
      .rpc('break_down_requirement', {
        p_project_id: project.id,
        p_requirement_version_id: version.id,
        p_breakdown: validated.data.modules as unknown as Json,
      });

    if (writeError) {
      await finishRun(admin, runId, 'failed', writeError.message, call.stepCount);
      await failJob(admin, job, writeError.message);
      return { status: 'failed', reason: 'persist failed', runId };
    }

    const result = (Array.isArray(written) ? written[0] : written) as
      | { outcome: string; modules: number | null; features: number | null; tasks: number | null }
      | null;

    // `already_broken_down` is a success, and deliberately: ADM-16 makes this
    // automatic, so a retry arriving after a partial network failure is the
    // ordinary case rather than a fault.
    const settled = result?.outcome === 'broken_down' || result?.outcome === 'already_broken_down';

    if (!settled) {
      const detail = `break_down_requirement answered ${result?.outcome ?? "nothing"}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: result?.outcome ?? 'broken_down',
      runId,
      modules: result?.modules ?? 0,
      features: result?.features ?? 0,
      tasks: result?.tasks ?? 0,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// ui_designer — the first agent the work-aware gate lets through
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Doc 12 §4's first two responsibilities: *"Analyze scope and derive UI
 * implications. Create screen inventory."*
 *
 * **The first L2 agent to run.** Until the gate learned to ask which work,
 * every L2 agent was refused by an argument written about requirement
 * extraction. Producing an inventory is ADM-61 §2's *"draft anything at all"*;
 * what this agent may NOT do is approve it, which is §3 work and stays with the
 * internal group.
 *
 * Everything dangerous about designing was already refused before this existed:
 * a screen cannot be mapped to an excluded scope item, a design cannot enter
 * review while an included item has no screen, and two screens cannot claim one
 * id. This workflow adds a producer to guards that were built first — which is
 * the order this system keeps choosing, and the reason adding the producer is
 * this small.
 */
const INVENTORY_PROMPT = [
  'You turn an agreed project scope into the inventory of screens it needs.',
  'For each screen give a stable lower-case id, a name, the user role it serves,',
  'and say which scope items it covers — every screen must cover at least one.',
  'Say honestly which of the four states each screen has: empty, loading, error, success.',
  'Design only what the scope lists. Do not add features it does not ask for,',
  'and do not drop a listed one because it is awkward to draw.',
  'You are not approving anything, and you are not deciding what is in scope.',
].join(' ');

const SCREEN_INVENTORY: AgentWorkflow = {
  jobKind: 'ui.inventory',
  agentKey: 'ui_designer',
  systemPrompt: INVENTORY_PROMPT,
  schemaName: 'ScreenInventory',
  jsonSchema: screenInventoryJsonSchema,
  // ADM-61 §2, "draft anything at all". Filing the result as a design VERSION
  // and submitting it is `delivery_approval` — §3 work this agent may not do
  // alone, and has no field to express.
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const versionId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!versionId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: baseline } = await admin
      .schema('projects')
      .from('scope_versions')
      .select('id, project_id, status, version')
      .eq('id', versionId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!baseline) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'scope version no longer exists' };
    }

    // A later baseline can supersede this one before the job is claimed.
    // Designing against a superseded scope is designing the wrong thing.
    if (baseline.status !== 'active') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `baseline is ${baseline.status}, not active` };
    }

    const { data: existing } = await admin
      .schema('projects')
      .from('screens')
      .select('id')
      .eq('project_id', baseline.project_id)
      .limit(1);

    if ((existing ?? []).length > 0) {
      // Doc 12 §5: "Do not overwrite an approved version." A project that
      // already has an inventory gets a revision through the change-request
      // path, not a second opinion from a retrying job.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this project already has a screen inventory' };
    }

    // **Included and optional only.** Doc 12 §20: "Excluded features not
    // accidentally designed as commitments." The agent is never shown an
    // exclusion, so it cannot design one — and the row rule refuses the
    // mapping regardless, which is where the rule actually lives.
    const { data: items } = await admin
      .schema('projects')
      .from('scope_items')
      .select('id, title, detail, inclusion, acceptance_criteria')
      .eq('scope_version_id', baseline.id)
      .in('inclusion', ['included', 'optional'])
      .order('position', { ascending: true });

    const designable = items ?? [];

    if (designable.length === 0) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the baseline includes nothing to design' };
    }

    const brief = designable
      .map(
        (i) =>
          `- id: ${i.id}\n  scope item: ${i.title}` +
          (i.detail ? `\n  detail: ${i.detail}` : '') +
          (i.acceptance_criteria ? `\n  accepted when: ${i.acceptance_criteria}` : '') +
          (i.inclusion === 'optional' ? '\n  (optional)' : ''),
      )
      .join('\n');

    const runId = await openRun(ctx, {
      type: 'projects.scope_version',
      id: baseline.id,
      input: { scopeVersionId: baseline.id, projectId: baseline.project_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: `The agreed scope:\n\n${brief}` }],
      runId,
    );

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

    const validated = screenInventorySchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // A scope item the agent invented is not a scope item. Checked here rather
    // than left to the foreign key, because the FK would report a uuid and this
    // reports what went wrong.
    const known = new Set(designable.map((i) => i.id));
    const invented = validated.data.screens
      .flatMap((s) => s.coversScopeItems)
      .filter((id) => !known.has(id));

    if (invented.length > 0) {
      const detail = `the inventory covers ${invented.length} scope item(s) that are not in this baseline`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    let written = 0;
    let mapped = 0;

    for (const screen of validated.data.screens) {
      const { data: row, error } = await admin
        .schema('projects')
        .from('screens')
        .insert({
          organization_id: job.organization_id,
          project_id: baseline.project_id,
          screen_key: screen.screenKey,
          name: screen.name,
          user_role: screen.userRole,
          purpose: screen.purpose ?? null,
          entry_point: screen.entryPoint ?? null,
          exit_action: screen.exitAction ?? null,
          required_data: screen.requiredData ?? null,
          actions: screen.actions ?? null,
          validation: screen.validation ?? null,
          has_empty_state: screen.hasEmptyState,
          has_loading_state: screen.hasLoadingState,
          has_error_state: screen.hasErrorState,
          has_success_state: screen.hasSuccessState,
          // No status and no deliverable: both are set by the act this agent
          // may not perform.
        })
        .select('id')
        .single();

      if (error || !row) {
        // A duplicate id is the model naming one screen twice. The rest of the
        // inventory is still worth having, and the coverage matrix reports what
        // is missing rather than this deciding.
        console.error(
          JSON.stringify({ level: 'error', scope: 'screenInventory', detail: error?.message ?? 'no row' }),
        );
        continue;
      }

      written += 1;

      for (const scopeItemId of screen.coversScopeItems) {
        const { error: mapError } = await admin
          .schema('projects')
          .from('screen_scope_items')
          .insert({
            organization_id: job.organization_id,
            screen_id: row.id,
            scope_item_id: scopeItemId,
          });
        if (!mapError) mapped += 1;
      }
    }

    if (written === 0) {
      const detail = 'no screen in the inventory could be written';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'inventoried', runId, screens: written, mappings: mapped };
  },
};

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Doc 08 §12: what a client's message means, from its own list of twenty-two.
 *
 * **The first step of Doc 03 §5's "Respond to new WhatsApp leads", and the only
 * step of it that is not §3 work.** Answering a lead reaches a client and comes
 * to the internal group; reading one does not touch anybody. ADM-61 §2, "update
 * internal work".
 *
 * The label causes nothing. No trigger fires on it, no status moves with it, no
 * proposal is accepted by it — which is the whole reason an agent may write it.
 * `acceptance` and `approval` are the two intents that make that necessary:
 * business rules §5 forbids treating a client's word as a fact at any level,
 * and Doc 08 §14 wants a confirmation flow rather than an inference. An
 * `acceptance` label means somebody should look.
 */
const INTENT_PROMPT = [
  'You read one message from a client and name what it is.',
  'Choose exactly one intent from the list and quote the words you read it from.',
  'If the message is ambiguous, choose the plainer reading — you are not deciding anything,',
  'and a wrong label costs a person a moment while a wrong assumption costs them a client.',
  'A message saying yes is still only a message: naming it acceptance accepts nothing.',
].join(' ');

const MESSAGE_INTENT: AgentWorkflow = {
  jobKind: 'message.intent',
  agentKey: 'sales',
  systemPrompt: INTENT_PROMPT,
  schemaName: 'MessageIntent',
  jsonSchema: messageIntentJsonSchema,
  // ADM-61 §2, "update internal work". Nobody is answered by this.
  workClass: 'internal_plan',

  async run(ctx) {
    const { admin, job } = ctx;
    const messageId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!messageId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: message } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('id, conversation_id, body, author_type, intent')
      .eq('id', messageId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!message) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'message no longer exists' };
    }

    if (message.intent !== null) {
      // Already read. The label is written once — a second reading is a record
      // of what somebody currently believes rather than of what was read.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'already read', intent: message.intent };
    }

    if (message.author_type !== 'client') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'not a client message' };
    }

    const runId = await openRun(ctx, {
      type: 'crm.conversation_message',
      id: message.id,
      input: { messageId: message.id, conversationId: message.conversation_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: `The client wrote:\n\n${message.body}` }],
      runId,
    );

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

    const validated = messageIntentSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // **Two columns, and neither of them can act.** No status, no lead, no
    // proposal — there is no path from a label to any of those to guard.
    const { error: writeError } = await admin
      .schema('crm')
      .from('conversation_messages')
      .update({ intent: validated.data.intent, intent_by_agent: ctx.agent.key })
      .eq('id', message.id)
      .eq('organization_id', job.organization_id);

    if (writeError) {
      await finishRun(admin, runId, 'failed', writeError.message, call.stepCount);
      await failJob(admin, job, writeError.message);
      return { status: 'failed', reason: 'persist failed', runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'read', runId, intent: validated.data.intent };
  },
};

// ═══════════════════════════════════════════════════════════════════════════

const TEST_PLAN_PROMPT = [
  'You decide what a project must be tested for, before anybody tests it.',
  'You are given the agreed scope, item by item, with its acceptance criteria.',
  'For each item say which testing categories apply and why — the reason is the',
  'part a human will actually check, so make it about THIS item, not testing in general.',
  'Mark an item as on the critical path when the project fails commercially if it fails.',
  'Not every category applies to every item; do not pad the plan to look thorough.',
  'You are not testing anything, not scoring readiness, and not deciding whether',
  'the project may be released. Say what needs looking at, and why.',
].join(' ');

const QA_TEST_PLAN: AgentWorkflow = {
  jobKind: 'qa.plan',
  agentKey: 'quality_assurance',
  systemPrompt: TEST_PLAN_PROMPT,
  schemaName: 'TestPlan',
  jsonSchema: testPlanJsonSchema,
  // ADM-61 §2 `draft`. Doc 14 §21's hard gates are deterministic policy and
  // §19's readiness score is Admin-configurable; this writes neither, and the
  // schema has no field for either. What QA is uniquely entitled to do —
  // verify another agent's work — is a different act and is untouched here.
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const versionId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!versionId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: baseline } = await admin
      .schema('projects')
      .from('scope_versions')
      .select('id, project_id, status, version')
      .eq('id', versionId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!baseline) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'scope version no longer exists' };
    }

    // Doc 14 §3: "QA tests the approved baseline." A superseded baseline is
    // not the approved one, and a plan written against it tests the wrong
    // project.
    if (baseline.status !== 'active') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `baseline is ${baseline.status}, not active` };
    }

    const { data: already } = await admin
      .schema('qa')
      .from('test_plans')
      .select('id')
      .eq('scope_version_id', baseline.id)
      .maybeSingle();

    if (already) {
      // One plan per baseline, and the unique index says so too. A retry that
      // reaches here has already done its work.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this baseline already has a plan', planId: already.id };
    }

    // Excluded items are not planned for, for the same reason the designer is
    // never shown one: a test written for a feature nobody bought is a defect
    // raised against work that was never owed.
    const { data: items } = await admin
      .schema('projects')
      .from('scope_items')
      .select('id, title, detail, inclusion, acceptance_criteria')
      .eq('scope_version_id', baseline.id)
      .in('inclusion', ['included', 'optional'])
      .order('position', { ascending: true });

    const testable = items ?? [];

    if (testable.length === 0) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the baseline includes nothing to test' };
    }

    const brief = testable
      .map(
        (i) =>
          `- id: ${i.id}\n  scope item: ${i.title}` +
          (i.detail ? `\n  detail: ${i.detail}` : '') +
          (i.acceptance_criteria ? `\n  accepted when: ${i.acceptance_criteria}` : '') +
          (i.inclusion === 'optional' ? '\n  (optional)' : ''),
      )
      .join('\n');

    const runId = await openRun(ctx, {
      type: 'projects.scope_version',
      id: baseline.id,
      input: { scopeVersionId: baseline.id, projectId: baseline.project_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: `The agreed scope:\n\n${brief}` }],
      runId,
    );

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

    const validated = testPlanSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // An item the agent invented is not an agreed item. Caught here so the
    // failure names the problem; the foreign key would only report a uuid.
    const known = new Set(testable.map((i) => i.id));
    const invented = validated.data.items.filter((i) => !known.has(i.scopeItemId));

    if (invented.length > 0) {
      const detail = `the plan tests ${invented.length} item(s) that are not in this baseline`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data: plan, error: planError } = await admin
      .schema('qa')
      .from('test_plans')
      .insert({
        organization_id: job.organization_id,
        project_id: baseline.project_id,
        scope_version_id: baseline.id,
        drafted_by_agent: ctx.agent.key,
      })
      .select('id')
      .single();

    if (planError || !plan) {
      const detail = planError?.message ?? 'the plan row could not be written';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'persist failed', detail, runId };
    }

    let written = 0;

    for (const item of validated.data.items) {
      const { error } = await admin
        .schema('qa')
        .from('test_plan_items')
        .insert({
          organization_id: job.organization_id,
          plan_id: plan.id,
          scope_item_id: item.scopeItemId,
          category: item.category,
          reason: item.reason,
          critical_path: item.criticalPath,
        });

      if (error) {
        // The model naming one (item, category) pair twice is a duplicate, not
        // a reason to discard the rest of a plan that is otherwise usable.
        console.error(
          JSON.stringify({ level: 'error', scope: 'qaTestPlan', detail: error.message }),
        );
        continue;
      }

      written += 1;
    }

    await succeedRun(
      admin,
      runId,
      { planId: plan.id, items: written } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'planned', runId, planId: plan.id, items: written };
  },
};


const CHECK_IN_PROMPT = [
  'A client has just accepted a handover. You prepare the check-in a person will have with them.',
  'You are given what the project left behind: what is still open, and what was raised during it.',
  'List the points worth raising, each as a kind and a note that says why it is worth raising.',
  'Be specific to this project — a point that would fit any client is not worth a person\'s time.',
  'You are not writing to the client and you are not promising anything.',
  'If something looks like new paid work, say so and stop there; a person prices it.',
].join(' ');

const CHECK_IN_BRIEF: AgentWorkflow = {
  jobKind: 'success.checkin',
  agentKey: 'customer_success',
  systemPrompt: CHECK_IN_PROMPT,
  schemaName: 'CheckInBrief',
  jsonSchema: checkInBriefJsonSchema,
  // ADM-61 §2 `internal_plan`. Doc 17 §22 puts the check-in itself under
  // customer success COMMUNICATION, which is §3 `client_facing` work and
  // stays with a person. This prepares it and sends nothing.
  workClass: 'internal_plan',

  async run(ctx) {
    const { admin, job } = ctx;
    const handoverId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!handoverId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: handover } = await admin
      .schema('projects')
      .from('handovers')
      .select('id, project_id, status, summary')
      .eq('id', handoverId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!handover) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'handover no longer exists' };
    }

    if (handover.status !== 'accepted') {
      // The event fires on the transition, so this can only be a replay of a
      // handover that was later reopened. There is no Day 0 to prepare for.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `handover is ${handover.status}, not accepted` };
    }

    const { data: already } = await admin
      .schema('crm')
      .from('check_in_briefs')
      .select('id')
      .eq('handover_id', handover.id)
      .maybeSingle();

    if (already) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this handover already has a brief', briefId: already.id };
    }

    // Doc 17 §18: "Review support history. Identify unresolved issues." The
    // history is `projects.maintenance_items`; reviewing it means reading it,
    // not recalling it, so the ids go over and come back on the points.
    const { data: items } = await admin
      .schema('projects')
      .from('maintenance_items')
      .select('id, title, description, status, ticket_type, raised_at')
      .eq('project_id', handover.project_id)
      .eq('organization_id', job.organization_id)
      .order('raised_at', { ascending: true });

    const history = items ?? [];

    const brief =
      history.length > 0
        ? history
            .map(
              (i) =>
                `- id: ${i.id}\n  raised: ${i.title}` +
                (i.description ? `\n  detail: ${i.description}` : '') +
                `\n  kind: ${i.ticket_type ?? 'unclassified'}\n  status: ${i.status}`,
            )
            .join('\n')
        : '(nothing was raised during this project)';

    const runId = await openRun(ctx, {
      type: 'projects.handover',
      id: handover.id,
      input: { handoverId: handover.id, projectId: handover.project_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content:
            `The handover said:\n\n${handover.summary ?? '(no summary was recorded)'}\n\n` +
            `What was raised during the project:\n\n${brief}`,
        },
      ],
      runId,
    );

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

    const validated = checkInBriefSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // A point may cite an item from THIS project's history or none at all. An
    // id from somewhere else is not a review of this project.
    const known = new Set(history.map((i) => i.id));
    const foreign = validated.data.points.filter(
      (p) => p.maintenanceItemId !== null && !known.has(p.maintenanceItemId),
    );

    if (foreign.length > 0) {
      const detail = `the brief cites ${foreign.length} item(s) that are not in this project's history`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data: row, error: briefError } = await admin
      .schema('crm')
      .from('check_in_briefs')
      .insert({
        organization_id: job.organization_id,
        project_id: handover.project_id,
        handover_id: handover.id,
        drafted_by_agent: ctx.agent.key,
      })
      .select('id')
      .single();

    if (briefError || !row) {
      const detail = briefError?.message ?? 'the brief row could not be written';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'persist failed', detail, runId };
    }

    let written = 0;

    for (const point of validated.data.points) {
      const { error } = await admin
        .schema('crm')
        .from('check_in_points')
        .insert({
          organization_id: job.organization_id,
          brief_id: row.id,
          kind: point.kind,
          note: point.note,
          maintenance_item_id: point.maintenanceItemId,
        });

      if (error) {
        console.error(
          JSON.stringify({ level: 'error', scope: 'checkInBrief', detail: error.message }),
        );
        continue;
      }

      written += 1;
    }

    await succeedRun(
      admin,
      runId,
      { briefId: row.id, points: written } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'prepared', runId, briefId: row.id, points: written };
  },
};


const PACKAGE_PROMPT = [
  'A project is being wrapped up. You list what its handover package owes the client.',
  'You are given what the project agreed to deliver and what was actually produced.',
  'For each obligation give its kind, a short label, and why THIS project owes it.',
  'List only what this project actually included — a package that owes a deployment',
  'for a project that was never deployed is a checklist nobody can complete.',
  'You are not handing anything over and you do not have the things themselves.',
  'Never write a credential, a password, a key or a URL that grants access.',
].join(' ');

const HANDOVER_PACKAGE: AgentWorkflow = {
  jobKind: 'handover.package',
  agentKey: 'handover',
  systemPrompt: PACKAGE_PROMPT,
  schemaName: 'HandoverPackage',
  jsonSchema: handoverPackageJsonSchema,
  // ADM-61 §2 `draft`. Delivering the package is §3's `delivery_approval` —
  // the one act Document 17 is entirely about, and the one this agent may
  // never perform alone. It lists obligations; a person meets them.
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const handoverId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!handoverId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: handover } = await admin
      .schema('projects')
      .from('handovers')
      .select('id, project_id, status')
      .eq('id', handoverId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!handover) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'handover no longer exists' };
    }

    if (handover.status !== 'preparing') {
      // Already delivered or accepted between the event and the claim. Listing
      // what a delivered package owes is a checklist for a decision already
      // made.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `handover is ${handover.status}, not preparing` };
    }

    const { data: already } = await admin
      .schema('projects')
      .from('handover_requirements')
      .select('id')
      .eq('handover_id', handover.id)
      .limit(1);

    if ((already ?? []).length > 0) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this package already knows what it owes' };
    }

    // What was agreed, and what was produced. Doc 17 §9's first two entries
    // are "final approved scope" and "final UI/design baseline", so both go
    // over — a package listed from the project's name alone would be a guess.
    const { data: baseline } = await admin
      .schema('projects')
      .from('scope_versions')
      .select('id')
      .eq('project_id', handover.project_id)
      .eq('organization_id', job.organization_id)
      .eq('status', 'active')
      .maybeSingle();

    const { data: agreed } = baseline
      ? await admin
          .schema('projects')
          .from('scope_items')
          .select('title, detail, inclusion')
          .eq('scope_version_id', baseline.id)
          .in('inclusion', ['included', 'optional'])
          .order('position', { ascending: true })
      : { data: [] };

    const { data: produced } = await admin
      .schema('projects')
      .from('deliverables')
      .select('kind, title, status')
      .eq('project_id', handover.project_id)
      .eq('organization_id', job.organization_id);

    const scopeText = (agreed ?? []).length
      ? (agreed ?? [])
          .map((i) => `- ${i.title}${i.detail ? `: ${i.detail}` : ''}${i.inclusion === 'optional' ? ' (optional)' : ''}`)
          .join('\n')
      : '(no agreed scope baseline was recorded)';

    const producedText = (produced ?? []).length
      ? (produced ?? []).map((d) => `- ${d.kind}: ${d.title} (${d.status})`).join('\n')
      : '(nothing was filed as a deliverable)';

    const runId = await openRun(ctx, {
      type: 'projects.handover',
      id: handover.id,
      input: { handoverId: handover.id, projectId: handover.project_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: `What was agreed:\n\n${scopeText}\n\nWhat was produced:\n\n${producedText}`,
        },
      ],
      runId,
    );

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

    const validated = handoverPackageSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    let written = 0;

    for (const requirement of validated.data.requirements) {
      const { error } = await admin
        .schema('projects')
        .from('handover_requirements')
        .insert({
          organization_id: job.organization_id,
          handover_id: handover.id,
          kind: requirement.kind,
          label: requirement.label,
          reason: requirement.reason,
          drafted_by_agent: ctx.agent.key,
          // No reference and no transfer_method: the requirements table has
          // neither, because those are the artifact and the artifact is a
          // person's.
        });

      if (error) {
        console.error(
          JSON.stringify({ level: 'error', scope: 'handoverPackage', detail: error.message }),
        );
        continue;
      }

      written += 1;
    }

    await succeedRun(
      admin,
      runId,
      { handoverId: handover.id, requirements: written } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'listed', runId, requirements: written };
  },
};


export const AGENT_WORKFLOWS: readonly AgentWorkflow[] = [
  REQUIREMENT_EXTRACT,
  MAINTENANCE_TRIAGE,
  PLAN_BREAKDOWN,
  SCREEN_INVENTORY,
  MESSAGE_INTENT,
  QA_TEST_PLAN,
  CHECK_IN_BRIEF,
  HANDOVER_PACKAGE,
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
