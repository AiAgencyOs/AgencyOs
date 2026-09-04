import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { resolveTemplateParameters, type ParameterSubject } from './template-parameters';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * How a message may leave, decided in one place — G-214.
 *
 * ── why one place ─────────────────────────────────────────────────────────
 *
 * G-213 taught `deliverFollowUp` about WhatsApp's 24-hour window and taught
 * nothing else. Nine other send sites went on handing free text to Meta with
 * no idea whether it would be carried, and two of them had already failed in
 * production: the approval announcement to the owner's own WhatsApp (ADM-95
 * made the internal channel a PERSON, so the window governs it), and the
 * approved quotation, which is dispatched hours or days after the client last
 * wrote and is therefore almost always outside it.
 *
 * A rule held in one caller is a rule the next caller does not know about.
 * This module is the rule; the callers ask it.
 *
 * ── what it will not do ───────────────────────────────────────────────────
 *
 * It never invents a way through. There is no path here that sends free text
 * outside the window, because Meta does not carry one — the choice outside
 * the window is an approved template or waiting, and waiting is a real
 * answer rather than a failure.
 */

/**
 * The four states the database tells apart, plus the one only a caller sees.
 *
 * `unreadable` is not a window state — it is the absence of one. It is here
 * so a caller cannot accidentally treat a failed read as a shut window, which
 * would turn a database blip into a policy about a client.
 */
export type WindowState = 'open' | 'closed' | 'never' | 'group' | 'unreadable';

export type OutboundPlan =
  /** Free text is carried: inside the window, or a group, where it does not apply. */
  | { mode: 'text'; window: WindowState }
  /** Outside the window, and an approved template answers this situation. */
  | {
      mode: 'template';
      window: WindowState;
      template: {
        /** Recorded on the message, so performance can be read from the transcript. */
        id: string;
        name: string;
        language: string;
        parameters: readonly string[];
        /** False when this is the English fallback rather than their own language. */
        matchedLanguage: boolean;
      };
      /** Why a template rather than the wording — recorded wherever this lands. */
      reason: string;
    }
  /**
   * Outside the window with nothing approved to say, or held by a limit. The
   * job waits — for a reply, or until `until` when a clock clears the
   * obstacle rather than a person (G-216).
   */
  | { mode: 'defer'; window: WindowState; reason: string; until?: Date }
  /** Nothing is known. Not a decision — a retry, so a blip never becomes a policy. */
  | { mode: 'retry'; window: 'unreadable'; reason: string };

/**
 * The window, read from our own transcript.
 *
 * A failed read answers `unreadable` rather than `closed`. The difference
 * matters: `closed` is a fact about a client and leads to a template or a
 * wait, while `unreadable` is a fact about a database and leads to trying
 * again. Collapsing them would turn a five-second outage into a message
 * nobody sends (G-054).
 */
export async function readWindowState(admin: Admin, conversationId: string): Promise<WindowState> {
  const { data, error } = await admin.schema('crm').rpc('window_state', {
    p_conversation_id: conversationId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'readWindowState', detail: error.message }));
    return 'unreadable';
  }

  const state = Array.isArray(data) ? data[0] : data;
  return state === 'open' || state === 'closed' || state === 'never' || state === 'group'
    ? state
    : 'unreadable';
}

/**
 * Whether this job has already told the counterpart something.
 *
 * A deferred job wakes and runs again. Without this it would send its
 * notification template a second time — the client hears twice about one
 * quotation, which is the spam this system exists not to be.
 */
async function alreadyNotified(admin: Admin, jobId: string): Promise<boolean | null> {
  const { data, error } = await admin
    .schema('crm')
    .from('deferred_sends')
    .select('id')
    .eq('job_id', jobId)
    .limit(1);

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'alreadyNotified', detail: error.message }));
    return null;
  }
  return (data ?? []).length > 0;
}

/**
 * The approved template for a situation, in this organization.
 *
 * The organization filter is load-bearing: this runs on the service-role
 * client, which bypasses RLS, so without it one agency sends another
 * agency's approved template to its own client. A live section caught
 * exactly that before it shipped.
 */
async function approvedTemplate(
  admin: Admin,
  organizationId: string,
  situationKey: string,
  conversationId: string,
): Promise<
  | { id: string; name: string; language: string; parameters: string[]; matchedLanguage: boolean }
  | null
  | 'unreadable'
> {
  if (!situationKey) return null;

  /**
   * Chosen in the database, not here — G-217.
   *
   * The choice is a rule with three tiers (their language, then English as
   * this deployment's shared fallback, then oldest so the answer is stable),
   * and it needs the contact's `preferred_language`, which is a join away
   * from the conversation. Doing it in SQL keeps the rule in one place and
   * keeps the ORGANIZATION FILTER inside the function that runs as definer —
   * the filter that is the only thing between two agencies on a client that
   * bypasses RLS.
   */
  const { data, error } = await admin.schema('crm').rpc('template_for', {
    p_organization_id: organizationId,
    p_situation_key: situationKey,
    p_conversation_id: conversationId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'approvedTemplate', detail: error.message }));
    return 'unreadable';
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        template_id: string;
        template_name: string;
        language_code: string;
        parameters: string[] | null;
        matched_language: boolean | null;
      }
    | undefined;
  if (!row) return null;

  return {
    id: row.template_id,
    name: row.template_name,
    language: row.language_code,
    parameters: row.parameters ?? [],
    matchedLanguage: row.matched_language === true,
  };
}

export type PlanInput = {
  organizationId: string;
  conversationId: string;
  /** Which registered situation answers this send. '' means none is defined. */
  situationKey: string;
  /**
   * The job this send belongs to, when there is one. Given, a shut window can
   * park the job and wake it on the counterpart's reply; withheld, the only
   * answers are text, template or defer-without-a-job, and the caller decides.
   */
  jobId?: string | null;
  /**
   * What this send is ABOUT, for the template variables that need it — G-215.
   *
   * A template declaring `quotation_reference` on a send that names no
   * quotation cannot be filled, and is refused rather than filled with a
   * guess.
   */
  subject?: ParameterSubject;
};

export async function planOutbound(admin: Admin, input: PlanInput): Promise<OutboundPlan> {
  const window = await readWindowState(admin, input.conversationId);

  if (window === 'unreadable') {
    return { mode: 'retry', window, reason: 'the 24-hour window could not be read' };
  }

  // A group has no counterpart and no window. Meta refuses these for other
  // reasons on this WABA (#131215), which is a different problem with a
  // different answer, and not this module's to decide.
  if (window === 'group' || window === 'open') {
    return { mode: 'text', window };
  }

  /**
   * How often is too often — G-216.
   *
   * Asked HERE and nowhere else, because here is where a message stops being
   * an answer and starts being outreach. Inside the window we are replying to
   * somebody who just wrote and no limit applies; outside it every message is
   * one the agency started, and twelve hundred historical leads are all
   * outside it.
   */
  const allowance = await outreachAllowance(admin, input.conversationId);

  if (allowance === 'unreadable') {
    return { mode: 'retry', window: 'unreadable', reason: 'the outreach limits could not be read' };
  }

  if (allowance !== 'ok') {
    return {
      mode: 'defer',
      window,
      reason: LIMIT_REASONS[allowance] ?? `outreach is limited right now (${allowance})`,
      // A clock clears a rate, so the wait is until the clock rather than
      // until they write. A cooldown is measured in days and gets one too.
      until: LIMIT_CLEARS_AT[allowance]?.(),
    };
  }

  const template = await approvedTemplate(
    admin,
    input.organizationId,
    input.situationKey,
    input.conversationId,
  );
  if (template === 'unreadable') {
    return { mode: 'retry', window: 'unreadable', reason: 'the approved templates could not be read' };
  }

  if (template) {
    // Told once. A job that already sent its template and is running again
    // after a wake has nothing new to say and everything still to deliver.
    const notified = input.jobId ? await alreadyNotified(admin, input.jobId) : false;
    if (notified === null) {
      return { mode: 'retry', window: 'unreadable', reason: 'the deferred sends could not be read' };
    }
    if (!notified) {
      /**
       * Every variable filled, or none of it goes — G-215.
       *
       * The registry holds NAMES; Meta needs values, in order. There is no
       * fallback here on purpose: "Hi there" in place of a name is a sentence
       * the agency did not write, and the name itself — "Hi first_name" — is
       * worse. A template that cannot be filled is not sent, and the reason
       * says which fact was missing so somebody can fix it.
       */
      const filled = await resolveTemplateParameters(admin, {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        names: template.parameters,
        subject: input.subject,
      });

      if (!filled.ok && 'unreadable' in filled) {
        return { mode: 'retry', window: 'unreadable', reason: filled.detail };
      }

      if (filled.ok) {
        return {
          mode: 'template',
          window,
          template: { ...template, parameters: filled.values },
          reason:
            window === 'never'
              ? `the contact has never written, so the approved template ${template.name} goes instead`
              : `the 24-hour window has shut, so the approved template ${template.name} goes instead`,
        };
      }

      return {
        mode: 'defer',
        window,
        reason: `the approved template ${template.name} needs ${filled.missing.join(', ')}, which this send has no value for`,
      };
    }
  }

  const shut = window === 'never'
    ? 'the contact has never written, so WhatsApp carries nothing but an approved template'
    : 'the 24-hour window has shut, so WhatsApp carries nothing but an approved template';

  return {
    mode: 'defer',
    window,
    reason: template
      ? `${shut}; the approved template was already sent and the rest waits for a reply`
      : `${shut}, and none is registered for ${input.situationKey || 'this situation'}`,
  };
}

/**
 * Which limit refused, if one did — G-216.
 *
 * A reason rather than a boolean, because a person reading a held send needs
 * to know which number to change.
 */
export type OutreachAllowance =
  | 'ok'
  | 'per_contact_per_day'
  | 'per_contact_per_week'
  | 'per_organization_per_day'
  | 'cooldown'
  | 'no_conversation'
  | 'unreadable';

const LIMIT_REASONS: Readonly<Record<string, string>> = {
  per_contact_per_day: 'this contact has already been messaged today',
  per_contact_per_week: 'this contact has had this week’s messages already',
  per_organization_per_day: 'this organization has sent its day’s outreach',
  cooldown: 'this contact has not answered the last few messages, so outreach is paused',
  no_conversation: 'the conversation could not be found',
};

/**
 * When the obstacle clears, for the ones a clock clears.
 *
 * Deliberately generous — tomorrow rather than "in 23 hours 12 minutes" —
 * because the point is to stop, not to resume at the first legal instant. A
 * cooldown has no entry at all: it is measured in days and the client's own
 * reply is the thing that should end it.
 */
const LIMIT_CLEARS_AT: Readonly<Record<string, () => Date>> = {
  per_contact_per_day: () => new Date(Date.now() + 24 * 3_600_000),
  per_organization_per_day: () => new Date(Date.now() + 24 * 3_600_000),
  per_contact_per_week: () => new Date(Date.now() + 7 * 24 * 3_600_000),
};

export async function outreachAllowance(
  admin: Admin,
  conversationId: string,
): Promise<OutreachAllowance> {
  const { data, error } = await admin.schema('crm').rpc('outreach_allowance', {
    p_conversation_id: conversationId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'outreachAllowance', detail: error.message }));
    return 'unreadable';
  }

  const answer = Array.isArray(data) ? data[0] : data;
  return typeof answer === 'string' ? (answer as OutreachAllowance) : 'unreadable';
}

/**
 * Park a job until its counterpart writes.
 *
 * Answers whether the parking actually happened: a group, another tenant's
 * conversation or a job that no longer exists cannot be parked, and a caller
 * that assumed it could would leave a client waiting on nothing.
 */
export async function deferSend(
  admin: Admin,
  input: { jobId: string; conversationId: string; reason: string; until?: Date },
): Promise<'deferred' | 'no_job' | 'wrong_tenant' | 'no_counterpart' | 'unreadable'> {
  const { data, error } = await admin.schema('crm').rpc('defer_send', {
    p_job_id: input.jobId,
    p_conversation_id: input.conversationId,
    p_reason: input.reason,
    ...(input.until ? { p_until: input.until.toISOString() } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'deferSend', detail: error.message }));
    return 'unreadable';
  }

  const outcome = Array.isArray(data) ? data[0] : data;
  return outcome === 'deferred' || outcome === 'no_job' || outcome === 'wrong_tenant' || outcome === 'no_counterpart'
    ? outcome
    : 'unreadable';
}

/**
 * Records that a message was one the agency started — G-216.
 *
 * Written at send time because the window at that moment is what makes it
 * outreach rather than an answer, and that is not recoverable afterwards. A
 * failure is logged and not raised: a message that went must not be undone
 * because its bookkeeping did not.
 */
export async function markAsOutreach(
  admin: Admin,
  messageId: string,
  templateId?: string,
): Promise<void> {
  const { error } = await admin.schema('crm').rpc('mark_message_as_outreach', {
    p_message_id: messageId,
    // G-217: which approved template carried it. Without this nothing can say
    // which templates work, and "which one did those four hundred people
    // receive" has no answer at all.
    ...(templateId ? { p_template_id: templateId } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'markAsOutreach', messageId, detail: error.message }));
  }
}

/** Everything waiting on this number becomes runnable, because they just wrote. */
export async function wakeDeferredSends(
  admin: Admin,
  input: { organizationId: string; phone: string },
): Promise<number> {
  const { data, error } = await admin.schema('crm').rpc('wake_deferred_sends', {
    p_organization_id: input.organizationId,
    p_digits: input.phone,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'wakeDeferredSends', detail: error.message }));
    return 0;
  }
  const woken = Array.isArray(data) ? data[0] : data;
  return typeof woken === 'number' ? woken : 0;
}
