import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { outreachWindow } from '@/lib/admin/operational-defaults';
import { clientEnv, serverEnv } from '@/lib/env';
import { heldByNotificationRules } from '@/lib/p13/notification-hold';
import { emailTransportState, sendEmail } from '@/lib/email/transport';

import { intoSendingWindow } from '../follow-up-rhythms';
import { classifySmtpFailure, renderOutreach, unsubscribeHeaders, type OutreachBasis, type OutreachLanguage } from './render';
import { signUnsubscribe } from './unsubscribe-token';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The outreach sweep: info@ email to prospects, through ONE chokepoint.
 *
 * Everything that decides WHETHER a message may go is `crm.claim_outreach_sends` (the owner's kill
 * switch, a running and approved campaign, suppression, the lawful basis, an approved template, the
 * sender identity, the daily cap with warm-up) - and it RESERVES the send before this file attempts
 * it, so a retried tick, two overlapping ticks or a crashed worker send nothing twice. This file only
 *
 *   1. declines to run outside the sending window (ADM-69) or without a configured outreach mailbox,
 *   2. renders the message (the template plus the system-added identity, reason and unsubscribe),
 *   3. sends it through the `outreach` lane - never the client mailbox - and
 *   4. records the outcome (sent / failed / bounced), which may suppress the address and may pause
 *      the whole campaign when too many bounce.
 *
 * A message with no working unsubscribe link is never sent: with no signing key the sweep stops.
 */

type ClaimedSend = {
  send_id: string;
  recipient_id: string;
  campaign_id: string;
  step_number: number;
  email: string;
  first_name: string | null;
  company: string | null;
  language: string | null;
  subject: string;
  body: string;
  sender_name: string;
  postal_address: string;
  reply_to: string | null;
};

export type OutreachSweep = { organizations: number; claimed: number; sent: number; failed: number; bounced: number; skipped: string[] };

const SEND_PAUSE_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signingKey(): string {
  const env = serverEnv();
  return env.VAULT_ENCRYPTION_KEY || env.CRON_SECRET || '';
}

function appUrl(): string {
  return (clientEnv.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
}

export async function runOutreach(admin: Admin, options: { limit?: number; now?: Date } = {}): Promise<OutreachSweep> {
  const sweep: OutreachSweep = { organizations: 0, claimed: 0, sent: 0, failed: 0, bounced: 0, skipped: [] };
  const now = options.now ?? new Date();

  const { data: orgs, error } = await admin.schema('crm').rpc('orgs_with_running_email_campaigns');
  if (error) {
    sweep.skipped.push(`could not list campaigns: ${error.message}`);
    return sweep;
  }
  if (((orgs ?? []) as unknown[]).length === 0) return sweep;

  const key = signingKey();
  const base = appUrl();
  if (!key || !base) {
    sweep.skipped.push('no signing key or app URL: an outreach email without a working unsubscribe link is never sent');
    return sweep;
  }
  const transport = await emailTransportState('outreach');
  if (!transport.configured) {
    sweep.skipped.push(transport.reason);
    return sweep;
  }

  for (const { organization_id: organizationId } of (orgs ?? []) as unknown as { organization_id: string }[]) {
    sweep.organizations += 1;

    // ADM-69: the window and the zone are the agency's. Outside it, nothing leaves - it waits.
    const { data: org } = await admin.schema('core').from('organizations').select('settings, timezone').eq('id', organizationId).maybeSingle();
    if (!org?.timezone) {
      sweep.skipped.push(`${organizationId}: the organisation has no timezone, so there is no sending window`);
      continue;
    }
    if (intoSendingWindow(now, org.timezone, outreachWindow(org.settings as Record<string, unknown> | null)).getTime() !== now.getTime()) {
      sweep.skipped.push(`${organizationId}: outside the sending window`);
      continue;
    }

    // P1-BLUEPRINT-032: asked BEFORE the claim, so a hold reserves nothing. Unreadable rules hold the organisation's outreach (a prospect is never mailed on the
    // strength of a rulebook that could not be read).
    const heldByRules = await heldByNotificationRules(admin, { organizationId, eventClass: 'sales', channel: 'email', clientFacing: true });
    if (heldByRules) {
      sweep.skipped.push(`${organizationId}: held by the notification rules: ${heldByRules.detail}`);
      continue;
    }

    const { data: claimed, error: claimError } = await admin.schema('crm').rpc('claim_outreach_sends', { p_organization_id: organizationId, p_limit: options.limit ?? 10 });
    if (claimError) {
      sweep.skipped.push(`${organizationId}: claim failed: ${claimError.message}`);
      continue;
    }

    for (const item of (claimed ?? []) as unknown as ClaimedSend[]) {
      sweep.claimed += 1;
      const { data: prospect } = await admin.schema('crm').from('outreach_prospects').select('lawful_basis').eq('email', item.email).eq('organization_id', organizationId).maybeSingle();
      const unsubscribeUrl = `${base}/unsubscribe/${signUnsubscribe({ organizationId, email: item.email }, key)}`;
      const rendered = renderOutreach({
        subject: item.subject,
        body: item.body,
        firstName: item.first_name,
        company: item.company,
        senderName: item.sender_name,
        postalAddress: item.postal_address,
        unsubscribeUrl,
        basis: (prospect?.lawful_basis ?? 'b2b_legitimate_interest') as OutreachBasis,
        language: (item.language ?? 'en') as OutreachLanguage,
      });

      const result = await sendEmail({
        lane: 'outreach',
        to: item.email,
        subject: rendered.subject,
        text: rendered.text,
        headers: unsubscribeHeaders(`${base}/api/outreach/unsubscribe/${signUnsubscribe({ organizationId, email: item.email }, key)}`, item.reply_to ?? null),
        replyTo: item.reply_to ?? undefined,
      });

      const outcome: 'sent' | 'failed' | 'bounced' = result.ok ? 'sent' : classifySmtpFailure(result.reason);
      const { error: recordError } = await admin.schema('crm').rpc('record_outreach_result', {
        p_send_id: item.send_id,
        p_outcome: outcome,
        p_message_ref: result.ok ? (result.messageRef ?? '') : '',
        p_error: result.ok ? '' : result.reason,
      });
      if (recordError) sweep.skipped.push(`${item.send_id}: could not record the result: ${recordError.message}`);
      if (outcome === 'sent') sweep.sent += 1;
      else if (outcome === 'bounced') sweep.bounced += 1;
      else sweep.failed += 1;
      await sleep(SEND_PAUSE_MS);
    }
  }
  return sweep;
}
