import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { heldByNotificationRules } from '@/lib/p13/notification-hold';

import type { CampaignRefusalReason } from './campaign-types';
import { outreachAllowance } from './outbound-window';
import { sendTemplateToConversation } from './template-send-service';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The campaign sweep — SCR-059, owner decision 2026-09-30 (broadcast
 * reopened as a governed campaign). Run from the cron tick right after
 * `runInvoiceReminders`.
 *
 * ── claim, check, send, record ────────────────────────────────────────────
 *
 *   **claim**   `crm.claim_campaign_recipient`: one pending row of an
 *               approved or running campaign, FOR UPDATE SKIP LOCKED, so
 *               two ticks never write to the same person. The first claim
 *               moves the campaign to running.
 *   **check**   the template is still approved and active at Meta (it may
 *               have been paused since approval), and the organization's
 *               daily outreach allowance is not spent — a campaign is
 *               outreach by nature, and when the day's allowance is gone the
 *               rest of the audience WAITS for the next tick rather than
 *               being burned through as refused. The held row's claim
 *               expires and it is picked up again.
 *   **send**    `sendTemplateToConversation` — the composer's own door, so
 *               consent (`crm.send_outbound_message`), the contact's phone,
 *               the per-contact outreach limits and the template's facts
 *               decide each recipient separately. This worker never imports
 *               the provider; the chokepoint guard test refuses one that does.
 *   **record**  `crm.record_campaign_recipient`: sent with the message id,
 *               refused with a reason from the closed set, or failed with
 *               the provider's words. When nothing is pending the campaign
 *               is done.
 *
 * Batches of `limit` per tick (25): with cron every minute that is 1,500 an
 * hour at most, and the allowance usually says less.
 */
export type CampaignOutcome = {
  claimed: number;
  sent: number;
  refused: number;
  failed: number;
  /** Left pending for the next tick: the organization's outreach allowance is spent. */
  held: number;
  failedRun: boolean;
};

export async function runCampaigns(admin: Admin, limit = 25): Promise<CampaignOutcome> {
  const outcome: CampaignOutcome = { claimed: 0, sent: 0, refused: 0, failed: 0, held: 0, failedRun: false };

  const record = async (
    recipientId: string,
    status: 'sent' | 'refused' | 'failed',
    reason?: CampaignRefusalReason | string,
    messageId?: string,
  ): Promise<boolean> => {
    const { error } = await admin.schema('crm').rpc('record_campaign_recipient', {
      p_recipient_id: recipientId,
      p_status: status,
      ...(reason ? { p_reason: reason.slice(0, 600) } : {}),
      ...(messageId ? { p_message_id: messageId } : {}),
    });
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'runCampaigns.record', recipientId, detail: error.message }));
      outcome.failedRun = true;
      return false;
    }
    outcome[status] += 1;
    return true;
  };

  for (let i = 0; i < limit; i += 1) {
    // ── claim ─────────────────────────────────────────────────────────────
    const { data: claimed, error: claimError } = await admin.schema('crm').rpc('claim_campaign_recipient', {});
    if (claimError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runCampaigns.claim', detail: claimError.message }));
      return { ...outcome, failedRun: true };
    }
    const row = (Array.isArray(claimed) ? claimed[0] : claimed) as
      | {
          recipient_id: string;
          campaign_id: string;
          organization_id: string;
          lead_id: string | null;
          conversation_id: string | null;
          template_id: string;
        }
      | undefined;
    if (!row) break;
    outcome.claimed += 1;

    if (!row.conversation_id) {
      await record(row.recipient_id, 'refused', 'no_conversation');
      continue;
    }

    // ── check ─────────────────────────────────────────────────────────────
    // The organization filter is load-bearing: this is the service-role
    // client, and without it one agency's campaign could carry another's
    // template.
    const { data: template, error: templateError } = await admin
      .schema('crm')
      .from('whatsapp_templates')
      .select('id, template_name, language_code, status, active, parameters')
      .eq('id', row.template_id)
      .eq('organization_id', row.organization_id)
      .maybeSingle();
    if (templateError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runCampaigns.template', campaignId: row.campaign_id, detail: templateError.message }));
      await record(row.recipient_id, 'refused', 'unreadable');
      outcome.failedRun = true;
      continue;
    }
    if (!template || template.status !== 'approved' || !template.active) {
      await record(row.recipient_id, 'refused', 'template_not_approved');
      continue;
    }

    // P1-BLUEPRINT-032: a campaign message is a client-facing send, so the organisation's notification rules are asked BEFORE it goes. A hold (quiet hours,
    // the class switched off, too soon, or rules that cannot be read) leaves the recipient pending for a later tick; the rules are the organisation's, not this
    // recipient's, so the rest of the batch waits with it.
    const heldByRules = await heldByNotificationRules(admin, { organizationId: row.organization_id, eventClass: 'sales', channel: 'whatsapp', clientFacing: true });
    if (heldByRules) {
      outcome.held += 1;
      break;
    }

    const allowance = await outreachAllowance(admin, row.conversation_id);
    if (allowance === 'per_organization_per_day') {
      // Not this recipient's fault and not a refusal: the day's outreach is
      // spent. The claim lapses and the row waits for a tick with room.
      outcome.held += 1;
      break;
    }

    // ── send ──────────────────────────────────────────────────────────────
    const sent = await sendTemplateToConversation(admin, {
      organizationId: row.organization_id,
      conversationId: row.conversation_id,
      template: {
        id: template.id,
        templateName: template.template_name,
        languageCode: template.language_code,
        parameters: template.parameters ?? [],
      },
      // The recipient row is the idempotency key: a retry after a crash
      // between the send and the record finds `already_sent`, not a second message.
      externalRef: `campaign-${row.recipient_id}`,
      scope: 'runCampaigns.send',
    });

    // ── record ────────────────────────────────────────────────────────────
    if (sent.ok) {
      await record(row.recipient_id, 'sent', undefined, sent.messageId);
    } else if (sent.reason === 'provider_failed') {
      await record(row.recipient_id, 'failed', sent.message);
    } else {
      await record(row.recipient_id, 'refused', sent.reason);
    }
  }

  return outcome;
}
