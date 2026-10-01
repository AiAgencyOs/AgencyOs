import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { emailTransportState, sendEmail } from '@/lib/email/transport';
import { err, ok, type Result } from '@/lib/result';

import { resendEmailSchema, sendCenterEmailSchema, type ResendEmailInput, type SendCenterEmailInput } from './email-schema';

/**
 * Send an email or a client update from the Communication Center — SCR-057.
 *
 * `lead.write` (owner, ops admin), the capability that messages clients on
 * WhatsApp. The sequence mirrors the invoice email: the transport must be
 * configured (else an honest refusal naming the variables, and nothing is
 * recorded — a missing key is not a delivery failure); the message goes
 * through `sendEmail`; and the outcome, accepted OR refused, is recorded by
 * `crm.record_outbound_email` with the provider's own words. A refused send
 * therefore shows in the lane as failed, with its reason, and can be sent
 * again with a reason of its own.
 */

type Recorded = { emailId: string; status: 'sent' | 'failed'; transport: 'resend' | 'smtp' | null; reason: string | null };

async function sendAndRecord(args: {
  kind: SendCenterEmailInput['kind'];
  to: string;
  subject: string;
  body: string;
  projectId?: string;
  retryOf?: string;
  retryReason?: string;
}): Promise<Result<Recorded>> {
  const transport = await emailTransportState();
  if (!transport.configured) return err('CONFLICT', `Email is not configured on this deployment. ${transport.reason}`);

  const sent = await sendEmail({ to: args.to, subject: args.subject, text: args.body });

  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').rpc('record_outbound_email', {
    p_kind: args.kind,
    p_to: args.to,
    p_subject: args.subject,
    p_body: args.body,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(args.projectId ? { p_project_id: args.projectId } : {}),
    ...(sent.ok ? { p_transport: sent.kind, ...(sent.messageRef ? { p_message_ref: sent.messageRef.slice(0, 200) } : {}) } : { p_error: sent.reason }),
    ...(args.retryOf ? { p_retry_of: args.retryOf, p_retry_reason: args.retryReason } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendCenterEmail', detail: error.message }));
    return err('INTERNAL', sent.ok ? 'The email was sent but could not be recorded.' : `The send failed (${sent.reason}) and could not be recorded.`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  if (row?.outcome !== 'recorded' || !row.id) {
    switch (row?.outcome) {
      case 'project_not_found':
        return err('NOT_FOUND', 'That project is not in this organization.');
      case 'no_reason':
        return err('VALIDATION', 'Say why you are sending it again (at least a few words).');
      case 'not_failed':
        return err('CONFLICT', 'Only a send that failed can be sent again.');
      case 'invalid':
        return err('VALIDATION', 'The address, subject or body was refused.');
      case 'forbidden':
        return err('FORBIDDEN', 'The database refused: owner or ops admin only.');
      default:
        return err('INTERNAL', `The database refused the record (${row?.outcome ?? 'no answer'}).`);
    }
  }
  return ok({ emailId: row.id, status: sent.ok ? 'sent' : 'failed', transport: sent.ok ? sent.kind : null, reason: sent.ok ? null : sent.reason });
}

export async function sendCenterEmail(input: SendCenterEmailInput): Promise<Result<Recorded>> {
  const parsed = sendCenterEmailSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid email.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to message clients.');

  return sendAndRecord({ ...parsed.data, ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}) });
}

/** Send a failed one again, with the reason — a new row that points back at the failure. */
export async function resendCenterEmail(input: ResendEmailInput): Promise<Result<Recorded>> {
  const parsed = resendEmailSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid resend.');

  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'You do not have permission to message clients.');

  const supabase = await createClient();
  const { data: original, error } = await supabase
    .schema('crm')
    .from('outbound_emails')
    .select('id, kind, to_address, subject, body, project_id, status')
    .eq('id', parsed.data.emailId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'resendCenterEmail', detail: error.message }));
    return err('INTERNAL', 'Could not load the email.');
  }
  if (!original) return err('NOT_FOUND', 'Email not found.');
  if (original.status !== 'failed') return err('CONFLICT', 'Only a send that failed can be sent again.');

  return sendAndRecord({
    kind: original.kind === 'client_update' ? 'client_update' : 'email',
    to: original.to_address,
    subject: original.subject,
    body: original.body,
    ...(original.project_id ? { projectId: original.project_id } : {}),
    retryOf: original.id,
    retryReason: parsed.data.reason,
  });
}
