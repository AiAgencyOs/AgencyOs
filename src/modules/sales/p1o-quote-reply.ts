/**
 * Phase 1 Quotation Master: reading a client's reply to a quotation (P1-QUOTE-052/054, P1-COORD-014, P1-HANDOFF-028/043).
 *
 * Two jobs, neither of which can accept anything:
 *   1. `classifyQuoteReply`  the typed class of a reply (price, scope, feature, timeline, payment-term or trust objection, a clarification, a change request,
 *      more time, a refusal), recorded through `sales.p1o_record_quote_response`, which refuses the class "accepted" by construction.
 *   2. `readAcceptanceSignal`  whether a reply looks like "yes". An acceptance is an exact-version act: a version named in the reply is EXPLICIT, a bare "okay"
 *      with several versions open is AMBIGUOUS (a clarification is drafted for the owner to send; nothing is accepted), and a bare "okay" with one open version
 *      is only a SIGNAL that a person then records with evidence through `sales.p1o_record_acceptance`. The agent never records an acceptance: that door
 *      refuses the service role.
 * The classifier is deterministic (English and Hinglish keywords) so it runs with no funded model; a model can be injected through the same port, and the
 * model-backed run is MANUAL_EXTERNAL.
 */

export type QuoteReplyClass =
  | 'rejected' | 'price_objection' | 'scope_objection' | 'feature_objection' | 'timeline_objection' | 'payment_term_objection' | 'trust_objection'
  | 'clarification' | 'change_request' | 'needs_more_time' | 'ambiguous';

export type ReplyReading = { replyClass: QuoteReplyClass | null; source: 'keywords' | 'model' };
export type ReplyClassifier = (text: string) => Promise<ReplyReading>;

const RULES: Array<[QuoteReplyClass, RegExp]> = [
  ['rejected', /\b(not interested|no thanks|no thank you|drop (it|this)|nahi chahiye|cancel the (quote|quotation)|going with (someone|another))/i],
  ['payment_term_objection', /\b(advance|instal+ment|payment (terms|plan|schedule)|pay later|50 ?%|upfront|emi|kist)/i],
  ['price_objection', /\b(too (expensive|costly|high)|expensive|costly|discount|price (is )?high|cheaper|kam karo|budget (is )?(less|low)|mehnga|mahanga)/i],
  ['timeline_objection', /\b(deadline|too long|faster|sooner|timeline|how soon|jaldi|kitne din)/i],
  ['trust_objection', /\b(trust|guarantee|reviews?|references?|portfolio|proof|scam|bharosa)/i],
  ['scope_objection', /\b(scope|out of scope|not included|remove (the|this)|drop (the|this) (page|module|feature))/i],
  ['change_request', /\b(change|modify|add (a|the|one)|include|can you also|aur add)/i],
  ['needs_more_time', /\b(think|let you know|get back|discuss|talk (to|with)|time chahiye|sochna|baad mein bataunga)/i],
  ['clarification', /(\?|\b(what is|what does|does it include|explain|samjha|meaning)\b)/i],
];

export const keywordReplyClassifier: ReplyClassifier = async (text) => {
  for (const [cls, re] of RULES) if (re.test(text)) return { replyClass: cls, source: 'keywords' };
  return { replyClass: null, source: 'keywords' };
};

export type AcceptanceSignal =
  | { kind: 'none' }
  | { kind: 'explicit'; version: number }
  | { kind: 'ambiguous'; openVersions: number[] }
  | { kind: 'single_open_unconfirmed'; version: number };

const YES = /\b(ok(ay)?|yes|yep|yeah|sure|done|go ahead|agreed?|approved?|accept(ed)?|confirm(ed)?|proceed|lets? (start|go)|theek hai|thik hai|haan|ha ji|chalega|kar do)\b/i;
const NO_ASSENT = /\b(not|no|nahi|don'?t|but|however|lekin)\b/i;
const VERSION = /\b(?:v(?:ersion)?\s*|option\s*|plan\s*|quote\s*|quotation\s*)(\d{1,2})\b/i;

/** `openVersions` are the version numbers currently sent and unanswered on the deal. A reply that mixes assent with a condition is not an acceptance signal. */
export function readAcceptanceSignal(text: string, openVersions: readonly number[]): AcceptanceSignal {
  if (!YES.test(text) || NO_ASSENT.test(text) || openVersions.length === 0) return { kind: 'none' };
  const named = text.match(VERSION);
  if (named) {
    const version = Number(named[1]);
    return openVersions.includes(version) ? { kind: 'explicit', version } : { kind: 'ambiguous', openVersions: [...openVersions] };
  }
  if (openVersions.length > 1) return { kind: 'ambiguous', openVersions: [...openVersions] };
  return { kind: 'single_open_unconfirmed', version: openVersions[0] as number };
}

/** The clarification a person approves before it is sent: asks which exact version, offers no inference. Hinglish when the client wrote in it. */
export function clarificationDraft(openVersions: readonly number[], language: 'en' | 'hinglish' = 'en'): string {
  const list = openVersions.map((v) => `version ${v}`).join(' or ');
  return language === 'hinglish'
    ? `Aapka reply mila, shukriya. Humare paas abhi ${list} khule hain. Kripya batayein ki aap kaun sa version accept kar rahe hain, taaki hum sahi terms par aage badh sakein.`
    : `Thank you for your reply. We currently have ${list} open with you. Could you confirm exactly which version you are accepting, so we proceed on the right terms?`;
}

export type RecordResponsePort = (args: { proposalId: string; responseClass: QuoteReplyClass; messageRef: string | null; note: string }) => Promise<{ outcome: string }>;

export type ReviewedReply = {
  recorded: { replyClass: QuoteReplyClass; outcome: string } | null;
  acceptance: AcceptanceSignal;
  /** Drafted for the owner to approve; never sent from here. */
  clarificationDraft: string | null;
  /** True when a person must record the acceptance (with evidence) through the acceptance door. */
  needsPersonToRecordAcceptance: boolean;
};

export async function reviewQuoteReply(
  input: { text: string; proposalId: string; messageRef: string | null; openVersions: readonly number[]; language?: 'en' | 'hinglish' },
  deps: { record: RecordResponsePort; classify?: ReplyClassifier },
): Promise<ReviewedReply> {
  const acceptance = readAcceptanceSignal(input.text, input.openVersions);
  let replyClass: QuoteReplyClass | null = null;
  if (acceptance.kind === 'ambiguous') replyClass = 'ambiguous';
  else if (acceptance.kind === 'none') replyClass = (await (deps.classify ?? keywordReplyClassifier)(input.text)).replyClass;
  const recorded = replyClass
    ? { replyClass, outcome: (await deps.record({ proposalId: input.proposalId, responseClass: replyClass, messageRef: input.messageRef, note: input.text.replace(/\s+/g, ' ').slice(0, 500) })).outcome }
    : null;
  return {
    recorded,
    acceptance,
    clarificationDraft: acceptance.kind === 'ambiguous' ? clarificationDraft(acceptance.openVersions, input.language ?? 'en') : null,
    needsPersonToRecordAcceptance: acceptance.kind === 'explicit' || acceptance.kind === 'single_open_unconfirmed',
  };
}
