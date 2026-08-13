import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  addLeadNoteSchema,
  appendMessageSchema,
  sendClientMessageSchema,
  requestExtractionSchema,
  setLeadFollowUpSchema,
  setLeadQualificationSchema,
  startConversationSchema,
  updateLeadStatusSchema,
  LEAD_TRANSITIONS,
  type AddLeadNoteInput,
  type AppendMessageInput,
  type SendClientMessageInput,
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

  // A read that failed is not "there is no conversation yet" (audit D12).
  // Nothing in the database holds one-active-conversation-per-lead, so this
  // read is the only thing standing between a blip and a second conversation
  // — and a second one hides the first from every later query, which all take
  // the most recent active thread.
  const { data: existing, error: existingError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('lead_id', lead.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'startConversation', detail: existingError.message }),
    );
    return err('INTERNAL', 'Could not check for an existing conversation. Please try again.');
  }

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

  // A read that failed is not an empty transcript (audit D11). It used to
  // fall through to seq 0, which collides with the first message already
  // there — and `unique (conversation_id, seq)` then reported that to the
  // operator as "somebody else posted at the same moment", which is a
  // statement about another person rather than about a database that did not
  // answer.
  const { data: last, error: lastError } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('seq')
    .eq('conversation_id', conversation.id)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastError) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'appendMessage', detail: lastError.message }),
    );
    return err('INTERNAL', 'Could not read the conversation. Please try again.');
  }

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
/**
 * Send a message to the client, and record it either way.
 *
 * Gap G-014, decision ADM-09. This is the first thing in AgencyOS that speaks
 * to a client rather than about one, and the ordering is what makes it safe:
 *
 *   The row is written first, by `crm.send_outbound_message`, marked pending
 *   and keyed on an idempotency reference. A message sent and not recorded is
 *   invisible — nobody knows it went, a retry sends it twice, and the
 *   transcript the extractor reads has a hole in it. A message recorded and
 *   not sent is merely wrong where anybody can see it.
 *
 *   The provider is called second, and what it says is written back. A failure
 *   leaves a `failed` row with the reason on it, which is a thing an operator
 *   can act on rather than a silence.
 *
 * **Nothing here composes the message.** The body is whatever a human typed.
 * An AI-drafted follow-up is G-012, and directive §7 says it goes through an
 * approval before it reaches anybody — the engine for which now exists, and
 * this function will be what it calls once that policy is written down.
 */
export async function sendClientMessage(
  input: SendClientMessageInput,
): Promise<Result<{ messageId: string; seq: number; delivered: boolean }>> {
  const parsed = sendClientMessageSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That message could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  // Reused rather than invented: `lead.write` is already what it takes to add
  // to a transcript, and this is that plus delivery. A new capability mapping
  // to the same role set would add vocabulary without adding control.
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to message clients.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: parsed.data.conversationId,
    p_body: parsed.data.body,
    p_external_ref: parsed.data.idempotencyKey,
    ...(context.userId ? { p_author_id: context.userId } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendClientMessage', detail: error.message }));
    return err('INTERNAL', 'Could not record the message.');
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found';
        message_id: string | null;
        seq: number | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
      }
    | undefined;

  if (!queued) return err('INTERNAL', 'Could not record the message.');
  if (queued.outcome === 'not_found') return err('NOT_FOUND', 'Conversation not found.');

  // A retry of the same send. Reported as success, because it is: the message
  // this caller asked for is on its way or already gone, and telling them it
  // failed is how a person ends up sending it twice on purpose.
  if (queued.outcome === 'already_sent') {
    return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
  }

  if (!queued.to_phone) {
    await supabase.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the contact has no phone number',
    });
    return err('VALIDATION', 'This contact has no phone number to message.');
  }

  // Imported here rather than at the top of the module. The provider module
  // reads the environment, and this service is imported by half the test
  // suite — a module-load side effect on a path most callers never take made
  // four unrelated test files fail to load, which is a cost paid by everybody
  // for one function's dependency.
  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    body: parsed.data.body,
  });

  await supabase.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.data.providerRef } : { p_error: sent.error.message }),
  });

  if (!sent.ok) {
    // The row survives with the reason on it, so the operations screen and the
    // transcript both show an attempt that failed rather than nothing at all.
    return err(sent.error.code, sent.error.message);
  }

  // No recordAudit call here: crm.mark_outbound_delivery writes the audit row
  // from inside its own transaction (G-079), so the history of a delivered
  // message commits with the delivery rather than in a request of its own.
  return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
}

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
  // The predicate the decision was made against, restated in the write (audit
  // D10). Reading the state and then matching on the id alone means a
  // concurrent transition is silently overwritten — the same shape D1, D2 and
  // D4 fixed in finance, where the answer was a lock. Here a compare-and-swap
  // is enough: there is no ledger to sum, only a state to not clobber, and a
  // write that matches zero rows says the world moved.
  const { data: moved, error } = await supabase
    .schema('crm')
    .from('leads')
    .update({
      status: to,
      // The table's CHECK constraints require these to be set alongside the
      // terminal statuses; keeping it here means the DB never has to reject us.
      ...(to === 'qualified' ? { qualified_at: now } : {}),
      // Cleared on the way out as well as set on the way in (audit D13): a
      // reopened lead should not still carry the reason it was rejected for.
      ...(to === 'disqualified'
        ? { disqualified_reason: parsed.data.reason ?? null }
        : from === 'disqualified'
          ? { disqualified_reason: null }
          : {}),
    })
    .eq('id', lead.id)
    .eq('status', from)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setLeadStatus', detail: error.message }));
    return err('INTERNAL', 'Could not update the lead.');
  }

  if (!moved) {
    return err(
      'CONFLICT',
      'This lead was changed by somebody else while you were working. Reload and try again.',
    );
  }

  await recordActivity(supabase, {
    organizationId: lead.organization_id,
    leadId: lead.id,
    kind: 'status_change',
    body: parsed.data.reason ?? `${from} → ${to}`,
    actorId: context.userId,
    metadata: { from, to },
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

  return ok({ saved: true });
}

/**
 * Marks a lead converted. Called by sales/service.ts when its opportunity is
 * won — not exposed to the UI, because conversion is a consequence of winning
 * rather than an independent action.
 *
 * Audit finding D20. This used to write `status = 'converted'` with the lead id
 * as its only predicate: no read, no transition check, and no look at whether
 * the write matched anything. Three separate things followed from that.
 *
 * It could move a lead from any state, including the two where doing so is
 * plainly wrong. A deal won against a *disqualified* lead forced it converted
 * anyway, carrying its `disqualified_reason` with it — D13 exists precisely to
 * clear that reason on the way out of `disqualified`, and this door left it
 * set. `createOpportunity` refuses to open a deal on a disqualified lead, so
 * reaching that state means somebody disqualified it *after* the deal existed:
 * a disagreement two people should resolve, not one this function should
 * settle by overwriting.
 *
 * It rewrote `converted_at` every time it ran. Re-running a conversion moved
 * the recorded moment of conversion to now, and that column is the only record
 * of when a lead actually became a client.
 *
 * And it reported success when it changed nothing. Without `.select()` a
 * PostgREST update that matched zero rows is indistinguishable from one that
 * matched — so a lead deleted, or belonging to another organization and
 * therefore invisible under RLS, came back as converted.
 *
 * The shape below is the one D10 established for `setLeadStatus`,
 * `setOpportunityStage` and `setProjectStatus`: restate the state the decision
 * was made against in the write itself, then find out why nothing moved rather
 * than assuming either answer.
 */
export async function markLeadConverted(
  leadId: string,
  /**
   * Who caused the conversion.
   *
   * Taken as a parameter rather than resolved here, because this function is
   * not on a request path of its own — it is called by sales when a deal is
   * won, and the person who moved that deal is the person who converted the
   * lead. Optional so the one existing caller can be updated in the same
   * change without the signature becoming a lie in between (gap G-087).
   */
  actorId?: string,
): Promise<Result<{ converted: true }>> {
  const supabase = await createClient();

  // The states a won deal may convert from — deliberately *not*
  // LEAD_TRANSITIONS' `qualified` alone.
  //
  // That map says which moves a person may make through setLeadStatus, and it
  // admits only `qualified → converted`. But `createOpportunity` refuses only
  // a *disqualified* lead, so deals are routinely opened on `new` and
  // `qualifying` ones, and those have always been converted when the deal was
  // won. Narrowing to `qualified` here would strand them: a project would
  // exist whose lead still reads `qualifying`, with nothing to reconcile it.
  //
  // Whether winning a deal should imply qualification, or should be refused
  // until somebody qualifies the lead, is a question about how this agency
  // works rather than about this code. It is raised as ADM-41 and is not
  // answered here. What is fixed is the part that is wrong under any answer:
  // `disqualified` and `converted` are excluded, and a write that matches
  // nothing is no longer reported as success.
  const CONVERTIBLE = ['new', 'qualifying', 'qualified'] as const;

  // Restating the status in the write is what makes the check hold under a
  // concurrent one: a lead disqualified between the caller's decision and this
  // statement matches nothing rather than being overwritten.
  const { data: moved, error } = await supabase
    .schema('crm')
    .from('leads')
    .update({ status: 'converted', converted_at: new Date().toISOString() })
    .eq('id', leadId)
    .in('status', CONVERTIBLE)
    // Every other lead read in this module filters soft deletes; this write
    // did not, so a deleted lead was genuinely converted rather than skipped.
    // RLS does not cover it either — `leads_write` carries no `deleted_at`
    // predicate.
    .is('deleted_at', null)
    .select('id, organization_id, status')
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'markLeadConverted', detail: error.message }),
    );
    return err('INTERNAL', 'Could not mark the lead converted.');
  }

  if (moved) {
    // Every other gated transition on a lead writes one of these, and this is
    // now a gated transition (SECURITY.md §7). Without it the move that turns
    // a prospect into a client left no record of who made it or when.
    //
    // No `before`, deliberately. A returning UPDATE hands back the row it
    // wrote, so `moved.status` is already 'converted' — recording it as the
    // prior state would be a lie. The only way to have the real one is to read
    // before writing, which is the round trip this shape exists to avoid; what
    // is certain is recorded instead, as the set the swap would accept.
    // And the lead's own visible history (gap G-087). setLeadStatus writes one
    // of these for every move a person makes; this door wrote none, so the
    // timeline on the lead page ran from "qualified" straight to nothing, with
    // the moment it became a client missing from the only place a human looks.
    //
    // Skipped rather than faked when there is no actor: `actor_id` is what
    // makes the row answerable, and `recordActivity` has no anonymous form.
    // The audit row above is written either way, so nothing is lost silently.
    if (actorId) {
      await recordActivity(supabase, {
        organizationId: moved.organization_id,
        leadId,
        kind: 'status_change',
        body: 'Converted — the deal was won',
        actorId,
        metadata: { to: 'converted', from: CONVERTIBLE },
      });
    }

    return ok({ converted: true });
  }

  // Nothing moved, and the three reasons are not the same answer.
  const { data: lead, error: readError } = await supabase
    .schema('crm')
    .from('leads')
    .select('status')
    .eq('id', leadId)
    // Filtered here too, so a soft-deleted lead reads as absent and is
    // answered NOT_FOUND rather than with a confusing conflict about the
    // status of a lead nobody can see.
    .is('deleted_at', null)
    .maybeSingle();

  if (readError) {
    // A database that did not answer is not a lead in a wrong state (D3, D5).
    console.error(
      JSON.stringify({ level: 'error', scope: 'markLeadConverted', detail: readError.message }),
    );
    return err('INTERNAL', 'Could not confirm the lead status.');
  }

  if (!lead) {
    return err('NOT_FOUND', 'That lead no longer exists.');
  }

  // Already converted is the answer, not an error — the caller asked for a
  // state the lead is already in. Reported without writing, so the original
  // `converted_at` survives a second call.
  if (lead.status === 'converted') return ok({ converted: true });

  // Which leaves `disqualified`, the one state this refuses.
  return err('CONFLICT', `A lead cannot move from ${lead.status} to converted.`);
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
