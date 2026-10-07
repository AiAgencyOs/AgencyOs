import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/db/admin';
import { limitPublicRoute } from '@/lib/security/rate-limit';
import { serverEnv } from '@/lib/env';
import { verifyUnsubscribe } from '@/modules/crm/outreach/unsubscribe-token';
import { routeError } from '@/lib/route-errors';

/**
 * RFC 8058 one-click unsubscribe: a mailbox provider POSTs here (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
 * when the reader presses its own "Unsubscribe" button. POST only - a GET changes nothing, so a link scanner cannot
 * unsubscribe anybody. The signed token is the only authority.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  // P1-DOD-064: a mailbox provider presses this once per message; a loop is not a person unsubscribing. Fails open.
  const blocked = await limitPublicRoute(_request, createAdminClient(), 'unsubscribe', 60, 60);
  if (blocked) return blocked;
  const { token } = await params;
  const env = serverEnv();
  const claim = verifyUnsubscribe(token, env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '');
  if (!claim) return routeError('VALIDATION', 'invalid token', { status: 400, extra: { ok: false } });
  const { error } = await createAdminClient().schema('crm').rpc('record_unsubscribe', { p_organization_id: claim.organizationId, p_email: claim.email, p_source: 'one_click' });
  if (error) return routeError('INTERNAL', 'could not record', { extra: { ok: false } });
  return NextResponse.json({ ok: true });
}
