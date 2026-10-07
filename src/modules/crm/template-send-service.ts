import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import type { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { ErrorCode } from '@/lib/errors';
import { err, ok, type Result } from '@/lib/result';

import type { CampaignRefusalReason } from './campaign-types';
import { markAsOutreach, outreachAllowance, readWindowState } from './outbound-window';
import { resolveTemplateParameters, type ParameterSubject } from './template-parameters';
import { describeTemplateSend, sendTemplateMessageSchema, type SendTemplateMessageInput } from './template-send-schema';
import { deliveryStatusOf } from '@/lib/whatsapp/delivery-status';

type Admin = ReturnType<typeof createAdminClient>;

/** The template as both callers hand it over: already read, already checked approved and active. */
export type SendableTemplate = {
  id: string;
  templateName: string;
  languageCode: string;
  parameters: readonly string[];
};

/**
 * What one governed template send answers. A refusal carries the closed-set
 * `reason` a campaign records on its recipient row AND the `code`/`message`
 * the composer shows a person — one outcome, read two ways.
 */
export type TemplateSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; code: ErrorCode; message: string; reason: CampaignRefusalReason | 'provider_failed' };

/**
 * One approved template to one conversation, through the chokepoint —
 * shared by the composer (`sendTemplateMessage`) and the campaign worker
 * (`campaign-worker.ts`), owner decision 2026-09-30.
 *
 * The shape is `sendClientMessage`'s: the row first (`crm.send_outbound_message`
 * refuses without consent), the provider second, the outcome written back by
 * `crm.mark_outbound_delivery`, which audits in its own transaction. Three
 * things differ, each on purpose:
 *
 *   - the template is the CALLER's choice, not the situation registry's —
 *     so the only registry rule that still applies is that the row must be
 *     Meta-approved and active, which the caller checks before coming here.
 *   - the variables are filled by `resolveTemplateParameters` from recorded
 *     facts, never from a form. A template whose fact is missing is refused
 *     naming the fact (G-215), not sent with a blank.
 *   - the window does not gate it (a template is what Meta carries outside
 *     it) but the outreach limits still do: outside the window this is a
 *     message the agency started (G-216), counted and refused like any other.
 *
 * This is the ONLY place a template reaches `@/lib/whatsapp/send` from this
 * module. A campaign that imported the provider itself would be a second
 * door, and the test `a-campaign-is-many-governed-sends` refuses one.
 */
export async function sendTemplateToConversation(
  client: Admin,
  input: {
    organizationId: string;
    conversationId: string;
    template: SendableTemplate;
    /** The person sending, when one is; a worker has none and the row says 'system'. */
    authorId?: string | null;
    subject?: ParameterSubject;
    /** Idempotency key for `crm.send_outbound_message`; defaults to a fresh one. */
    externalRef?: string;
    /** Where the log lines say they came from. */
    scope?: string;
  },
): Promise<TemplateSendOutcome> {
  const scope = input.scope ?? 'sendTemplateToConversation';
  const { template } = input;

  const filled = await resolveTemplateParameters(client, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    names: template.parameters,
    subject: input.subject,
  });
  if (!filled.ok) {
    if ('unreadable' in filled) {
      return { ok: false, code: 'INTERNAL', reason: 'unreadable', message: `AgencyOS could not fill the template: ${filled.detail}` };
    }
    return {
      ok: false,
      code: 'VALIDATION',
      reason: 'missing_fact',
      message: `Template ${template.templateName} needs ${filled.missing.join(', ')}, which this conversation has no recorded value for. Nothing was sent.`,
    };
  }

  const body = describeTemplateSend({
    templateName: template.templateName,
    languageCode: template.languageCode,
    parameters: template.parameters,
    values: filled.values,
  });

  const { data, error } = await client.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: input.conversationId,
    p_body: body,
    p_external_ref: input.externalRef ?? `tpl-${crypto.randomUUID()}`,
    ...(input.authorId ? { p_author_id: input.authorId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope, detail: error.message }));
    return { ok: false, code: 'INTERNAL', reason: 'record_failed', message: 'Could not record the message.' };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
      }
    | undefined;
  if (!queued) return { ok: false, code: 'INTERNAL', reason: 'record_failed', message: 'Could not record the message.' };
  if (queued.outcome === 'not_found') return { ok: false, code: 'NOT_FOUND', reason: 'thread_not_found', message: 'Conversation not found.' };
  if (queued.outcome === 'no_consent') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: 'no_consent',
      message: 'This contact has no recorded consent to be messaged on WhatsApp. Record their consent before AgencyOS sends to them.',
    };
  }
  if (!queued.message_id) return { ok: false, code: 'INTERNAL', reason: 'record_failed', message: 'Could not record the message.' };
  const messageId = queued.message_id;

  const fail = async (reason: string) => {
    await client.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: messageId,
      p_status: 'failed',
      p_error: reason,
    });
  };

  if (!queued.to_phone) {
    const missing = queued.recipient_type === 'group' ? 'this group has no provider id to send to' : 'the contact has no phone number';
    await fail(missing);
    return {
      ok: false,
      code: 'VALIDATION',
      reason: 'no_phone',
      message: queued.recipient_type === 'group' ? 'This group is not linked to a WhatsApp group yet.' : 'This contact has no phone number to message.',
    };
  }

  // Outside the window this is outreach — G-216 — and the limits decide.
  const window = await readWindowState(client, input.conversationId);
  if (window === 'unreadable') {
    await fail('the 24-hour window could not be read');
    return { ok: false, code: 'INTERNAL', reason: 'unreadable', message: 'AgencyOS could not check the 24-hour window. Try again.' };
  }
  const outreach = window === 'closed' || window === 'never';
  if (outreach) {
    const allowance = await outreachAllowance(client, input.conversationId);
    if (allowance === 'unreadable') {
      await fail('the outreach limits could not be read');
      return { ok: false, code: 'INTERNAL', reason: 'unreadable', message: 'AgencyOS could not check the outreach limits. Try again.' };
    }
    if (allowance !== 'ok') {
      await fail(`outreach limit: ${allowance}`);
      return {
        ok: false,
        code: 'VALIDATION',
        reason: 'outreach_limit',
        message: `The outreach limits refuse this send right now (${allowance.replace(/_/g, ' ')}). See Settings › Communication.`,
      };
    }
  }

  // Lazy for the reason sendClientMessage documents: the provider module
  // reads the environment at load, which most callers of this service never need.
  const { sendWhatsAppTemplate } = await import('@/lib/whatsapp/send');
  const sent = await sendWhatsAppTemplate({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    templateName: template.templateName,
    languageCode: template.languageCode,
    parameters: filled.values,
    recipientType: queued.recipient_type ?? 'individual',
  });

  const settled = await client.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: messageId,
    p_status: deliveryStatusOf(sent),
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });
  if (settled.error) {
    console.error(JSON.stringify({ level: 'error', scope, detail: settled.error.message }));
    return { ok: false, code: 'INTERNAL', reason: 'record_failed', message: 'The delivery could not be recorded.' };
  }

  if (sent.ok && outreach) {
    await markAsOutreach(client, messageId, template.id);
  }

  if (!sent.ok) return { ok: false, code: 'PROVIDER_ERROR', reason: 'provider_failed', message: sent.message };

  return { ok: true, messageId };
}

/**
 * Send an approved template to a client from the composer — owner decision
 * 2026-09-29. The person picks the template; the send itself is the shared
 * `sendTemplateToConversation` above, and every refusal is shown as written.
 */
export async function sendTemplateMessage(
  input: SendTemplateMessageInput,
): Promise<Result<{ messageId: string; templateName: string }>> {
  const parsed = sendTemplateMessageSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'That template send could not be validated.');
  }

  const context = await requireInternal();
  if (!can(context, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to message clients.');
  }
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  const { data: template, error: templateError } = await supabase
    .schema('crm')
    .from('whatsapp_templates')
    .select('id, template_name, language_code, status, active, parameters, situation_key')
    .eq('id', parsed.data.templateId)
    .maybeSingle();
  if (templateError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendTemplateMessage', detail: templateError.message }));
    return err('INTERNAL', 'The template could not be read.');
  }
  if (!template) return err('NOT_FOUND', 'That template is not registered here.');
  if (template.status !== 'approved' || !template.active) {
    return err(
      'CONFLICT',
      `Template ${template.template_name} is ${template.active ? template.status : 'inactive'}, not approved and active. Only a template Meta approved can be sent.`,
    );
  }

  const outcome = await sendTemplateToConversation(supabase, {
    organizationId: context.organizationId,
    conversationId: parsed.data.conversationId,
    template: {
      id: template.id,
      templateName: template.template_name,
      languageCode: template.language_code,
      parameters: template.parameters ?? [],
    },
    authorId: context.userId,
    subject: { proposalId: parsed.data.proposalId ?? null },
    scope: 'sendTemplateMessage',
  });
  if (!outcome.ok) return err(outcome.code, outcome.message);

  return ok({ messageId: outcome.messageId, templateName: template.template_name });
}
