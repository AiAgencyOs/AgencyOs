/**
 * Phase 1 Scheduler: a client's reschedule, cancel, availability or reminder question is routed to a PERSON (P1-SCHED-006/011/024/036/041).
 *
 * The Scheduler document says only call/meeting requests create a meeting and every other scheduling intent is "recorded and routed back". This is the routing:
 * an intent reading becomes a flag (`crm.p1o_flag_meeting`) a person sees on the attention page. Nothing is rebooked, cancelled or sent from here, and no human
 * gate is touched: the agent flags, a person acts through the existing meeting doors.
 *
 * The reading itself comes through the `IntentClassifier` port. The default is deterministic (keywords in English and Hinglish) so the workflow runs with no
 * funded model; a model-backed classifier can be passed instead (that run is MANUAL_EXTERNAL: it needs a funded model). In tests a stub model proves the workflow.
 * When the reading is unsure, or several live meetings fit, the outcome is an AMBIGUITY flag naming the candidates, never a guess about which meeting.
 */

export type MeetingIntent = 'reschedule' | 'cancel' | 'availability_question' | 'reminder_question' | 'none' | 'ambiguous';
export type IntentReading = { intent: MeetingIntent; source: 'keywords' | 'model' };
export type IntentClassifier = (text: string) => Promise<IntentReading>;

const CANCEL = /\b(cancel|call off|called off|not able to attend|can'?t attend|cannot attend|won'?t (be )?able|nahi (aa|ho) pa|cancel kar)/i;
const RESCHEDULE = /\b(re-?schedule|postpone|push (it|the)|move (it|the)|change (the )?(time|date|slot)|another (time|day|slot)|different (time|day)|time change|dusre din|shift (it|kar)|kal nahi|baad mein)/i;
const AVAILABILITY = /\b(when are you free|are you free|any (free )?slot|available|availability|kab free|free kab)/i;
const REMINDER = /\b(remind|reminder|yaad dila|yaad rakh)/i;

/** Deterministic default. Both cancel and reschedule words in one message is `ambiguous`, not a coin flip. */
export const keywordIntentClassifier: IntentClassifier = async (text) => {
  const cancel = CANCEL.test(text);
  const resched = RESCHEDULE.test(text);
  if (cancel && resched) return { intent: 'ambiguous', source: 'keywords' };
  if (cancel) return { intent: 'cancel', source: 'keywords' };
  if (resched) return { intent: 'reschedule', source: 'keywords' };
  if (REMINDER.test(text)) return { intent: 'reminder_question', source: 'keywords' };
  if (AVAILABILITY.test(text)) return { intent: 'availability_question', source: 'keywords' };
  return { intent: 'none', source: 'keywords' };
};

export type LiveMeeting = { id: string; status: string; confirmedStartAt: string | null };
export type FlagKind = 'reschedule_request' | 'cancel_request' | 'availability_question' | 'reminder_question' | 'ambiguous_cancel' | 'ambiguous_reschedule' | 'needs_escalation';
export type FlagPort = (args: { meetingId: string; kind: FlagKind; note: string; candidateMeetingIds: string[] }) => Promise<{ outcome: string }>;

export type RoutedIntent =
  | { routed: false; reason: 'not_a_scheduling_intent' | 'no_live_meeting' }
  | { routed: true; kind: FlagKind; meetingId: string; candidates: string[]; outcome: string };

const LIVE = new Set(['requested', 'proposed', 'booked']);

function earliestFirst(a: LiveMeeting, b: LiveMeeting): number {
  return (a.confirmedStartAt ?? '9999').localeCompare(b.confirmedStartAt ?? '9999');
}

export async function routeMeetingIntent(
  input: { text: string; meetings: readonly LiveMeeting[] },
  deps: { classify?: IntentClassifier; flag: FlagPort },
): Promise<RoutedIntent> {
  const reading = await (deps.classify ?? keywordIntentClassifier)(input.text);
  if (reading.intent === 'none') return { routed: false, reason: 'not_a_scheduling_intent' };
  const live = input.meetings.filter((m) => LIVE.has(m.status)).sort(earliestFirst);
  if (live.length === 0) return { routed: false, reason: 'no_live_meeting' };
  const note = `Client message read as ${reading.intent.replace('_', ' ')} (${reading.source}): ${input.text.replace(/\s+/g, ' ').slice(0, 300)}`;
  const ids = live.map((m) => m.id);
  const first = live[0] as LiveMeeting;

  let kind: FlagKind;
  let candidates: string[] = [];
  if (reading.intent === 'availability_question') kind = 'availability_question';
  else if (reading.intent === 'reminder_question') kind = 'reminder_question';
  else if (reading.intent === 'ambiguous') {
    // the client's own words pull both ways (cancel AND move): a person must read it and ask, so it is not filed as either
    if (ids.length >= 2) {
      kind = 'ambiguous_cancel';
      candidates = ids;
    } else kind = 'needs_escalation';
  } else if (live.length > 1) {
    // which meeting? never guessed
    kind = reading.intent === 'cancel' ? 'ambiguous_cancel' : 'ambiguous_reschedule';
    candidates = ids;
  } else kind = reading.intent === 'cancel' ? 'cancel_request' : 'reschedule_request';

  const { outcome } = await deps.flag({ meetingId: first.id, kind, note, candidateMeetingIds: candidates });
  return { routed: true, kind, meetingId: first.id, candidates, outcome };
}
