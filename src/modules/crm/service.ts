import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addLeadNoteSchema,
  appendMessageSchema,
  requestExtractionSchema,
  setLeadFollowUpSchema,
  setLeadQualificationSchema,
  startConversationSchema,
  updateLeadStatusSchema,
  LEAD_TRANSITIONS,
  type AddLeadNoteInput,
  type AppendMessageInput,
  type LeadStatus,
  type RequestExtractionInput,
  type SetLeadFollowUpInput,
  type SetLeadQualificationInput,
  type StartConversationInput,
  type UpdateLeadStatusInput,
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
 * This is the approval gate. The requirement_collector agent is L1 — it
 * proposes, a human decides — so nothing downstream may treat an extraction as
 * agreed scope until this has run (ARCHITECTURE.md §6.1).
 *
 * Three things make the decision trustworthy, and none of them is this
 * function's own diligence:
 *
 *   • The payload is immutable. crm.requirement_versions_guard permits `status`
 *     and nothing else, so deciding cannot quietly rewrite what was decided on.
 *     Editing means writing the next version.
 *   • Only `proposed` can be decided. The same trigger refuses accepted →
 *     rejected, so a decision already made cannot be reversed by a later
 *     caller. The read below turns that into a clear CONFLICT instead of a
 *     database error, but the database is what enforces it.
 *   • Tenancy is RLS. The select and the update both run through the
 *     session-scoped client, so a version belonging to another organization is
 *     not visible and cannot be reached by guessing an id.
 *
 * The read before the write exists to tell those cases apart. Updating blind
 * would report success for a row that does not exist, belongs to somebody else,
 * or was decided an hour ago — three different answers the caller needs.
 */
export async function decideRequirementVersion(
  versionId: string,
  decision: 'accepted' | 'rejected',
): Promise<Result<{ versionId: string; status: 'accepted' | 'rejected' }>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to decide requirements.');
  }

  const supabase = await createClient();

  const { data: version, error: readError } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id, organization_id, conversation_id, version, status')
    .eq('id', versionId)
    .maybeSingle();

  if (readError) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'decideRequirementVersion', detail: readError.message }),
    );
    return err('INTERNAL', 'Could not load the requirement version.');
  }

  // Invisible under RLS and genuinely absent are the same answer on purpose:
  // telling a caller that a row exists in an organization they cannot see is
  // itself a leak.
  if (!version) return err('NOT_FOUND', 'Requirement version not found.');

  if (version.status !== 'proposed') {
    return err(
      'CONFLICT',
      `This requirement set is already ${version.status}. Run a new extraction to propose another.`,
    );
  }

  const { data: updated, error } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .update({ status: decision })
    // Re-stating the predicate makes the write conditional on the state the
    // read saw, so two people deciding at once cannot both succeed.
    .eq('id', versionId)
    .eq('status', 'proposed')
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'decideRequirementVersion', detail: error.message }),
    );
    return err('INTERNAL', 'Could not record the decision.');
  }

  if (!updated) {
    return err('CONFLICT', 'Someone else decided this requirement set first.');
  }

  // Rule 4: nothing important happens without an audit row. Which human agreed
  // to which scope, and when, is the whole point of an approval gate.
  await recordAudit({
    organizationId: version.organization_id,
    action: `requirement.${decision}`,
    subjectType: 'crm.requirement_version',
    subjectId: versionId,
    before: { status: 'proposed' },
    after: {
      status: decision,
      conversationId: version.conversation_id,
      version: version.version,
    },
  });

  return ok({ versionId, status: decision });
}

// ── Lead pipeline ─────────────────────────────────────────────────────────

/**
 * Moves a lead through the pipeline.
 *
 * The transition table is consulted before the write, so an illegal move is a
 * CONFLICT rather than a database error — and `converted` cannot be set from
 * here at all, because becoming a project is a side effect of winning the
 * opportunity, not a status a human types in (see sales/service.ts).
 */
export async function setLeadStatus(
  input: UpdateLeadStatusInput,
): Promise<Result<{ status: LeadStatus }>> {
  const parsed = updateLeadStatusSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid status change.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to change lead status.');
  }

  if (parsed.data.status === 'converted') {
    return err(
      'VALIDATION',
      'A lead becomes converted by winning its opportunity, not by setting the status directly.',
    );
  }
  if (parsed.data.status === 'disqualified' && !parsed.data.reason?.trim()) {
    return err('VALIDATION', 'A disqualified lead needs a reason.');
  }

  const supabase = await createClient();

  const { data: lead, error: readError } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, status, organization_id')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (readError) return err('INTERNAL', 'Could not load the lead.');
  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const from = lead.status as LeadStatus;
  const to = parsed.data.status;

  if (from === to) return ok({ status: to });
  if (!LEAD_TRANSITIONS[from]?.includes(to)) {
    return err('CONFLICT', `A lead cannot move from ${from} to ${to}.`);
  }

  const now = new Date().toISOString();
  const { error } = await supabase
    .schema('crm')
    .from('leads')
    .update({
      status: to,
      // The table's CHECK constraints require these to be set alongside the
      // terminal statuses; keeping it here means the DB never has to reject us.
      ...(to === 'qualified' ? { qualified_at: now } : {}),
      ...(to === 'disqualified' ? { disqualified_reason: parsed.data.reason ?? null } : {}),
    })
    .eq('id', lead.id);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadStatus', detail: error.message }));
    return err('INTERNAL', 'Could not update the lead.');
  }

  await recordActivity(supabase, {
    organizationId: lead.organization_id,
    leadId: lead.id,
    kind: 'status_change',
    body: parsed.data.reason ?? `${from} → ${to}`,
    actorId: context.userId,
    metadata: { from, to },
  });

  await recordAudit({
    organizationId: lead.organization_id,
    action: 'lead.status_changed',
    subjectType: 'lead',
    subjectId: lead.id,
    before: { status: from },
    after: { status: to, reason: parsed.data.reason ?? null },
  });

  return ok({ status: to });
}

/** Adds a sales note to the lead timeline. */
export async function addLeadNote(input: AddLeadNoteInput): Promise<Result<{ added: true }>> {
  const parsed = addLeadNoteSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Note could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to add notes.');
  }

  const supabase = await createClient();
  const { data: lead } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const written = await recordActivity(supabase, {
    organizationId: lead.organization_id,
    leadId: lead.id,
    kind: 'note',
    body: parsed.data.body,
    actorId: context.userId,
  });

  if (!written) return err('INTERNAL', 'Could not save the note.');

  await recordAudit({
    organizationId: lead.organization_id,
    action: 'lead.note_added',
    subjectType: 'lead',
    subjectId: lead.id,
  });

  return ok({ added: true });
}

/** Replaces the lead's qualification record. */
export async function setLeadQualification(
  input: SetLeadQualificationInput,
): Promise<Result<{ saved: true }>> {
  const parsed = setLeadQualificationSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Qualification could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to qualify leads.');
  }

  const supabase = await createClient();
  const { data: lead } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id, qualification')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const { error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ qualification: parsed.data.qualification })
    .eq('id', lead.id);

  if (error) return err('INTERNAL', 'Could not save the qualification.');

  await recordAudit({
    organizationId: lead.organization_id,
    action: 'lead.qualification_updated',
    subjectType: 'lead',
    subjectId: lead.id,
    before: lead.qualification,
    after: parsed.data.qualification,
  });

  return ok({ saved: true });
}

/** Schedules — or clears — the next sales touch. */
export async function setLeadFollowUp(
  input: SetLeadFollowUpInput,
): Promise<Result<{ saved: true }>> {
  const parsed = setLeadFollowUpSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid follow-up date.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to schedule follow-ups.');
  }

  const supabase = await createClient();
  const { data: lead } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!lead) return err('NOT_FOUND', 'Lead not found.');

  const { error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ next_follow_up_at: parsed.data.nextFollowUpAt })
    .eq('id', lead.id);

  if (error) return err('INTERNAL', 'Could not schedule the follow-up.');

  await recordAudit({
    organizationId: lead.organization_id,
    action: 'lead.follow_up_scheduled',
    subjectType: 'lead',
    subjectId: lead.id,
    after: { nextFollowUpAt: parsed.data.nextFollowUpAt },
  });

  return ok({ saved: true });
}

/**
 * Marks a lead converted. Called by sales/service.ts when its opportunity is
 * won — not exposed to the UI, because conversion is a consequence of winning
 * rather than an independent action.
 */
export async function markLeadConverted(leadId: string): Promise<Result<{ converted: true }>> {
  const supabase = await createClient();

  const { error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ status: 'converted', converted_at: new Date().toISOString() })
    .eq('id', leadId);

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'markLeadConverted', detail: error.message }),
    );
    return err('INTERNAL', 'Could not mark the lead converted.');
  }

  return ok({ converted: true });
}

/** Shared writer for the crm.lead_activities timeline. */
async function recordActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  entry: {
    organizationId: string;
    leadId: string;
    kind: 'note' | 'status_change' | 'assignment';
    body: string;
    actorId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const { error } = await supabase
    .schema('crm')
    .from('lead_activities')
    .insert({
      organization_id: entry.organizationId,
      lead_id: entry.leadId,
      kind: entry.kind,
      body: entry.body,
      actor_type: 'user',
      actor_id: entry.actorId,
      ...(entry.metadata ? { metadata: entry.metadata as never } : {}),
    });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordActivity', detail: error.message }));
    return false;
  }
  return true;
}
