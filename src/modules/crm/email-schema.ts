import { z } from 'zod';

/**
 * The email and client-update lane of the Communication Center — SCR-057
 * ("across WhatsApp, email, announcements, client updates"). One send through
 * the same transport the invoice email uses (Resend or SMTP, whichever the
 * deployment configured), recorded in `crm.outbound_emails` with the
 * provider's answer. A failed send is sent again as a new row that points
 * back at it, with the reason.
 */
export const EMAIL_KINDS = ['email', 'client_update'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

export const sendCenterEmailSchema = z.object({
  kind: z.enum(EMAIL_KINDS),
  to: z.string().trim().email('That is not an email address.').max(254),
  subject: z.string().trim().min(1, 'A subject is required.').max(200),
  body: z.string().trim().min(1, 'Write the message.').max(10000),
  projectId: z.uuid().optional(),
});
export type SendCenterEmailInput = z.input<typeof sendCenterEmailSchema>;

export const resendEmailSchema = z.object({
  emailId: z.uuid(),
  reason: z.string().trim().min(5, 'Say why you are sending it again (at least a few words).').max(600),
});
export type ResendEmailInput = z.input<typeof resendEmailSchema>;
