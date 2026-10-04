import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { verifyUnsubscribe } from '@/modules/crm/outreach/unsubscribe-token';

/**
 * RFC 8058 one-click unsubscribe: a mailbox provider POSTs here (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
 * when the reader presses its own "Unsubscribe" button. POST only - a GET changes nothing, so a link scanner cannot
 * unsubscribe anybody. The signed token is the only authority.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const env = serverEnv();
  const claim = verifyUnsubscribe(token, env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '');
  if (!claim) return NextResponse.json({ ok: false, error: 'invalid token' }, { status: 400 });
  const { error } = await createAdminClient().schema('crm').rpc('record_unsubscribe', { p_organization_id: claim.organizationId, p_email: claim.email, p_source: 'one_click' });
  if (error) return NextResponse.json({ ok: false, error: 'could not record' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
