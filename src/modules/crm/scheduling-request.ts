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
 * Two questions the workflow asks BEFORE it costs anything — here, as pure
 * functions, because a guard tested only by reading the source it guards is a
 * guard that stays green when somebody disables it.
 *
 * Review of this unit red-proved both by wrapping them in `false &&` and the
 * suite stayed green: the assertions matched the sentence, not the behaviour.
 */

/**
 * An imported history is not somebody asking now.
 *
 * `crm.commit_import_record` writes every inbound line of a WhatsApp export as
 * `author_type = 'client'` with `metadata.imported`, and
 * `crm.emit_message_received` fires for each — right for a label, a
 * qualification and a summary, which are true of a message whenever it was
 * sent. This is the first reader that writes a row somebody must ACTION, and a
 * March message saying "kal 4 baje call kar sakte hain?" would arrive today as
 * a live meeting request. With the reactivation import that is twelve hundred
 * leads of manufactured scheduling work.
 */
export function isImportedMessage(metadata: unknown): boolean {
  return (metadata as { imported?: unknown } | null | undefined)?.imported === true;
}

/**
 * Whether the CLIENT used words — a photograph with no caption, a sticker or a
 * location is the agent's own description, and a reader asking "did they ask
 * to meet?" of that would be reading its own handwriting. It cannot be an
 * explicit request, so it must not cost a model call.
 */
export function theirWords(parts: { body: string | null; caption: string | null; spoken: string | null }): boolean {
  return Boolean((parts.body ?? '').trim() || (parts.caption ?? '').trim() || (parts.spoken ?? '').trim());
}

/**
 * A wall-clock reading in a named zone, as an instant.
 *
 * **The bug this exists to kill.** The first draft handed the model's answer
 * to `Date.parse` and stored the result. `Date.parse('2026-09-17T16:00:00')` —
 * ISO-8601 with no `Z` and no offset — is defined to mean the local time *of
 * the host process*, and production runs UTC. So a client asking for 4 PM in
 * Kolkata had `21:30 IST` written onto their meeting, five and a half hours
 * late, while the row's own `timezone` column said `Asia/Kolkata` so every
 * screen rendered the wrong hour confidently. The whole test suite was blind
 * to it because every fixture carried an explicit `Z`.
 *
 * A model told "it is Wednesday 11:30 in Asia/Kolkata" will answer in that
 * wall clock, and it is right to: the zone is the agency's, not the host's.
 * So an answer with no offset is resolved HERE, against the zone the caller
 * names, and an answer that carries one is honoured as given.
 *
 * Two passes, because a zone's offset depends on the instant and the instant
 * depends on the offset: guess with the offset at the naive reading, then
 * re-ask at the answer. That settles every case except the hour that does not
 * exist on a spring-forward morning, which lands on the hour after it.
 */
export function zonedInstant(value: string, timeZone: string): Date | null {
  const text = value.trim();
  // An answer that already carries an offset is an instant, and honouring it
  // is the whole point of an offset. Only a bare wall clock is ambiguous.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const explicit = Date.parse(text);
    return Number.isFinite(explicit) ? new Date(explicit) : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as number[];
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!);
  if (!Number.isFinite(naive)) return null;
  const first = naive - offsetAt(new Date(naive), timeZone);
  const second = naive - offsetAt(new Date(first), timeZone);
  return new Date(second);
}

/** How far ahead of UTC `timeZone` is at that instant, in milliseconds. */
function offsetAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  return asUtc - at.getTime();
}

/** True when the model answered a DATE with no clock time — §4.3's "only a date is supplied". */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * The end of that calendar day in the zone, as an instant — what a date with
 * no time actually means.
 *
 * §4.3: *"If only a date is supplied, find suitable slots on that date."* The
 * first draft turned `2026-09-17` into midnight UTC, which in Kolkata is
 * 05:30 on the 17th, so a client who said "Thursday" was recorded as asking
 * for a 5:30 AM meeting — and a client who said "today" had their request
 * resolved into the past and the date thrown away entirely. A date is a
 * WINDOW, and saying so is the whole fix.
 */
export function endOfDayInZone(value: string, timeZone: string): Date | null {
  const start = zonedInstant(value, timeZone);
  if (start === null) return null;
  const nextDay = new Date(start.getTime() + 36 * 3_600_000);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nextDay);
  const nextMidnight = zonedInstant(iso, timeZone);
  return nextMidnight === null ? null : new Date(nextMidnight.getTime() - 60_000);
}

/**
 * What the reading means for the door — the whole rule, and pure.
 *
 * Returns the action to take, never takes it. Every refusal is NAMED so the
 * run's output says which one happened; "no meeting was created" without a
 * reason is indistinguishable from a bug.
 */
export type SchedulingDecision =
  | {
      act: 'request';
      mode: string;
      startAt: string | null;
      windowEnd: string | null;
      evidence: string;
      /**
       * What the reading offered and the rule refused to store, and why.
       *
       * Review found the first draft dropping a past time and then recording
       * the model's ORIGINAL answer on the run — so a person debugging "why
       * has this meeting no time?" read a run that said it had one. A refusal
       * the record cannot see is a refusal nobody can act on.
       */
      dropped: SchedulingDrop | null;
    }
  | { act: 'none'; reason: SchedulingRefusal; detail?: string };

export type SchedulingRefusal =
  | 'not_scheduling'
  | 'not_explicit'
  | 'other_intent'
  | 'no_timezone';

/** Why a time the client named was not stored. The request always survives it. */
export type SchedulingDrop = 'time_in_the_past' | 'window_before_start' | 'window_without_a_start' | 'unreadable_time';

/** Every refusal, with the sentence a person reads. §3.1 and §4.4 in one table. */
export const SCHEDULING_REFUSALS: Record<SchedulingRefusal, string> = {
  not_scheduling: 'The message is not about scheduling.',
  not_explicit:
    'A scheduling request was read but not an explicit one, so nothing was created — §3.3 wants a focused clarification question here, and asking one reaches the client.',
  other_intent:
    'The client asked about an existing meeting — a reschedule, a cancellation, or a question — which is a different door and needs a person to confirm which meeting they mean.',
  no_timezone:
    'The agency has not set its timezone, and §4.4 says to store the zone a meeting was agreed in. Recording one as UTC would be a durable false claim, so nothing was created.',
};

/** Every drop, with the sentence a person reads. The request stood in every case. */
export const SCHEDULING_DROPS: Record<SchedulingDrop, string> = {
  time_in_the_past: 'The time the client named has already passed (§4.2), so the request was recorded without it.',
  window_before_start: 'The range the client named ends before it begins, so the request kept only its start.',
  window_without_a_start: 'A range was given with no start, which is not a window, so the request was recorded without either end.',
  unreadable_time: 'The time in the reading could not be resolved, so the request was recorded without one.',
};

/**
 * `now` and `timeZone` are passed rather than read: the rule is about a clock
 * and a zone, and a rule that reads its own cannot be tested against either.
 *
 * A null zone is a REFUSAL, not a default. `core.organizations.timezone` is
 * null by design — its own comment says an agency timezone is a real-world
 * fact nobody has stated — and the follow-up worker honours that by refusing
 * to send. The first draft wrote `UTC` onto the row instead, which §4.4's
 * "store the timezone used" turns into a lie every later screen repeats.
 */
export function decideScheduling(reading: SchedulingRequest, now: Date, timeZone: string | null): SchedulingDecision {
  if (reading.intent === 'none') return { act: 'none', reason: 'not_scheduling' };

  // The four §3.1 reads and does not act on. Named rather than folded into
  // "no", so the log says what the client actually asked for.
  if (reading.intent !== 'call' && reading.intent !== 'meeting') {
    return { act: 'none', reason: 'other_intent', detail: reading.intent };
  }

  // §3.1's explicit/ambiguous, and §3.3's answer to the ambiguous half.
  if (!reading.explicit) return { act: 'none', reason: 'not_explicit' };

  if (!timeZone) return { act: 'none', reason: 'no_timezone' };

  // §4.1: the mode is the client's when they gave one. A `call` intent with no
  // mode is a call — they said so in the intent. A `meeting` with no mode is
  // `other`, because "meeting" alone does not say video or in person and
  // picking one would be the invention this schema refuses.
  const mode = reading.mode ?? (reading.intent === 'call' ? 'call' : 'other');
  const request = (startAt: Date | null, windowEnd: Date | null, dropped: SchedulingDrop | null): SchedulingDecision => ({
    act: 'request',
    mode,
    startAt: startAt?.toISOString() ?? null,
    windowEnd: windowEnd?.toISOString() ?? null,
    evidence: reading.evidence,
    dropped,
  });

  const rawStart = (reading.startAt ?? '').trim();
  const rawEnd = (reading.windowEnd ?? '').trim();
  const start = rawStart ? zonedInstant(rawStart, timeZone) : null;
  let end = rawEnd ? zonedInstant(rawEnd, timeZone) : null;

  // §4.3: "If only a date is supplied, find suitable slots on that date." A
  // date is a WINDOW over that day, not midnight — and midnight in a +hh zone
  // is the previous evening in UTC, which is how the first draft turned
  // "Thursday" into a 5:30 AM meeting and "today" into the past.
  if (start !== null && rawStart && isDateOnly(rawStart) && end === null) {
    end = endOfDayInZone(rawStart, timeZone);
  }

  if (rawStart && start === null) return request(null, null, 'unreadable_time');
  // A window with no start is not a window; the door refuses it by name and
  // sending one would be asking for a refusal this rule can already see.
  if (start === null && end !== null) return request(null, null, 'window_without_a_start');

  if (start !== null && end !== null && end.getTime() < start.getTime()) {
    if (start.getTime() <= now.getTime()) return request(null, null, 'time_in_the_past');
    return request(start, null, 'window_before_start');
  }

  // §4.2: "Reject or clarify dates that resolve to the past." The REQUEST
  // still stands — a client who named an hour that has passed still asked to
  // meet — and what is dropped is the hour. But a window whose far end is
  // still ahead is not past: the rest of today is exactly what "today" meant,
  // so the start is clamped rather than the day thrown away.
  if (start !== null && start.getTime() <= now.getTime()) {
    if (end !== null && end.getTime() > now.getTime()) return request(now, end, null);
    return request(null, null, 'time_in_the_past');
  }

  return request(start, end, null);
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
