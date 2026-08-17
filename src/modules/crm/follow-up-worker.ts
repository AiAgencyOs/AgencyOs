import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { evaluate, type SuppressionReason } from './follow-up-contract';
import { nextSendAt, notBefore, spacingAfter, type Rhythm } from './follow-up-rhythms';
import { isRunnable, situationFor } from './follow-up-situations';

/**
 * The follow-up worker — gap G-012, decisions ADM-69, ADM-70 and ADM-81.
 *
 * Lives in `modules/crm` rather than beside the other sweeps in `lib/`,
 * because ARCHITECTURE §3.2 forbids `lib/` depending on `modules/` and this
 * needs the situation registry and the contract. The sweeps it sits beside in
 * the tick are `lib/` primitives that need no policy; this is policy.
 *
 * Run from the existing cron tick, beside the approval expiry and quotation
 * lapse sweeps. There is no second queue and no second scheduler: ADM-69's
 * work is the same shape as theirs, and a parallel subsystem would be a second
 * set of retry, tenancy and idempotency rules to keep in step.
 *
 * ── observe, revalidate, claim, send, record ─────────────────────────────
 *
 * Each step is separable and separately safe:
 *
 *   **observe**     `crm.observe_follow_up_candidates` finds subjects owed a
 *                   sequence. It never sends and never claims.
 *   **revalidate**  the subject is re-read here, because observation is not
 *                   authorization. A candidate that qualified thirty seconds
 *                   ago may have replied since.
 *   **claim**       the attempt row is INSERTed. The unique constraint is the
 *                   claim; a conflict means another worker owns this attempt
 *                   and this one exits without sending.
 *   **send**        through `crm.send_outbound_message`, never around it.
 *   **record**      the sequence advances, stops, or escalates.
 *
 * ── what this worker cannot do today, and says so ────────────────────────
 *
 * ADM-69's sending window needs a timezone. G-137: none is stored, and
 * `core.organizations.timezone` now exists but is **null by design** — an
 * agency's timezone is a real-world fact nobody has stated.
 *
 * So on a deployment that has not set one, every sequence is blocked with
 * `timezone_unavailable` and **nothing is sent**. That is the honest state
 * rather than a failure: the alternative is guessing an hour and messaging
 * clients at the wrong time in every deployment that never noticed.
 *
 * A block is not an attempt. A sequence blocked every minute would otherwise
 * exhaust ADM-69's seven attempts in seven minutes and escalate about a client
 * who ignored seven messages that were never sent.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type FollowUpOutcome = {
  started: number;
  sent: number;
  suppressed: number;
  blocked: number;
  escalated: number;
  failed: boolean;
};

const EMPTY: FollowUpOutcome = {
  started: 0, sent: 0, suppressed: 0, blocked: 0, escalated: 0, failed: false,
};

/** How many candidates and sequences one tick will look at. */
const BATCH = 50;

/**
 * The message.
 *
 * A placeholder, and named as one. ADM-11 permits AgencyOS to write follow-up
 * text without a human reading it first, and the agent infrastructure that
 * would write it is Phase 5 — so generating something here would either invent
 * an agent path or hardcode prose nobody approved. One neutral sentence that
 * states no price, promises no date and commits to nothing is the honest
 * placeholder until an agent writes it.
 */
const FOLLOW_UP_BODY = 'Following up on our last message.';

type Candidate = {
  organization_id: string;
  situation_key: string;
  subject_type: string;
  subject_id: string;
  conversation_id: string | null;
  triggered_at: string;
  contact_id: string | null;
};

type DueSequence = {
  sequence_id: string;
  organization_id: string;
  situation_key: string;
  subject_type: string;
  subject_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  triggered_at: string;
  attempts_sent: number;
  correlation_id: string;
};

/**
 * What the subject looks like *now*, rather than when it was observed.
 *
 * `missing` is its own answer rather than an error: a deleted subject is a
 * sequence that should stop, and treating it as a failure would retry it
 * forever.
 */
type SubjectState =
  | { present: false }
  | { present: true; stopConditions: string[]; stateChanged: boolean };

async function readSubject(
  admin: Admin,
  seq: Pick<DueSequence, 'organization_id' | 'subject_type' | 'subject_id' | 'situation_key'>,
): Promise<SubjectState> {
  const scoped = <T>(q: T) => q as T;
  void scoped;

  if (seq.subject_type === 'lead') {
    const { data } = await admin
      .schema('crm')
      .from('leads')
      .select('status, deleted_at')
      .eq('id', seq.subject_id)
      .eq('organization_id', seq.organization_id)
      .maybeSingle();
    if (!data || data.deleted_at) return { present: false };
    const stops: string[] = [];
    if (data.status === 'converted') stops.push('lead_converted');
    if (data.status === 'disqualified') stops.push('lead_lost', 'lead_closed');
    return { present: true, stopConditions: stops, stateChanged: false };
  }

  if (seq.subject_type === 'proposal') {
    const { data } = await admin
      .schema('sales')
      .from('proposals')
      .select('status, opportunity_id')
      .eq('id', seq.subject_id)
      .eq('organization_id', seq.organization_id)
      .maybeSingle();
    if (!data) return { present: false };
    const stops: string[] = [];
    if (data.status === 'accepted') stops.push('quotation_accepted');
    if (data.status === 'rejected') stops.push('quotation_rejected');
    if (data.status === 'lapsed') stops.push('quotation_lapsed');
    // A superseded quotation is not one of ADM-69's named stop conditions, and
    // it plainly ends the sequence — a newer version replaced what was asked.
    const superseded = data.status === 'superseded';

    const { data: deal } = await admin
      .schema('sales')
      .from('opportunities')
      .select('stage')
      .eq('id', data.opportunity_id)
      .eq('organization_id', seq.organization_id)
      .maybeSingle();
    if (deal && (deal.stage === 'won' || deal.stage === 'lost')) stops.push('deal_closed');

    return { present: true, stopConditions: stops, stateChanged: superseded };
  }

  if (seq.subject_type === 'approval_request') {
    const { data } = await admin
      .schema('approvals')
      .from('approval_requests')
      .select('state')
      .eq('id', seq.subject_id)
      .eq('organization_id', seq.organization_id)
      .maybeSingle();
    if (!data) return { present: false };
    const stops: string[] = [];
    if (data.state === 'approved') stops.push('approved');
    if (data.state === 'rejected') stops.push('rejected');
    if (data.state === 'cancelled') stops.push('cancelled');
    // Anything else terminal - expired, for one - ends the sequence too.
    // ADM-69: never send a reminder after the approval is terminal.
    const terminal = !['pending', 'approved', 'rejected', 'cancelled'].includes(data.state);
    return { present: true, stopConditions: stops, stateChanged: terminal };
  }

  if (seq.subject_type === 'project') {
    const { data } = await admin
      .schema('projects')
      .from('projects')
      .select('status, deleted_at')
      .eq('id', seq.subject_id)
      .eq('organization_id', seq.organization_id)
      .maybeSingle();
    if (!data || data.deleted_at) return { present: false };
    return { present: true, stopConditions: [], stateChanged: data.status !== 'completed' };
  }

  return { present: false };
}

/**
 * Whether the client replied after the sequence started.
 *
 * ADM-69's most important stop condition, and the one most easily got wrong:
 * "reply" means *inbound since day 0*, not "any message exists". Counting
 * outbound messages would make the sequence stop itself the moment it sent.
 */
async function hasReplied(
  admin: Admin,
  organizationId: string,
  conversationId: string | null,
  since: string,
): Promise<boolean> {
  if (!conversationId) return false;
  const { data } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('conversation_id', conversationId)
    .eq('author_type', 'client')
    .gt('occurred_at', since)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/** Recorded consent on WhatsApp for a contact. Absent and withdrawn are one answer. */
async function hasConsent(admin: Admin, organizationId: string, contactId: string | null) {
  if (!contactId) return false;
  const { data } = await admin
    .schema('crm')
    .from('communication_consent')
    .select('status')
    .eq('organization_id', organizationId)
    .eq('contact_id', contactId)
    .eq('channel', 'whatsapp')
    .maybeSingle();
  return data?.status === 'granted';
}

/** The agency timezone, or null. Never defaulted — see the module note. */
async function agencyTimeZone(admin: Admin, organizationId: string): Promise<string | null> {
  const { data } = await admin
    .schema('core')
    .from('organizations')
    .select('timezone')
    .eq('id', organizationId)
    .maybeSingle();
  return data?.timezone ?? null;
}

async function noteBlock(admin: Admin, sequenceId: string, reason: string) {
  await admin
    .schema('crm')
    .from('follow_up_sequences')
    .update({ last_evaluated_at: new Date().toISOString(), last_block_reason: reason })
    .eq('id', sequenceId);
}

/**
 * One tick of follow-up work.
 *
 * A failure never fails the tick, matching every other sweep: the runner's job
 * is to move work, and a follow-up a minute late is a far smaller problem than
 * a job queue that stopped.
 */
export async function runFollowUps(admin: Admin): Promise<FollowUpOutcome> {
  const outcome: FollowUpOutcome = { ...EMPTY };

  // ── observe, and start what is owed ────────────────────────────────────
  const { data: candidates, error: observeError } = await admin
    .schema('crm')
    .rpc('observe_follow_up_candidates', { p_limit: BATCH });

  if (observeError) {
    console.error(JSON.stringify({ level: 'error', scope: 'followUpObserve', detail: observeError.message }));
    outcome.failed = true;
  }

  for (const candidate of (candidates ?? []) as Candidate[]) {
    const situation = situationFor(candidate.situation_key);
    // The observer only returns runnable situations, and this is checked again
    // rather than trusted: a query is easier to change than a decision, and
    // ADM-69's deferred payment situation must not start a sequence because
    // somebody widened a `where` clause.
    if (!situation || !isRunnable(situation)) continue;

    const { data, error } = await admin.schema('crm').rpc('start_follow_up_sequence', {
      p_organization_id: candidate.organization_id,
      p_situation_key: candidate.situation_key,
      p_subject_type: candidate.subject_type,
      p_subject_id: candidate.subject_id,
      p_triggered_at: candidate.triggered_at,
      ...(candidate.conversation_id ? { p_conversation_id: candidate.conversation_id } : {}),
      // Carried through rather than dropped. Without it a situation with no
      // conversation - post-project - can never have its consent checked, and
      // blocks as `no_consent` forever against a contact who granted it.
      ...(candidate.contact_id ? { p_contact_id: candidate.contact_id } : {}),
    });
    if (error) {
      console.error(JSON.stringify({ level: 'error', scope: 'followUpStart', detail: error.message }));
      outcome.failed = true;
      continue;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { sequence_id: string; created: boolean } | undefined;
    if (!row?.sequence_id) continue;
    if (row.created) {
      outcome.started += 1;
      // The first attempt's due time, computed once from day 0.
      const zone = await agencyTimeZone(admin, candidate.organization_id);
      if (zone) {
        const due = nextSendAt({
          triggeredAt: new Date(candidate.triggered_at),
          rhythm: situation.rhythm as Rhythm,
          attemptsSoFar: 0,
          timeZone: zone,
        });
        if (due) {
          await admin.schema('crm').from('follow_up_sequences')
            .update({ next_due_at: due.toISOString() }).eq('id', row.sequence_id);
        }
      } else {
        await noteBlock(admin, row.sequence_id, 'timezone_unavailable');
        outcome.blocked += 1;
      }
    }
  }

  // ── schedule what a missing timezone left unscheduled ──────────────────
  //
  // A sequence created while the agency had no timezone was started but left
  // with next_due_at NULL: without a zone the first due time cannot be computed
  // (the business-day count and the sending hour both need it), and a block is
  // not an attempt. Nothing ever filled it in afterward — the observer will not
  // re-create it (one sequence per subject, forever), the due loop below
  // excludes a null next_due_at, and so does wedged_follow_ups. So an owner who
  // enabled follow-ups before setting a timezone — the by-design default until
  // G-137 — would have every sequence started in that window stay silent
  // FOREVER, even after the timezone was finally set.
  //
  // Schedule them here, once a zone exists, from their own triggered_at and
  // attempts_sent — the same computation the creation branch does — so they
  // enter the due loop and send at the RIGHT time, not immediately (the day-0
  // arithmetic still applies, and recordSent's floor keeps the catch-up from
  // flooding). This runs after creation, so a sequence started this tick WITH a
  // zone is already scheduled and skipped; an exhausted sequence computes a null
  // next time and is left alone.
  const { data: unscheduled, error: unschedError } = await admin
    .schema('crm')
    .from('follow_up_sequences')
    .select('id, organization_id, situation_key, triggered_at, attempts_sent')
    .eq('status', 'active')
    .is('next_due_at', null)
    .limit(BATCH);

  if (unschedError) {
    console.error(JSON.stringify({ level: 'error', scope: 'followUpSchedule', detail: unschedError.message }));
    outcome.failed = true;
  }

  for (const seq of unscheduled ?? []) {
    const situation = situationFor(seq.situation_key);
    if (!situation) continue;
    const zone = await agencyTimeZone(admin, seq.organization_id);
    if (!zone) {
      // Still no timezone. Re-record the block so last_evaluated_at stays fresh
      // — the worker is looking, it just cannot schedule yet.
      await noteBlock(admin, seq.id, 'timezone_unavailable');
      continue;
    }
    const due = nextSendAt({
      triggeredAt: new Date(seq.triggered_at),
      rhythm: situation.rhythm as Rhythm,
      attemptsSoFar: seq.attempts_sent,
      timeZone: zone,
    });
    if (due) {
      await admin.schema('crm').from('follow_up_sequences')
        .update({ next_due_at: due.toISOString(), last_block_reason: null }).eq('id', seq.id);
    }
  }

  // ── advance what is due ────────────────────────────────────────────────
  const { data: due, error: dueError } = await admin
    .schema('crm')
    .rpc('due_follow_up_sequences', { p_limit: BATCH });

  if (dueError) {
    console.error(JSON.stringify({ level: 'error', scope: 'followUpDue', detail: dueError.message }));
    return { ...outcome, failed: true };
  }

  for (const seq of (due ?? []) as DueSequence[]) {
    const situation = situationFor(seq.situation_key);
    if (!situation || !isRunnable(situation)) {
      await noteBlock(admin, seq.sequence_id, 'situation_not_automated');
      outcome.blocked += 1;
      continue;
    }

    // ── the timezone, which today is usually absent ────────────────────
    const zone = await agencyTimeZone(admin, seq.organization_id);
    if (!zone) {
      await noteBlock(admin, seq.sequence_id, 'timezone_unavailable');
      outcome.blocked += 1;
      continue;
    }

    // ── revalidate: observation is not authorization ───────────────────
    const subject = await readSubject(admin, seq);
    if (!subject.present) {
      await stop(admin, seq.sequence_id, 'subject no longer exists');
      outcome.blocked += 1;
      continue;
    }

    const replied = await hasReplied(admin, seq.organization_id, seq.conversation_id, seq.triggered_at);
    const stops = [...subject.stopConditions];
    if (replied) stops.push('reply', 'response');

    // The contact the observer identified, falling back to the conversation's
    // for sequences started before that column existed.
    const contactId = seq.contact_id ?? (await contactFor(admin, seq));
    const consent =
      situation.audience === 'internal'
        ? true
        : await hasConsent(admin, seq.organization_id, contactId);

    const slaDueAt =
      seq.situation_key === 'pending_approval'
        ? await approvalSla(admin, seq.organization_id, seq.subject_id)
        : null;

    const decision = evaluate({
      situationKey: seq.situation_key,
      triggeredAt: new Date(seq.triggered_at),
      attemptsSoFar: seq.attempts_sent,
      timeZone: zone,
      hasConsent: consent,
      optedOut: false,
      stopConditionsMet: stops,
      stateChanged: subject.stateChanged,
      slaDueAt,
      now: new Date(),
    });

    if (!decision.send) {
      await handleRefusal(admin, seq, decision.reason, outcome);
      continue;
    }

    // ── resolve where the message would go, BEFORE anything is claimed ──
    //
    // An internal situation resolves the internal group the way the announcer
    // does — the observer deliberately selects no conversation for it. This
    // happens before the claim so that an unresolvable destination spends no
    // attempt, and the three outcomes are three different facts:
    //
    //   read failed    → block and retry: a read that failed is not a group
    //                    that is absent (the announcer's own rule, dropped by
    //                    the first version of this code and caught in review)
    //   no group       → block and retry: an organization that links its
    //                    group tomorrow gets reminders for approvals already
    //                    pending today — a permanent stop here would deny it
    //                    forever, silently
    //   post_project   → resolve-or-create the client_account thread (G-139):
    //                    a completed project's account outlives its leads, so
    //                    it sends on the relationship channel rather than stops
    //   no conversation
    //   (other,
    //   client-facing) → stop with the reason, without consuming an attempt
    let conversationId = seq.conversation_id;
    if (!conversationId && situation.audience === 'internal') {
      const group = await internalGroupFor(admin, seq.organization_id);
      if (group.readFailed) {
        await noteBlock(admin, seq.sequence_id, 'internal_group_unreadable');
        outcome.blocked += 1;
        continue;
      }
      if (!group.id) {
        await noteBlock(admin, seq.sequence_id, 'no_internal_group');
        outcome.blocked += 1;
        continue;
      }
      conversationId = group.id;
    }
    if (!conversationId && seq.situation_key === 'post_project') {
      // G-139: the post-project rhythm has no lead thread — a completed
      // project's client account outlives its leads. Resolve-or-create the one
      // client_account thread for the account (the relationship channel) and
      // send on it. Read/creation failures block and retry rather than stop,
      // the internal-group rule again: a transient failure is not an absence.
      const thread = await clientAccountThreadFor(admin, seq);
      if (thread.readFailed) {
        await noteBlock(admin, seq.sequence_id, 'client_account_unreadable');
        outcome.blocked += 1;
        continue;
      }
      if (!thread.id) {
        await noteBlock(admin, seq.sequence_id, 'no_client_account');
        outcome.blocked += 1;
        continue;
      }
      conversationId = thread.id;
    }
    if (!conversationId) {
      await stop(admin, seq.sequence_id, 'no_conversation');
      outcome.blocked += 1;
      continue;
    }


    // ── claim: the INSERT is the claim ─────────────────────────────────
    const { error: claimError } = await admin.schema('crm').from('follow_up_sends').insert({
      organization_id: seq.organization_id,
      sequence_id: seq.sequence_id,
      attempt: decision.attempt,
      outcome: 'sent',
      scheduled_for: decision.at.toISOString(),
    });

    if (claimError) {
      const conflict = /duplicate key|unique/i.test(claimError.message);
      if (!conflict) {
        console.error(JSON.stringify({ level: 'error', scope: 'followUpClaim', detail: claimError.message }));
        outcome.failed = true;
        continue;
      }

      // A conflict usually means another worker owns this attempt. But it has
      // a second cause, found by driving exhaustion through the worker: **our
      // own earlier row**, from a run that claimed and then crashed - or
      // failed - before recording the result. The sequence's counter never
      // advanced, so every later tick recomputes the same attempt number,
      // loses to the old row, and the sequence wedges silently forever.
      //
      // So a conflict is reconciled rather than skipped: if the winning row is
      // `sent` but the sequence has not recorded it, the attempt is *finished*
      // here - which is exactly the crash-after-claim recovery the failure
      // semantics require. The crash can land anywhere in the claim→send→emit
      // window, so the record step alone is not enough: a run that claimed and
      // then died before (or partway through) the send left a `sent` row and no
      // message, and recording it without re-driving the send would advance the
      // counter past an attempt that never went out - silently dropping it.
      //
      // So re-drive the send first. It is idempotent on the derived
      // external_ref: an attempt whose message WAS created finds `already_sent`
      // and the dispatch keys on the event, so a genuinely dropped attempt is
      // delivered while an already-delivered one is never sent twice. Only then
      // record it. This is the re-emit the failure semantics require - now
      // actually performed rather than only asserted.
      const { data: winner } = await admin
        .schema('crm')
        .from('follow_up_sends')
        .select('outcome')
        .eq('sequence_id', seq.sequence_id)
        .eq('attempt', decision.attempt)
        .maybeSingle();

      if (winner?.outcome === 'sent' && seq.attempts_sent < decision.attempt) {
        const resent = await sendAttempt(admin, { ...seq, conversation_id: conversationId }, decision.attempt);
        if (!resent.ok) {
          if (resent.permanent) {
            // A destination that can never deliver - the same terminal state
            // the main path stops on, reached here through the orphan row.
            await admin.schema('crm').from('follow_up_sends')
              .update({ outcome: 'failed' })
              .eq('sequence_id', seq.sequence_id).eq('attempt', decision.attempt);
            await stop(admin, seq.sequence_id, resent.reason);
            outcome.suppressed += 1;
          }
          // Transient: leave the claim row and let the next tick reconcile
          // again - the same retry-until-it-lands the main path gives a
          // released claim, without a double-send (the message is deduped).
          continue;
        }
        await recordSent(admin, seq, situation.rhythm as Rhythm, decision.attempt, zone, slaDueAt, outcome);
      }
      continue;
    }

    // ── send, through the chokepoint and never around it ───────────────
    //
    // The scheduler has decided the attempt is due. Whether the message is
    // *permitted* is the communication layer's, and G-135 put that in
    // `send_outbound_message` where every caller passes through it.
    const sent = await sendAttempt(admin, { ...seq, conversation_id: conversationId }, decision.attempt);
    if (!sent.ok) {
      if (sent.permanent) {
        // No conversation, or one that no longer exists. Retrying cannot
        // change either, and leaving the sequence active would wedge it: the
        // claim row survives, the counter never advances, and every later
        // tick loses the conflict to this row in silence. A sequence that can
        // never deliver stops, and says why.
        await admin.schema('crm').from('follow_up_sends')
          .update({ outcome: 'failed' })
          .eq('sequence_id', seq.sequence_id).eq('attempt', decision.attempt);
        await stop(admin, seq.sequence_id, sent.reason);
        outcome.suppressed += 1;
        continue;
      }

      // Transient. The claim is released so the next tick can retry the same
      // attempt number - and releasing it is safe from double-send, because
      // the message itself is deduped on the derived external_ref: a re-claim
      // that re-sends finds `already_sent`. Keeping the row instead is the
      // wedge described above.
      await admin.schema('crm').from('follow_up_sends')
        .delete()
        .eq('sequence_id', seq.sequence_id).eq('attempt', decision.attempt);
      await noteBlock(admin, seq.sequence_id, sent.reason);
      outcome.suppressed += 1;
      continue;
    }

    await recordSent(admin, seq, situation.rhythm as Rhythm, decision.attempt, zone, slaDueAt, outcome);
  }

  return outcome;
}

/**
 * The record step, after a successful send: advance the counter, schedule the
 * next attempt, escalate on exhaustion.
 *
 * Extracted because it has two callers with one meaning: the worker that just
 * sent, and the conflict-reconciliation path that finishes the bookkeeping for
 * a run that crashed between the claim and this step.
 */
async function recordSent(
  admin: Admin,
  seq: DueSequence,
  rhythm: Rhythm,
  attempt: number,
  zone: string,
  slaDueAt: Date | null,
  outcome: FollowUpOutcome,
): Promise<void> {
  {
    outcome.sent += 1;
    const sentAt = new Date();

    // The absolute schedule ADM-69 records, from day 0.
    const scheduled = nextSendAt({
      triggeredAt: new Date(seq.triggered_at),
      rhythm,
      attemptsSoFar: attempt,
      timeZone: zone,
      slaDueAt,
    });

    // …floored at the same spacing after the message that was *actually* sent.
    //
    // Found by running the worker twice against a real database: a sequence
    // triggered forty days ago has every attempt overdue at once, so each tick
    // sent the next one and seven messages went out in seven minutes. ADM-69's
    // "spacing 7 business days" plainly does not mean that. This uses the
    // intervals ADM-69 already states and only ever makes a follow-up later.
    const floor = notBefore(sentAt, spacingAfter(rhythm, attempt), zone);
    const nextDue =
      scheduled === null ? null : new Date(Math.max(scheduled.getTime(), floor.getTime()));

    await admin.schema('crm').from('follow_up_sequences').update({
      attempts_sent: attempt,
      last_sent_at: sentAt.toISOString(),
      last_evaluated_at: new Date().toISOString(),
      last_block_reason: null,
      next_due_at: nextDue ? nextDue.toISOString() : null,
    }).eq('id', seq.sequence_id);

    if (!nextDue) {
      if (await escalate(admin, seq.sequence_id)) outcome.escalated += 1;
    }
  }
}

/**
 * The organization's internal WhatsApp group.
 *
 * The same lookup the approval announcer performs — including its error
 * branch, which the first version of this function dropped and the review
 * caught: a read that failed is not a group that is absent. Collapsing the
 * two turned one transient blip into a permanent `no_conversation` stop, and
 * a stopped sequence can never resume, so a single read error silently killed
 * ADM-69's Internal-Approval rhythm for that approval forever.
 */
async function internalGroupFor(
  admin: Admin,
  organizationId: string,
): Promise<{ id: string | null; readFailed: boolean }> {
  const { data, error } = await admin
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('kind', 'internal_group')
    .neq('status', 'abandoned')
    .maybeSingle();
  if (error) return { id: null, readFailed: true };
  return { id: data?.id ?? null, readFailed: false };
}

/**
 * Resolve-or-create the client_account thread a post-project sequence sends on
 * (G-139). Delegates to `crm.ensure_client_account_conversation`, which derives
 * the account from the project row and is idempotent (one thread per account).
 * A read/RPC error is a transient failure, not an absent account — the caller
 * blocks and retries rather than stopping, the internal-group rule again.
 */
async function clientAccountThreadFor(
  admin: Admin,
  seq: DueSequence,
): Promise<{ id: string | null; readFailed: boolean }> {
  const { data, error } = await admin
    .schema('crm')
    .rpc('ensure_client_account_conversation', {
      p_project_id: seq.subject_id,
      p_contact_id: seq.contact_id ?? undefined,
    });
  if (error) return { id: null, readFailed: true };
  return { id: typeof data === 'string' ? data : (data ?? null), readFailed: false };
}

async function contactFor(admin: Admin, seq: DueSequence): Promise<string | null> {
  if (!seq.conversation_id) return null;
  const { data } = await admin
    .schema('crm')
    .from('conversations')
    .select('contact_id')
    .eq('id', seq.conversation_id)
    .eq('organization_id', seq.organization_id)
    .maybeSingle();
  return data?.contact_id ?? null;
}

async function approvalSla(admin: Admin, organizationId: string, requestId: string): Promise<Date | null> {
  const { data } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('sla_due_at')
    .eq('id', requestId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data?.sla_due_at ? new Date(data.sla_due_at) : null;
}

/**
 * What a refusal does to the sequence.
 *
 * The distinction that matters: a refusal that will never change ends the
 * sequence, and one that might resolve leaves it alone. `outside_sending_window`
 * is the second kind — the job simply ran early.
 */
async function handleRefusal(
  admin: Admin,
  seq: DueSequence,
  reason: SuppressionReason,
  outcome: FollowUpOutcome,
): Promise<void> {
  if (reason === 'rhythm_exhausted') {
    if (await escalate(admin, seq.sequence_id)) outcome.escalated += 1;
    return;
  }

  if (reason === 'stop_condition_met' || reason === 'state_changed') {
    await stop(admin, seq.sequence_id, reason);
    outcome.blocked += 1;
    return;
  }

  // Everything else is a block: recorded, no attempt consumed, tried again
  // next tick. Consent can be granted, a window closes and reopens.
  await noteBlock(admin, seq.sequence_id, reason);
  outcome.blocked += 1;
}

async function stop(admin: Admin, sequenceId: string, reason: string): Promise<void> {
  await admin.schema('crm').from('follow_up_sequences').update({
    status: 'stopped',
    stop_reason: reason,
    next_due_at: null,
    last_evaluated_at: new Date().toISOString(),
  }).eq('id', sequenceId).eq('status', 'active');
}

async function escalate(admin: Admin, sequenceId: string): Promise<boolean> {
  const { data, error } = await admin
    .schema('crm')
    .rpc('escalate_follow_up_sequence', { p_sequence_id: sequenceId, p_reason: 'rhythm exhausted' });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'followUpEscalate', detail: error.message }));
    return false;
  }
  // True only for the worker that actually moved the row, so two workers
  // produce one escalation and only one of them acts on it.
  return data === true;
}

type SendResult = { ok: true } | { ok: false; reason: string; permanent: boolean };

/**
 * The send, through the chokepoint.
 *
 * `external_ref` is the message-level dedupe key and is derived rather than
 * random: the same sequence and attempt always produce the same reference, so
 * a retry after a crash between the claim and the send finds the existing
 * message instead of writing a second one.
 */
async function sendAttempt(admin: Admin, seq: DueSequence, attempt: number): Promise<SendResult> {
  if (!seq.conversation_id) {
    return { ok: false, reason: 'no_conversation', permanent: true };
  }

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: seq.conversation_id,
    p_body: FOLLOW_UP_BODY,
    p_external_ref: `followup:${seq.sequence_id}:${attempt}`,
  });

  if (error) return { ok: false, reason: 'send_error', permanent: false };

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  if (row?.outcome === 'created' || row?.outcome === 'already_sent') {
    // The message exists and is `pending`. Handing it to the provider is a
    // separate job so the delivery inherits the runner's retry budget, backoff
    // and parking — a worker running in the cron tick has none of those, and
    // calling the provider inline would lose a follow-up to a transient blip
    // or grow a second retry subsystem for the same problem.
    //
    // Emitted rather than enqueued directly: the dispatcher keys the job on
    // the event, so a crash between the emit and the enqueue re-enqueues
    // nothing extra.
    const { error: emitError } = await admin.schema('core').rpc('emit_event', {
      p_organization_id: seq.organization_id,
      p_type: 'followup.queued',
      p_subject_type: 'follow_up_send',
      p_subject_id: seq.sequence_id,
      p_payload: {
        conversationId: seq.conversation_id,
        externalRef: `followup:${seq.sequence_id}:${attempt}`,
        body: FOLLOW_UP_BODY,
      },
      p_correlation_id: seq.correlation_id,
    });
    if (emitError) {
      // The message row exists but nothing will deliver it. Retryable rather
      // than silent: the next tick re-evaluates, and the derived external_ref
      // means a second `send_outbound_message` finds the same message.
      return { ok: false, reason: 'emit_failed', permanent: false };
    }
    return { ok: true };
  }
  if (row?.outcome === 'no_consent') return { ok: false, reason: 'no_consent', permanent: false };
  return { ok: false, reason: row?.outcome ?? 'unknown', permanent: true };
}
