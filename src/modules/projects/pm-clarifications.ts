import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { sendSystemText } from '@/modules/crm/system-message';

import type { HandlerResult } from './handlers';
import { isSafeClientQuestion, pmClarificationAsk } from './pm-messages';
import { loadContext, projectForConversation, settle, type PmCommsJob } from './pm-client-comms';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Planning §10 — the planner asks, the PM puts it to the client, the client's
 * answer comes back, and the plan waits for a person to settle it.
 *
 *   planner raises a clarification         (open)
 *   PM asks the client, ONE at a time      (asked)    ← handleAskClarification
 *   client's next message is recorded      (answered) ← handleReadClarificationAnswer
 *   a person resolves it, or routes it to a change request when the answer is
 *   new scope - the system never decides what an answer means for the plan.
 *
 * One at a time because a message with four questions in it is a form, and
 * because an answer can only be matched to a question when only one is out.
 * The next question goes when the person resolves the last (the same handler
 * listens to `project.clarification_resolved`).
 *
 * The question's words come from a model, so they pass `isSafeClientQuestion`
 * before they reach a client; one that does not is held for a person and
 * staff are told. Every message is sent at most once under a stable reference.
 */

type ClarificationRow = { id: string; question: string; status: string; asked_at: string | null; created_at: string };

async function draftClarifications(admin: Admin, organizationId: string, projectId: string): Promise<{ rows: ClarificationRow[] } | { error: string }> {
  const { data: plan, error: planError } = await admin
    .schema('projects')
    .from('project_plans')
    .select('id')
    .eq('project_id', projectId)
    .eq('organization_id', organizationId)
    .eq('status', 'draft')
    .maybeSingle();
  if (planError) return { error: `could not read the plan: ${planError.message}` };
  if (!plan) return { rows: [] };

  const { data, error } = await admin
    .schema('projects')
    .from('plan_clarifications')
    .select('id, question, status, asked_at, created_at')
    .eq('plan_id', plan.id)
    .eq('organization_id', organizationId)
    .in('status', ['open', 'asked'])
    .order('created_at', { ascending: true });
  if (error) return { error: `could not read the clarifications: ${error.message}` };
  return { rows: data ?? [] };
}

export async function handleAskClarification(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const projectId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };

  const read = await draftClarifications(admin, job.organization_id, projectId);
  if ('error' in read) return { status: 'failed', permanent: false, detail: read.error };
  if (read.rows.some((r) => r.status === 'asked')) {
    return { status: 'succeeded', outcome: 'waiting_on_the_client', detail: 'a question is already out; the next goes when it is settled' };
  }
  const next = read.rows.find((r) => r.status === 'open');
  if (!next) return { status: 'succeeded', outcome: 'nothing_to_ask', detail: 'no open question on a draft plan' };

  const ctx = await loadContext(admin, job.organization_id, projectId);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };

  if (!isSafeClientQuestion(next.question)) {
    await admin.schema('core').rpc('raise_alert', {
      p_organization_id: job.organization_id,
      p_source: 'planning',
      p_severity: 'warning',
      p_summary: `${ctx.projectName}: the planner's question to the client was held back (it reads as more than a plain question) — ask it yourself: "${next.question.slice(0, 200)}"`,
      p_fingerprint: `planning-question-held:${next.id}`,
    });
    return { status: 'succeeded', outcome: 'held_for_a_person', detail: 'the question did not read as a single plain question' };
  }
  if (!ctx.conversationId) {
    await admin.schema('core').rpc('raise_alert', {
      p_organization_id: job.organization_id,
      p_source: 'planning',
      p_severity: 'info',
      p_summary: `${ctx.projectName}: the planner has a question for the client but there is no WhatsApp thread to ask it on: "${next.question.slice(0, 200)}"`,
      p_fingerprint: `planning-question-no-thread:${next.id}`,
    });
    return { status: 'succeeded', outcome: 'no_thread', detail: 'nowhere to ask it' };
  }

  const ref = `pm:clarify:${next.id}`;
  const sent = await sendSystemText(admin as never, {
    organizationId: job.organization_id,
    conversationId: ctx.conversationId,
    body: pmClarificationAsk(ctx.language, next.question),
    ref,
  });
  const result = settle([{ label: 'planning question', result: sent }]);
  if (result.status === 'failed' || sent.kind === 'no_consent' || sent.kind === 'in_flight') return result;

  // The message's own record is the evidence the door asks for.
  const { data: message } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('external_ref', ref)
    .maybeSingle();
  if (!message) return { status: 'failed', permanent: false, detail: 'the question was sent but its record could not be found' };

  const { data: marked, error } = await admin.schema('projects').rpc('agent_mark_clarification_asked', {
    p_clarification_id: next.id,
    p_message_id: message.id,
  });
  if (error) return { status: 'failed', permanent: false, detail: `could not record the question as asked: ${error.message}` };
  return { status: 'succeeded', outcome: String(marked ?? 'unknown'), detail: `planning question ${next.id}: ${String(marked)}` };
}

/** `message.received` → if the client is answering a planning question, keep the answer for a person to settle. */
export async function handleReadClarificationAnswer(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const messageId = typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;
  if (!messageId) return { status: 'failed', permanent: true, detail: 'the event named no message' };

  const { data: message, error } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id, body, author_type, conversation_id, created_at')
    .eq('id', messageId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the message: ${error.message}` };
  if (!message || message.author_type !== 'client' || !message.body?.trim()) {
    return { status: 'succeeded', outcome: 'not_applicable', detail: 'not a client text message' };
  }

  const { data: conversation } = await admin
    .schema('crm')
    .from('conversations')
    .select('id, kind, project_id, lead_id')
    .eq('id', message.conversation_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (!conversation) return { status: 'succeeded', outcome: 'gone', detail: 'the conversation no longer exists' };

  const projectId = await projectForConversation(admin, job.organization_id, conversation);
  if (!projectId) return { status: 'succeeded', outcome: 'no_project', detail: 'this thread belongs to no project' };

  const read = await draftClarifications(admin, job.organization_id, projectId);
  if ('error' in read) return { status: 'failed', permanent: false, detail: read.error };
  const asked = read.rows.find((r) => r.status === 'asked' && r.asked_at && r.asked_at <= message.created_at);
  if (!asked) return { status: 'succeeded', outcome: 'nothing_asked', detail: 'no planning question is waiting for an answer' };

  const { data: recorded, error: doorError } = await admin.schema('projects').rpc('agent_record_clarification_answer', {
    p_clarification_id: asked.id,
    p_message_id: message.id,
  });
  if (doorError) return { status: 'failed', permanent: false, detail: `could not record the answer: ${doorError.message}` };
  if (recorded !== 'answered') return { status: 'succeeded', outcome: String(recorded), detail: `the door answered ${String(recorded)}` };

  const { data: project } = await admin.schema('projects').from('projects').select('name').eq('id', projectId).eq('organization_id', job.organization_id).maybeSingle();
  await admin.schema('core').rpc('raise_alert', {
    p_organization_id: job.organization_id,
    p_source: 'planning',
    p_severity: 'info',
    p_summary: `${project?.name ?? 'A project'}: the client answered the planning question "${asked.question.slice(0, 120)}" — "${message.body.trim().slice(0, 160)}". Review it on the plan page and resolve it (or route it to a change request if it adds scope).`,
    p_fingerprint: `planning-answer:${asked.id}`,
  });
  return { status: 'succeeded', outcome: 'answered', detail: `kept the client's answer to ${asked.id} for a person to settle` };
}
