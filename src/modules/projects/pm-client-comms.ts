import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { sendSystemText, type SystemTextResult } from '@/modules/crm/system-message';

import type { HandlerResult } from './handlers';
import {
  pmAdvanceVerified,
  pmBillingQuestion,
  pmGstDetailsRequest,
  pmPaymentNeedsAttention,
  pmPaymentReceived,
  pmPaymentVerified,
  pmWelcome,
  type PmLanguage,
} from './pm-messages';

type Admin = ReturnType<typeof createAdminClient>;

type JobEnvelope = { eventType?: string; subjectId?: string | null; subjectType?: string | null; event?: unknown };
export type PmCommsJob = {
  id: string;
  organization_id: string;
  payload: JobEnvelope | null;
  correlation_id: string | null;
};

/**
 * What the project manager says to the client during Phase 2 — Phase 2 PM
 * §4.2, §6 PM-03/05/06/08, §14. Until this existed the PM contacted nobody:
 * the welcome, the billing question, the GST request and every payment status
 * were a person typing into WhatsApp.
 *
 * ── what this is and is not ──────────────────────────────────────────────
 *
 *   • Every sentence is a template in `pm-messages.ts` — code, not a model.
 *     A message that reaches a client during onboarding states facts the
 *     system holds or asks one question; nothing here can promise a date,
 *     quote a price or approve anything.
 *   • Each message goes out AT MOST ONCE, under a stable reference
 *     (`sendSystemText`), so a replayed event, a retried job and two
 *     overlapping ticks all send it once.
 *   • It changes no state. It does not confirm a billing mode (that stays a
 *     person's act, `finance.confirm_billing_mode`), does not verify a payment
 *     and does not decide anything about the plan.
 *   • Consent, the 24-hour window, the template fallback and the owner's
 *     outbound kill switch all still decide inside the send chokepoint.
 */

export type PmContext = {
  organizationId: string;
  projectId: string;
  projectName: string;
  agencyName: string;
  clientAccountId: string | null;
  leadId: string | null;
  language: PmLanguage;
  conversationId: string | null;
};

/**
 * The thread the client is talking to us on. The official project group once it
 * exists (Master §5.7), otherwise the thread the deal was won on, otherwise the
 * client account's own. Never an abandoned thread.
 */
export async function loadContext(admin: Admin, organizationId: string, projectId: string): Promise<PmContext | 'gone' | 'unreadable'> {
  const { data: project, error } = await admin
    .schema('projects')
    .from('projects')
    .select('id, name, client_account_id, opportunity_id, deleted_at')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) return 'unreadable';
  if (!project || project.deleted_at) return 'gone';

  const { data: org } = await admin.schema('core').from('organizations').select('name').eq('id', organizationId).maybeSingle();

  let leadId: string | null = null;
  if (project.opportunity_id) {
    const { data: opp } = await admin
      .schema('sales')
      .from('opportunities')
      .select('lead_id')
      .eq('id', project.opportunity_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    leadId = opp?.lead_id ?? null;
  }

  const newest = async (filters: Record<string, string>): Promise<string | null> => {
    let q = admin
      .schema('crm')
      .from('conversations')
      .select('id, updated_at')
      .eq('organization_id', organizationId)
      .neq('status', 'abandoned');
    for (const [column, value] of Object.entries(filters)) q = q.eq(column as 'kind', value);
    const { data } = await q.order('updated_at', { ascending: false }).limit(1);
    return data?.[0]?.id ?? null;
  };

  const group = await newest({ kind: 'project_group', project_id: projectId });
  const direct = group || !leadId ? null : await newest({ kind: 'direct', lead_id: leadId });
  const account =
    group || direct || !project.client_account_id ? null : await newest({ kind: 'client_account', client_account_id: project.client_account_id });

  let language: PmLanguage = 'en';
  if (leadId) {
    const { quotationLanguageForLead } = await import('@/modules/sales/quotation-language');
    language = await quotationLanguageForLead(admin as never, leadId, organizationId);
  }

  return {
    organizationId,
    projectId,
    projectName: project.name,
    agencyName: org?.name ?? 'our agency',
    clientAccountId: project.client_account_id ?? null,
    leadId,
    language,
    conversationId: group ?? direct ?? account,
  };
}

const subjectOf = (job: PmCommsJob): string | null =>
  typeof job.payload?.subjectId === 'string' ? job.payload.subjectId : null;

/** Fold the sends of one job into the one answer the runner needs. */
export function settle(results: Array<{ label: string; result: SystemTextResult }>): HandlerResult {
  const paused = results.find((r) => r.result.kind === 'paused');
  if (paused) {
    return { status: 'failed', permanent: false, detail: 'Outbound messaging is paused by the owner; this goes out when the switch is released.' };
  }
  const failed = results.find((r) => r.result.kind === 'failed');
  if (failed && failed.result.kind === 'failed') {
    return { status: 'failed', permanent: failed.result.permanent, detail: `${failed.label}: ${failed.result.detail}` };
  }
  const summary = results.map((r) => `${r.label}: ${r.result.kind}`).join('; ');
  return { status: 'succeeded', outcome: results.some((r) => r.result.kind === 'sent') ? 'sent' : 'nothing_new', detail: summary };
}

async function noThread(admin: Admin, ctx: PmContext, why: string): Promise<HandlerResult> {
  // A person has to reach this client another way; say so where staff look.
  await admin.schema('core').rpc('raise_alert', {
    p_organization_id: ctx.organizationId,
    p_source: 'onboarding',
    p_severity: 'info',
    p_summary: `${ctx.projectName}: ${why} — the client has no WhatsApp thread to onboard on, so nobody has been messaged.`,
    p_fingerprint: `pm-no-thread:${ctx.projectId}`,
  });
  return { status: 'succeeded', outcome: 'no_thread', detail: why };
}

// ── 1. the welcome and the billing question ─────────────────────────────────

/**
 * `project.handoff_bound` → welcome the client and ask GST or Non-GST.
 *
 * Runs beside `projects:startPhaseTwo` off the same event, so the workspace may
 * not exist yet when this claims its job: that is a retry, not a failure.
 */
export async function handleWelcomeClient(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const projectId = subjectOf(job);
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };

  const { data: phase, error } = await admin
    .schema('projects')
    .from('phase_two')
    .select('id')
    .eq('project_id', projectId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the phase: ${error.message}` };
  if (!phase) return { status: 'failed', permanent: false, detail: 'Phase 2 has not started for this project yet' };

  const ctx = await loadContext(admin, job.organization_id, projectId);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };
  if (!ctx.conversationId) return noThread(admin, ctx, 'Welcome not sent');

  const sends: Array<{ label: string; result: SystemTextResult }> = [];
  sends.push({
    label: 'welcome',
    result: await sendSystemText(admin as never, {
      organizationId: job.organization_id,
      conversationId: ctx.conversationId,
      body: pmWelcome({ language: ctx.language, agencyName: ctx.agencyName, projectName: ctx.projectName }),
      ref: `pm:welcome:${projectId}`,
    }),
  });

  // The billing question only while nobody has settled it (a mode already
  // confirmed is exactly the thing PM §4.1 says not to ask again).
  const { data: profile, error: profileError } = await admin
    .schema('finance')
    .from('billing_profiles')
    .select('id')
    .eq('project_id', projectId)
    .eq('organization_id', job.organization_id)
    .eq('status', 'active')
    .maybeSingle();
  if (profileError) return { status: 'failed', permanent: false, detail: `could not read the billing profile: ${profileError.message}` };
  if (!profile) {
    sends.push({
      label: 'billing question',
      result: await sendSystemText(admin as never, {
        organizationId: job.organization_id,
        conversationId: ctx.conversationId,
        body: pmBillingQuestion(ctx.language),
        ref: `pm:billing-question:${projectId}`,
      }),
    });
  }
  return settle(sends);
}

// ── 2. the GST details ──────────────────────────────────────────────────────

/** `project.billing_mode_confirmed` → when the mode is GST and details are missing, ask. */
export async function handleAskGstDetails(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const projectId = subjectOf(job);
  if (!projectId) return { status: 'failed', permanent: true, detail: 'the event named no project' };

  const { data: profile, error } = await admin
    .schema('finance')
    .from('billing_profiles')
    .select('id, mode, version, legal_name, gstin, billing_address, billing_state')
    .eq('project_id', projectId)
    .eq('organization_id', job.organization_id)
    .eq('status', 'active')
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the billing profile: ${error.message}` };
  if (!profile) return { status: 'succeeded', outcome: 'no_profile', detail: 'no active billing profile' };
  if (profile.mode !== 'gst') return { status: 'succeeded', outcome: 'not_gst', detail: 'a Non-GST project needs no GST details' };
  if (profile.legal_name && profile.gstin && profile.billing_address && profile.billing_state) {
    return { status: 'succeeded', outcome: 'complete', detail: 'the GST details are already on file' };
  }

  const ctx = await loadContext(admin, job.organization_id, projectId);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };
  if (!ctx.conversationId) return noThread(admin, ctx, 'GST details not requested');

  return settle([
    {
      label: 'GST details request',
      result: await sendSystemText(admin as never, {
        organizationId: job.organization_id,
        conversationId: ctx.conversationId,
        body: pmGstDetailsRequest(ctx.language),
        ref: `pm:gst-details:${projectId}:${profile.version}`,
      }),
    },
  ]);
}

// ── 3. payment status ───────────────────────────────────────────────────────

/**
 * `payment.submitted | verified | rejected | mismatched` → tell the client
 * where their payment stands. The subject is the payment submission; the
 * project is read through its invoice, org-scoped, never from the payload.
 *
 * It states the OUTCOME a person already decided. It verifies nothing.
 */
export async function handlePaymentUpdate(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const submissionId = subjectOf(job);
  const eventType = job.payload?.eventType;
  if (!submissionId) return { status: 'failed', permanent: true, detail: 'the event named no payment' };
  if (!['payment.submitted', 'payment.verified', 'payment.rejected', 'payment.mismatched'].includes(eventType ?? '')) {
    return { status: 'failed', permanent: true, detail: `not a payment status event: ${eventType ?? 'none'}` };
  }

  const { data: submission, error } = await admin
    .schema('finance')
    .from('payment_submissions')
    .select('id, invoice_id, status')
    .eq('id', submissionId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the payment: ${error.message}` };
  if (!submission) return { status: 'succeeded', outcome: 'gone', detail: 'the payment no longer exists' };

  const { data: invoice, error: invoiceError } = await admin
    .schema('finance')
    .from('invoices')
    .select('id, number, project_id, milestone_id')
    .eq('id', submission.invoice_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (invoiceError) return { status: 'failed', permanent: false, detail: `could not read the invoice: ${invoiceError.message}` };
  if (!invoice?.project_id) return { status: 'succeeded', outcome: 'no_project', detail: 'this invoice belongs to no project' };

  // The state at the time of the job, not at the time of the event: a payment
  // verified and then reversed must not be congratulated.
  const expected: Record<string, string> = {
    'payment.submitted': 'pending_verification',
    'payment.verified': 'verified',
    'payment.rejected': 'rejected',
    'payment.mismatched': 'mismatch',
  };
  if (submission.status !== expected[eventType!] && eventType !== 'payment.submitted') {
    return { status: 'succeeded', outcome: 'superseded', detail: `the payment is now ${submission.status}; this update is stale` };
  }

  let isAdvance = false;
  if (invoice.milestone_id) {
    const { data: milestone } = await admin
      .schema('projects')
      .from('milestones')
      .select('position')
      .eq('id', invoice.milestone_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    // The locked 30/20/30/20 plan numbers its milestones 1-4 (payment-structure.ts); the advance is position 1.
    isAdvance = milestone?.position === 1;
  }

  const ctx = await loadContext(admin, job.organization_id, invoice.project_id);
  if (ctx === 'unreadable') return { status: 'failed', permanent: false, detail: 'could not read the project' };
  if (ctx === 'gone') return { status: 'succeeded', outcome: 'gone', detail: 'the project no longer exists' };
  if (!ctx.conversationId) return noThread(admin, ctx, 'Payment update not sent');

  const body =
    eventType === 'payment.submitted'
      ? pmPaymentReceived(ctx.language)
      : eventType === 'payment.verified'
        ? isAdvance
          ? pmAdvanceVerified(ctx.language)
          : pmPaymentVerified(ctx.language, invoice.number)
        : pmPaymentNeedsAttention(ctx.language, invoice.number);

  return settle([
    {
      label: eventType!.replace('payment.', 'payment '),
      result: await sendSystemText(admin as never, {
        organizationId: job.organization_id,
        conversationId: ctx.conversationId,
        body,
        ref: `pm:payment:${eventType}:${submissionId}`,
      }),
    },
  ]);
}

/**
 * Which project a client's thread is about: the project's own group, or the
 * thread the deal was won on (its lead's opportunity's project). Null when the
 * thread belongs to no project.
 */
export async function projectForConversation(
  admin: Admin,
  organizationId: string,
  conversation: { kind: string; project_id: string | null; lead_id: string | null },
): Promise<string | null> {
  if (conversation.kind === 'project_group') return conversation.project_id;
  if (!conversation.lead_id) return null;
  const { data: opp } = await admin
    .schema('sales')
    .from('opportunities')
    .select('id')
    .eq('lead_id', conversation.lead_id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (!opp) return null;
  const { data: project } = await admin
    .schema('projects')
    .from('projects')
    .select('id')
    .eq('opportunity_id', opp.id)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();
  return project?.id ?? null;
}

// ── 4. the client's answer to the billing question ──────────────────────────

/**
 * Words a client uses to say which invoice they want. Deliberately narrow: a
 * short answer, no question mark, one clear side. Anything else is left for a
 * person, because billing mode is money and §4.1 says it must not be inferred.
 */
export function readBillingAnswer(text: string): 'gst' | 'non_gst' | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t || t.length > 140 || /[?？]/.test(t)) return null;
  const non = /\bnon[\s-]?gst\b|\bwithout gst\b|\bno gst\b|\bgst (nahi|nahin|nhi)\b|\bbina gst\b|गैर[\s-]?जीएसटी|बिना (gst|जीएसटी)/.test(t);
  const gst = /\bgst\b|जीएसटी/.test(t.replace(/\bnon[\s-]?gst\b|\bwithout gst\b|\bno gst\b|\bgst (nahi|nahin|nhi)\b|\bbina gst\b/g, ''));
  if (non && !gst) return 'non_gst';
  if (gst && !non) return 'gst';
  return null;
}

/**
 * `message.received` → if the client just answered the billing question, put
 * the answer in front of staff to confirm. This does NOT confirm the mode:
 * `finance.confirm_billing_mode` is a person's act on purpose (Finance §4.1 —
 * "an unattended process confirming a billing mode is an inference wearing a
 * record's clothes"). The PM's job here is to make that one click obvious.
 */
export async function handleReadBillingReply(admin: Admin, job: PmCommsJob): Promise<HandlerResult> {
  const messageId = subjectOf(job);
  if (!messageId) return { status: 'failed', permanent: true, detail: 'the event named no message' };

  const { data: message, error } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id, body, author_type, conversation_id')
    .eq('id', messageId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (error) return { status: 'failed', permanent: false, detail: `could not read the message: ${error.message}` };
  if (!message || message.author_type !== 'client' || !message.body) {
    return { status: 'succeeded', outcome: 'not_applicable', detail: 'not a client text message' };
  }

  const answer = readBillingAnswer(message.body);
  if (!answer) return { status: 'succeeded', outcome: 'no_answer', detail: 'not a clear GST / Non-GST answer' };

  // Which project is this thread about, and did we ask?
  const { data: conversation } = await admin
    .schema('crm')
    .from('conversations')
    .select('id, kind, project_id, lead_id')
    .eq('id', message.conversation_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (!conversation) return { status: 'succeeded', outcome: 'gone', detail: 'the conversation no longer exists' };

  const projectId = await projectForConversation(admin, job.organization_id, conversation);
  if (!projectId) return { status: 'succeeded', outcome: 'no_project', detail: 'this thread belongs to no project' };
  const { data: asked } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('external_ref', `pm:billing-question:${projectId}`)
    .maybeSingle();
  if (!asked) return { status: 'succeeded', outcome: 'not_asked', detail: 'the billing question has not been asked on this project' };

  const { data: profile } = await admin
    .schema('finance')
    .from('billing_profiles')
    .select('id')
    .eq('project_id', projectId)
    .eq('organization_id', job.organization_id)
    .eq('status', 'active')
    .maybeSingle();
  if (profile) return { status: 'succeeded', outcome: 'already_confirmed', detail: 'a billing mode is already confirmed' };

  const { data: project } = await admin
    .schema('projects')
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  const { error: alertError } = await admin.schema('core').rpc('raise_alert', {
    p_organization_id: job.organization_id,
    p_source: 'onboarding',
    p_severity: 'warning',
    p_summary: `${project?.name ?? 'A project'}: the client answered the billing question — "${answer === 'gst' ? 'GST invoice' : 'Non-GST invoice'}". Confirm it on the project page to raise the advance invoice.`,
    p_fingerprint: `billing-answer:${projectId}`,
  });
  if (alertError) return { status: 'failed', permanent: false, detail: `could not alert staff: ${alertError.message}` };
  return { status: 'succeeded', outcome: 'staff_alerted', detail: `the client answered ${answer}; staff were asked to confirm` };
}
