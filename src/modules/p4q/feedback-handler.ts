import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';

import { callDoor } from './door';

type Admin = ReturnType<typeof createAdminClient>;

export const FEEDBACK_CLASSIFICATIONS = ['CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST'] as const;
export type FeedbackClassification = (typeof FEEDBACK_CLASSIFICATIONS)[number];

/** Anything that turns the client's words into one of the six labels. The real one calls a model; tests and the stub-model proof use `keywordFeedbackClassifier`. */
export type FeedbackClassifier = (clientWords: string) => Promise<{ classification: FeedbackClassification; reasoning: string }>;

/**
 * A deterministic classifier used where no funded model is available (the stub-model proof of the workflow). It is conservative: anything it cannot place is a
 * CLARIFICATION, never a CORRECTION, so an unclear request is asked about instead of rebuilt. It is NOT a stand-in for model judgement in production.
 */
export const keywordFeedbackClassifier: FeedbackClassifier = async (words) => {
  const w = words.toLowerCase();
  if (/\b(start over|different style|new direction|redo the whole|completely different)\b/.test(w)) return { classification: 'DESIGN_DIRECTION_CHANGE', reasoning: 'asks for a different overall direction' };
  if (/\b(add|new feature|also want|integrate|loyalty|payments?|subscription|chat|another module)\b/.test(w)) return { classification: 'POSSIBLE_SCOPE_CHANGE', reasoning: 'asks for something that is not in the approved scope' };
  if (/\b(no\b.*\bwon'?t|refuse|not doing|cancel this|reject)\b/.test(w)) return { classification: 'REJECTED_REQUEST', reasoning: 'rejects the build' };
  if (/\b(colou?r|font|size|bigger|smaller|typo|spelling|spacing|align|label|wording|move|text)\b/.test(w)) return { classification: 'CORRECTION', reasoning: 'a visual or wording correction of what was shown' };
  return { classification: 'CLARIFICATION', reasoning: 'the request is not clear enough to act on' };
};

/**
 * `project.deliverable_decided` (kind = prototype, changes_requested) -> classify the client's words against the EXACT build and route them (P4-PM-011).
 *
 * The words are read from the approval request the deliverable decision came from (never from the event payload, which is a claim). The database door stores
 * them verbatim, applies the label, and routes: CORRECTION / INCLUDED_REVISION allow the rebuild, CLARIFICATION becomes a clarification request, POSSIBLE_SCOPE_CHANGE
 * becomes a change request (or a person is told when there is no active scope), a direction change or a rejected request is escalated.
 * With no classifier supplied this fails honestly as environment_missing instead of guessing.
 */
export async function handleP4qClassifyPrototypeFeedback(admin: Admin, job: UnlockJob, classifier?: FeedbackClassifier): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const deliverableId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;
  const event = (envelope.event ?? {}) as { kind?: unknown; status?: unknown };
  if (!deliverableId) return { status: 'failed', permanent: true, detail: 'the event named no deliverable' };
  if (event.kind !== 'prototype' || event.status !== 'changes_requested') {
    return { status: 'succeeded', outcome: 'not_mine', detail: 'only a prototype changes_requested decision is classified here' };
  }
  if (!classifier) return { status: 'failed', permanent: true, detail: 'environment_missing: no feedback classifier (model) is configured; nothing was classified' };

  const { data: deliverable, error: dError } = await admin
    .schema('projects')
    .from('deliverables')
    .select('id, approval_request_id')
    .eq('id', deliverableId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (dError) return { status: 'failed', permanent: false, detail: `the deliverable could not be read: ${dError.message}` };
  if (!deliverable?.approval_request_id) return { status: 'succeeded', outcome: 'gone', detail: 'no deliverable or no decision to classify' };

  const { data: request, error: rError } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('id, decision_note')
    .eq('id', deliverable.approval_request_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (rError) return { status: 'failed', permanent: false, detail: `the decision could not be read: ${rError.message}` };
  const words = request?.decision_note?.trim();
  if (!words) return { status: 'succeeded', outcome: 'no_words', detail: 'the decision carried no words to classify; a person reads the review' };

  let verdict: Awaited<ReturnType<FeedbackClassifier>>;
  try {
    verdict = await classifier(words);
  } catch (err) {
    return { status: 'failed', permanent: false, detail: `the classifier failed: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  if (!FEEDBACK_CLASSIFICATIONS.includes(verdict.classification)) return { status: 'failed', permanent: true, detail: 'the classifier returned a label outside the six' };

  const result = await callDoor(admin, 'projects', 'p4q_classify_prototype_feedback', {
    p_deliverable_id: deliverableId,
    p_decision_key: request!.id,
    p_client_words: words,
    p_classification: verdict.classification,
    p_reasoning: verdict.reasoning.slice(0, 500),
  });
  if (!result.ok) return { status: 'failed', permanent: false, detail: `the door did not answer: ${result.message}` };
  const outcome = result.row.outcome ?? 'no answer';
  if (outcome === 'classified' || outcome === 'already_classified') {
    return { status: 'succeeded', outcome: `${verdict.classification}:${String(result.row.routed_to)}`, detail: `Prototype feedback ${outcome}; routed to ${String(result.row.routed_to)}.` };
  }
  return { status: 'failed', permanent: outcome !== 'no_actor', detail: `the door answered ${outcome}` };
}
