/**
 * Round 4, Scheduler: the client-facing scheduling messages, as DRAFTS (P1-SCHED-011, 024, 025, 027, 029).
 *
 * Pure and deterministic: no model, no network, nothing sent. Each function returns the words a person will read, edit and send; the draft is stored by
 * `crm.p1r_save_scheduling_draft` and sent only when a signed-in person presses send. The specification's rules are the shape of the text:
 *   proposal         date, time, zone, duration and mode in every option; a single option asks for a yes, several ask for the NUMBER (a bare "okay" is never a choice);
 *   confirmation     the exact date, time, zone and type, the link only when there is one, and the way to change or cancel;
 *   no_availability  says there is no free time WITHOUT giving reasons and asks for another day or time;
 *   clarification    names the meetings it could mean and asks which; never guesses.
 * English, Hinglish (Roman script) and Hindi (Devanagari), the three languages a quotation is already written in.
 */
export type DraftLanguage = 'en' | 'hinglish' | 'hindi';
export type MeetingMode = 'call' | 'video_meeting' | 'in_person_meeting' | 'other';
export type TimeSlot = { startAt: string; endAt: string };

const MODE_WORDS: Record<DraftLanguage, Record<MeetingMode, string>> = {
  en: { call: 'call', video_meeting: 'video meeting', in_person_meeting: 'in-person meeting', other: 'meeting' },
  hinglish: { call: 'call', video_meeting: 'video meeting', in_person_meeting: 'in-person meeting', other: 'meeting' },
  hindi: { call: 'कॉल', video_meeting: 'वीडियो मीटिंग', in_person_meeting: 'आमने-सामने की मीटिंग', other: 'मीटिंग' },
};

/** The time as the meeting's own zone reads it, never the server's. An unreadable instant or zone is refused rather than printed as a guess. */
export function whenIn(startAt: string, timezone: string): string {
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) throw new Error('p1r-messages: an unreadable time cannot be written into a message');
  try {
    return d.toLocaleString('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    throw new Error('p1r-messages: an unknown time zone cannot be written into a message');
  }
}

export function clockIn(instant: string, timezone: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error('p1r-messages: an unreadable time cannot be written into a message');
  return d.toLocaleString('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true });
}

const greet = (language: DraftLanguage, name: string | null | undefined): string => {
  const n = name?.trim() ? ` ${name.trim()}` : '';
  return language === 'hindi' ? `नमस्ते${n},` : language === 'hinglish' ? `Namaste${n},` : `Hi${n},`;
};

const minutesBetween = (s: TimeSlot): number => Math.round((Date.parse(s.endAt) - Date.parse(s.startAt)) / 60_000);

export function composeProposal(input: { slots: readonly TimeSlot[]; timezone: string; mode: MeetingMode; language: DraftLanguage; clientName?: string | null }): string {
  if (input.slots.length === 0) throw new Error('p1r-messages: a proposal needs at least one slot');
  const { language: L, timezone: tz } = input;
  const mode = MODE_WORDS[L][input.mode];
  const minutes = minutesBetween(input.slots[0]!);
  const lines = input.slots.map((s, i) => `${input.slots.length === 1 ? '' : `${i + 1}) `}${whenIn(s.startAt, tz)} - ${clockIn(s.endAt, tz)}`);
  if (input.slots.length === 1) {
    if (L === 'hindi') return `${greet(L, input.clientName)} क्या ${minutes} मिनट के ${mode} के लिए यह समय ठीक रहेगा?\n${lines[0]}\n(समय ${tz} में है) कृपया हाँ बताइए, या कोई और समय बताइए।`;
    if (L === 'hinglish') return `${greet(L, input.clientName)} kya ${minutes} minute ke ${mode} ke liye ye time theek rahega?\n${lines[0]}\n(time ${tz} mein hai) Please haan bata dijiye, ya koi aur time bataiye.`;
    return `${greet(L, input.clientName)} would this time work for a ${minutes}-minute ${mode}?\n${lines[0]}\n(Times are in ${tz}.) Please reply yes, or tell us another time that suits you.`;
  }
  if (L === 'hindi') return `${greet(L, input.clientName)} ${minutes} मिनट के ${mode} के लिए ये समय खाली हैं:\n${lines.join('\n')}\n(समय ${tz} में हैं) जो समय आपके अनुकूल हो, उसका नंबर बताइए।`;
  if (L === 'hinglish') return `${greet(L, input.clientName)} ${minutes} minute ke ${mode} ke liye ye time free hain:\n${lines.join('\n')}\n(time ${tz} mein hain) Jo time aapko suit kare, uska number bata dijiye.`;
  return `${greet(L, input.clientName)} these times are free for a ${minutes}-minute ${mode}:\n${lines.join('\n')}\n(Times are in ${tz}.) Please reply with the number of the one that suits you.`;
}

export function composeConfirmation(input: { startAt: string; endAt: string; timezone: string; mode: MeetingMode; meetUrl?: string | null; language: DraftLanguage; clientName?: string | null }): string {
  const { language: L, timezone: tz } = input;
  const mode = MODE_WORDS[L][input.mode];
  const when = `${whenIn(input.startAt, tz)} - ${clockIn(input.endAt, tz)} (${tz})`;
  const link = input.meetUrl?.trim() ? input.meetUrl.trim() : null;
  if (L === 'hindi') return `${greet(L, input.clientName)} आपका ${mode} तय हो गया है: ${when}।${link ? `\nजुड़ने का लिंक: ${link}` : ''}\nसमय बदलना या रद्द करना हो तो यहीं जवाब दीजिए।`;
  if (L === 'hinglish') return `${greet(L, input.clientName)} aapka ${mode} confirm ho gaya hai: ${when}.${link ? `\nJoin link: ${link}` : ''}\nTime badalna ya cancel karna ho to yahin reply kar dijiye.`;
  return `${greet(L, input.clientName)} your ${mode} is confirmed for ${when}.${link ? `\nJoin here: ${link}` : ''}\nIf you need to change or cancel it, just reply here.`;
}

/** No free time. The client is told there is none and asked for another day or time: no reasons (the calendar's contents are not the client's business). */
export function composeNoAvailability(input: { language: DraftLanguage; clientName?: string | null }): string {
  const L = input.language;
  if (L === 'hindi') return `${greet(L, input.clientName)} आपके बताए समय में हमारे पास कोई खाली समय नहीं है। क्या आप कोई और दिन या समय बता सकते हैं? हम तुरंत देख लेंगे।`;
  if (L === 'hinglish') return `${greet(L, input.clientName)} aapke bataye time mein hamare paas koi free slot nahi hai. Kya aap koi aur din ya time bata sakte hain? Hum turant dekh lenge.`;
  return `${greet(L, input.clientName)} we do not have a free time in the window you mentioned. Could you share another day or time that works for you? We will check it right away.`;
}

export type ClarificationIntent = 'cancel' | 'reschedule' | 'unclear';
export type CandidateMeeting = { startAt: string | null; timezone: string | null; mode: MeetingMode | null };

/** Which meeting do you mean / what do you want done. Never guesses: it lists what it could mean and asks. */
export function composeClarification(input: { intent: ClarificationIntent; candidates: readonly CandidateMeeting[]; language: DraftLanguage; clientName?: string | null; fallbackTimezone: string }): string {
  const L = input.language;
  const describe = (c: CandidateMeeting): string => {
    const mode = c.mode ? MODE_WORDS[L][c.mode] : MODE_WORDS[L].other;
    if (!c.startAt) return L === 'hindi' ? `${mode} (समय अभी तय नहीं)` : L === 'hinglish' ? `${mode} (time abhi tay nahi)` : `${mode} (time not yet fixed)`;
    const tz = c.timezone ?? input.fallbackTimezone;
    return `${mode}, ${whenIn(c.startAt, tz)} (${tz})`;
  };
  const verb = {
    en: { cancel: 'cancel', reschedule: 'move', unclear: 'change' },
    hinglish: { cancel: 'cancel', reschedule: 'move', unclear: 'change' },
    hindi: { cancel: 'रद्द', reschedule: 'आगे-पीछे', unclear: 'बदल' },
  }[L][input.intent];
  if (input.candidates.length >= 2) {
    const letters = input.candidates.map((c, i) => `${String.fromCharCode(65 + i)}) ${describe(c)}`).join('\n');
    if (L === 'hindi') return `${greet(L, input.clientName)} आपकी हमारे साथ एक से ज़्यादा मीटिंग हैं:\n${letters}\nआप कौन-सी ${verb} करना चाहते हैं? कृपया अक्षर बताइए।`;
    if (L === 'hinglish') return `${greet(L, input.clientName)} aapki hamare saath ek se zyada meeting hain:\n${letters}\nAap kaun si ${verb} karna chahte hain? Please letter bata dijiye.`;
    return `${greet(L, input.clientName)} you have more than one meeting with us:\n${letters}\nWhich one would you like to ${verb}? Please reply with the letter.`;
  }
  const only = input.candidates[0];
  const what = only ? describe(only) : MODE_WORDS[L].other;
  if (L === 'hindi') return `${greet(L, input.clientName)} आपकी मीटिंग (${what}) के बारे में पक्का करना चाहते हैं: क्या आप इसे वैसे ही रखना चाहते हैं, दूसरे समय पर करना चाहते हैं, या रद्द करना चाहते हैं?`;
  if (L === 'hinglish') return `${greet(L, input.clientName)} aapki meeting (${what}) ke baare mein pakka karna chahte hain: kya ise waise hi rakhna hai, doosre time par karna hai, ya cancel karna hai?`;
  return `${greet(L, input.clientName)} just to be sure about your meeting (${what}): would you like to keep it, move it to another time, or cancel it?`;
}
