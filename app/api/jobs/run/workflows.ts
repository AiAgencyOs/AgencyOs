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
import type { AiAudioMediaType, AiMessage } from '@/lib/ai/types';
import type { Json } from '@/lib/db/types';
import {
  checkInBriefJsonSchema,
  checkInBriefSchema,
  clientReplyJsonSchema,
  clientReplySchema,
  followUpDraftJsonSchema,
  followUpDraftSchema,
  imageReadingJsonSchema,
  imageReadingSchema,
  messageIntentJsonSchema,
  messageIntentSchema,
  QUALIFICATION_AREAS,
  qualificationCoverageJsonSchema,
  qualificationCoverageSchema,
  redactLongDigitRuns,
  requirementJsonSchema,
  requirementPayloadSchema,
} from '@/modules/crm/schema';
import { MAX_EXTRACTION_MESSAGES } from '@/modules/crm/service';
import { testPlanJsonSchema, testPlanSchema } from '@/modules/qa/schema';
import {
  objectionReadingJsonSchema,
  objectionReadingSchema,
  parseQuotationDocument,
  quotationScopeJsonSchema,
  quotationScopeSchema,
} from '@/modules/sales/schema';
import { PRICING_KNOWLEDGE } from '@/modules/sales/pricing-knowledge';
import { approvalDecidedEventSchema } from '@/modules/crm/schema';
import {
  deliveryOf,
  readingIsTheirWords,
  transcriptContent,
  transcriptForModel,
} from '@/modules/crm/types';
import { fetchWhatsAppMedia } from '@/lib/whatsapp/media';
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

import { resolveTranscriber } from '@/lib/ai/router';
import { TRANSCRIPTION_MODEL } from '@/lib/ai/openai';

import {
  callModel,
  failJob,
  finishRun,
  openRun,
  recordModelCall,
  settledSucceeded,
  succeedRun,
  type AgentContext,
} from './agent-run';

/**
 * What one message says, for a workflow that reads a single one rather than a
 * transcript.
 *
 * `message.body` was read directly, which was right while every message was
 * text and became wrong the moment media was recorded: a media row's body is
 * empty by constraint, so the intent read and the objection read were each
 * handed `The client wrote:` and nothing after it, and a model asked to name
 * what a message means from an empty string will name something.
 *
 * Through the same function the transcript uses, so an image that has been
 * looked at reads as what was seen and one that has not says so — a single
 * message and a whole conversation cannot disagree about what a photograph
 * contained.
 */
function clientSaid(message: {
  body: string | null;
  metadata: unknown;
  media_description: string | null;
}): string {
  const media = deliveryOf(message.metadata);
  return (
    transcriptContent(message.body, media.mediaKind, {
      description: message.media_description,
      caption: media.caption,
    }) ?? ''
  );
}

/**
 * The same message, with one thing said out loud: whether the client wrote any
 * words of their own.
 *
 * The intent read asks for two things at once — what the message MEANS, and
 * what language it was WRITTEN in — and those two want different material. The
 * meaning of a photograph is the description; the language of a photograph is
 * nothing at all.
 *
 * Handing over only `clientSaid` conflated them, and production showed it: a
 * screenshot with no caption came back tagged `en`, because the agent's own
 * English description was the only prose in front of the model. It cost
 * nothing that time. It would have cost a great deal from a client whose FIRST
 * message was a caption-less screenshot — `crm.maintain_preferred_language`
 * writes the contact's preferred language from the first message that carries
 * one and never again, so that client would have been answered in English for
 * the life of the relationship.
 */
function clientTurn(message: {
  body: string | null;
  metadata: unknown;
  media_description: string | null;
}): string {
  const media = deliveryOf(message.metadata);
  // A transcript is the client speaking, written down. A description of a
  // photograph is the agent's own sentence. `readingIsTheirWords` owns that
  // distinction, and the transcript renderer asks it the same question.
  const spoken = readingIsTheirWords(media.mediaKind) ? (message.media_description ?? '').trim() : '';
  const theirWords = (message.body ?? '').trim() || media.caption || spoken;

  return [
    `The client's message:\n\n${clientSaid(message)}`,
    theirWords
      ? `\n\nThe words THEY used: ${theirWords}`
      : '\n\nThey used no words at all. Anything above in square brackets is the agent describing what they sent.',
  ].join('');
}

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
      .select('seq, author_type, body, metadata, media_description')
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
  'Also say which language THEY wrote in, as a short tag: hi, en, and so on.',
  'If it genuinely mixes two, join them — Hinglish is hi-en. Say what was written,',
  'not what you think the client would prefer.',
  'A message asking to change, add to, remove from, or re-price a quotation —',
  'their words will name one, you cannot see it — is change_request, on a lead',
  'as much as on a project.',
  'A transcribed voice note counts: those are their words, spoken instead of typed.',
  'If they used no words at all — a photograph with no caption — the language is null.',
  'A description of a photograph is the agent\'s sentence, not theirs, and its language',
  'is not theirs.',
  'Finally: if this message STATES a durable fact about the client — who decides, what they',
  'already use, a constraint they named — record it. Most messages state none; say null then.',
  'It must be what they said, not what it suggests. "My co-founder signs off on spend" is a fact.',
  '"Seems price-sensitive" is a guess, and guesses are not memory.',
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
      .select('id, conversation_id, body, author_type, intent, language, metadata, media_description')
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

    // The lead this thread belongs to, for Doc 05 §5's scope. Read before the
    // model call rather than after, so a conversation with no lead costs
    // nothing to discover — there is nowhere to file a memory against it.
    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, lead_id')
      .eq('id', message.conversation_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    const runId = await openRun(ctx, {
      type: 'crm.conversation_message',
      id: message.id,
      input: { messageId: message.id, conversationId: message.conversation_id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: clientTurn(message) }],
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
      .update({
        intent: validated.data.intent,
        intent_by_agent: ctx.agent.key,
        // Doc 08 §8, written in the same statement as the intent because it
        // came back from the same call. The message body is untouched — §8's
        // "Keep original message unchanged as source evidence", and there is
        // no column a translation could go in.
        //
        // Null when the client wrote no words. Left null rather than guessed:
        // `crm.maintain_preferred_language` reads this column to set the
        // contact's preferred language once and for ever, and it skips a null
        // — so a caption-less photograph leaves the question open for the next
        // message to answer instead of answering it wrongly.
        //
        // **And omitted entirely when the column already has a value.**
        //
        // A voice note has TWO readers with an opinion about its language: the
        // transcriber, which heard it, and this, which reads the transcript.
        // The transcriber writes first, so this one wrote second — and
        // `freeze_message_language` refused it, correctly, taking the whole
        // intent read down with it. The owner's first successfully transcribed
        // recording produced exactly that: `language: hi` from the transcriber
        // at 18:02, and a failed job at 18:04 saying *"the language of a
        // message is what it was written in, not what somebody thinks now"* —
        // so the message was never labelled at all, and the job was on its way
        // to burning five model calls to fail the same way.
        //
        // The freeze is right and the fix belongs here. Whoever read it first
        // read it from the thing itself; this one is reading a transcript of
        // it, which is further away.
        ...(message.language === null ? { language: validated.data.language } : {}),
      })
      .eq('id', message.id)
      .eq('organization_id', job.organization_id);

    if (writeError) {
      await finishRun(admin, runId, 'failed', writeError.message, call.stepCount);
      await failJob(admin, job, writeError.message);
      return { status: 'failed', reason: 'persist failed', runId };
    }

    // Doc 05 §5, and the first thing in this system ever to write a memory.
    //
    // `explicit` with the message as provenance, which the table's own
    // constraints make the only honest option: a row claiming to be explicit
    // must name where it came from, and an agent may never write `verified`
    // at all. So the strongest thing an agent can record is "the client said
    // this, here" — checkable by opening the thread.
    //
    // Best-effort, and after the label is written: a memory that fails to
    // save must not cost the reading that did succeed. The lead is the scope
    // because Doc 05 §5 is Lead Memory, and a lead that never becomes a
    // client still has facts worth keeping.
    let remembered = false;
    if (validated.data.clientFact && conversation?.lead_id) {
      const { error: memoryError } = await admin
        .schema('ai')
        .from('memory_records')
        .insert({
          organization_id: job.organization_id,
          scope: 'lead',
          scope_id: conversation.lead_id,
          kind: validated.data.clientFact.kind,
          fact: validated.data.clientFact.fact,
          confidence: 'explicit',
          source_kind: 'crm.conversation_message',
          source_id: message.id,
          authored_by_agent: ctx.agent.key,
        });

      if (memoryError) {
        console.error(
          JSON.stringify({ level: 'error', scope: 'messageIntent.memory', detail: memoryError.message }),
        );
      } else {
        remembered = true;
      }
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'read', runId, intent: validated.data.intent, remembered };
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


const QUALIFY_PROMPT = [
  'You read a sales conversation and say which qualification areas it has ALREADY answered.',
  'You are told which areas are still open — say nothing about the ones that are not listed.',
  'For each area the client has answered, quote the words they answered it in.',
  'Only what the CLIENT said counts. What the agency asked is not an answer,',
  'and an area nobody has addressed is left out rather than guessed at.',
  'Do not interpret an amount, a date or a decision — quote the sentence and stop.',
  'If the conversation answers nothing new, return an empty list. That is a real answer.',
].join(' ');

const QUALIFICATION_READ: AgentWorkflow = {
  jobKind: 'lead.qualify',
  // The sales agent, which Document 09 names for this by name — §9's "The
  // Sales Agent should not interrogate the lead with a rigid checklist when
  // the conversation already provides the answer" — and which is already
  // reading every inbound message for its intent.
  //
  // NOT `lead_qualifier`, whose name fits and whose row exists: it is one of
  // the two agents installed without a definition, and G-125's closure
  // condition 11 says it "is not accidentally enabled as an unimplemented
  // independent runtime agent". Reaching for it would have been building a
  // feature by breaking a decision.
  agentKey: 'sales',
  systemPrompt: QUALIFY_PROMPT,
  schemaName: 'QualificationCoverage',
  jsonSchema: qualificationCoverageJsonSchema,
  // ADM-61 §2 `read`. Nothing is drafted, nothing is planned and nothing
  // reaches the client — Doc 09 §9 is about noticing what is already there.
  workClass: 'read',

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
      .select('id, conversation_id, author_type')
      .eq('id', messageId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!message) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'message no longer exists' };
    }

    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, lead_id')
      .eq('id', message.conversation_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!conversation?.lead_id) {
      // A thread with no lead is a client account or an internal group. There
      // is nothing to qualify.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this conversation belongs to no lead' };
    }

    const { data: knownRows } = await admin
      .schema('crm')
      .from('qualification_coverage')
      .select('area')
      .eq('lead_id', conversation.lead_id)
      .eq('organization_id', job.organization_id);

    const known = new Set((knownRows ?? []).map((r) => r.area));
    const open = QUALIFICATION_AREAS.filter((a) => !known.has(a));

    if (open.length === 0) {
      // Every area is answered. Re-reading converges on nothing and costs a
      // model call per message for ever, which is how a cheap agent becomes
      // an expensive one.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this lead is fully qualified' };
    }

    const { data: rows } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('author_type, body, seq, metadata, media_description')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', job.organization_id)
      .order('seq', { ascending: true })
      .limit(MAX_EXTRACTION_MESSAGES);

    const transcript = transcriptForModel(rows ?? []);

    if (!transcript.trim()) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'nothing readable in this conversation' };
    }

    const runId = await openRun(ctx, {
      type: 'crm.lead',
      id: conversation.lead_id,
      input: { leadId: conversation.lead_id, conversationId: conversation.id, open } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: `Still open:\n\n${open.join('\n')}\n\nThe conversation:\n\n${transcript}`,
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

    const validated = qualificationCoverageSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // A restatement is dropped, not treated as a failure — and that correction
    // came from production.
    //
    // This used to fail the whole run when the model named an area that was
    // already answered, reasoning that a model ignoring the "still open" list
    // should not half-write. But a model handed the whole transcript reads the
    // whole transcript, so it restates as a matter of course: on the owner's
    // first real conversation three runs failed this way, one job burned four
    // attempts before it happened to succeed, and another was heading for
    // `dead` at five.
    //
    // What that cost was the areas it DID find. Nothing is harmed by a
    // restatement — the unique index refuses the duplicate row anyway — so the
    // new ones are written and the rest are ignored. Thoroughness is not an
    // error.
    const openSet = new Set(open);
    const fresh = validated.data.covered.filter((c) => openSet.has(c.area));
    const restated = validated.data.covered.length - fresh.length;

    let written = 0;

    for (const covered of fresh) {
      const { error } = await admin
        .schema('crm')
        .from('qualification_coverage')
        .insert({
          organization_id: job.organization_id,
          lead_id: conversation.lead_id,
          conversation_id: conversation.id,
          area: covered.area,
          quote: covered.quote,
          read_by_agent: ctx.agent.key,
        });

      if (error) {
        console.error(
          JSON.stringify({ level: 'error', scope: 'qualificationRead', detail: error.message }),
        );
        continue;
      }

      written += 1;
    }

    await succeedRun(
      admin,
      runId,
      { leadId: conversation.lead_id, areas: written, restated, stillOpen: open.length - written } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'read', runId, areas: written, restated };
  },
};


const OBJECTION_PROMPT = [
  'A client has pushed back on something. You say which kind of objection it is,',
  'and quote the words they raised it in.',
  'price — the cost, the budget, a discount, the payment amount.',
  'trust — doubt that the work will be finished, or that the agency is safe to pay.',
  'timeline — the schedule is wrong for them.',
  'feature — what is included is not what they expected, or they are asking to add',
  'or remove something from the scope.',
  'Quote the client, do not summarise them, and pick the concern they actually lead with.',
  'You are not answering the objection. You do not offer a discount, a payment plan,',
  'a new deadline or any reassurance — a person decides all of those.',
].join(' ');

const OBJECTION_READ: AgentWorkflow = {
  jobKind: 'objection.read',
  agentKey: 'sales',
  systemPrompt: OBJECTION_PROMPT,
  schemaName: 'ObjectionReading',
  jsonSchema: objectionReadingJsonSchema,
  // ADM-61 §2 `read`. Doc 09 §13 defines a RESPONSE as offering an approved
  // structure, requesting an Admin exception or presenting evidence — every
  // one of them §3 `client_facing`, and the payment structures §3 `money`
  // besides. This reads; the row rule refuses it writing an answer.
  workClass: 'read',

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
      .select('id, conversation_id, body, intent, metadata, media_description')
      .eq('id', messageId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!message) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'message no longer exists' };
    }

    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, lead_id')
      .eq('id', message.conversation_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!conversation?.lead_id) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this conversation belongs to no lead' };
    }

    const { data: seen } = await admin
      .schema('sales')
      .from('objections')
      .select('id')
      .eq('message_id', message.id)
      .maybeSingle();

    if (seen) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this message is already recorded', objectionId: seen.id };
    }

    const runId = await openRun(ctx, {
      type: 'crm.conversation_message',
      id: message.id,
      input: { messageId: message.id, leadId: conversation.lead_id, intent: message.intent } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [{ role: 'user', content: `The client wrote:\n\n${clientSaid(message)}` }],
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

    const validated = objectionReadingSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // §20's round: this objection's place in the sequence for this lead. Read
    // rather than counted from a cached number, because two objections raised
    // in the same tick would both read a stale count — and the unique index on
    // (lead_id, round) is what turns that race into a refusal rather than two
    // rows both called round 3.
    const { data: sofar } = await admin
      .schema('sales')
      .from('objections')
      .select('round')
      .eq('lead_id', conversation.lead_id)
      .eq('organization_id', job.organization_id)
      .order('round', { ascending: false })
      .limit(1);

    const round = ((sofar ?? [])[0]?.round ?? 0) + 1;

    // The quotation this was raised against, when there is one. §20's "track
    // quote version" — and it is READ rather than decided: the live version is
    // whichever one is currently out with the client.
    const { data: opportunity } = await admin
      .schema('sales')
      .from('opportunities')
      .select('id')
      .eq('lead_id', conversation.lead_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    const { data: live } = opportunity
      ? await admin
          .schema('sales')
          .from('proposals')
          .select('id')
          .eq('opportunity_id', opportunity.id)
          .in('status', ['sent', 'approved'])
          .order('version', { ascending: false })
          .limit(1)
      : { data: [] };

    const { data: row, error: writeError } = await admin
      .schema('sales')
      .from('objections')
      .insert({
        organization_id: job.organization_id,
        lead_id: conversation.lead_id,
        message_id: message.id,
        round,
        proposal_id: (live ?? [])[0]?.id ?? null,
        kind: validated.data.kind,
        concern: validated.data.concern,
        raised_by_agent: ctx.agent.key,
        // No response, no outcome, no next action. The row rule refuses them
        // from an agent regardless; their absence here is why it never has to.
      })
      .select('id')
      .single();

    if (writeError || !row) {
      const detail = writeError?.message ?? 'the objection row could not be written';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'persist failed', detail, runId };
    }

    await succeedRun(
      admin,
      runId,
      { objectionId: row.id, kind: validated.data.kind, round } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'recorded', runId, objectionId: row.id, round };
  },
};


/**
 * How much of the thread a follow-up is written from.
 *
 * Eight turns is the last exchange and a little either side — enough to name
 * what was being discussed, and short of Doc 05 §20's *"never send the entire
 * project history by default"*. A nudge written from forty messages is a nudge
 * that quotes something from three weeks ago.
 */
const FOLLOW_UP_CONTEXT_MESSAGES = 8;

const FOLLOW_UP_PROMPT = [
  'You write one short follow-up message to a client who has not replied.',
  'You are given the end of the conversation. Use it.',

  'REFER TO THE ACTUAL THING. Name what you were last talking about, in their words:',
  '"kal jo booking flow ke baare mein baat hui thi, uska ek point clear karna tha".',
  'NEVER "any update?", "just following up", "checking in", "did you get a chance to look":',
  'those are what somebody writes when they cannot remember the conversation, and the client',
  'can tell. If the thread genuinely gives you nothing to name, say the one thing that is',
  'outstanding and stop — a plain question beats a manufactured memory.',

  'LANGUAGE. Theirs, matched to how they write it. Hinglish means Hinglish.',

  'LENGTH. A line or two. This is a nudge, not the conversation — you are reopening a door,',
  'not walking through it.',

  'NO NUMBERS AT ALL — no price, no date, no percentage, no count, and none quoted back',
  'out of the thread either. The database refuses a digit and the message would never send.',
  'Promise nothing, offer nothing, apologise for nothing and explain nothing.',
].join(' ');

const FOLLOW_UP_DRAFT: AgentWorkflow = {
  jobKind: 'followup.compose',
  agentKey: 'sales',
  systemPrompt: FOLLOW_UP_PROMPT,
  schemaName: 'FollowUpDraft',
  jsonSchema: followUpDraftJsonSchema,
  /**
   * The only `client_facing` workflow in this system, and ADM-61 names the
   * reason: *"L2 acts alone on internal work and asks for anything
   * client-facing or touching money, with the ADM-11 follow-ups as the single
   * exception."* A test asserts it stays the only one — a second would be a
   * decision somebody has to make rather than a workflow somebody adds.
   *
   * Sales is L1, so the gate allows it whatever the class. Declaring it
   * honestly matters anyway: the run record then says what was actually done,
   * and if this agent were ever moved to L2 the gate would refuse it and
   * somebody would have to reckon with ADM-11 rather than discover it.
   */
  workClass: 'client_facing',

  async run(ctx) {
    const { admin, job } = ctx;
    const sequenceId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!sequenceId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    const { data: sequence } = await admin
      .schema('crm')
      .from('follow_up_sequences')
      .select('id, organization_id, situation_key, status, conversation_id, contact_id, drafted_body, subject_type, subject_id')
      .eq('id', sequenceId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!sequence) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'sequence no longer exists' };
    }

    if (sequence.status !== 'active') {
      // Stopped between the schedule and the claim — the client replied, or
      // somebody closed it. Writing a nudge for a conversation that has moved
      // on is worse than writing nothing.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `sequence is ${sequence.status}, not active` };
    }

    if (sequence.drafted_body) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this sequence already has a draft' };
    }

    // Doc 08 §8: write back in the language they write in. Absent — a contact
    // who has never written, or one whose messages nothing has read — the
    // draft is skipped rather than guessed at, and the neutral placeholder
    // goes out instead. Guessing a language is how a Hindi-speaking client
    // gets a nudge in a language they did not choose.
    const { data: contact } = sequence.contact_id
      ? await admin
          .schema('crm')
          .from('contacts')
          .select('preferred_language')
          .eq('id', sequence.contact_id)
          .eq('organization_id', job.organization_id)
          .maybeSingle()
      : { data: null };

    const language = contact?.preferred_language ?? null;

    if (!language) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'no language is recorded for this contact' };
    }

    // Doc 05 §19: *"Agents should receive relevant context dynamically rather
    // than dumping all historical information into every model call."* This
    // is the first thing in this system to recall a memory, and the composer
    // is where it earns its keep — a nudge written from a situation key and a
    // language tag is a nudge that could go to anybody.
    //
    // Through `ai.recall`, which orders by Doc 05 §18's confidence and drops
    // superseded and expired rows, so the ranking is the document's rather
    // than this workflow's. Capped low on purpose: §20's *"Never send the
    // entire project history by default."*
    const { data: memories } = sequence.subject_type === 'lead' && sequence.subject_id
      ? await admin.schema('ai').rpc('recall', {
          p_scope: 'lead',
          p_scope_id: sequence.subject_id,
          p_limit: 8,
        })
      : { data: [] };

    const known = (memories ?? []).map((m) => `- ${m.fact}`).join('\n');

    /**
     * The end of the conversation — the one thing this composer never had.
     *
     * It was given a situation key, a language and a handful of durable facts,
     * and asked for a follow-up. From that the only honest message is *"any
     * update?"* — which is the owner's brief §17 quoting the bad example
     * verbatim, and which a client reads as *nobody here remembers talking to
     * me*. A memory is what they told us once; a transcript is what we were
     * last saying.
     *
     * The TAIL, not the thread: Doc 05 §20 — *"Never send the entire project
     * history by default"* — and a nudge is written from the last exchange
     * rather than from the whole relationship. Ordered ascending after the
     * read so the model sees them in the order they were said.
     */
    const { data: tail } = sequence.conversation_id
      ? await admin
          .schema('crm')
          .from('conversation_messages')
          .select('author_type, body, seq, metadata, media_description')
          .eq('conversation_id', sequence.conversation_id)
          .eq('organization_id', job.organization_id)
          .order('seq', { ascending: false })
          .limit(FOLLOW_UP_CONTEXT_MESSAGES)
      : { data: [] };

    const recent = transcriptForModel([...(tail ?? [])].reverse());

    const runId = await openRun(ctx, {
      type: 'crm.follow_up_sequence',
      id: sequence.id,
      input: {
        sequenceId: sequence.id,
        situation: sequence.situation_key,
        language,
        context: (tail ?? []).length,
      } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content:
            (recent
              ? `How the conversation ended:\n\n${recent}\n\n`
              : 'There is no conversation to draw on — this thread has nothing in it.\n\n') +
            `What is outstanding: ${sequence.situation_key}\n` +
            `Write in: ${language}` +
            (known ? `\n\nWhat this client has told us:\n${known}` : ''),
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

    const validated = followUpDraftSchema.safeParse(call.json);
    if (!validated.success) {
      // Includes the digit rule. A model that writes a price into a follow-up
      // fails here, fails again at the constraint, and the placeholder goes —
      // three layers, and the client never sees the number.
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { error: writeError } = await admin
      .schema('crm')
      .from('follow_up_sequences')
      .update({
        drafted_body: validated.data.body,
        drafted_language: language,
        drafted_by_agent: ctx.agent.key,
        drafted_at: new Date().toISOString(),
      })
      .eq('id', sequence.id)
      .eq('organization_id', job.organization_id);

    if (writeError) {
      await finishRun(admin, runId, 'failed', writeError.message, call.stepCount);
      await failJob(admin, job, writeError.message);
      return { status: 'failed', reason: 'persist failed', detail: writeError.message, runId };
    }

    await succeedRun(
      admin,
      runId,
      { sequenceId: sequence.id, language } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'drafted', runId, language };
  },
};


/**
 * What the sales agent is told about how to talk.
 *
 * Written as a person's brief rather than a machine's, because the failure it
 * exists to prevent is not a wrong fact — it is a client reading three
 * sentences and knowing nobody is there. The first live reply opened
 * "Great! 😊", asked one clean question, and read exactly like software.
 *
 * Four things are held here that no constraint can hold: how long to be, how
 * to lay a long answer out, which language to be in, and when to say nothing
 * useful is possible without a person. The rules that CAN be held at the row —
 * no price, no amount — are held there instead (`crm.refuse_unread_price`),
 * because a prompt is a request and a client is on the other end of this one.
 */
const REPLY_PROMPT = [
  'You are a salesperson at this agency with thirty years behind you: apps, websites,',
  'software, design, automation. You are on WhatsApp with someone who wrote in.',
  'You are not a form, a survey, or a support bot. You are the person who has had',
  'this conversation a thousand times and still finds it interesting.',

  'LANGUAGE. Answer in the language they wrote in, matched to how they write it.',
  'English to English. Hindi to Hindi. Hinglish to Hinglish — and Hinglish means',
  'Hinglish, not translated Hindi: "aapke mind mein kis type ka app hai?", never',
  '"कृपया अपनी लक्षित ग्राहक-वर्ग की जानकारी प्रदान करें". If they switch, you switch.',
  'Simple words if they use simple words. Technical words only if they do.',

  'LENGTH follows the question, not a rule. A small question gets a small answer.',
  'A real question — "what features would an app like this need?" — gets a real one.',
  'Never pad. Never withhold something useful to stay short.',

  'LAYOUT. This is WhatsApp. A long answer is never one block of text.',
  'Break it: a line to open, then numbered sections with short bullets under them,',
  'then one line asking what matters most to them. Blank lines between sections.',
  'Use numbers when things are steps or options, bullets when they are independent.',

  'TONE. No emoji, almost always. One occasionally, if it is genuinely how you would write.',
  'Never open with "Great!", "Absolutely!", "Certainly!" or "Thank you for providing that".',
  'Say "achha", "samajh gaya", "got it", "bilkul", "theek hai" — and vary it.',
  'Use "sir" only if they do, and not in every sentence.',

  'WHAT TO ASK. You are told which things about this project are still unknown.',
  'That is context, not a checklist — ask the one that would genuinely help you next,',
  'and only when it fits. Never ask what the thread already answered.',
  'Do not open with budget, platform or target users. Understand the idea first.',

  'MONEY. Never a number: no price, no range, no discount, no delivery date.',
  'If they ask what it costs — and they will — answer it properly rather than dodging:',
  'say it depends on scope, ask what the app needs to do, and tell them a colleague',
  'will give them a proper figure once that is clear. Never invent one to seem helpful.',

  'WHY, NOT ONLY WHAT. Doc 09 §15: a client who feels understood buys. Before scope,',
  'understand the business — what they do, who it is for, what problem this solves,',
  'how it makes money. "App like Uber" is not a requirement, it is a reference.',
  'Ask what makes theirs different. They should feel you understood the business,',
  'not that you took an order.',

  'WHEN THEY ARE READY, STOP DISCOVERING. Asking a price, a timeline, payment terms,',
  'how you work, when you could start, whether you have done this before — that is',
  'somebody deciding, not somebody browsing. Answer what they asked, confirm what is',
  'agreed, and name the next step. Do not go back to discovery questions.',
  'Doc 09 §32 tells you where this lead stands; believe it over your instinct to ask more.',

  'BUDGET is not an opening question and not a forbidden one. Once they have told you',
  'what they want built and you have shown you understood it, asking whether they have',
  'a rough range in mind is normal. If they say they have not decided, drop it and',
  'carry on — do not ask twice.',

  'HONESTY. If they ask whether you are a person or an AI, tell them the truth plainly',
  'and carry on being useful. Do not deny it, do not make a speech about it, and do not',
  'change your tone afterwards. If they then ask for a person, get one.',

  'DO NOT ARGUE. If they say a competitor is cheaper, or that they had a bad experience,',
  'or that they are not sure — take it seriously and ask about it. Never get defensive,',
  'never talk them out of a concern, never compete on price. A concern explored is',
  'worth more than a concern answered.',

  'AND. Do not promise. Do not claim work exists that you have not been told about.',
  'If something needs a person — an exception, a commitment, anything you are unsure of —',
  'say a colleague will come back on it. That is a real answer, not a failure.',

  'CHANGES to a quotation they were sent — add this, remove that, a different',
  'price — are not yours to grant or refuse. Acknowledge exactly what they asked,',
  'say the team will confirm an updated quotation internally, and promise nothing',
  'about what it will say. This is not a hand-over; keep the conversation.',

  'HAND OVER when they ask for a human, when they want something you may not give',
  '(a discount, a fixed price, a guaranteed date, a payment structure), or when the',
  'conversation is going badly. Set handToHuman with the reason. Say so in the reply,',
  'plainly — "main abhi ek colleague ko bolta hoon, wo aapse baat karenge" — and stop.',
  'Everything after that message is theirs, not yours. Asking for help is not failing.',
  'Otherwise handToHuman is null.',
].join(' ');

/**
 * The sales file, as a salesperson would glance at it before answering.
 *
 * Document 09 §32 lists thirteen things the Sales Agent must have. This is the
 * eight that live in tables nothing was handing it. Rendered as prose rather
 * than as JSON, because the model is being asked to have a conversation and a
 * person glancing at a file does not read a payload.
 *
 * **Nothing here carries a number.** Not a price, not a quoted amount, not a
 * discount, not a deal value: the agent's own schema and
 * `crm.refuse_unread_price` would both refuse a reply containing one, and the
 * cheapest way not to say a number is not to be told one. What it is told
 * about a quotation is that a quotation EXISTS and whether the client has seen
 * it — which is exactly what changes how a salesperson talks, and none of what
 * ADM-22 reserves for a human.
 *
 * Omits every empty section rather than saying "none": a file of nine "none"s
 * reads as a checklist, and Doc 09 §9 is explicit that a checklist is what the
 * client must not feel.
 */
function salesFileFor(file: {
  leadStatus: string | null;
  requirement: { version: number; status: string; payload: unknown } | null;
  objections: ReadonlyArray<{ kind: string; concern: string; round: number; response: string | null; proposal_id: string | null }>;
  proposals: ReadonlyArray<{ id: string; version: number; status: string; sent_at: string | null }>;
  followUps: ReadonlyArray<{ situation_key: string; last_sent_at: string | null }>;
  portfolioCount: number;
}): string {
  const lines: string[] = [];

  if (file.leadStatus) lines.push(`Where this lead stands: ${file.leadStatus}`);

  if (file.requirement) {
    const payload = file.requirement.payload as { summary?: unknown; scopeItems?: unknown } | null;
    const summary = typeof payload?.summary === 'string' ? payload.summary : null;
    const items = Array.isArray(payload?.scopeItems)
      ? (payload.scopeItems as { title?: unknown }[])
          .map((i) => (typeof i.title === 'string' ? i.title : null))
          .filter((t): t is string => t !== null)
      : [];
    lines.push(
      `What we have written down so far (v${file.requirement.version}, ${file.requirement.status}):` +
        (summary ? ` ${summary}` : '') +
        (items.length ? `\n  Scope: ${items.join(', ')}` : ''),
    );
    // The one instruction the requirements imply. Doc 09 §9 asks the agent not
    // to interrogate what the conversation already answered, and this is the
    // sharpest form of that: it is written down, so it is answered.
    lines.push('You already know this. Do not ask it again.');
  }

  if (file.objections.length) {
    lines.push(
      'Concerns they have raised:\n' +
        file.objections
          .map(
            (o) =>
              `  ${o.round}. (${o.kind}) “${o.concern}”` +
              (o.response ? ' — a colleague has answered this' : ' — nobody has answered this yet'),
          )
          .join('\n'),
    );
    // Doc 09 §13's response strategy, minus everything it reserves for a
    // person. Acknowledging a concern and explaining how the agency works are
    // both things this agent may do; an advance structure and a guarantee are
    // not, and §13 lists them separately for that reason.
    lines.push(
      'You may acknowledge a concern and explain how we work — stage by stage, ' +
        'client approves each stage before the next invoice. You may NOT offer a ' +
        'payment structure, a discount or any guarantee: those are a colleague’s.',
    );
  }

  const sent = file.proposals.find((p) => p.status === 'sent');
  if (sent) {
    // §32's "Quote versions". The state, never the amount — and it changes the
    // conversation completely: a client who has a quotation in hand is not
    // being discovered, they are deciding.
    lines.push(
      `A quotation (v${sent.version}) has already gone to them. They are deciding, not being discovered — ` +
        'do not restart discovery. Ask what they think of it, or what is holding it up.',
    );
    // Brief §23. An open concern against the version that is out with them
    // means they have already answered the quote — with "change it" — and the
    // one honest reply is the one that promises nothing.
    // Against THIS version, specifically — the same condition as the
    // revision_asked tier. An old open concern from before this quotation
    // would otherwise make the agent apologise for a change nobody asked of
    // the number now on the table.
    if (file.objections.some((o) => o.response === null && o.proposal_id === sent.id)) {
      lines.push(
        'They have asked for the quotation to change. Say the team is preparing an ' +
          'updated version and it will reach them once it is confirmed internally. ' +
          'Do NOT promise any change, any price, or any date — the revision is not yours to shape.',
      );
    }
  } else if (file.proposals.length) {
    // What the client is actually HOLDING is the newest version that ever
    // went out — not the first superseded row the array happens to list.
    // Three revisions in, v1 and v2 are both superseded and the client has
    // v3; telling the agent "they are holding v1" would have it apologise
    // for a document two versions stale.
    const held = file.proposals
      .filter((p) => p.sent_at !== null)
      .sort((a, b) => b.version - a.version)[0];
    lines.push(
      held
        ? // The revision loop's middle: the client is holding v(n) while
          // v(n+1) is inside the machine. Saying "nothing has been sent"
          // would deny a document they can see.
          `They are holding an older quotation (v${held.version}); a revised one is being prepared internally. ` +
            'Say it is coming. Do not discuss what it will say, and promise nothing about it.'
        : 'A quotation is being prepared internally. It has not gone to them; do not mention it as sent.',
    );
  }

  if (file.followUps.length) {
    lines.push(
      `We have already followed up ${file.followUps.length === 1 ? 'once' : `${file.followUps.length} times`}` +
        ` (${file.followUps.map((f) => f.situation_key).join(', ')}). Do not repeat it.`,
    );
  }

  // ADM-12: samples come only from the Admin's list, and the list is empty
  // until they fill it. Told either way, because "we can show you work" when
  // there is none to show is a promise the agency cannot keep.
  lines.push(
    file.portfolioCount > 0
      ? `There is approved past work you may offer to show (${file.portfolioCount} item${file.portfolioCount === 1 ? '' : 's'}).`
      : 'There is NO approved past work to show. Do not offer samples, demos or a portfolio.',
  );

  return lines.length ? `\nThe sales file on this lead:\n${lines.join('\n')}\n` : '';
}

const CLIENT_REPLY: AgentWorkflow = {
  jobKind: 'reply.compose',
  agentKey: 'sales',
  systemPrompt: REPLY_PROMPT,
  schemaName: 'ClientReply',
  jsonSchema: clientReplyJsonSchema,
  /**
   * ADM-91, 2026-08-22 — the owner widened ADM-11 so a reply reaches the client
   * unread. Before it, ADM-61 §4 recorded follow-ups as "the only path in
   * AgencyOS where something reaches a client unread"; there are two now, and
   * this is the second.
   *
   * The five absolutes of ADM-61 §5 are untouched, and two of them are held at
   * the row rather than in this prompt — see `crm.refuse_agent_money_talk`.
   */
  workClass: 'client_facing',

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
      .select('id, conversation_id, seq, author_type')
      .eq('id', messageId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!message) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'message no longer exists' };
    }

    // The switch is read again here, not only at the trigger. A job queued
    // while replying was on must not send after somebody turns it off — the
    // gap between the two is exactly when an owner changes their mind.
    const { data: org } = await admin
      .schema('core')
      .from('organizations')
      .select('agent_answers_clients, name, settings')
      .eq('id', job.organization_id)
      .maybeSingle();

    if (!org?.agent_answers_clients) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this organization does not have agent replies switched on' };
    }

    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, lead_id, contact_id, status')
      .eq('id', message.conversation_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!conversation || conversation.status !== 'active') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the conversation is not active' };
    }

    // Somebody else may already have answered — a colleague typing a reply, or
    // an earlier job for a message that arrived seconds before this one. The
    // client should get one answer, not two.
    //
    // Excluding this job's OWN reply, and that exclusion is the whole reason a
    // refused send can be retried at all. `send_outbound_message` writes the
    // row before the provider is called, so a send Meta refuses still leaves a
    // message at a higher seq — and without this the retry reads its own
    // failed attempt as "somebody answered" and never sends the words it
    // already composed. Found on the owner's first real message, where Meta
    // answered 401 on a stale token.
    const { data: newer } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('id, author_type, external_ref')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', job.organization_id)
      .gt('seq', message.seq)
      .neq('external_ref', `reply:${message.id}`)
      .limit(1);

    if ((newer ?? []).length > 0) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the thread has moved on since this message' };
    }

    const { data: rows } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('author_type, body, seq, metadata, media_description')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', job.organization_id)
      .order('seq', { ascending: true })
      .limit(MAX_EXTRACTION_MESSAGES);

    const transcript = transcriptForModel(rows ?? []);

    // Doc 08 §8: reply in the language they write in. Absent, the agent answers
    // in the language of the thread it was just given — which is the honest
    // fallback, and better than guessing a tag.
    const { data: contact } = conversation.contact_id
      ? await admin
          .schema('crm')
          .from('contacts')
          .select('preferred_language')
          .eq('id', conversation.contact_id)
          .eq('organization_id', job.organization_id)
          .maybeSingle()
      : { data: null };

    // Doc 09 §9: do not interrogate a lead about what the conversation already
    // answered. The areas still open are the useful half of that instruction.
    const { data: covered } = conversation.lead_id
      ? await admin
          .schema('crm')
          .from('qualification_coverage')
          .select('area')
          .eq('lead_id', conversation.lead_id)
          .eq('organization_id', job.organization_id)
      : { data: [] };

    const answered = new Set((covered ?? []).map((c) => c.area));
    const open = QUALIFICATION_AREAS.filter((a) => !answered.has(a));

    const { data: memories } = conversation.lead_id
      ? await admin.schema('ai').rpc('recall', {
          p_scope: 'lead',
          p_scope_id: conversation.lead_id,
          p_limit: 8,
        })
      : { data: [] };

    const known = (memories ?? []).map((m) => `- ${m.fact}`).join('\n');

    /**
     * ── the rest of Doc 09 §32 ───────────────────────────────────────────
     *
     * §32 lists thirteen things the Sales Agent must have in front of it.
     * Before this it had two and a half — the recent conversation, the
     * unanswered questions, and a language. Every other one was in a table
     * nobody handed it.
     *
     * That single fact explains most of what a reader would call the agent
     * "not being a salesperson": it asked about things the requirements
     * already record, it never mentioned a concern the client had raised two
     * messages earlier, and it kept discovering long after there was a quote
     * on the table. None of that is a prompt failing. It is a prompt reasoning
     * about a conversation with the sales file closed.
     *
     * Read together and best-effort: a context read that fails costs a poorer
     * reply, never the reply.
     */
    const [lead, requirement, objections, proposals, followUps, portfolio] = await Promise.all([
      conversation.lead_id
        ? admin.schema('crm').from('leads')
            .select('status, next_follow_up_at')
            .eq('id', conversation.lead_id).eq('organization_id', job.organization_id).maybeSingle()
        : Promise.resolve({ data: null }),
      // The requirements as they currently stand — §32's "Requirements". The
      // latest version, whatever its status, because a PROPOSED one is still
      // what this conversation has established.
      admin.schema('crm').from('requirement_versions')
        .select('version, status, payload')
        .eq('conversation_id', conversation.id).eq('organization_id', job.organization_id)
        .order('version', { ascending: false }).limit(1).maybeSingle(),
      // §32's "Objections", and §19's four kinds. What was raised, in the
      // client's own words, and whether a person has answered it yet.
      conversation.lead_id
        ? admin.schema('sales').from('objections')
            .select('kind, concern, round, response, proposal_id')
            .eq('lead_id', conversation.lead_id).eq('organization_id', job.organization_id)
            .order('round', { ascending: true }).limit(10)
        : Promise.resolve({ data: [] }),
      // §32's "Quote versions" and "Negotiation history". The agent may not
      // state a price and there is none here to state — the STATE is what it
      // needs: whether a quote exists and whether the client has seen it.
      // Keyed by the conversation rather than the lead: `sales.proposals` hangs
      // off an opportunity and a conversation, not off a lead directly.
      admin.schema('sales').from('proposals')
        .select('id, version, status, sent_at')
        // Ten, not three: the held-version line below looks for the newest
        // version with a sent_at, and three consecutive redrafts (each
        // superseding an unsent draft) would push the version the client is
        // actually HOLDING out of a three-row window — the file would then
        // deny a document they can see.
        .eq('conversation_id', conversation.id).eq('organization_id', job.organization_id)
        .order('version', { ascending: false }).limit(10),
      // §32's "Follow-up history" — so it does not open with a question the
      // follow-up engine asked yesterday.
      // The SEQUENCES rather than the sends: a send is one attempt, and what
      // the agent must not repeat is the situation somebody already wrote to
      // them about.
      admin.schema('crm').from('follow_up_sequences')
        .select('situation_key, last_sent_at')
        .eq('conversation_id', conversation.id).eq('organization_id', job.organization_id)
        .not('last_sent_at', 'is', null)
        .order('last_sent_at', { ascending: false }).limit(3),
      // §32's "Sales knowledge/portfolio", under ADM-12: only from the list
      // the Admin maintains. The COUNT, not the items — what the agent needs
      // to know is whether there is anything it may offer to show, and while
      // the list is empty the honest answer is no.
      admin.schema('crm').from('portfolio_items')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', job.organization_id).eq('is_active', true),
    ]);

    const salesFile = salesFileFor({
      leadStatus: lead.data?.status ?? null,
      requirement: requirement.data ?? null,
      objections: objections.data ?? [],
      proposals: proposals.data ?? [],
      followUps: followUps.data ?? [],
      portfolioCount: portfolio.count ?? 0,
    });

    // Doc 03 §5 and the owner's §3: a salesperson says who they are the first
    // time, and does not re-introduce themselves on message four. Whether this
    // thread has ever heard from the agency is a fact, so it is read rather
    // than guessed.
    const { data: priorAgency } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', job.organization_id)
      .neq('author_type', 'client')
      .limit(1);

    const firstContact = (priorAgency ?? []).length === 0;

    // A configured human name if the agency set one, and none if not. NOT
    // INVENTED: a name nobody chose, attached to a model, is a person who does
    // not exist — and the introduction reads perfectly well without one.
    const settings = (org?.settings ?? {}) as Record<string, unknown>;
    const agentName = typeof settings.sales_agent_name === 'string' ? settings.sales_agent_name : null;

    const runId = await openRun(ctx, {
      type: 'crm.conversation_message',
      id: message.id,
      input: { conversationId: conversation.id, open, language: contact?.preferred_language ?? null } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content:
            `The conversation so far:\n\n${transcript}\n\n` +
            (firstContact
              ? `This is your first message to them. Introduce yourself briefly${
                  agentName ? ` as ${agentName}` : ''
                } from ${org?.name ?? 'the agency'}, then answer what they wrote.\n`
              : 'You have spoken before on this thread — do not introduce yourself again.\n') +
            (contact?.preferred_language ? `Write in: ${contact.preferred_language}\n` : '') +
            (open.length
              ? `Not yet known about this project: ${open.join(', ')}\n`
              : 'You know everything you need; acknowledge and offer the next step.\n') +
            (known ? `\nWhat this client has told us before:\n${known}\n` : '') +
            salesFile,
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

    // First of three refusals. The schema cannot express a price; the row
    // refuses one too; and nothing is handed to the provider until the row has
    // accepted it. A model that names an amount fails here and the client sees
    // nothing.
    const validated = clientReplySchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // Through the chokepoint, never around it: consent (ADM-70), the sequence
    // two writers cannot corrupt, and the idempotency key are all its.
    const { data: queuedRows, error: sendError } = await admin.schema('crm').rpc('send_outbound_message', {
      p_conversation_id: conversation.id,
      p_body: validated.data.reply,
      p_external_ref: `reply:${message.id}`,
    });

    if (sendError) {
      await finishRun(admin, runId, 'failed', sendError.message, call.stepCount);
      await failJob(admin, job, sendError.message);
      return { status: 'failed', reason: 'send failed', detail: sendError.message, runId };
    }

    const queued = (Array.isArray(queuedRows) ? queuedRows[0] : queuedRows) as
      | { outcome: string; message_id: string | null; to_phone: string | null;
          from_phone_number_id: string | null; recipient_type: string | null;
          delivery: string | null }
      | undefined;

    if (queued?.outcome === 'no_consent') {
      // ADM-70, and ADM-92 is why it should not normally happen: a contact who
      // wrote to us has consent recorded by the ingest. Reaching here means
      // they withdrew it, and a withdrawal is not undone by writing again.
      await finishRun(admin, runId, 'succeeded', '', call.stepCount);
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this contact has withdrawn consent', runId };
    }

    // `already_sent` is not a failure, and treating it as one made a refused
    // send unretryable. `send_outbound_message` returns the row's DELIVERY
    // state alongside it precisely so a caller can tell the two apart — its
    // own comment says "the caller sends again only if the row is not already
    // `sent`" — and the first version of this ignored that.
    //
    // Found on the owner's first real message: Meta answered 401, the row was
    // written `failed`, and the retry would have seen `already_sent` and given
    // up. The words were composed, paid for, and would never have gone.
    const usable =
      queued?.message_id &&
      (queued.outcome === 'created' ||
        (queued.outcome === 'already_sent' && queued.delivery !== 'sent'));

    if (!usable) {
      // Genuinely nothing to do: either the send was refused outright, or the
      // row is already `sent` and this is a duplicate attempt at work that
      // landed. The second is a success, not an error — reporting it as one is
      // how somebody ends up sending a client the same message twice.
      if (queued?.outcome === 'already_sent') {
        await succeedRun(admin, runId, { messageId: queued.message_id } as unknown as Json, call.usage, call.stepCount);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: 'this message was already sent', runId };
      }
      const detail = `send returned ${queued?.outcome ?? 'nothing'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // Narrowed once, so every use below is a string rather than a repeated `!`.
    const outboundId = queued!.message_id!;

    // Second refusal, and the reason this happens BEFORE the provider call:
    // `send_outbound_message` writes every outbound row as `user`, so the row
    // guard cannot tell an agent's words from a colleague's until this column
    // is set. Stamping it re-runs `crm.refuse_agent_money_talk` against the
    // body. If it refuses, the message is `pending` and has reached nobody.
    const { error: stampError } = await admin
      .schema('crm')
      .from('conversation_messages')
      .update({ authored_by_agent: ctx.agent.key })
      .eq('id', outboundId)
      .eq('organization_id', job.organization_id);

    if (stampError) {
      await admin.schema('crm').rpc('mark_outbound_delivery', {
        p_message_id: outboundId,
        p_status: 'failed',
        p_error: `refused before sending: ${stampError.message}`,
      });
      await finishRun(admin, runId, 'failed', stampError.message, call.stepCount);
      await failJob(admin, job, stampError.message);
      return { status: 'failed', reason: 'refused before sending', detail: stampError.message, runId };
    }

    if (!queued.to_phone) {
      await admin.schema('crm').rpc('mark_outbound_delivery', {
        p_message_id: outboundId,
        p_status: 'failed',
        p_error: 'the contact has no phone number',
      });
      await finishRun(admin, runId, 'failed', 'no phone number', call.stepCount);
      await failJob(admin, job, 'the contact has no phone number');
      return { status: 'failed', reason: 'no phone number', runId };
    }

    const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

    const sent = await sendWhatsAppText({
      phoneNumberId: queued.from_phone_number_id ?? '',
      to: queued.to_phone,
      body: validated.data.reply,
      recipientType: (queued.recipient_type as 'individual' | 'group') ?? 'individual',
    });

    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: outboundId,
      p_status: sent.ok ? 'sent' : 'failed',
      ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
    });

    if (!sent.ok) {
      await finishRun(admin, runId, 'failed', sent.message, call.stepCount);
      await failJob(admin, job, sent.message);
      return { status: 'failed', reason: 'provider refused the send', detail: sent.message, runId };
    }

    /**
     * Doc 09 §7 and §36 — and it happens AFTER the send, deliberately.
     *
     * The client asked for a person; they hear that one is coming. What stops
     * is every reply after this one. Pausing first would have made the
     * escalation itself the last thing that did not reach them.
     *
     * Best-effort in the same sense the audit rows are: a pause that fails to
     * write must not undo a message that has already gone. It fails loudly to
     * the log, because a thread that should be paused and is not is the one
     * state worth somebody noticing.
     */
    if (validated.data.handToHuman) {
      const { data: paused, error: pauseError } = await admin
        .schema('crm')
        .rpc('hand_conversation_to_a_person', {
          p_conversation: conversation.id,
          p_reason: validated.data.handToHuman,
        });

      if (pauseError) {
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'reply.compose',
            conversationId: conversation.id,
            detail: `handed to a person but the pause did not save: ${pauseError.message}`,
          }),
        );
      }

      await succeedRun(
        admin,
        runId,
        {
          messageId: outboundId,
          handedToHuman: validated.data.handToHuman,
          paused: paused === true,
        } as unknown as Json,
        call.usage,
        call.stepCount,
      );
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

      return {
        status: 'succeeded',
        reason: 'answered, and handed to a person',
        runId,
        messageId: outboundId,
        handedToHuman: validated.data.handToHuman,
      };
    }

    await succeedRun(
      admin,
      runId,
      { messageId: outboundId, asked: open[0] ?? null } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return { status: 'succeeded', reason: 'answered', runId, messageId: outboundId };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// sales — reading what the client sent
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Brief 2026-08-22 §28 and §29.
 *
 * The instruction it is written from is short and has two halves: *"If vision
 * capability is available: analyze it"*, and *"If image understanding is
 * unavailable: do not pretend."* Only the first needs a prompt. The second is
 * held by the transcript being built from whether a description exists.
 *
 * What it is NOT asked for is as deliberate as what it is. No suggested
 * requirement, no proposed status, no price. A client sends a competitor's
 * pricing page more often than anything else, and a number read off it and
 * treated as ours would be ADM-22 broken by a photograph.
 */
const IMAGE_PROMPT = [
  'You are looking at one image a client sent on WhatsApp.',
  'Say what is in it, plainly, in English, in as much detail as is useful and no more.',
  '',
  'IF IT CONTAINS WORDS — a screenshot, a feature list, a handwritten note, a form —',
  'read them out, in the language they were written in. Do not assume that language is English:',
  'Hindi, Hinglish and mixed text are all normal here, and a translation loses what was written.',
  'Say which language you found, as a short tag: hi, en, hi-en. Null if there are no words at all.',
  '',
  'IF IT IS A REFERENCE — somebody else\'s app, a website, a design — describe what it does and',
  'how it is laid out, because that is what the client is pointing at.',
  '',
  'DO NOT copy a card number, an account number, a password or a one-time code, even if you',
  'can read it clearly. Say that the image shows one instead.',
  'DO NOT guess at what you cannot see. "The screenshot is too blurred to read" is a useful',
  'answer and an invented one is not.',
  'DO NOT decide anything. You are not naming a requirement, a price or a next step —',
  'somebody else reads this description and does that.',
].join('\n');

/**
 * A recording, turned into the words that are in it — Doc 08 §9, ADM-94.
 *
 * Split out rather than inlined because it is the one branch that talks to a
 * different vendor through a different port, and burying that inside a
 * two-hundred-line workflow is how a second system starts. Everything it
 * shares with the image path it receives as arguments: the same run, the same
 * release rules, the same column.
 *
 * `redactLongDigitRuns` applies here too, and it is worth saying why, because
 * this is the client's own speech rather than the agent's sentence: people
 * read card numbers and UPI references aloud into voice notes constantly. The
 * recording itself is untouched in WhatsApp, so nothing is lost that a person
 * cannot go and hear — what is not kept is a durable copy in a column an
 * internal screen renders and a model is handed on every later turn.
 */
async function hear(
  ctx: AgentContext,
  args: {
    message: { id: string; conversation_id: string; organization_id?: string };
    runId: string | null;
    audio: { mediaType: AiAudioMediaType; bytes: Uint8Array; byteLength: number };
    lastAttempt: boolean;
    markRead: (reading: string | null, language: string | null) => Promise<boolean>;
  },
): Promise<WorkflowResult> {
  const { admin, job } = ctx;
  const { message, runId, audio, lastAttempt, markRead } = args;

  const transcriber = resolveTranscriber();

  if (!transcriber.ok) {
    await finishRun(admin, runId, 'failed', transcriber.error.message);
    // Nothing here can hear, and a retry will not change that: the key is
    // either configured or it is not. §28's *"if image understanding is
    // unavailable: do not pretend"* reads the same one capability over, and
    // it is satisfied by the same sentence — the transcript says
    // `[voice note — not transcribed]`, which is true.
    await markRead(null, null);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
    return {
      status: 'succeeded',
      reason: 'nothing here can hear a recording, and the conversation is not held up for it',
      detail: transcriber.error.message,
      runId,
    };
  }

  const started = Date.now();
  const heard = await transcriber.data.transcribe({
    model: TRANSCRIPTION_MODEL,
    audio: {
      bytes: audio.bytes,
      mediaType: audio.mediaType,
      // A name the service can infer a container from. Not the client's, not
      // the message id — nothing identifying travels with the upload.
      fileName: `voice-note.${audio.mediaType.split('/')[1] ?? 'ogg'}`,
    },
  });

  await recordModelCall(admin, {
    organizationId: job.organization_id,
    runId,
    seq: 0,
    providerId: transcriber.data.id,
    // The same record the generation path leaves, and the same omission: what
    // went over the wire is a count and a model, never the payload. A client's
    // recording does not end up in `ai.agent_steps`, which renders on an
    // admin screen.
    request: {
      model: TRANSCRIPTION_MODEL,
      system: 'transcription',
      messages: [{ role: 'user', content: `audio/${audio.byteLength} bytes` }],
      schemaName: 'Transcript',
      effort: 'low',
    },
    result: heard.ok
      ? { ok: true, data: { json: null, model: TRANSCRIPTION_MODEL, usage: heard.usage } }
      : { ok: false, error: { code: 'PROVIDER_ERROR', message: heard.message, correlationId: ctx.correlationId } },
    latencyMs: Date.now() - started,
  });

  if (!heard.ok) {
    await finishRun(admin, runId, 'failed', heard.message, 1);
    if (heard.permanent || lastAttempt) {
      await markRead(null, null);
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: 'the recording could not be transcribed, and the conversation is not held up for it',
        detail: heard.message,
        runId,
      };
    }
    await failJob(admin, job, heard.message);
    return { status: 'failed', reason: 'the recording could not be transcribed', detail: heard.message, runId };
  }

  const said = redactLongDigitRuns(heard.text);

  if (!(await markRead(said, heard.language))) {
    const detail = 'the transcript could not be saved';
    await finishRun(admin, runId, 'failed', detail, 1);
    await failJob(admin, job, detail);
    return { status: 'failed', reason: detail, runId };
  }

  await succeedRun(
    admin,
    runId,
    { messageId: message.id, spokenLanguage: heard.language, byteLength: audio.byteLength } as unknown as Json,
    heard.usage,
    1,
  );
  await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

  return { status: 'succeeded', reason: 'heard', runId, spokenLanguage: heard.language };
}

const MEDIA_READ: AgentWorkflow = {
  jobKind: 'message.describe',
  agentKey: 'sales',
  systemPrompt: IMAGE_PROMPT,
  schemaName: 'ImageReading',
  jsonSchema: imageReadingJsonSchema,
  /**
   * ADM-61 §2, "update internal work". Nobody is answered by a reading and
   * nothing moves because of one — it is words in a column that the reply then
   * reads, exactly as it reads the client's own.
   */
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
      .select('id, conversation_id, seq, author_type, metadata, media_read_at')
      .eq('id', messageId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!message) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'message no longer exists' };
    }

    if (message.media_read_at !== null) {
      // Looked at once. A second reading would be a record of what a model
      // currently believes rather than of what was seen, which is the rule
      // `freeze_message_media_reading` holds at the row as well.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'already read' };
    }

    const media = deliveryOf(message.metadata);
    // The two kinds anything here can read. A video, a document, a sticker and
    // a location are recorded and never queued — `crm.awaits_media_reading`
    // holds nothing back for them either, so the two agree.
    const readable = media.mediaKind === 'image' || media.mediaKind === 'audio' ? media.mediaKind : null;

    if (message.author_type !== 'client' || !readable || !media.mediaId) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'nothing here to read' };
    }

    /**
     * Whether this is the last chance to answer this client at all.
     *
     * `media_read_at` is what releases the intent reading and the reply. A job
     * that dies without setting it leaves the client's image as the reason
     * nobody ever replied to them — a silence caused by a failure to read a
     * photograph, which is far worse than replying without having read it.
     *
     * So a transient failure retries while there is budget, and on the last
     * attempt the message is marked read with NO description. The transcript
     * then says `[photo — not transcribed]`, which is the truth, and §28's
     * *"if image understanding is unavailable: do not pretend"* is satisfied
     * by the same sentence that satisfies it when the provider is absent.
     */
    const lastAttempt = job.attempts + 1 >= job.max_attempts;

    /**
     * `language` is written here only for a recording, and only because the
     * transcriber is the thing that heard it.
     *
     * A photograph passes null and leaves the column alone — a picture has no
     * language, and `crm.maintain_preferred_language` sets a contact's
     * language from the first message that carries one and never again. Speech
     * IS the client using a language, so a voice note answers the question the
     * intent read would otherwise have to guess at from a transcript it did
     * not hear.
     *
     * `freeze_message_language` refuses a second value, so this can only ever
     * fill a column nobody has filled.
     */
    const markRead = async (
      description: string | null,
      language: string | null = null,
    ): Promise<boolean> => {
      const { error } = await admin
        .schema('crm')
        .from('conversation_messages')
        .update({
          media_description: description,
          media_read_at: new Date().toISOString(),
          media_read_by_agent: ctx.agent.key,
          ...(language ? { language } : {}),
        })
        .eq('id', message.id)
        .eq('organization_id', job.organization_id)
        .is('media_read_at', null);
      if (error) {
        console.error(
          JSON.stringify({ level: 'error', scope: 'message.describe', detail: error.message }),
        );
      }
      return !error;
    };

    /**
     * Opened BEFORE the fetch, which is where it belongs and is not where it
     * was.
     *
     * A failed fetch used to cost no run row, as an economy. What that
     * economy actually bought was a system that knew exactly why it could not
     * read a client's image and recorded it nowhere a person could look: the
     * message row said `media_read_at` set and `media_description` null, the
     * job said `succeeded` — correctly, because the conversation was released
     * — and the reason existed only in a `console.error` on the platform.
     *
     * The owner's first real image hit this. Reading production, the answer to
     * "why is there no description?" was inferable only from a *different*
     * job's `last_error` a minute later: `WhatsApp refused the message (401)`,
     * an expired token. That is a diagnosis by coincidence.
     *
     * `ai.agent_runs` is the table for this. One row per attempt to read an
     * image, failed with the provider's own words, joinable to the message.
     */
    const runId = await openRun(ctx, {
      type: 'crm.conversation_message',
      id: message.id,
      input: { messageId: message.id, conversationId: message.conversation_id } as unknown as Json,
    });

    const fetched = await fetchWhatsAppMedia(media.mediaId, readable);

    if (!fetched.ok) {
      await finishRun(admin, runId, 'failed', fetched.message);
      if (fetched.permanent || lastAttempt) {
        // Nothing will read this image. Release everything it was holding
        // back, and say so in the job's own words rather than in the client's.
        await markRead(null);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: 'the image could not be read, and the conversation is not held up for it',
          detail: fetched.message,
          runId,
        };
      }
      await failJob(admin, job, fetched.message);
      return {
        status: 'failed',
        reason: 'the image could not be fetched',
        detail: fetched.message,
        runId,
      };
    }

    // ── a recording: the words that are in it ────────────────────────────
    //
    // A different vendor, a different port and no structured output — so it
    // does not go through `callModel`, which exists for one shape of call and
    // would have to be widened into two to carry this. What it DOES share is
    // everything that matters: the same job, the same run record, the same
    // release rules, the same column, and the same sentence in the transcript.
    if (fetched.kind === 'audio') {
      return await hear(ctx, { message, runId, audio: fetched, lastAttempt, markRead });
    }

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              mediaType: fetched.mediaType,
              dataBase64: Buffer.from(fetched.bytes).toString('base64'),
            },
            {
              type: 'text',
              text: media.caption
                ? `The client sent this and wrote beside it: ${media.caption}`
                : 'The client sent this with no message beside it.',
            },
          ],
        },
      ],
      runId,
    );

    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);

      // No provider at all is exactly the state §28 calls "unavailable", and
      // it will not resolve on a retry — the key is either configured or it is
      // not. Release rather than burn five attempts and then release anyway.
      if (call.kind === 'no_provider' || lastAttempt) {
        await markRead(null);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: 'nothing here can read an image, and the conversation is not held up for it',
          detail: call.detail,
          runId,
        };
      }

      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: 'provider error', detail: call.detail, runId };
    }

    const validated = imageReadingSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      if (lastAttempt) {
        await markRead(null);
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: 'the image could not be read', detail, runId };
      }
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // §27. The prompt asks the model not to copy an account number; this is
    // what holds when the asking does not, and it cannot fail the job the way
    // a refusal would.
    const description = redactLongDigitRuns(validated.data.description);

    if (!(await markRead(description))) {
      const detail = 'the reading could not be saved';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    await succeedRun(
      admin,
      runId,
      // What was read, never what was in it. The bytes are not here and they
      // are not in the step trace either: `recordModelCall` records
      // `message_count` rather than the messages, so a client's photograph is
      // read and dropped and this system keeps no copy of it.
      {
        messageId: message.id,
        textLanguage: validated.data.textLanguage,
        byteLength: fetched.byteLength,
        mediaType: fetched.mediaType,
      } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: 'read',
      runId,
      textLanguage: validated.data.textLanguage,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// sales — the scope of a quotation, and none of its numbers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Document 09 §15: *"Quote generation is assisted by AI but governed by the
 * Policy Engine."*
 *
 * The loop itself is not new — `sales.draft_proposal`, `add_proposal_item`,
 * `set_proposal_pricing`, `submit_proposal`, `send_proposal` and the version
 * history on the lead page have existed since G-011 and ADM-07. What was
 * missing is the AI half: every quotation began on a blank form even when an
 * accepted requirement version already listed the scope.
 *
 * This writes the scope and stops. A person prices it, submits it, and the
 * owner approves it before a client sees anything — unchanged, and it is the
 * whole of ADM-07.
 */
const QUOTATION_PROMPT = [
  'You are turning requirements a client has already agreed into a complete draft quotation:',
  'the work items and, on each, a proposed price the owner will decide.',

  'EACH ITEM is one piece of work somebody could quote separately — "Customer app: signup,',
  'browse, order, track", "Admin panel: orders, drivers, payouts", "Payment gateway integration".',
  'Use their words for their product. If they call it a delivery app it is a delivery app.',
  'Do not pad the list to look thorough, and do not collapse a real division to look tidy.',

  'THE SUMMARY says what this covers and — more usefully — what it does not.',
  'Exclusions are what a client argues about three months later, so name the ones the',
  'requirements support. Do not invent an exclusion nobody discussed.',

  // ADM-96 replaced the paragraph that stood here — "YOU MAY NOT PRICE
  // ANYTHING" — in the owner's own words: "agent sab kuch kre mai bs pdf
  // approve changes karo". The price is now proposed here and DECIDED by the
  // owner; nothing reaches a client until they have (ADM-07, unchanged).
  'EVERY PRICE IS A PROPOSAL TO THE OWNER, not a statement to a client. Price each line in',
  'whole rupees from the observed bands below — this agency\'s own practice, not a market',
  'guess — and stay inside them unless the requirements clearly demand otherwise. The owner',
  'approves or reprices every number before anything is sent, so a defensible middle-of-band',
  'figure beats a clever one. Still not yours: payment terms, discounts, taxes, delivery',
  'dates, day counts. There is no field for them, and the person who approves owns them.',

  'ONLY WHAT THE REQUIREMENTS SUPPORT. If something was never discussed, leave it out.',
  'A quotation that lists work nobody asked for is worse than a short one: somebody has to',
  'notice it before it reaches a client.',

  'THE DOCUMENT AROUND THE LINES: also write (a) UNDERSTANDING — the client’s core loop in',
  'their words, two to four sentences; (b) per-line FEATURES — bullet-level contents in their',
  'vocabulary, never “complete functionality”; (c) EXCLUSIONS, with the reason where the',
  'requirements show one; (d) ASSUMPTIONS — only real unknowns; (e) CLIENT RESPONSIBILITIES —',
  'only what applies (hosting, gateway accounts, content). Empty lists are honest; invented',
  'entries are not. Payment schedules, timelines, support terms and GST are written by the',
  'system from standing policy — never by you.',

  PRICING_KNOWLEDGE,
].join(' ');

const QUOTATION_SCOPE: AgentWorkflow = {
  jobKind: 'quotation.scope',
  agentKey: 'sales',
  systemPrompt: QUOTATION_PROMPT,
  schemaName: 'QuotationScope',
  jsonSchema: quotationScopeJsonSchema,
  /**
   * ADM-61 §2, "draft anything at all" — and since ADM-96, the draft is
   * COMPLETE: scoped, priced from the agency's own corpus, and submitted
   * into the approval queue. What keeps it a draft is what has not changed:
   * nothing here is client-facing (§3) — the submission's audience is
   * internal, the announcement goes to the owner's own channel, and ADM-07
   * still puts the owner's decision between this work and any client.
   */
  workClass: 'draft',

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
      .select('id, conversation_id, status, payload')
      .eq('id', versionId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!version) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the requirement version no longer exists' };
    }

    // §15's first input is "Confirmed requirements". A proposed version is the
    // agent's own reading; quoting from it would be quoting from itself.
    if (version.status !== 'accepted') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'these requirements are not accepted' };
    }

    const { data: conversation } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, lead_id')
      .eq('id', version.conversation_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (!conversation?.lead_id) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'this conversation belongs to no lead' };
    }

    const leadId = conversation.lead_id;

    /**
     * The deal to quote against — read first, and OPENED when absent (ADM-96).
     *
     * The rule this replaces — "a lead with no deal yet is a person's next
     * step, not a gap to fill" — belonged to the world where a person had to
     * arrive anyway to type the price. The owner moved the human act to the
     * decision itself, and a deal row is internal bookkeeping (ADM-61 §2):
     * nothing leaves the building because a row says a negotiation exists.
     *
     * G-088's semantics hold untouched: one OPEN deal per lead, enforced by
     * `opportunities_open_lead_key`. The insert races a person opening a deal
     * by hand — whoever wins, the loser reads the winner's row, which is the
     * same 23505-then-re-read shape `createOpportunity` uses.
     *
     * The read refuses to treat a failure as an absence (G-054): an insert on
     * a database blink would give a lead with a deal a SECOND one to fight
     * the index over, or supersede work under a quotation somebody is pricing.
     */
    const openDeal = () =>
      admin
        .schema('sales')
        .from('opportunities')
        .select('id, stage')
        .eq('lead_id', leadId)
        .eq('organization_id', job.organization_id)
        .not('stage', 'in', '("won","lost")')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    const firstRead = await openDeal();
    if (firstRead.error) {
      await failJob(admin, job, `could not read the lead's deals: ${firstRead.error.message}`);
      return { status: 'failed', reason: 'could not read the deal' };
    }

    let opportunity = firstRead.data;

    if (!opportunity) {
      const { data: lead, error: leadError } = await admin
        .schema('crm')
        .from('leads')
        .select('title')
        .eq('id', leadId)
        .eq('organization_id', job.organization_id)
        .maybeSingle();

      if (leadError) {
        await failJob(admin, job, `could not read the lead: ${leadError.message}`);
        return { status: 'failed', reason: 'could not read the lead' };
      }

      const { data: opened, error: openError } = await admin
        .schema('sales')
        .from('opportunities')
        .insert({
          organization_id: job.organization_id,
          lead_id: leadId,
          // The lead's own name for itself — never invented (ADM-76).
          name: (lead?.title ?? '').trim() || 'WhatsApp lead',
          stage: 'discovery',
          currency: 'INR',
          value_minor: 0,
        })
        .select('id, stage')
        .single();

      if (openError && openError.code !== '23505') {
        await failJob(admin, job, `could not open a deal for the lead: ${openError.message}`);
        return { status: 'failed', reason: 'could not open a deal' };
      }

      if (openError) {
        // Lost the race — a person (or a concurrent run) opened one first.
        const reread = await openDeal();
        if (reread.error || !reread.data) {
          await failJob(
            admin,
            job,
            `lost the open-deal race and could not read the winner: ${reread.error?.message ?? 'no open deal found'}`,
          );
          return { status: 'failed', reason: 'could not read the deal' };
        }
        opportunity = reread.data;
      } else {
        opportunity = opened;
      }
    }

    if (!opportunity) {
      // Unreachable by construction — every branch above assigned or
      // returned — but a quotation against no deal is not worth an assertion
      // being wrong about.
      await failJob(admin, job, 'no deal to quote against after opening one');
      return { status: 'failed', reason: 'could not read the deal' };
    }

    // Drafted once per accepted version. A second draft against the same
    // requirements would supersede a quotation somebody may already be
    // reviewing. Read with the error CHECKED (G-054): treating a blink as
    // "not yet quoted" would draft v2 over a v1 this run could not see.
    const { data: already, error: alreadyError } = await admin
      .schema('sales')
      .from('proposals')
      .select('id, status, generated_by_run_id')
      .eq('requirement_version_id', version.id)
      .eq('organization_id', job.organization_id)
      .limit(1);

    if (alreadyError) {
      await failJob(admin, job, `could not read existing quotations: ${alreadyError.message}`);
      return { status: 'failed', reason: 'could not read existing quotations' };
    }

    /**
     * Since ADM-96 the submission is part of THIS job, so "already quoted"
     * has three honest readings, and only one of them is "done".
     *
     * A version past draft needs nothing. A DRAFT with no run id is a
     * person's work in progress — not the agent's to submit, because a
     * half-typed human draft handed to the owner would be the agent putting
     * words in somebody's mouth. A draft WITH a run id is the agent's own,
     * left by a FAILED prior attempt (this job only runs again because it
     * failed) — and it is not submitted either, because the item loop can
     * die half-written and no reader can tell a complete draft from a
     * truncated one after the fact. It falls through: the normal path below
     * re-drafts COMPLETE and submits, and `draft_proposal` supersedes this
     * one under the opportunity's lock. A version number burns per failed
     * attempt, bounded by the retry budget — cheaper than an owner approving
     * half a scope and a client receiving it.
     */
    const existing = (already ?? [])[0];
    if (existing) {
      if (existing.status !== 'draft') {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: 'these requirements are already quoted' };
      }
      if (!existing.generated_by_run_id) {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: 'a person is drafting against these requirements; theirs to finish',
        };
      }
      // The agent's own failed half — fall through and supersede it.
    }

    const runId = await openRun(ctx, {
      type: 'crm.requirement_version',
      id: version.id,
      input: { versionId: version.id, opportunityId: opportunity.id } as unknown as Json,
    });

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: `The requirements the client agreed:\n\n${JSON.stringify(version.payload, null, 2)}`,
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

    const validated = quotationScopeSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data: drafted, error: draftError } = await admin.schema('sales').rpc('draft_proposal', {
      p_opportunity_id: opportunity.id,
      p_title: validated.data.title,
      p_body: validated.data.summary,
      p_requirement_version_id: version.id,
      // Fifteen days — the corpus modal (13 of the 38 quotations that print a
      // validity), computed here rather than asked of the model, which cannot
      // know today's date. The owner sees it on the PDF they decide (ADM-96).
      p_valid_until: quotationValidUntil(),
      // Named, so an owner approving this can see it was drafted rather than
      // typed. The column has existed since the schema's first day and until
      // now nothing wrote it.
      ...(runId ? { p_generated_by_run_id: runId } : {}),
      // On the resume path the base is the agent's own failed half, named so
      // the database refuses a stale supersede (review finding, 2026-08-24).
      // The fresh path names nothing: there is no base to expect.
      ...(existing ? { p_expected_supersede: existing.id } : {}),
    });

    const draft = (Array.isArray(drafted) ? drafted[0] : drafted) as
      | { outcome: string; proposal_id: string | null; version: number | null }
      | undefined;

    if (draftError || !draft || draft.outcome !== 'created' || !draft.proposal_id) {
      const detail = draftError?.message ?? `draft_proposal answered ${draft?.outcome ?? 'nothing'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not open a quotation', detail, runId };
    }

    /**
     * The lines, priced — ADM-96.
     *
     * This block once wrote every line at zero, because ADM-22 said the agent
     * may not price and `sales.refuse_priced_by_nobody` held that rule at the
     * row. The owner revised the rule itself; the guard is retired in the
     * same change (migration 20260824120000) rather than routed around. The
     * ×100 is the ONE place rupees become minor units — the model reasons in
     * the whole rupees its bands are written in, and never touches paise.
     * What still stands between this number and a client: `submit_proposal`
     * below, and the owner it asks (ADM-07).
     */
    let written = 0;
    for (const [index, item] of validated.data.items.entries()) {
      const { data: itemData, error: itemError } = await admin.schema('sales').rpc('add_proposal_item', {
        p_proposal_id: draft.proposal_id,
        p_description: item.description,
        p_position: index,
        p_unit_price_minor: item.priceRupees * 100,
        p_features: item.features,
      });
      // `not_draft` arrives as an OUTCOME row, not a transport error — a
      // draft superseded mid-write would otherwise count every refused line
      // as written and report success on destroyed work (review finding,
      // 2026-08-24).
      const added = (Array.isArray(itemData) ? itemData[0] : itemData) as
        | { outcome?: string }
        | undefined;
      if (itemError || added?.outcome !== 'added') {
        const detail = itemError
          ? `line ${index + 1} could not be written: ${itemError.message}`
          : `line ${index + 1} was refused as ${added?.outcome ?? 'nothing'} — the draft moved under the writes`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: 'could not write the scope', detail, runId };
      }
      written += 1;
    }

    /**
     * Submitted in the same job — ADM-96's second half. Submission raises the
     * internal approval, which is what puts the quotation (and its PDF) on
     * the owner's phone; leaving it out would leave the owner's two verbs
     * with a third: "go find the draft". A failure HERE fails the job while
     * the draft stands, and the retry takes the resume door above — the
     * "already drafted" branch finishes the submission instead of drafting
     * over it.
     */
    /**
     * The document around the lines (G-165) — written while the draft is a
     * draft, frozen by proposals_guard the moment it leaves. Before the
     * submission on purpose: a failure here fails the job, and the retry's
     * resume path supersedes this half rather than submitting it.
     */
    const { error: documentError } = await admin
      .schema('sales')
      .from('proposals')
      .update({
        document: {
          understanding: validated.data.understanding,
          exclusions: validated.data.exclusions,
          assumptions: validated.data.assumptions,
          clientResponsibilities: validated.data.clientResponsibilities,
          // G-167 — every one optional in the schema, so an older model
          // answer simply stores nothing here and renders as it did.
          dependencies: validated.data.dependencies ?? null,
          acceptanceCriteria: validated.data.acceptanceCriteria ?? null,
          optionalAddons: validated.data.optionalAddons ?? null,
          industryTheme: validated.data.industryTheme ?? null,
          regulatedCategory: validated.data.regulatedCategory ?? null,
        },
      })
      .eq('id', draft.proposal_id)
      .eq('organization_id', job.organization_id);

    if (documentError) {
      const detail = `the document could not be written: ${documentError.message}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not write the document', detail, runId };
    }

    const submitted = await submitDraftedQuotation(admin, draft.proposal_id);
    if (!submitted.ok) {
      await finishRun(admin, runId, 'failed', submitted.detail, call.stepCount);
      await failJob(admin, job, submitted.detail);
      return { status: 'failed', reason: submitted.detail, runId };
    }

    await succeedRun(
      admin,
      runId,
      {
        proposalId: draft.proposal_id,
        version: draft.version,
        items: written,
        submission: submitted.outcome,
        requestId: submitted.requestId,
      } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: `scope drafted and priced; ${submitted.reason}`,
      runId,
      proposalId: draft.proposal_id,
      items: written,
    };
  },
};


/** Fifteen days out — the corpus modal (13 of the 38 quotations that print one). */
function quotationValidUntil(): string {
  return new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
}

type QuotationSubmission =
  | {
      ok: true;
      outcome: 'submitted' | 'already_pending' | 'no_policy' | 'no_amount' | 'no_items' | 'not_draft';
      requestId: string | null;
      reason: string;
    }
  | { ok: false; detail: string };

/**
 * The half of ADM-96 that puts the quotation in front of the owner.
 *
 * Shared by three doors that must not disagree: the scope job's main path,
 * its resume branch (a retry that finds the draft made and the submission
 * missing), and the revision job. Every outcome `submit_proposal` can answer
 * is mapped to a sentence a person can act on — the non-submitting ones are
 * SUCCESSES, not failures, because in each the draft stands and the honest
 * next step belongs to a person (no policy, no amount) or already happened
 * (pending, moved on).
 */
async function submitDraftedQuotation(
  admin: AgentContext['admin'],
  proposalId: string,
): Promise<QuotationSubmission> {
  const { data, error } = await admin.schema('sales').rpc('submit_proposal', {
    p_proposal_id: proposalId,
    // No requester on purpose: nobody asked. `submit_proposal` records
    // 'system', and the announcement still carries the full quotation and its
    // PDF — the internal channel is exempt from the authored-price rule
    // (migration 20260824120000), because telling the owner the number is how
    // the number gets its human.
  });

  if (error) return { ok: false, detail: `submit_proposal failed: ${error.message}` };

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; request_id: string | null; status: string | null }
    | undefined;

  if (!row) return { ok: false, detail: 'submit_proposal answered nothing' };

  switch (row.outcome) {
    case 'submitted':
      return {
        ok: true,
        outcome: 'submitted',
        requestId: row.request_id,
        reason: 'submitted for the owner to decide (ADM-07)',
      };
    case 'already_pending':
      return {
        ok: true,
        outcome: 'already_pending',
        requestId: row.request_id,
        reason: 'already waiting on the owner',
      };
    case 'no_policy':
      return {
        ok: true,
        outcome: 'no_policy',
        requestId: null,
        reason: 'drafted; no approval policy names a decider, so the draft waits for a person',
      };
    case 'no_amount':
      return {
        ok: true,
        outcome: 'no_amount',
        requestId: null,
        reason: 'drafted at zero; a person prices it',
      };
    case 'no_items':
      // Unreachable from the drafting paths (the schema demands a line
      // before anything is written), but reachable in principle — and a
      // deterministic answer retried to death is a dead job, not a fact.
      return {
        ok: true,
        outcome: 'no_items',
        requestId: null,
        reason: 'drafted with no lines; a person completes it',
      };
    case 'not_draft':
      return {
        ok: true,
        outcome: 'not_draft',
        requestId: null,
        reason: 'no longer a draft — somebody already moved it on',
      };
    default:
      // `not_found` lands here: the draft this job just made or read is gone,
      // which nothing about retrying the SUBMISSION explains. Failed, so the
      // retry re-reads the world from the top and says something honest.
      return { ok: false, detail: `submit_proposal answered ${row.outcome}` };
  }
}

/**
 * Whose work is an agent-drafted newer version? — review finding, 2026-08-24.
 *
 * `generated_by_run_id` alone cannot tell "this job's own failed half" from
 * "another cycle's live base": `sync_proposal_decision` returns a
 * changes_requested version to `draft` with its run id intact, so an owner's
 * revision-in-waiting looks exactly like a crashed rework — and a guard that
 * guessed superseded the owner's base and dropped their note, with every job
 * reporting success. The run row keeps the answer: `openRun` writes the
 * subject each drafting job worked FOR, so it is read, never guessed.
 */
async function draftBelongsTo(
  admin: AgentContext['admin'],
  runId: string,
  subjectType: string,
  subjectId: string,
): Promise<{ ok: true; own: boolean } | { ok: false; detail: string }> {
  const { data, error } = await admin
    .schema('ai')
    .from('agent_runs')
    .select('subject_type, subject_id')
    .eq('id', runId)
    .maybeSingle();
  if (error) return { ok: false, detail: `could not read the drafting run: ${error.message}` };
  return { ok: true, own: data?.subject_type === subjectType && data?.subject_id === subjectId };
}

const REVISION_PROMPT = [
  'You are revising a quotation this agency already drafted, because the owner reviewed it',
  'and asked for changes. You will see the agreed requirements, the current quotation —',
  'title, summary, lines with prices in whole rupees — and the owner\'s note.',

  'THE NOTE IS AN INSTRUCTION from the person who owns every price. Apply it faithfully —',
  'reprice what it reprices, add what it adds, remove what it removes — and change nothing',
  'it does not touch: this is a revision, not a rewrite. Where the note and the requirements',
  'pull apart, the note wins; it is the later word from the decider.',

  'Return the COMPLETE revised quotation: every line it should now carry, each priced in',
  'whole rupees, with the title and the summary. Lines you keep are returned unchanged.',

  'EVERY PRICE IS STILL A PROPOSAL TO THE OWNER — the revision goes back for their decision',
  'before a client sees anything (ADM-07). Payment terms, discounts, taxes and dates remain',
  'theirs; there is no field for them.',

  'THE DOCUMENT AROUND THE LINES: also write (a) UNDERSTANDING — the client’s core loop in',
  'their words, two to four sentences; (b) per-line FEATURES — bullet-level contents in their',
  'vocabulary, never “complete functionality”; (c) EXCLUSIONS, with the reason where the',
  'requirements show one; (d) ASSUMPTIONS — only real unknowns; (e) CLIENT RESPONSIBILITIES —',
  'only what applies (hosting, gateway accounts, content). Empty lists are honest; invented',
  'entries are not. Payment schedules, timelines, support terms and GST are written by the',
  'system from standing policy — never by you.',

  PRICING_KNOWLEDGE,
].join(' ');

const QUOTATION_REVISE: AgentWorkflow = {
  jobKind: 'quotation.revise',
  agentKey: 'sales',
  systemPrompt: REVISION_PROMPT,
  schemaName: 'QuotationScope',
  jsonSchema: quotationScopeJsonSchema,
  /**
   * The other half of the owner's sentence — "changes karo" (ADM-96). The
   * owner answers a quotation with `changes_requested` and a note; this job
   * turns the note into the next version and submits it back. Same class as
   * the draft it revises: internal, priced as a proposal, decided by the
   * owner before anything is client-facing (ADM-61 §2, ADM-07).
   */
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const requestId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    const parsed = approvalDecidedEventSchema.safeParse(job.payload?.event);
    if (!parsed.success || !requestId) {
      await failJob(
        admin,
        job,
        `malformed approval.decided payload: ${parsed.success ? 'no request named' : (parsed.error.issues[0]?.message ?? 'unparseable')}`,
      );
      return { status: 'failed', reason: 'bad payload' };
    }

    /**
     * The ROW is the authority; the payload only says which row.
     *
     * An outbox event is insertable over PostgREST by an org owner (the PR
     * #178 lesson), so the payload's decision and note are CLAIMS. Revising a
     * quotation from a forged note would put words in the owner's mouth —
     * the request row's `state` and `decision_note` are reachable only
     * through `decide_approval`, so they are what gets read.
     */
    const { data: request, error: requestError } = await admin
      .schema('approvals')
      .from('approval_requests')
      .select('state, decision_note, subject_type, subject_id')
      .eq('id', requestId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (requestError) {
      await failJob(admin, job, `could not read the approval request: ${requestError.message}`);
      return { status: 'failed', reason: 'could not read the approval request' };
    }
    if (!request) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the approval request no longer exists' };
    }

    if (request.subject_type !== 'proposal' || !request.subject_id) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'not a quotation decision; nothing to revise' };
    }

    if (request.state !== 'changes_requested') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: `a ${request.state} request asks for no revision` };
    }

    const note = (request.decision_note ?? '').trim();
    if (!note) {
      // "Changes" with no note is a decision the agent cannot read a change
      // out of. Inventing one would be ADM-76's exact sin; the draft stands
      // and the lead page shows it to a person.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: 'the owner asked for changes but left no note; the draft waits for a person',
      };
    }

    // Carry the decision to the proposal first — idempotent, and normally the
    // UI already has. Doing it here too means a decide whose caller died
    // between the decide and the carry still converges (G-161's family).
    const carried = await admin
      .schema('sales')
      .rpc('sync_proposal_decision', { p_proposal_id: request.subject_id });
    if (carried.error) {
      await failJob(admin, job, `could not carry the decision: ${carried.error.message}`);
      return { status: 'failed', reason: 'could not carry the decision' };
    }

    const { data: proposal, error: proposalError } = await admin
      .schema('sales')
      .from('proposals')
      .select('id, opportunity_id, version, status, title, body, requirement_version_id, document')
      .eq('id', request.subject_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (proposalError) {
      await failJob(admin, job, `could not read the quotation: ${proposalError.message}`);
      return { status: 'failed', reason: 'could not read the quotation' };
    }
    if (!proposal) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the quotation no longer exists' };
    }

    /**
     * The resume guard, with the same three readings as the scope job's.
     *
     * A newer version PAST draft already answers this note — done. A newer
     * DRAFT with no run id is a person's own next version in progress, and
     * theirs wins: auto-submitting somebody's half-typed draft would put
     * words in their mouth. A newer draft WITH a run id is this job's own
     * work from a FAILED prior attempt — possibly half-written, since the
     * item loop can die mid-way and nothing can tell a complete draft from a
     * truncated one after the fact — so it is never submitted; it is
     * SUPERSEDED by the complete redraft below. A version number burns per
     * failed attempt, bounded by the retry budget.
     */
    const { data: newer, error: newerError } = await admin
      .schema('sales')
      .from('proposals')
      .select('id, status, version, generated_by_run_id')
      .eq('opportunity_id', proposal.opportunity_id)
      .eq('organization_id', job.organization_id)
      .gt('version', proposal.version)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newerError) {
      await failJob(admin, job, `could not read newer versions: ${newerError.message}`);
      return { status: 'failed', reason: 'could not read newer versions' };
    }

    let supersedingOwnFailedDraft = false;
    if (newer) {
      if (newer.status !== 'draft') {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return { status: 'succeeded', reason: `v${newer.version} already answers this note` };
      }
      if (!newer.generated_by_run_id) {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: 'a person is already drafting the next version; theirs wins',
        };
      }
      /**
       * A run id alone cannot say WHOSE work this is — a changes_requested
       * version returns to `draft` with its run id intact, so another
       * cycle's live base looks exactly like this job's own crashed half
       * (review finding, 2026-08-24). The run row is read, never guessed;
       * another cycle's draft is WAITED OUT, because superseding it would
       * revert an applied revision with every job reporting success.
       */
      const ownership = await draftBelongsTo(admin, newer.generated_by_run_id, 'sales.proposal', request.subject_id);
      if (!ownership.ok) {
        await failJob(admin, job, ownership.detail);
        return { status: 'failed', reason: 'could not read the drafting run' };
      }
      if (!ownership.own) {
        await failJob(
          admin,
          job,
          `v${newer.version} belongs to another drafting cycle; waiting for it to settle`,
        );
        return { status: 'failed', reason: 'another cycle holds the draft' };
      }
      supersedingOwnFailedDraft = true;
    }

    // The version the owner reviewed is the base for the revision even when a
    // failed attempt has already superseded it — the note was written against
    // ITS lines, and they are what the model must see.
    if (!supersedingOwnFailedDraft && proposal.status !== 'draft') {
      // The sync above maps changes_requested back to draft; any other state
      // here means the world moved (approved again, sent, superseded by a
      // person) and a revision on top of it would fight them.
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: `v${proposal.version} is ${proposal.status}; not a draft to revise`,
      };
    }

    const { data: items, error: itemsError } = await admin
      .schema('sales')
      .from('proposal_items')
      .select('description, amount_minor, features')
      .eq('proposal_id', proposal.id)
      .eq('organization_id', job.organization_id)
      .order('position')
      .order('created_at');

    if (itemsError) {
      await failJob(admin, job, `could not read the quotation's lines: ${itemsError.message}`);
      return { status: 'failed', reason: 'could not read the lines' };
    }

    let requirements: unknown = null;
    if (proposal.requirement_version_id) {
      const { data: version, error: versionError } = await admin
        .schema('crm')
        .from('requirement_versions')
        .select('payload')
        .eq('id', proposal.requirement_version_id)
        .eq('organization_id', job.organization_id)
        .maybeSingle();
      if (versionError) {
        await failJob(admin, job, `could not read the requirements: ${versionError.message}`);
        return { status: 'failed', reason: 'could not read the requirements' };
      }
      requirements = version?.payload ?? null;
    }

    const runId = await openRun(ctx, {
      type: 'sales.proposal',
      id: proposal.id,
      input: { proposalId: proposal.id, note } as unknown as Json,
    });

    const storedDocument = parseQuotationDocument(proposal.document ?? null);
    const current = {
      title: proposal.title,
      summary: proposal.body,
      understanding: storedDocument?.understanding ?? undefined,
      lines: (items ?? []).map((i) => ({
        description: i.description,
        priceRupees: Math.round((i.amount_minor ?? 0) / 100),
        features: Array.isArray(i.features) ? i.features : undefined,
      })),
      exclusions: storedDocument?.exclusions ?? undefined,
      assumptions: storedDocument?.assumptions ?? undefined,
      clientResponsibilities: storedDocument?.clientResponsibilities ?? undefined,
    };

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: [
            requirements === null
              ? null
              : `The requirements the client agreed:\n\n${JSON.stringify(requirements, null, 2)}`,
            `The current quotation (v${proposal.version}):\n\n${JSON.stringify(current, null, 2)}`,
            `The owner reviewed v${proposal.version} and asked for changes:\n\n${note}`,
          ]
            .filter((part): part is string => part !== null)
            .join('\n\n'),
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

    const validated = quotationScopeSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // `draft_proposal` supersedes the rejected draft under the opportunity's
    // lock — the version history stays what the database wrote, never edited
    // in place.
    const { data: drafted, error: draftError } = await admin.schema('sales').rpc('draft_proposal', {
      p_opportunity_id: proposal.opportunity_id,
      p_title: validated.data.title,
      p_body: validated.data.summary,
      p_valid_until: quotationValidUntil(),
      ...(proposal.requirement_version_id
        ? { p_requirement_version_id: proposal.requirement_version_id }
        : {}),
      ...(runId ? { p_generated_by_run_id: runId } : {}),
      // The base this job reworked FROM, named so the database refuses a
      // stale supersede under its own lock — the guard above is minutes old
      // by the end of a model call (review finding, 2026-08-24).
      p_expected_supersede: supersedingOwnFailedDraft && newer ? newer.id : proposal.id,
    });

    const draft = (Array.isArray(drafted) ? drafted[0] : drafted) as
      | { outcome: string; proposal_id: string | null; version: number | null }
      | undefined;

    if (draft?.outcome === 'stale') {
      // The live version moved between this job's read and its write — the
      // database's own lock said so. Nothing was superseded; the retry
      // re-reads the world through the guards above.
      const detail = 'the live version moved during the model call; retrying against the new world';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'stale base', runId };
    }

    if (draftError || !draft || (draft.outcome !== 'created' && draft.outcome !== 'settled')) {
      const detail = draftError?.message ?? `draft_proposal answered ${draft?.outcome ?? 'nothing'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not draft the revision', detail, runId };
    }

    if (draft.outcome === 'settled') {
      // The deal closed while the revision was being drafted. Nothing to
      // revise against; said, not retried.
      await succeedRun(
        admin,
        runId,
        { outcome: 'deal_settled' } as unknown as Json,
        call.usage,
        call.stepCount,
      );
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the deal settled while the revision was drafted', runId };
    }

    if (!draft.proposal_id) {
      const detail = 'draft_proposal answered created without a proposal id';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    let written = 0;
    for (const [index, item] of validated.data.items.entries()) {
      const { data: itemData, error: itemError } = await admin.schema('sales').rpc('add_proposal_item', {
        p_proposal_id: draft.proposal_id,
        p_description: item.description,
        p_position: index,
        p_unit_price_minor: item.priceRupees * 100,
        p_features: item.features,
      });
      // `not_draft` arrives as an OUTCOME row, not a transport error — a
      // draft superseded mid-write would otherwise count every refused line
      // as written and report success on destroyed work (review finding,
      // 2026-08-24).
      const added = (Array.isArray(itemData) ? itemData[0] : itemData) as
        | { outcome?: string }
        | undefined;
      if (itemError || added?.outcome !== 'added') {
        const detail = itemError
          ? `line ${index + 1} could not be written: ${itemError.message}`
          : `line ${index + 1} was refused as ${added?.outcome ?? 'nothing'} — the draft moved under the writes`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: 'could not write the revision', detail, runId };
      }
      written += 1;
    }

    /**
     * The document around the lines (G-165) — written while the draft is a
     * draft, frozen by proposals_guard the moment it leaves. Before the
     * submission on purpose: a failure here fails the job, and the retry's
     * resume path supersedes this half rather than submitting it.
     */
    const { error: documentError } = await admin
      .schema('sales')
      .from('proposals')
      .update({
        document: {
          understanding: validated.data.understanding,
          exclusions: validated.data.exclusions,
          assumptions: validated.data.assumptions,
          clientResponsibilities: validated.data.clientResponsibilities,
          // G-167 — every one optional in the schema, so an older model
          // answer simply stores nothing here and renders as it did.
          dependencies: validated.data.dependencies ?? null,
          acceptanceCriteria: validated.data.acceptanceCriteria ?? null,
          optionalAddons: validated.data.optionalAddons ?? null,
          industryTheme: validated.data.industryTheme ?? null,
          regulatedCategory: validated.data.regulatedCategory ?? null,
        },
      })
      .eq('id', draft.proposal_id)
      .eq('organization_id', job.organization_id);

    if (documentError) {
      const detail = `the document could not be written: ${documentError.message}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not write the document', detail, runId };
    }

    const submitted = await submitDraftedQuotation(admin, draft.proposal_id);
    if (!submitted.ok) {
      await finishRun(admin, runId, 'failed', submitted.detail, call.stepCount);
      await failJob(admin, job, submitted.detail);
      return { status: 'failed', reason: submitted.detail, runId };
    }

    await succeedRun(
      admin,
      runId,
      {
        proposalId: draft.proposal_id,
        version: draft.version,
        items: written,
        submission: submitted.outcome,
        requestId: submitted.requestId,
      } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: `revised from the owner's note; ${submitted.reason}`,
      runId,
      proposalId: draft.proposal_id,
      items: written,
    };
  },
};

const REWORK_PROMPT = [
  'You are reworking a quotation this agency already SENT, because the client asked for the',
  'scope to change. You will see the agreed requirements, the quotation the client is holding',
  '— title, summary, lines with prices in whole rupees — and the client’s ask in their own',
  'words.',

  'THE ASK IS A REQUEST, NOT AN INSTRUCTION. Accommodate what it adds, removes or changes in',
  'SCOPE; the owner decides the result before the client sees anything (ADM-07). Keep',
  'everything the ask does not touch — this is a revision, not a rewrite.',

  'NEVER DISCOUNT THE SAME SCOPE. When an ask is budget-shaped, this agency re-scopes to a',
  'smaller honest build — it does not lower the number for the same work; that is the posture',
  'its own quotation history shows, and a pure price push is a person’s negotiation, never',
  'yours.',

  'Return the COMPLETE reworked quotation: every line it should now carry, each priced in',
  'whole rupees, with the title and the summary.',

  'THE DOCUMENT AROUND THE LINES: also write (a) UNDERSTANDING — the client’s core loop in',
  'their words, two to four sentences; (b) per-line FEATURES — bullet-level contents in their',
  'vocabulary, never “complete functionality”; (c) EXCLUSIONS, with the reason where the',
  'requirements show one; (d) ASSUMPTIONS — only real unknowns; (e) CLIENT RESPONSIBILITIES —',
  'only what applies (hosting, gateway accounts, content). Empty lists are honest; invented',
  'entries are not. Payment schedules, timelines, support terms and GST are written by the',
  'system from standing policy — never by you.',

  PRICING_KNOWLEDGE,
].join(' ');

const QUOTATION_REWORK: AgentWorkflow = {
  jobKind: 'quotation.rework',
  agentKey: 'sales',
  systemPrompt: REWORK_PROMPT,
  schemaName: 'QuotationScope',
  jsonSchema: quotationScopeJsonSchema,
  /**
   * G-163 — ADM-96's second half. The owner's changes-note already redrafts
   * (QUOTATION_REVISE); this is the same loop when the CLIENT asks, gated to
   * SCOPE-change objections alone: a price objection is a negotiation and the
   * agent may not move a number under client pressure (ADM-22's surviving
   * posture); trust and timeline are conversations. Internal end to end —
   * the reworked version goes to the owner's decision, never to the client
   * (ADM-61 §2, ADM-07).
   */
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const objectionId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

    if (!objectionId) {
      await failJob(admin, job, 'objection.recorded names no objection');
      return { status: 'failed', reason: 'bad payload' };
    }

    /**
     * The ROW is the authority; the event's kind was only the plan-time
     * filter's claim (PR #178's rule). Re-read everything that gates the
     * loop: the kind, the openness, and the quotation the ask names.
     */
    const { data: objection, error: objectionError } = await admin
      .schema('sales')
      .from('objections')
      .select('id, lead_id, message_id, proposal_id, kind, concern, response, outcome, answered_by')
      .eq('id', objectionId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (objectionError) {
      await failJob(admin, job, `could not read the objection: ${objectionError.message}`);
      return { status: 'failed', reason: 'could not read the objection' };
    }
    if (!objection) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the objection no longer exists' };
    }

    // A person settles an objection through ANY of its three answer columns —
    // a withdrawn ask has an outcome and a person, and no response text to
    // write. Checking response alone let a settled ask rework a quotation
    // hours later off a retry (review finding, 2026-08-24).
    if (objection.response !== null || objection.outcome !== null || objection.answered_by !== null) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'a person already settled this objection' };
    }

    if (objection.kind !== 'feature') {
      // The plan filter said feature; the row is the authority and says
      // otherwise. A price push is a negotiation, trust and timeline are
      // conversations — all three are a person's (ADM-22).
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: `a ${objection.kind} objection is a person's conversation, not a rework`,
      };
    }

    if (!objection.proposal_id) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the ask names no quotation to rework' };
    }

    const { data: proposal, error: proposalError } = await admin
      .schema('sales')
      .from('proposals')
      .select('id, opportunity_id, version, status, title, body, requirement_version_id, document')
      .eq('id', objection.proposal_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();

    if (proposalError) {
      await failJob(admin, job, `could not read the quotation: ${proposalError.message}`);
      return { status: 'failed', reason: 'could not read the quotation' };
    }
    if (!proposal) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the quotation no longer exists' };
    }

    /**
     * The same three-reading resume guard as the revise job: a newer version
     * past draft is already the answer in flight; a person's newer draft is
     * theirs; the agent's own newer draft is a FAILED attempt's half and is
     * superseded, never submitted as-is.
     */
    const { data: newer, error: newerError } = await admin
      .schema('sales')
      .from('proposals')
      .select('id, status, version, generated_by_run_id')
      .eq('opportunity_id', proposal.opportunity_id)
      .eq('organization_id', job.organization_id)
      .gt('version', proposal.version)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newerError) {
      await failJob(admin, job, `could not read newer versions: ${newerError.message}`);
      return { status: 'failed', reason: 'could not read newer versions' };
    }

    let supersedingOwnFailedDraft = false;
    if (newer) {
      if (newer.status !== 'draft') {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: `v${newer.version} is already in flight; the ask will be decided with it`,
        };
      }
      if (!newer.generated_by_run_id) {
        await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
        return {
          status: 'succeeded',
          reason: 'a person is already drafting the next version; theirs wins',
        };
      }
      /**
       * A run id alone cannot say WHOSE work this is — a changes_requested
       * version returns to `draft` with its run id intact, so another
       * cycle's live base looks exactly like this job's own crashed half
       * (review finding, 2026-08-24). The run row is read, never guessed;
       * another cycle's draft is WAITED OUT, because superseding it would
       * revert the owner's revision base with every job reporting success.
       */
      const ownership = await draftBelongsTo(admin, newer.generated_by_run_id, 'sales.objection', objection.id);
      if (!ownership.ok) {
        await failJob(admin, job, ownership.detail);
        return { status: 'failed', reason: 'could not read the drafting run' };
      }
      if (!ownership.own) {
        await failJob(
          admin,
          job,
          `v${newer.version} belongs to another drafting cycle; waiting for it to settle`,
        );
        return { status: 'failed', reason: 'another cycle holds the draft' };
      }
      supersedingOwnFailedDraft = true;
    }

    // The approved→sent gap is DISPATCH mid-flight: the gate's condition is
    // about to become true, and a settle here was permanent for it (review
    // finding, 2026-08-24). Retried instead; if the dispatch dies, the retry
    // budget parks this honestly and the ask stays open for a person.
    if (!supersedingOwnFailedDraft && proposal.status === 'approved') {
      await failJob(
        admin,
        job,
        `v${proposal.version} is approved and on its way to the client; retrying until it lands`,
      );
      return { status: 'failed', reason: 'dispatch in flight' };
    }

    // Only the version the client is HOLDING is reworked from their ask —
    // anything else means the loop is already turning somewhere else.
    if (!supersedingOwnFailedDraft && proposal.status !== 'sent') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return {
        status: 'succeeded',
        reason: `v${proposal.version} is ${proposal.status}; the client is not holding it`,
      };
    }

    const { data: items, error: itemsError } = await admin
      .schema('sales')
      .from('proposal_items')
      .select('description, amount_minor, features')
      .eq('proposal_id', proposal.id)
      .eq('organization_id', job.organization_id)
      .order('position')
      .order('created_at');

    if (itemsError) {
      await failJob(admin, job, `could not read the quotation's lines: ${itemsError.message}`);
      return { status: 'failed', reason: 'could not read the lines' };
    }

    let requirements: unknown = null;
    if (proposal.requirement_version_id) {
      const { data: version, error: versionError } = await admin
        .schema('crm')
        .from('requirement_versions')
        .select('payload')
        .eq('id', proposal.requirement_version_id)
        .eq('organization_id', job.organization_id)
        .maybeSingle();
      if (versionError) {
        await failJob(admin, job, `could not read the requirements: ${versionError.message}`);
        return { status: 'failed', reason: 'could not read the requirements' };
      }
      requirements = version?.payload ?? null;
    }

    const runId = await openRun(ctx, {
      type: 'sales.objection',
      id: objection.id,
      input: { objectionId: objection.id, proposalId: proposal.id } as unknown as Json,
    });

    const storedDocument = parseQuotationDocument(proposal.document ?? null);
    const current = {
      title: proposal.title,
      summary: proposal.body,
      understanding: storedDocument?.understanding ?? undefined,
      lines: (items ?? []).map((i) => ({
        description: i.description,
        priceRupees: Math.round((i.amount_minor ?? 0) / 100),
        features: Array.isArray(i.features) ? i.features : undefined,
      })),
      exclusions: storedDocument?.exclusions ?? undefined,
      assumptions: storedDocument?.assumptions ?? undefined,
      clientResponsibilities: storedDocument?.clientResponsibilities ?? undefined,
    };

    const call = await callModel(
      ctx,
      this,
      [
        {
          role: 'user',
          content: [
            requirements === null
              ? null
              : `The requirements the client agreed:\n\n${JSON.stringify(requirements, null, 2)}`,
            `The quotation the client is holding (v${proposal.version}):\n\n${JSON.stringify(current, null, 2)}`,
            `The client asked, in their own words:\n\n${objection.concern}`,
          ]
            .filter((part): part is string => part !== null)
            .join('\n\n'),
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

    const validated = quotationScopeSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = 'model output failed schema validation';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    // Supersedes the SENT version under the opportunity's lock — §16's own
    // bookkeeping: the number the client is holding is no longer on the
    // table the moment a rework exists, and the history stays what the
    // database wrote.
    const { data: drafted, error: draftError } = await admin.schema('sales').rpc('draft_proposal', {
      p_opportunity_id: proposal.opportunity_id,
      p_title: validated.data.title,
      p_body: validated.data.summary,
      p_valid_until: quotationValidUntil(),
      ...(proposal.requirement_version_id
        ? { p_requirement_version_id: proposal.requirement_version_id }
        : {}),
      ...(runId ? { p_generated_by_run_id: runId } : {}),
      // The base this job reworked FROM, named so the database refuses a
      // stale supersede under its own lock — the guard above is minutes old
      // by the end of a model call (review finding, 2026-08-24).
      p_expected_supersede: supersedingOwnFailedDraft && newer ? newer.id : proposal.id,
    });

    const draft = (Array.isArray(drafted) ? drafted[0] : drafted) as
      | { outcome: string; proposal_id: string | null; version: number | null }
      | undefined;

    if (draft?.outcome === 'stale') {
      // The live version moved between this job's read and its write — the
      // database's own lock said so. Nothing was superseded; the retry
      // re-reads the world through the guards above.
      const detail = 'the live version moved during the model call; retrying against the new world';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'stale base', runId };
    }

    if (draftError || !draft || (draft.outcome !== 'created' && draft.outcome !== 'settled')) {
      const detail = draftError?.message ?? `draft_proposal answered ${draft?.outcome ?? 'nothing'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not draft the rework', detail, runId };
    }

    if (draft.outcome === 'settled') {
      await succeedRun(
        admin,
        runId,
        { outcome: 'deal_settled' } as unknown as Json,
        call.usage,
        call.stepCount,
      );
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', reason: 'the deal settled while the rework was drafted', runId };
    }

    if (!draft.proposal_id) {
      const detail = 'draft_proposal answered created without a proposal id';
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    let written = 0;
    for (const [index, item] of validated.data.items.entries()) {
      const { data: itemData, error: itemError } = await admin.schema('sales').rpc('add_proposal_item', {
        p_proposal_id: draft.proposal_id,
        p_description: item.description,
        p_position: index,
        p_unit_price_minor: item.priceRupees * 100,
        p_features: item.features,
      });
      // `not_draft` arrives as an OUTCOME row, not a transport error — a
      // draft superseded mid-write would otherwise count every refused line
      // as written and report success on destroyed work (review finding,
      // 2026-08-24).
      const added = (Array.isArray(itemData) ? itemData[0] : itemData) as
        | { outcome?: string }
        | undefined;
      if (itemError || added?.outcome !== 'added') {
        const detail = itemError
          ? `line ${index + 1} could not be written: ${itemError.message}`
          : `line ${index + 1} was refused as ${added?.outcome ?? 'nothing'} — the draft moved under the writes`;
        await finishRun(admin, runId, 'failed', detail, call.stepCount);
        await failJob(admin, job, detail);
        return { status: 'failed', reason: 'could not write the rework', detail, runId };
      }
      written += 1;
    }

    /**
     * The document around the lines (G-165) — written while the draft is a
     * draft, frozen by proposals_guard the moment it leaves. Before the
     * submission on purpose: a failure here fails the job, and the retry's
     * resume path supersedes this half rather than submitting it.
     */
    const { error: documentError } = await admin
      .schema('sales')
      .from('proposals')
      .update({
        document: {
          understanding: validated.data.understanding,
          exclusions: validated.data.exclusions,
          assumptions: validated.data.assumptions,
          clientResponsibilities: validated.data.clientResponsibilities,
          // G-167 — every one optional in the schema, so an older model
          // answer simply stores nothing here and renders as it did.
          dependencies: validated.data.dependencies ?? null,
          acceptanceCriteria: validated.data.acceptanceCriteria ?? null,
          optionalAddons: validated.data.optionalAddons ?? null,
          industryTheme: validated.data.industryTheme ?? null,
          regulatedCategory: validated.data.regulatedCategory ?? null,
        },
      })
      .eq('id', draft.proposal_id)
      .eq('organization_id', job.organization_id);

    if (documentError) {
      const detail = `the document could not be written: ${documentError.message}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: 'could not write the document', detail, runId };
    }

    const submitted = await submitDraftedQuotation(admin, draft.proposal_id);
    if (!submitted.ok) {
      await finishRun(admin, runId, 'failed', submitted.detail, call.stepCount);
      await failJob(admin, job, submitted.detail);
      return { status: 'failed', reason: submitted.detail, runId };
    }

    await succeedRun(
      admin,
      runId,
      {
        proposalId: draft.proposal_id,
        version: draft.version,
        items: written,
        submission: submitted.outcome,
        requestId: submitted.requestId,
      } as unknown as Json,
      call.usage,
      call.stepCount,
    );
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);

    return {
      status: 'succeeded',
      reason: `reworked from the client's ask; ${submitted.reason}`,
      runId,
      proposalId: draft.proposal_id,
      items: written,
    };
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
  QUALIFICATION_READ,
  OBJECTION_READ,
  FOLLOW_UP_DRAFT,
  CLIENT_REPLY,
  MEDIA_READ,
  QUOTATION_SCOPE,
  QUOTATION_REVISE,
  QUOTATION_REWORK,
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
