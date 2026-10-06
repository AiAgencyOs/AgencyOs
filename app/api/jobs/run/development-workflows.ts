import type { Json } from '@/lib/db/types';
import { buildFeedbackSuggestionJsonSchema, buildFeedbackSuggestionSchema } from '@/modules/projects/build-feedback-suggestion';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * Phase 5 development workflows. Today: the PM agent's SUGGESTION of how a client's feedback on a build should be classified (P5-FEED-02).
 *
 * The agent proposes; a person decides. Nothing here opens a defect, a Change Request or a revision: the suggestion is recorded beside the
 * existing classification door, which stays the only thing that classifies and routes. A model that
 * answered wrongly, or invented a category, leaves nothing but a refused run: the vocabulary is closed and the schema is strict.
 */

const PROMPT = [
  'A client tested a development build of their software and wrote feedback. You are given their words, verbatim. Propose how it should be classified; a person decides.',
  'Choose exactly one: bug (the build does not do what was approved), missed_requirement (an approved requirement is absent), ui_mismatch (it differs from the approved UI),',
  'included_small_revision (a small change inside the agreed scope), clarification (you genuinely cannot tell what they want: also write the exact question to ask them),',
  'possible_scope_change (a new capability beyond the approved scope), new_feature (a wholly new feature).',
  'Never invent scope you have not been shown, never promise a fix, a price or a date, and never repeat anything that looks like a secret.',
  'Say briefly why in one sentence.',
].join(' ');

const BUILD_FEEDBACK_SUGGEST: AgentWorkflow = {
  jobKind: 'build_feedback.suggest_classification',
  agentKey: 'project_manager',
  systemPrompt: PROMPT,
  schemaName: 'BuildFeedbackSuggestion',
  jsonSchema: buildFeedbackSuggestionJsonSchema,
  workClass: 'draft',

  async run(ctx) {
    const { admin, job } = ctx;
    const feedbackId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
    if (!feedbackId) {
      await failJob(admin, job, 'job payload has no subjectId');
      return { status: 'failed', reason: 'bad payload' };
    }

    // the feedback row is the authority, read again for THIS organization: the event only says which row to look at
    const { data: fb, error: fbError } = await admin
      .schema('projects')
      .from('build_feedback')
      .select('id, project_id, client_words, state')
      .eq('id', feedbackId)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (fbError) {
      await failJob(admin, job, `could not read the feedback: ${fbError.message}`);
      return { status: 'failed', reason: fbError.message };
    }
    if (!fb) {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', outcome: 'gone', reason: 'the feedback no longer exists' };
    }
    if (fb.state !== 'received') {
      await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
      return { status: 'succeeded', outcome: 'already_classified', reason: 'a person already classified this feedback; nothing to suggest' };
    }

    const runId = await openRun(ctx, { type: 'projects.build_feedback', id: fb.id, input: { feedbackId: fb.id, projectId: fb.project_id } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: fb.client_words }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    const validated = buildFeedbackSuggestionSchema.safeParse(call.json);
    if (!validated.success) {
      const detail = `the model's answer was refused: ${validated.error.issues[0]?.message ?? 'unparseable'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    const { data, error } = await admin.schema('projects').rpc('record_feedback_suggestion' as never, {
      p_feedback_id: fb.id,
      p_classification: validated.data.classification,
      p_reasoning: validated.data.reasoning,
      p_question: validated.data.clarifyingQuestion ?? null,
      p_run_id: runId,
    } as never);
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');
    if (outcome !== 'recorded' && outcome !== 'already_classified') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }

    await succeedRun(admin, runId, validated.data as unknown as Json, call.usage, call.stepCount);
    await admin.schema('core').from('jobs').update(settledSucceeded).eq('id', job.id);
    return { status: 'succeeded', reason: outcome, runId, classification: validated.data.classification };
  },
};

export const DEVELOPMENT_WORKFLOWS: readonly AgentWorkflow[] = [BUILD_FEEDBACK_SUGGEST];
