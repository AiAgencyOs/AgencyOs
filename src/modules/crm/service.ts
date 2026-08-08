import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  appendMessageSchema,
  requestExtractionSchema,
  startConversationSchema,
  type AppendMessageInput,
  type RequestExtractionInput,
  type StartConversationInput,
} from './schema';

/**
 * Writes and domain logic for the crm module — its only public surface
 * (ARCHITECTURE.md §3.2).
 *
 * Two layers guard every function here. The capability check answers "may this
 * role perform this action?", which RLS cannot express; RLS then answers
 * "which rows may this principal touch?", which the application must not be
 * trusted to get right. Neither is redundant (ARCHITECTURE.md §8).
 *
 * `lead.write` is reused rather than a new capability invented: a requirement
 * conversation is a lead being worked, and the roles that may work a lead are
 * exactly the roles that may collect its requirements.
 */

const JOB_KIND = 'requirement.extract';

/** Starts a conversation for a lead, or returns the existing active one. */
export async function startConversation(
  input: StartConversationInput,
): Promise<Result<{ conversationId: string }>> {
  const parsed = startConversationSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid conversation request.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to collect requirements.');
  }

  const supabase = await createClient();

  // RLS restricts this read to the caller's organization, so a lead id from
  // another tenant simply is not found rather than being rejected as
  // forbidden — which also avoids confirming that the id exists at all.
  const { data: lead, error: leadError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, contact_id, organization_id')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (leadError) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const { data: existing } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('lead_id', lead.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return ok({ conversationId: existing.id });

  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .insert({
      organization_id: lead.organization_id,
      lead_id: lead.id,
      contact_id: lead.contact_id,
      channel: parsed.data.channel,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'startConversation', detail: error?.message }),
    );
    return err('INTERNAL', 'Could not start the conversation.');
  }

  return ok({ conversationId: data.id });
}

/**
 * Appends a message to the transcript.
 *
 * `seq` is assigned from the current maximum. Two concurrent appends can
 * therefore collide on the (conversation_id, seq) unique index; that surfaces
 * as CONFLICT rather than silently reordering the transcript. A single
 * interviewer per thread makes this rare, and losing the write is strictly
 * better than corrupting the order of what a customer said.
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<Result<{ messageId: string; seq: number }>> {
  const parsed = appendMessageSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Message could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to add messages.');
  }

  const supabase = await createClient();

  const { data: conversation, error: convError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, organization_id')
    .eq('id', parsed.data.conversationId)
    .maybeSingle();

  if (convError) return err('INTERNAL', 'Could not load the conversation.');
  if (!conversation) return err('NOT_FOUND', 'Conversation not found.');

  const { data: last } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('seq')
    .eq('conversation_id', conversation.id)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();

  const seq = (last?.seq ?? -1) + 1;

  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .insert({
      organization_id: conversation.organization_id,
      conversation_id: conversation.id,
      seq,
      author_type: parsed.data.authorType,
      author_id: parsed.data.authorType === 'user' ? context.userId : null,
      body: parsed.data.body,
    })
    .select('id, seq')
    .single();

  if (error || !data) {
    // 23505 = unique_violation on (conversation_id, seq).
    if (error?.code === '23505') {
      return err('CONFLICT', 'Another message was added at the same time. Please retry.');
    }
    console.error(
      JSON.stringify({ level: 'error', scope: 'appendMessage', detail: error?.message }),
    );
    return err('INTERNAL', 'Could not save the message.');
  }

  return ok({ messageId: data.id, seq: data.seq });
}

/**
 * Enqueues a requirement extraction.
 *
 * Extraction deliberately does not run here. `ai.agent_runs` is service-role
 * write-only so a trace cannot be forged, and ARCHITECTURE.md §7.3 permits the
 * service-role client in exactly four places — a Server Action is not one of
 * them. So this writes a job and the runner (app/api/jobs/run) executes it
 * under the role that is allowed to record the run.
 *
 * `dedupe_key` makes a double click a no-op rather than two model calls
 * against the same transcript.
 */
export async function requestExtraction(
  input: RequestExtractionInput,
): Promise<Result<{ enqueued: boolean; jobId: string | null }>> {
  const parsed = requestExtractionSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid extraction request.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to run extraction.');
  }

  const supabase = await createClient();

  const { data: conversation, error: convError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, organization_id')
    .eq('id', parsed.data.conversationId)
    .maybeSingle();

  if (convError) return err('INTERNAL', 'Could not load the conversation.');
  if (!conversation) return err('NOT_FOUND', 'Conversation not found.');

  const { count } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id);

  if (!count) {
    return err('VALIDATION', 'Add at least one message before running extraction.');
  }

  // One queued extraction per conversation per message count: re-running after
  // the transcript grows is a genuinely different request.
  const dedupeKey = `${JOB_KIND}:${conversation.id}:${count}`;

  const { data, error } = await supabase
    .schema('core')
    .from('jobs')
    .insert({
      organization_id: conversation.organization_id,
      kind: JOB_KIND,
      payload: { conversationId: conversation.id, requestedBy: context.userId },
      dedupe_key: dedupeKey,
      correlation_id: crypto.randomUUID(),
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Already queued for this exact transcript state.
      return ok({ enqueued: false, jobId: null });
    }
    console.error(
      JSON.stringify({ level: 'error', scope: 'requestExtraction', detail: error.message }),
    );
    return err('INTERNAL', 'Could not queue the extraction.');
  }

  return ok({ enqueued: true, jobId: data?.id ?? null });
}

/**
 * Records a human decision on a proposed requirement set.
 *
 * The payload itself is immutable (enforced by the crm.requirement_versions
 * guard trigger), so this only moves status. Editing means writing the next
 * version.
 */
export async function decideRequirementVersion(
  versionId: string,
  decision: 'accepted' | 'rejected',
): Promise<Result<{ updated: true }>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to decide requirements.');
  }

  const supabase = await createClient();

  const { error } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .update({ status: decision })
    .eq('id', versionId);

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'decideRequirementVersion', detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the decision.');
  }

  return ok({ updated: true });
}
