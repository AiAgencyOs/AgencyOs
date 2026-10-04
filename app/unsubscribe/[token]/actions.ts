'use server';

import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { verifyUnsubscribe } from '@/modules/crm/outreach/unsubscribe-token';

export type UnsubscribeState = { status: 'idle' | 'done' | 'error'; message?: string };

/** A recipient's confirmed unsubscribe. The token is the only authority; it names the address and the organisation. */
export async function confirmUnsubscribeAction(_prev: UnsubscribeState, formData: FormData): Promise<UnsubscribeState> {
  const env = serverEnv();
  const claim = verifyUnsubscribe(String(formData.get('token') ?? ''), env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '');
  if (!claim) return { status: 'error', message: 'This link is not valid. Please reply to the email and ask us to stop.' };
  const { error } = await createAdminClient().schema('crm').rpc('record_unsubscribe', { p_organization_id: claim.organizationId, p_email: claim.email, p_source: 'link' });
  if (error) return { status: 'error', message: 'We could not record that just now. Please try again in a moment, or reply to the email and ask us to stop.' };
  return { status: 'done' };
}
