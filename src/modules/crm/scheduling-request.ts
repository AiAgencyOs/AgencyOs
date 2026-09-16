import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

/**
 * Reading a client's message for a scheduling request — Scheduler §3.1, §3.3,
 * §4.1–§4.3, and gap G-249.
 *
 * `crm.request_meeting` (G-248) gave the Scheduler the door it had been
 * missing, and left one question open on purpose: *who decides that a client
 * asked?* Until this, the answer was "a person noticed". A client writing
 * **"kal 4 baje call kar sakte hain?"** produced a message, an intent label and
 * a requirement extraction, and no meeting — somebody had to read it and click.
 *
 * Pure: no database, no clock of its own, no model. What it holds is the
 * vocabulary §3.1 names, the schema the model must answer in, and the rule that
 * turns an answer into an action — so the rule can be exercised exhaustively
 * without a tenant, a provider or a message.
 *
 * ── the vocabulary is the specification's, not a convenient subset ────────
 *
 * §3.1: *"Identify scheduling intent: call, meeting, reschedule, cancel,
 * reminder question, availability question."* All six are read. Only two of
 * them — `call` and `meeting` — are ACTED on here, and the other four are
 * recorded and named rather than quietly folded into "no". A reschedule and a
 * cancellation have their own doors, which want a meeting to act on and a
 * person to confirm the client meant this one; a question about availability
 * or a reminder is an answer somebody owes the client, not a row.
 *
 * Reading all six and acting on two is the honest shape: the log then says
 * *"the client asked to cancel and nothing here did that"*, which is a
 * findable gap, rather than saying nothing at all.
 *
 * ── explicit, ambiguous, and the third thing §3.3 asks for ────────────────
 *
 * §3.1 asks whether the request is explicit or ambiguous, and §3.3 says what
 * to do when it is ambiguous: *"Ask a focused clarification question."* That
 * question reaches a client, so it is a different kind of act with a different
 * gate, and it is NOT done here. What is done is refusing to act on an
 * ambiguous reading, and saying so — an ambiguous request that quietly became
 * a meeting row would be the agent deciding what the client meant.
 */

/** §3.1's six, plus the answer for a message that is not about scheduling at all. */
export const SCHEDULING_INTENTS = [
  'call',
  'meeting',
  'reschedule',
  'cancel',
  'reminder_question',
  'availability_question',
  'none',
] as const;

export type SchedulingIntent = (typeof SCHEDULING_INTENTS)[number];

/** §4.1's modes, as the meeting row and `crm.request_meeting` spell them. */
export const REQUESTED_MODES = ['call', 'video_meeting', 'in_person_meeting', 'other'] as const;

export const schedulingRequestSchema = z
  .object({
    /**
     * §3.1. What the client is asking for, in the specification's own words.
     * `none` is the ordinary answer: most messages are not about scheduling.
     */
    intent: z.enum(SCHEDULING_INTENTS),

    /**
     * §3.1's "explicit or ambiguous", as the boolean the rule below reads.
     *
     * Explicit means the client asked in words that need no interpretation —
     * *"can we talk tomorrow?"*, *"schedule a call"*. Not explicit: a
     * **hypothetical** (*"maybe we should talk sometime"*), a message ABOUT a
     * meeting that already exists, or a reading that rests on what the client
     * probably meant.
     */
    explicit: z.boolean(),

    /**
     * §4.1. How they want to meet, when they said. Null when they did not —
     * and null is not "call": choosing a mode nobody named is the smallest
     * possible invention and still an invention.
     */
    mode: z.enum(REQUESTED_MODES).nullish().catch(null),

    /**
     * §4.2 and §4.3, resolved. The date and time the client named, as a single
     * instant, resolved against the agency's local date which the prompt
     * supplies. Null when they named no time — §4.2's "if no date is provided"
     * case, which is ordinary and not a failure.
     *
     * A model resolving "kal" is a judgement, and this one is deliberately
     * low-stakes: the requested time only RANKS what is offered (§5.2), and a
     * person books from the offer after the calendar is re-read. A misreading
     * shows up as an odd first suggestion, never as a booking nobody agreed.
     *
     * §4.2's "reject or clarify dates that resolve to the past" is enforced in
     * code below, not trusted to the model.
     */
    startAt: z.string().nullish().catch(null),

    /**
     * §4.3's "parse ranges such as 6–8 PM" — the far end, when they gave one.
     * Null for a single time or no time.
     */
    windowEnd: z.string().nullish().catch(null),

    /**
     * §3.1's "preserve original source message" in the reading itself: the
     * client's own words that carry the request, quoted rather than
     * paraphrased, so a person can check the reading against the thread
     * without trusting it.
     */
    evidence: z.string().min(1).max(400),
  })
  .strict();

export type SchedulingRequest = z.infer<typeof schedulingRequestSchema>;

export function schedulingRequestJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(schedulingRequestSchema)) as Record<string, unknown>;
}

export const SCHEDULING_REQUEST_PROMPT = [
  'You read ONE message from a client and answer a single question: are they asking to meet?',
  'Answer with the scheduling intent — call, meeting, reschedule, cancel, reminder_question,',
  'availability_question — or none, which is the ordinary answer. Most messages are not about scheduling.',
  'Say whether the request is EXPLICIT: they asked in words that need no interpretation.',
  'A hypothetical ("maybe we should talk sometime"), a message about a meeting that already exists,',
  'or a reading that rests on what they probably meant is NOT explicit.',
  'Give the mode only if they named one, the time only if they named one, and null otherwise —',
  'choosing a mode or a time nobody gave is inventing what the client said.',
  'Resolve relative dates (today, tomorrow, day after, a named weekday) against the local date you are given.',
  'Ranges such as 6-8 PM give both ends. Quote the client’s own words as evidence, never a paraphrase.',
  'You are not booking anything, not offering times and not replying. You are reading one message.',
].join(' ');

/**
 * What the reading means for the door — the whole rule, and pure.
 *
 * Returns the action to take, never takes it. Every refusal is NAMED so the
 * run's output says which one happened; "no meeting was created" without a
 * reason is indistinguishable from a bug.
 */
export type SchedulingDecision =
  | { act: 'request'; mode: string; startAt: string | null; windowEnd: string | null; evidence: string }
  | { act: 'none'; reason: SchedulingRefusal; detail?: string };

export type SchedulingRefusal =
  | 'not_scheduling'
  | 'not_explicit'
  | 'other_intent'
  | 'time_in_the_past'
  | 'window_before_start';

/** Every refusal, with the sentence a person reads. §3.1 and §4.2 in one table. */
export const SCHEDULING_REFUSALS: Record<SchedulingRefusal, string> = {
  not_scheduling: 'The message is not about scheduling.',
  not_explicit:
    'A scheduling request was read but not an explicit one, so nothing was created — §3.3 wants a focused clarification question here, and asking one reaches the client.',
  other_intent:
    'The client asked about an existing meeting — a reschedule, a cancellation, or a question — which is a different door and needs a person to confirm which meeting they mean.',
  time_in_the_past: 'The time the client named resolves to the past (§4.2), so it was not recorded as a requested time.',
  window_before_start: 'The range the client named ends before it begins, so it was not recorded.',
};

/**
 * `now` is passed rather than read: the rule is about a clock, and a rule that
 * reads its own clock cannot be tested against one.
 */
export function decideScheduling(reading: SchedulingRequest, now: Date): SchedulingDecision {
  if (reading.intent === 'none') return { act: 'none', reason: 'not_scheduling' };

  // The four §3.1 reads and does not act on. Named rather than folded into
  // "no", so the log says what the client actually asked for.
  if (reading.intent !== 'call' && reading.intent !== 'meeting') {
    return { act: 'none', reason: 'other_intent', detail: reading.intent };
  }

  // §3.1's explicit/ambiguous, and §3.3's answer to the ambiguous half.
  if (!reading.explicit) return { act: 'none', reason: 'not_explicit' };

  // §4.1: the mode is the client's when they gave one. A `call` intent with no
  // mode is a call — they said so in the intent. A `meeting` with no mode is
  // `other`, because "meeting" alone does not say video or in person and
  // picking one would be the invention this schema refuses.
  const mode = reading.mode ?? (reading.intent === 'call' ? 'call' : 'other');

  const startAt = instantOrNull(reading.startAt);
  const windowEnd = instantOrNull(reading.windowEnd);

  // §4.2: "Reject or clarify dates that resolve to the past." Enforced here,
  // not trusted to the model — and the REQUEST still stands. A client who
  // asked for a time that has passed still asked to meet; what is dropped is
  // the time, not the request, and the refusal says which.
  if (startAt !== null && startAt.getTime() <= now.getTime()) {
    return { act: 'request', mode, startAt: null, windowEnd: null, evidence: reading.evidence };
  }
  if (startAt !== null && windowEnd !== null && windowEnd.getTime() < startAt.getTime()) {
    return { act: 'request', mode, startAt: startAt.toISOString(), windowEnd: null, evidence: reading.evidence };
  }
  // A window with no start is not a window — the door refuses it by name, and
  // sending one would be asking for a refusal this rule can see coming.
  return {
    act: 'request',
    mode,
    startAt: startAt === null ? null : startAt.toISOString(),
    windowEnd: startAt === null || windowEnd === null ? null : windowEnd.toISOString(),
    evidence: reading.evidence,
  };
}

/** A string the model offered as an instant, or null. Anything unparseable is null, never NaN. */
function instantOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * What the model is told about *now*, so §4.2's relative dates resolve against
 * the right day. The agency's zone, because the client's is not known — §4.4
 * prefers a verified client zone and there is none at this point, and the
 * agency's is the one real zone there is.
 */
export function localDateLine(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `Right now it is ${fmt.format(now)} in ${timeZone}. Resolve any relative date against that.`;
}
