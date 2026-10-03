import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import { markAsOutreach, planOutbound } from './outbound-window';

/**
 * Delivery of a text message that is already RECORDED (delivery `pending`),
 * with no session attached.
 *
 * It lived in `service.ts`, which is session-bound and so cannot ride into a
 * cron handler. Two callers need it: a staff send and the requirement summary
 * (both in the service), and the handover acknowledgement (a handler). One
 * implementation means one place that knows the 24-hour window, the template
 * fallback and how a provider refusal is written back.
 */
export type QueuedOutbound = {
  message_id: string | null;
  seq: number | null;
  to_phone: string | null;
  from_phone_number_id: string | null;
  recipient_type: 'individual' | 'group' | null;
};

type Db = Parameters<typeof planOutbound>[0];

/**
 * The second half of every staff text send: the row already exists (pending);
 * decide whether WhatsApp will carry it, call the provider, write the outcome
 * back. Shared so that a send recorded by a DATABASE door (the requirement
 * summary) is delivered by the same code as one typed in the composer — the
 * requirement summary used to be recorded and never transmitted, and the
 * lead page said it had been sent.
 */
export async function deliverQueuedText(
  supabase: Db,
  args: { organizationId: string; conversationId: string; body: string; queued: QueuedOutbound },
): Promise<Result<{ messageId: string; seq: number; delivered: boolean }>> {
  const { queued } = args;
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
    organizationId: args.organizationId,
    conversationId: args.conversationId,
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
        body: args.body,
        recipientType: queued.recipient_type ?? 'individual',
      });

  await supabase.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  // A template went, so the window was shut, so this was outreach — G-216.
  if (sent.ok && plan.mode === 'template') {
    await markAsOutreach(supabase, queued.message_id!, plan.template.id);
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

