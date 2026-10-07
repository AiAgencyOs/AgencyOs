import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { sendSystemText } from '@/modules/crm/system-message';

import { sweepDesignShareReminders, type DueShare, type SendResult, type SweepOutcome } from './design-share-followups';
import { loadContext } from './pm-client-comms';
import type { PmLanguage } from './pm-messages';

/**
 * W10 (P3-PM-030): the cron tick's design-share reminder sweep, for every organization.
 *
 * The sweep (`design-share-followups.ts`) decides who is due and asks the central notification rules; this file supplies the one thing it injects, the
 * sender. The sender is the SAME outbound path every other client message uses (`sendSystemText` -> `crm.send_outbound_message` -> `deliverQueuedText`),
 * so consent, the 24-hour window, the template fallback, the owner's outbound kill switch and the WhatsApp provider all still decide. Nothing is faked:
 * with no WhatsApp number or token configured the delivery fails and the sender answers `{ sent: false, reason }`, and the sweep then records NO reminder,
 * so the share is simply due again at the next sweep.
 *
 * The wording is fixed text written in code (no model), states no date or price, and each reminder has its own stable reference, so a retried sweep
 * cannot send the same reminder twice.
 */
type Admin = ReturnType<typeof createAdminClient>;

export function designShareReminderText(language: PmLanguage, projectName: string): string {
  switch (language) {
    case 'hinglish':
      return `Hi! "${projectName}" ke design aapko share kiye gaye the. Jab time mile, please dekh kar batayein: approve karna hai ya koi change chahiye. Aapke jawab ke baad hi hum agle step par badhenge.`;
    case 'hindi':
      return `नमस्ते! "${projectName}" के डिज़ाइन आपके साथ साझा किए गए थे। समय मिलने पर कृपया देखकर बताएँ: अनुमोदन करना है या कोई बदलाव चाहिए। आपके उत्तर के बाद ही हम अगले चरण पर बढ़ेंगे।`;
    default:
      return `Hi! The designs for "${projectName}" were shared with you. When you have a moment, please take a look and let us know whether you approve them or would like changes. We move to the next step only after we hear from you.`;
  }
}

export function reminderSenderFor(admin: Admin, organizationId: string): (share: DueShare) => Promise<SendResult> {
  return async (share) => {
    const ctx = await loadContext(admin, organizationId, share.project_id);
    if (ctx === 'unreadable') return { sent: false, reason: 'PROJECT_UNREADABLE' };
    if (ctx === 'gone') return { sent: false, reason: 'PROJECT_GONE' };
    if (!ctx.conversationId) return { sent: false, reason: 'NO_CLIENT_THREAD' };
    const result = await sendSystemText(admin as never, {
      organizationId,
      conversationId: ctx.conversationId,
      body: designShareReminderText(ctx.language, ctx.projectName),
      ref: `p13:design-share-reminder:${share.share_id}:${share.next_reminder_number}`,
    });
    switch (result.kind) {
      case 'sent':
        return { sent: true, channel: 'whatsapp', evidenceRef: result.messageId };
      case 'already_sent':
        // Delivered on an earlier sweep whose bookkeeping did not complete: it must be recorded, not sent again. The message id is not at hand, so the
        // stable reference is the evidence.
        return { sent: true, channel: 'whatsapp', evidenceRef: `ref:p13:design-share-reminder:${share.share_id}:${share.next_reminder_number}` };
      case 'paused':
        return { sent: false, reason: 'OUTBOUND_PAUSED' };
      case 'no_consent':
        return { sent: false, reason: 'NO_CONSENT' };
      case 'in_flight':
        return { sent: false, reason: 'IN_FLIGHT' };
      case 'failed':
        return { sent: false, reason: `WHATSAPP_NOT_CONFIGURED_OR_FAILED: ${result.detail}` };
    }
  };
}

export async function sweepDesignShareRemindersAllOrganizations(admin: Admin): Promise<{ organizations: number; reminded: number; held: number; notSent: number; failed: number }> {
  const { data, error } = await admin.schema('core').from('organizations').select('id');
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `design-share reminder sweep: organisations unreadable: ${error.message}` }));
    return { organizations: 0, reminded: 0, held: 0, notSent: 0, failed: 1 };
  }
  const totals = { organizations: (data ?? []).length, reminded: 0, held: 0, notSent: 0, failed: 0 };
  for (const org of (data ?? []) as Array<{ id: string }>) {
    try {
      const swept = await sweepDesignShareReminders(admin, { organizationId: org.id }, reminderSenderFor(admin, org.id));
      if (!swept.ok) {
        totals.failed += 1;
        console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `design-share reminder sweep for ${org.id}: ${swept.detail}` }));
        continue;
      }
      for (const o of swept.outcomes as SweepOutcome[]) {
        if (o.result === 'reminded') totals.reminded += 1;
        else if (o.result === 'held_by_rules') totals.held += 1;
        else if (o.result === 'not_sent') totals.notSent += 1;
      }
    } catch (e) {
      totals.failed += 1;
      console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `design-share reminder sweep for ${org.id}: ${e instanceof Error ? e.message : 'unknown'}` }));
    }
  }
  return totals;
}
