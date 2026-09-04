import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

import { markAsOutreach, planOutbound } from './outbound-window';

import {
  addLeadNoteSchema,
  appendMessageSchema,
  sendClientDocumentSchema,
  sendClientMessageSchema,
  requestExtractionSchema,
  setLeadFollowUpSchema,
  setLeadQualificationSchema,
  startConversationSchema,
  updateLeadStatusSchema,
  LEAD_TRANSITIONS,
  type AddLeadNoteInput,
  type AppendMessageInput,
  type SendClientDocumentInput,
  type SendClientMessageInput,
  type LeadStatus,
  type RequestExtractionInput,
  type SetLeadFollowUpInput,
  type SetLeadQualificationInput,
  type StartConversationInput,
  type UpdateLeadStatusInput,
  linkInternalRecipientSchema,
  linkWhatsAppGroupSchema,
  type LinkInternalRecipientInput,
  type LinkWhatsAppGroupInput,
  recordSalesActivitySchema,
  SALES_ACTIVITY_LABELS,
  type RecordSalesActivityInput,
  type SalesActivityKind,
  addPortfolioItemSchema,
  setPortfolioItemActiveSchema,
  type AddPortfolioItemInput,
  type SetPortfolioItemActiveInput,
  requirementConfirmationMessage,
  requirementPayloadSchema,
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

/**
 * The most messages one extraction reads. It exists because PostgREST caps
 * every response at `max_rows` (1000): the runner's transcript read would
 * silently return only the OLDEST 1000 of a longer conversation, while this
 * request-time count is uncapped — so the two disagreed above the cap, and a
 * conversation past 1000 messages queued a fresh extraction for every new
 * message that then no-op'd against the version already written at 1000,
 * freezing the requirement scope forever. Both sides now bound to this same
 * number (the runner reads the most-recent window explicitly), so above the cap
 * the dedupe key stops changing and extraction settles rather than churns.
 * Kept at the max_rows value on purpose: a single sales conversation past 1000
 * turns is an extreme edge, and the fix is that it behaves honestly, not that
 * it reads unboundedly.
 */
export const MAX_EXTRACTION_MESSAGES = 1000;

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
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        seq: number | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
      }
    | undefined;

  if (!queued) return err('INTERNAL', 'Could not record the message.');
  if (queued.outcome === 'not_found') return err('NOT_FOUND', 'Conversation not found.');

  // G-012, ADM-70 and ADM-81. The refusal is the database's, not this
  // function's — suppression lives in `crm.send_outbound_message` so a future
  // caller cannot skip it by not knowing about it. This turns it into a
  // sentence somebody can act on.
  //
  // It names the channel because consent is channel-specific: a contact who
  // agreed to email has not agreed to WhatsApp, and a message saying only
  // "no consent" would send somebody looking at the wrong record.
  if (queued.outcome === 'no_consent') {
    return err(
      'FORBIDDEN',
      'This contact has no recorded consent to be messaged on WhatsApp. Record their consent before AgencyOS sends to them.',
    );
  }

  // A retry of the same send. Reported as success, because it is: the message
  // this caller asked for is on its way or already gone, and telling them it
  // failed is how a person ends up sending it twice on purpose.
  if (queued.outcome === 'already_sent') {
    return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
  }

  if (!queued.to_phone) {
    // Two ways to get here now: a contact with no phone, or a group that was
    // linked in this system and never mapped to a provider group. Said apart,
    // because they are fixed by different people doing different things.
    const missing =
      queued.recipient_type === 'group'
        ? 'this group has no provider id to send to'
        : 'the contact has no phone number';

    await supabase.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: missing,
    });
    return err(
      'VALIDATION',
      queued.recipient_type === 'group'
        ? 'This group is not linked to a WhatsApp group yet.'
        : 'This contact has no phone number to message.',
    );
  }

  // Imported here rather than at the top of the module. The provider module
  // reads the environment, and this service is imported by half the test
  // suite — a module-load side effect on a path most callers never take made
  // four unrelated test files fail to load, which is a cost paid by everybody
  // for one function's dependency.
  /**
   * Will WhatsApp carry this? — G-214.
   *
   * A person pressing send is still a business-initiated message, and Meta
   * carries free text only inside the 24-hour window. There is no job here to
   * park, so the two honest answers are an approved template or a refusal
   * that says exactly why — never a send the provider will reject and a
   * failure the person cannot interpret.
   */
  const plan = await planOutbound(supabase, {
    organizationId: context.organizationId!,
    conversationId: parsed.data.conversationId,
    situationKey: 'agent_message',
  });

  if (plan.mode === 'retry') {
    return err('INTERNAL', 'AgencyOS could not check whether WhatsApp will carry this message. Try again.');
  }

  if (plan.mode === 'defer') {
    await supabase.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: plan.reason,
    });
    return err(
      'VALIDATION',
      plan.window === 'never'
        ? 'This contact has never messaged you, so WhatsApp will only carry an approved template. Register one for a direct message in Settings, or wait for them to write first.'
        : 'It is more than 24 hours since this contact last wrote, so WhatsApp will only carry an approved template. Register one for a direct message in Settings, or wait for them to write first.',
    );
  }

  const { sendWhatsAppText, sendWhatsAppTemplate } = await import('@/lib/whatsapp/send');

  const sent = plan.mode === 'template'
    ? await sendWhatsAppTemplate({
        phoneNumberId: queued.from_phone_number_id ?? '',
        to: queued.to_phone,
        templateName: plan.template.name,
        languageCode: plan.template.language,
        parameters: plan.template.parameters,
        recipientType: queued.recipient_type ?? 'individual',
      })
    : await sendWhatsAppText({
        phoneNumberId: queued.from_phone_number_id ?? '',
        // A phone number for a 1:1 thread, the provider's group id for a group —
        // and the envelope differs, so the type travels with the recipient rather
        // than being assumed here. Sending a group id as `individual` is refused
        // by the provider, which is how this was found.
        to: queued.to_phone,
        body: parsed.data.body,
        recipientType: queued.recipient_type ?? 'individual',
      });

  await supabase.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  // A template went, so the window was shut, so this was outreach — G-216.
  if (sent.ok && plan.mode === 'template') {
    await markAsOutreach(supabase, queued.message_id!);
  }

  if (!sent.ok) {
    // The row survives with the reason on it, so the operations screen and the
    // transcript both show an attempt that failed rather than nothing at all.
    return err('PROVIDER_ERROR', sent.message);
  }

  // No recordAudit call here: crm.mark_outbound_delivery writes the audit row
  // from inside its own transaction (G-079), so the history of a delivered
  // message commits with the delivery rather than in a request of its own.
  return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
}

/**
 * Send one document to a client conversation — the quotation PDF, today.
 *
 * The shape is `sendClientMessage`'s — row first, provider second, outcome
 * written back — with two deliberate differences, both worth their words:
 *
 * **A provider failure is data here, not an `err`.** `sendClientMessage`
 * answers `PROVIDER_ERROR` and its caller gives up; this returns
 * `ok({ delivered: false, retryable, reason })`, because the one caller this
 * exists for (`sendProposal`) must choose differently by failure class — a
 * transient failure should block the quotation being stamped `sent` so a
 * retry can finish the job, a permanent one should not doom an approved
 * quotation to a state it can never leave. The record half succeeded either
 * way, and the row carries the failure for the operations screen.
 *
 * **`already_sent` re-attempts when the row is not `sent`.** The text path's
 * already_sent answers delivered:true without looking at the delivery state,
 * which is exactly what made a refused reply unretryable in PR #300. The row
 * is re-read here the way the job handlers do it: `sent` short-circuits,
 * `pending`/`failed` fall through and try the provider again under the same
 * external_ref.
 *
 * The `pending` half of that rule carries a KNOWN, ACCEPTED window: a second
 * session pressing Send while the first is still inside its provider call
 * sees `pending`, falls through, and the client receives the document twice.
 * The alternative — refusing to re-attempt `pending` — wedges every send
 * whose process died between the row and the provider, permanently, and a
 * quotation nobody can deliver is worse than one delivered twice. The same
 * trade the job handlers made; there the queue's claim serializes it, here
 * the disabled submit button narrows it to the two-sessions case.
 *
 * The bytes are a parameter rather than a path or an id: this function knows
 * how to deliver a document, not which document — composition stays with the
 * caller, the way `sendClientMessage` never composes a body.
 */
export async function sendClientDocument(
  input: SendClientDocumentInput & { bytes: Uint8Array },
): Promise<
  Result<{
    messageId: string;
    seq: number;
    delivered: boolean;
    retryable?: boolean;
    reason?: string;
  }>
> {
  const parsed = sendClientDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That document could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    return err('VALIDATION', 'That document has no content.');
  }

  const context = await requireInternal();
  // The same capability as a text message, for the same reason: this is
  // adding to a transcript plus delivery, and a document is not more
  // dangerous than the words beside it.
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to message clients.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: parsed.data.conversationId,
    p_body: '',
    p_external_ref: parsed.data.idempotencyKey,
    ...(context.userId ? { p_author_id: context.userId } : {}),
    p_media_type: 'document',
    p_media_filename: parsed.data.filename,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendClientDocument', detail: error.message }));
    return err('INTERNAL', 'Could not record the document.');
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent' | 'bad_shape';
        message_id: string | null;
        seq: number | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) return err('INTERNAL', 'Could not record the document.');
  if (queued.outcome === 'not_found') return err('NOT_FOUND', 'Conversation not found.');
  if (queued.outcome === 'bad_shape') {
    // Unreachable from this function, which controls both halves of the
    // shape — reaching it means the function and the database disagree about
    // what a document row is, and that is a bug, not a user's problem.
    return err('INTERNAL', 'The document could not be recorded in a valid shape.');
  }

  if (queued.outcome === 'no_consent') {
    return err(
      'FORBIDDEN',
      'This contact has no recorded consent to be messaged on WhatsApp. Record their consent before AgencyOS sends to them.',
    );
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
  }

  if (!queued.to_phone) {
    const missing =
      queued.recipient_type === 'group'
        ? 'this group has no provider id to send to'
        : 'the contact has no phone number';
    await supabase.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: missing,
    });
    return err(
      'VALIDATION',
      queued.recipient_type === 'group'
        ? 'This group is not linked to a WhatsApp group yet.'
        : 'This contact has no phone number to message.',
    );
  }

  /**
   * A document has no template route at all — G-214.
   *
   * An approved template can carry a document header, but nothing in this
   * system registers one, and inventing a header a person never submitted to
   * Meta would be a send nobody approved. So outside the window the honest
   * answer is a refusal that says what to do, not an upload the provider
   * throws away.
   */
  const plan = await planOutbound(supabase, {
    organizationId: context.organizationId!,
    conversationId: parsed.data.conversationId,
    situationKey: '',
  });

  if (plan.mode === 'retry') {
    return err('INTERNAL', 'AgencyOS could not check whether WhatsApp will carry this file. Try again.');
  }

  if (plan.mode !== 'text') {
    await supabase.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'outside the 24-hour window, and WhatsApp carries no file there',
    });
    return err(
      'VALIDATION',
      'WhatsApp will not carry a file to this contact right now — it is more than 24 hours since they last wrote. Ask them to message first, then send it.',
    );
  }

  // Lazy for the reason sendClientMessage documents: a module-load side
  // effect on a path most callers never take is a cost paid by everybody.
  const { uploadWhatsAppMedia, sendWhatsAppDocument } = await import('@/lib/whatsapp/send');

  const uploaded = await uploadWhatsAppMedia({
    phoneNumberId: queued.from_phone_number_id ?? '',
    bytes: input.bytes,
    mediaType: 'application/pdf',
    filename: parsed.data.filename,
  });

  const sent = uploaded.ok
    ? await sendWhatsAppDocument({
        phoneNumberId: queued.from_phone_number_id ?? '',
        to: queued.to_phone,
        mediaId: uploaded.mediaId,
        filename: parsed.data.filename,
        recipientType: queued.recipient_type ?? 'individual',
      })
    : uploaded;

  const settled = await supabase.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    // Reached the provider but could not record the outcome. Retryable, and
    // the retry reconciles against the row's own delivery state — the same
    // answer the announce handler gives this situation.
    console.error(JSON.stringify({ level: 'error', scope: 'sendClientDocument', detail: settled.error.message }));
    return err('INTERNAL', 'The document delivery could not be recorded.');
  }

  if (!sent.ok) {
    // `false` from mark_outbound_delivery means a terminal `sent` row refused
    // the update: this attempt lost a race to a send that already landed, so
    // the document IS on the client's phone. Reporting the loser's failure
    // would say the opposite of what happened.
    if (settled.data === false) {
      return ok({ messageId: queued.message_id!, seq: queued.seq!, delivered: true });
    }
    return ok({
      messageId: queued.message_id!,
      seq: queued.seq!,
      delivered: false,
      retryable: !sent.permanent,
      reason: sent.message,
    });
  }

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
  // the transcript grows is a genuinely different request. Bounded to the same
  // window the runner reads, so request-time and run-time agree above the cap —
  // below it this is just `count`, unchanged.
  const dedupeKey = `${JOB_KIND}:${conversation.id}:${Math.min(count, MAX_EXTRACTION_MESSAGES)}`;

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
 * The third-party charges the Admin maintains — G-207, audit QM-20.
 *
 * ADM-12's shape applied to money instead of samples: the agent may print a
 * fee only if a person recorded it, and an empty list means no figures are
 * printed at all — which G-178 already calls the honest and common answer.
 *
 * A failed read REFUSES rather than answering "none recorded" (G-054). The
 * settings page would otherwise show an Admin an empty list while quotations
 * go on citing charges from it.
 */
export async function readThirdPartyCharges(): Promise<
  Result<Array<{ service: string; charge: string; source: string | null; checkedOn: string; stale: boolean }>>
> {
  await requireInternal();
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('third_party_charges')
    .select('service, charge, source, checked_on')
    .eq('active', true)
    .order('service');

  if (error) unreadable('readThirdPartyCharges', error);

  /**
   * Six months, and it is a WARNING rather than a rule.
   *
   * QM-20 asks for current and reliable, not merely recorded, and a gateway's
   * percentage moves. But refusing a stale charge would mean a quotation
   * cannot be drafted because nobody revisited a fee page — trading a real
   * deal for a tidy record, which is the trade G-168 and G-177 both declined.
   */
  const staleAfter = new Date();
  staleAfter.setMonth(staleAfter.getMonth() - 6);

  return ok(
    (data ?? []).map((row) => ({
      service: String(row.service),
      charge: String(row.charge),
      source: row.source ?? null,
      checkedOn: String(row.checked_on),
      stale: new Date(String(row.checked_on)).getTime() < staleAfter.getTime(),
    })),
  );
}

/** Recording one — G-207. Admin only, in the database as well as here. */
export async function setThirdPartyCharge(input: {
  service: string;
  charge: string;
  source?: string | null;
  checkedOn?: string | null;
}): Promise<Result<{ service: string }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to record third-party charges.');
  }

  const service = input.service.trim();
  const charge = input.charge.trim();
  if (!service || !charge) return err('VALIDATION', 'A charge needs a service and the charge itself.');
  // `organizationId` is `string | undefined` on the session. Coercing an
  // absent one to '' would send an empty string where a uuid is expected and
  // fail as a cast error, which says nothing about the real cause.
  if (!context.organizationId) return err('FORBIDDEN', 'This session has no organization.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('set_third_party_charge', {
    p_organization_id: context.organizationId,
    p_service: service,
    p_charge: charge,
    // The generated types make these optional rather than nullable, so an
    // absent value is omitted instead of sent as null — the function's own
    // defaults then apply, which is what "the Admin left it blank" means.
    ...(input.source?.trim() ? { p_source: input.source.trim() } : {}),
    ...(input.checkedOn?.trim() ? { p_checked_on: input.checkedOn.trim() } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setThirdPartyCharge', detail: error.message }));
    return err('INTERNAL', 'The charge could not be recorded.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string } | undefined;
  switch (row?.outcome) {
    case 'set':
      return ok({ service });
    case 'not_yet':
      return err('VALIDATION', 'That confirmation date is in the future. Use the day you actually checked it.');
    case 'incomplete':
      return err('VALIDATION', 'A charge needs a service and the charge itself.');
    case 'forbidden':
      return err('FORBIDDEN', 'You do not have permission to record third-party charges.');
    default:
      return err('INTERNAL', `The charge could not be recorded (${row?.outcome ?? 'no answer'}).`);
  }
}

/** Retiring one — G-207. Deactivated, never deleted. */
export async function clearThirdPartyCharge(service: string): Promise<Result<{ service: string }>> {
  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'You do not have permission to change third-party charges.');
  }

  if (!context.organizationId) return err('FORBIDDEN', 'This session has no organization.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('clear_third_party_charge', {
    p_organization_id: context.organizationId,
    p_service: service.trim(),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'clearThirdPartyCharge', detail: error.message }));
    return err('INTERNAL', 'The charge could not be withdrawn.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome: string } | undefined;
  if (row?.outcome === 'cleared') return ok({ service: service.trim() });
  if (row?.outcome === 'no_charge') return err('NOT_FOUND', 'No such charge is on the list.');
  return err('INTERNAL', `The charge could not be withdrawn (${row?.outcome ?? 'no answer'}).`);
}

/**
 * Put the summary in front of the client — G-200, Doc 09 §12.
 *
 * The step §12 has always had and this system never took: the version a
 * client's whole quotation is built on was agreed on their behalf, and
 * nothing ever showed them the sentence.
 *
 * A person presses it. Deliberately not autonomous: this is a client-facing
 * message about scope, and ADM-70's consent gate is the chokepoint it goes
 * through rather than a check somebody remembered. The database composes
 * nothing and the model composes nothing — the body is built from the stored
 * payload, because a restatement is how a client ends up confirming a scope
 * nobody wrote down.
 *
 * It does NOT read the reply. Doc 08 §14 refuses to let acceptance be
 * inferred, and there is no path from a client's words to a status here to
 * guard.
 */
export async function sendRequirementForConfirmation(
  versionId: string,
): Promise<Result<{ versionId: string; messageId: string }>> {
  const idCheck = z.string().uuid().safeParse(versionId);
  if (!idCheck.success) return err('VALIDATION', 'Not a requirement version id.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to send a requirement summary.');
  }

  const supabase = await createClient();

  const { data: version, error: readError } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id, status, payload, sent_for_confirmation_at')
    .eq('id', idCheck.data)
    .maybeSingle();

  if (readError) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'sendRequirementForConfirmation', detail: readError.message }),
    );
    return err('INTERNAL', 'Could not load the requirement version.');
  }
  if (!version) return err('NOT_FOUND', 'Requirement version not found.');
  if (version.status !== 'proposed') {
    return err('CONFLICT', 'Only a version still awaiting a decision can be sent for confirmation.');
  }

  const payload = requirementPayloadSchema.safeParse(version.payload);
  if (!payload.success) {
    // A payload this cannot read is a payload the client must not be shown a
    // guess at. Refused rather than partially composed.
    return err('VALIDATION', 'This version’s requirements could not be read, so nothing was sent.');
  }

  const { data, error } = await supabase.schema('crm').rpc('send_requirement_for_confirmation', {
    p_version_id: idCheck.data,
    p_body: requirementConfirmationMessage(payload.data),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'sendRequirementForConfirmation', detail: error.message }),
    );
    return err('INTERNAL', 'The summary could not be sent.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; message_id: string | null }
    | undefined;

  switch (row?.outcome) {
    case 'sent':
      return ok({ versionId: idCheck.data, messageId: row.message_id ?? '' });
    case 'already_sent':
      return err('CONFLICT', 'This summary has already been sent to the client.');
    case 'not_proposed':
      return err('CONFLICT', 'Only a version still awaiting a decision can be sent for confirmation.');
    case 'no_consent':
      return err('FORBIDDEN', 'This contact has not agreed to be messaged, so nothing was sent.');
    default:
      return err('INTERNAL', `The summary could not be sent (${row?.outcome ?? 'no answer'}).`);
  }
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
  /**
   * Both, or neither — G-203, Doc 09 §26.
   *
   * Checked here as well as at the row, so the person gets a sentence rather
   * than a constraint violation; checked at the row as well as here, because
   * this form is not the only door.
   */
  if (parsed.data.status === 'nurture') {
    if (!parsed.data.nurtureReason) {
      return err('VALIDATION', 'Say why this lead is not ready — “not ready now”, “budget later”, “waiting for a decision-maker”, or “needs more evidence”.');
    }
    const until = parsed.data.nurtureUntil ? new Date(parsed.data.nurtureUntil) : null;
    if (!until || Number.isNaN(until.getTime())) {
      return err('VALIDATION', 'Say when to come back to it. A lead nobody has agreed to look at again is lost with extra steps.');
    }
    if (until.getTime() <= Date.now()) {
      return err('VALIDATION', 'That date has already passed. Pick a date to come back on.');
    }
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
      // G-203 — the reason and the date travel with the state. Leaving
      // nurture clears the reason at the row too; this sets `next_follow_up_at`
      // on the way in and leaves it alone on the way out, because a date to
      // come back is what the follow-up engine already reads and a lead that
      // has come back does not need it erased.
      ...(to === 'nurture'
        ? {
            nurture_reason: parsed.data.nurtureReason ?? null,
            next_follow_up_at: new Date(parsed.data.nurtureUntil as string).toISOString(),
          }
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

/**
 * Records one of the six sales activities ADM-10 §7 names — G-010.
 *
 * §7 moved contacted, sample sent, demo sent, offer sent, follow-up and
 * advance requested *out* of the pipeline and into the lead's history. Until
 * this they had nowhere to go: `lead_activities.kind` admitted seven values
 * and none of the six was among them, so the states the decision relocated
 * were not recordable anywhere.
 *
 * Deliberately shaped like `addLeadNote` rather than like `setLeadStatus`:
 * these are things that happened, not transitions between states. Nothing is
 * validated against the deal's stage, because §7's whole point is that the two
 * are independent — a sample can be sent at any stage, or none.
 */
export async function recordSalesActivity(
  input: RecordSalesActivityInput,
): Promise<Result<{ recorded: true }>> {
  const parsed = recordSalesActivitySchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That activity could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to record lead activity.');
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
    kind: parsed.data.kind,
    // The label when nothing is said, so the timeline reads as a sentence
    // either way and never shows an empty row.
    body: parsed.data.body || SALES_ACTIVITY_LABELS[parsed.data.kind],
    actorId: context.userId,
  });

  if (!written) return err('INTERNAL', 'Could not record the activity.');

  return ok({ recorded: true });
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
    kind: 'note' | 'status_change' | 'assignment' | SalesActivityKind;
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

// ── WhatsApp groups ────────────────────────────────────────────────────────

/** The row `crm.link_whatsapp_group` returns. */
type LinkGroupRow = {
  outcome: 'linked' | 'already_linked' | 'group_taken' | 'bad_kind';
  conversation_id: string | null;
};

/**
 * Links a WhatsApp group — G-015 and G-109.
 *
 * Two kinds, and they are different things. A **project group** is the
 * client-facing thread for one project; since ADM-13 a project cannot
 * officially start without one. An **internal group** is the owner, the staff
 * and the agent, and it is where the agent raises what it needs confirmed —
 * payments, prices, deliveries — and gets approve, reject or feedback.
 *
 * A group is a conversation, not a table of its own. That is what lets
 * `sendClientMessage` post into either without knowing it is a group, and what
 * gives both a message sequence that two staff replying at once cannot
 * corrupt.
 *
 * Nothing is decided here. `crm.link_whatsapp_group` refuses through indexes
 * rather than pre-checks, so two people linking a group to the same project at
 * the same moment produce one group and two identical answers — the shape D21
 * and D22 both were.
 *
 * The three outcomes are three different sentences on purpose. "Already
 * linked" is the answer, not an error; "that group belongs to somebody else"
 * is a genuine refusal a retry cannot fix, and the two look identical from a
 * driver error code.
 */
export async function linkWhatsAppGroup(
  input: LinkWhatsAppGroupInput,
): Promise<Result<{ conversationId: string; linked: boolean }>> {
  const parsed = linkWhatsAppGroupSchema.safeParse(input);
  if (!parsed.success) {
    // The FIRST field error is the message, not a generic wrapper: the
    // invite-link refusal was written to tell the owner exactly what they
    // pasted and what to do instead, and a sentence buried in a details
    // object the form never renders is a sentence nobody was told.
    const fields = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    const first = Object.values(fields).flat()[0];
    return err('VALIDATION', first ?? 'Invalid group link request.', { details: fields });
  }

  const context = await requireInternal();

  // The internal group is where money and delivery decisions are answered, so
  // pointing it at the wrong chat is not a CRM edit. `organization.settings`
  // is the capability that already means "change what this agency is", and it
  // resolves to the owner alone.
  const capability = parsed.data.kind === 'internal_group' ? 'organization.settings' : 'lead.write';
  if (!can(context.role, capability)) {
    return err('FORBIDDEN', 'You do not have permission to link that group.');
  }

  // Same refusal qa/service.ts makes: a session with no organization cannot
  // write a row that must belong to one.
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('link_whatsapp_group', {
    p_organization_id: context.organizationId,
    p_kind: parsed.data.kind,
    p_external_ref: parsed.data.externalRef,
    ...(parsed.data.projectId ? { p_project_id: parsed.data.projectId } : {}),
    ...(parsed.data.title ? { p_title: parsed.data.title } : {}),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'linkWhatsAppGroup', detail: error.message }),
    );
    return err('INTERNAL', 'Could not link that group.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as LinkGroupRow | undefined;

  // A read that returned nothing is a failed read, not an empty answer — G-054.
  if (!row) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'linkWhatsAppGroup', detail: 'no row returned' }),
    );
    return err('INTERNAL', 'Could not link that group.');
  }

  switch (row.outcome) {
    case 'linked':
      return ok({ conversationId: row.conversation_id as string, linked: true });

    case 'already_linked':
      return ok({ conversationId: row.conversation_id as string, linked: false });

    case 'group_taken':
      return err('CONFLICT', 'That WhatsApp group is already linked somewhere else.');

    // Unreachable through the schema above, which admits two kinds. Answered
    // rather than assumed away, because the function is callable directly.
    case 'bad_kind':
      return err('VALIDATION', 'That is not a kind of group.');

    default:
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'linkWhatsAppGroup',
          detail: `unrecognised outcome "${String(row.outcome)}"`,
        }),
      );
      return err('INTERNAL', 'Could not link that group.');
  }
}

/**
 * Point the internal announcement channel at a person — ADM-95, G-159.
 *
 * The fallback Meta forced: this WABA is not eligible for Groups APIs
 * (#131215), so the channel G-109 designed cannot deliver here. A person's
 * own WhatsApp can. The same capability as the group — pointing the place
 * where money is announced is `organization.settings`, the owner alone —
 * and a second call genuinely RE-links, which the group linker never did.
 */
export async function linkInternalRecipient(
  input: LinkInternalRecipientInput,
): Promise<Result<{ conversationId: string; relinked: boolean }>> {
  const parsed = linkInternalRecipientSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That number could not be used.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'organization.settings')) {
    return err('FORBIDDEN', 'Only an owner may change where announcements go.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('link_internal_recipient', {
    p_organization_id: context.organizationId,
    p_phone: parsed.data.phone,
    ...(parsed.data.title ? { p_title: parsed.data.title } : {}),
  });

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'linkInternalRecipient', detail: error.message }),
    );
    return err('INTERNAL', 'Could not link that number.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: 'linked' | 'relinked' | 'bad_phone'; conversation_id: string | null }
    | undefined;

  if (!row) return err('INTERNAL', 'Could not link that number.');
  if (row.outcome === 'bad_phone') return err('VALIDATION', 'That does not look like a phone number.');

  return ok({ conversationId: row.conversation_id as string, relinked: row.outcome === 'relinked' });
}

/**
 * Who internal announcements currently reach, if anyone — ADM-95.
 *
 * Null when nothing is linked; that is a normal state the settings page
 * says out loud. The number comes back for display, prefix stripped.
 */
export async function getInternalRecipient(): Promise<
  Result<{ conversationId: string; phone: string; title: string | null } | null>
> {
  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, external_ref, title')
    .eq('kind', 'internal_direct')
    .neq('status', 'abandoned')
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'getInternalRecipient', detail: error.message }),
    );
    return err('INTERNAL', 'Could not read the announcement number.');
  }

  return ok(
    data
      ? {
          conversationId: data.id,
          phone: (data.external_ref ?? '').replace(/^internal:\+/, ''),
          title: data.title,
        }
      : null,
  );
}

/**
 * The organization's approval group, if it has one — G-109.
 *
 * Returns null rather than an error when none is linked: an agency that has
 * not set one up yet is a normal state, and the caller's job is to say so
 * rather than to fail.
 */
export async function getInternalGroup(): Promise<Result<{ conversationId: string; title: string | null } | null>> {
  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, title')
    .eq('kind', 'internal_group')
    .neq('status', 'abandoned')
    .maybeSingle();

  if (error) {
    console.error(
      JSON.stringify({ level: 'error', scope: 'getInternalGroup', detail: error.message }),
    );
    return err('INTERNAL', 'Could not read the approval group.');
  }

  return ok(data ? { conversationId: data.id, title: data.title } : null);
}

/**
 * Adds an item to the list AgencyOS may send from — G-013, ADM-12.
 *
 * §5.3 says the list is one *the Admin maintains*, so the capability check is
 * `portfolio.write` and the database says the same thing again through RLS:
 * `core.is_admin()`. Two layers, the way ARCHITECTURE §8.1 asks — a future
 * caller that forgets the first still meets the second.
 *
 * Adding an item does not send it. Nothing sends from this list yet.
 */
export async function addPortfolioItem(
  input: AddPortfolioItemInput,
): Promise<Result<{ id: string }>> {
  const parsed = addPortfolioItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That portfolio item could not be validated.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'portfolio.write')) {
    return err('FORBIDDEN', 'Only an admin maintains the portfolio list.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('portfolio_items')
    .insert({
      organization_id: context.organizationId,
      kind: parsed.data.kind,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      url: parsed.data.url,
      created_by: context.userId,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 is the per-organization URL uniqueness: the same link twice is
    // the same item, and reporting it as a conflict says so.
    if (error.code === '23505') {
      return err('CONFLICT', 'That link is already on the list.');
    }
    return err('INTERNAL', 'Could not add the item.');
  }

  return ok({ id: data.id });
}

/**
 * Retires an item, or brings it back — G-013, ADM-12.
 *
 * Deactivation rather than deletion, so a message that already went out still
 * points at something. Recorded as an engineering decision in the migration
 * header, not as a rule §5.3 states.
 */
export async function setPortfolioItemActive(
  input: SetPortfolioItemActiveInput,
): Promise<Result<{ updated: true }>> {
  const parsed = setPortfolioItemActiveSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'That change could not be validated.');
  }

  const context = await requireInternal();
  if (!can(context.role, 'portfolio.write')) {
    return err('FORBIDDEN', 'Only an admin maintains the portfolio list.');
  }

  const supabase = await createClient();
  const { error } = await supabase
    .schema('crm')
    .from('portfolio_items')
    .update({ is_active: parsed.data.isActive })
    .eq('id', parsed.data.itemId);

  if (error) return err('INTERNAL', 'Could not update the item.');
  return ok({ updated: true });
}

/**
 * Put the sales agent back on a conversation a person has finished with —
 * Doc 09 §7 and §36.
 *
 * The other half of `crm.hand_conversation_to_a_person`, and deliberately not
 * its mirror. The pause takes no identity because the agent has none; this
 * refuses a caller without one — including the service role — so the sentence
 * *"only a human clearing agent_paused_at starts it answering again"* is
 * enforced rather than merely written down.
 *
 * `lead.write` because putting an agent back on a client conversation is a
 * sales action, and the same capability governs every other one on this lead.
 */
export async function resumeAgentReplies(
  conversationId: string,
): Promise<Result<{ resumed: boolean }>> {
  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to put the agent back on this conversation.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('crm')
    .rpc('resume_agent_replies', { p_conversation: conversationId });

  if (error) {
    return err('INTERNAL', 'The agent could not be put back on this conversation.');
  }

  // False is not an error: the thread was not paused, which is where somebody
  // clicking twice lands and is not worth an error message.
  return ok({ resumed: data === true });
}
