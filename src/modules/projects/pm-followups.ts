import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { outreachWindow } from '@/lib/admin/operational-defaults';
import { intoSendingWindow } from '@/modules/crm/follow-up-rhythms';
import { sendSystemText } from '@/modules/crm/system-message';

import { loadContext } from './pm-client-comms';
import { pmFollowUp } from './pm-messages';
import { resolvePmText } from './pm-template-resolve';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Reminding a client who has not answered an onboarding ask - Phase 2 PM §4.2,
 * Master §13 ("client no response: WAITING_CLIENT + configured follow-up
 * policy"), ADM-109.
 *
 * The owner chooses ONE number - how many days to wait (`onboarding_followup_days`,
 * unset = never chase, which is the safe default and what ADM-109's silence
 * has meant until now). Everything else is fixed here and tested: at most two
 * reminders, spaced by that same number of days, only inside the agency's
 * sending window, never to a client who has written since the ask (a reply, even
 * an unhelpful one, is a person's turn to read), each sent at most once under a
 * stable reference, and always through the same consent / window / kill-switch
 * chokepoint every client message uses.
 *
 * What it chases is exactly the two asks the PM makes itself: the billing mode
 * and the GST details. It reminds; it never asks anything new.
 */
export const MAX_ONBOARDING_REMINDERS = 2;
/** The most waiting projects one organization's sweep will look at in a tick - a bound, not a target. */
const MAX_WAITING_PER_ORG = 1000;
const DAY_MS = 86_400_000;

export type FollowUpDecision =
  | { action: 'send'; reminderNumber: number }
  | { action: 'wait' | 'outside_window' | 'client_replied' | 'done' };

/** Pure: what to do about one unanswered ask, right now. */
export function decideOnboardingFollowUp(input: {
  now: Date;
  timeZone: string;
  days: number;
  askedAt: Date;
  lastClientAt: Date | null;
  reminderTimes: readonly Date[];
  /** The agency's own sending window (`outreach_window_*`), the one every follow-up respects. */
  window?: { startHour: number; endHour: number };
}): FollowUpDecision {
  if (input.lastClientAt && input.lastClientAt.getTime() > input.askedAt.getTime()) return { action: 'client_replied' };
  if (input.reminderTimes.length >= MAX_ONBOARDING_REMINDERS) return { action: 'done' };

  const last = input.reminderTimes.length > 0 ? input.reminderTimes[input.reminderTimes.length - 1]! : input.askedAt;
  if (input.now.getTime() < last.getTime() + input.days * DAY_MS) return { action: 'wait' };
  if (intoSendingWindow(input.now, input.timeZone, input.window).getTime() !== input.now.getTime()) return { action: 'outside_window' };
  return { action: 'send', reminderNumber: input.reminderTimes.length + 1 };
}

export type FollowUpSweep = { checked: number; sent: number; held: number; failed: boolean };

/** One bounded pass over every organization that has chosen a wait. Run each tick. */
export async function runOnboardingFollowUps(admin: Admin, now: Date = new Date(), limit = 50): Promise<FollowUpSweep> {
  const out: FollowUpSweep = { checked: 0, sent: 0, held: 0, failed: false };

  const { data: orgs, error } = await admin
    .schema('core')
    .from('organizations')
    .select('id, settings, timezone')
    .not('settings->>onboarding_followup_days', 'is', null);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'runOnboardingFollowUps.orgs', detail: error.message }));
    return { ...out, failed: true };
  }

  for (const org of orgs ?? []) {
    const raw = (org.settings as Record<string, unknown> | null)?.onboarding_followup_days;
    const days = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 30) continue;

    // Every waiting project, a page at a time in a fixed order. This was `.limit(limit)` with no order, so the first `limit` rows were the
    // only ones ever looked at: with more than that many projects waiting, the others were never reminded (found when a verifier's own
    // project, planted after fifty leftovers, was never chased). `limit` is the page size; MAX_WAITING_PER_ORG is the safety bound.
    let offset = 0;
    while (offset < MAX_WAITING_PER_ORG) {
      const { data: phases, error: phaseError } = await admin
        .schema('projects')
        .from('phase_two')
        .select('project_id')
        .eq('organization_id', org.id)
        .eq('state', 'waiting_client')
        .order('project_id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (phaseError) {
        console.error(JSON.stringify({ level: 'error', scope: 'runOnboardingFollowUps.phases', detail: phaseError.message }));
        out.failed = true;
        break;
      }

      for (const { project_id: projectId } of phases ?? []) {
        out.checked += 1;
        const result = await followUpOne(admin, org.id, org.timezone ?? 'UTC', outreachWindow(org.settings as Record<string, unknown> | null), projectId, days, now);
        if (result === 'sent') out.sent += 1;
        else if (result === 'failed') out.failed = true;
        else if (result === 'held') out.held += 1;
      }
      if ((phases ?? []).length < limit) break;
      offset += limit;
    }
  }
  return out;
}

async function followUpOne(
  admin: Admin,
  organizationId: string,
  timeZone: string,
  window: { startHour: number; endHour: number },
  projectId: string,
  days: number,
  now: Date,
): Promise<'sent' | 'held' | 'skipped' | 'failed'> {
  // What is the PM waiting for? The two asks it makes itself.
  const { data: profile, error: profileError } = await admin
    .schema('finance')
    .from('billing_profiles')
    .select('mode, version, legal_name, gstin, billing_address, billing_state')
    .eq('project_id', projectId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle();
  if (profileError) return 'failed';

  let what: 'billing' | 'gst_details';
  let askRef: string;
  if (!profile) {
    what = 'billing';
    askRef = `pm:billing-question:${projectId}`;
  } else if (profile.mode === 'gst' && !(profile.legal_name && profile.gstin && profile.billing_address && profile.billing_state)) {
    what = 'gst_details';
    askRef = `pm:gst-details:${projectId}:${profile.version}`;
  } else {
    return 'skipped';
  }

  const { data: asked } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('created_at, conversation_id')
    .eq('organization_id', organizationId)
    .eq('external_ref', askRef)
    .maybeSingle();
  if (!asked) return 'skipped';

  const [{ data: lastClient }, { data: reminders }] = await Promise.all([
    admin
      .schema('crm')
      .from('conversation_messages')
      .select('created_at')
      .eq('organization_id', organizationId)
      .eq('conversation_id', asked.conversation_id)
      .eq('author_type', 'client')
      .order('created_at', { ascending: false })
      .limit(1),
    admin
      .schema('crm')
      .from('conversation_messages')
      .select('created_at')
      .eq('organization_id', organizationId)
      .like('external_ref', `pm:followup:${projectId}:%`)
      .order('created_at', { ascending: true }),
  ]);

  const decision = decideOnboardingFollowUp({
    now,
    timeZone,
    days,
    askedAt: new Date(asked.created_at),
    lastClientAt: lastClient?.[0] ? new Date(lastClient[0].created_at) : null,
    reminderTimes: (reminders ?? []).map((r) => new Date(r.created_at)),
    window,
  });
  if (decision.action !== 'send') return decision.action === 'outside_window' ? 'held' : 'skipped';

  const ctx = await loadContext(admin, organizationId, projectId);
  if (ctx === 'unreadable') return 'failed';
  if (ctx === 'gone' || !ctx.conversationId) return 'skipped';

  const sent = await sendSystemText(admin as never, {
    organizationId,
    conversationId: ctx.conversationId,
    body: await resolvePmText(admin, {
      organizationId,
      key: what === 'billing' ? 'follow_up_billing' : 'follow_up_gst_details',
      language: ctx.language,
      vars: {},
      fallback: pmFollowUp(ctx.language, what),
    }),
    ref: `pm:followup:${projectId}:${decision.reminderNumber}`,
  });
  if (sent.kind === 'sent') return 'sent';
  if (sent.kind === 'failed') return 'failed';
  return 'held';
}
