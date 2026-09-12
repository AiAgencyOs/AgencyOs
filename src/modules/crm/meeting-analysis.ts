import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

import { requirementPayloadSchema } from './schema';

/**
 * What a completed meeting said — the analysis §10 of the Scheduler
 * specification asks for, as data (G-239, the half of G-229 that waited on
 * BLK-001).
 *
 * Pure. The shape the model must fill (§10.2's fourteen outputs, bounded),
 * the document the model is given (§10.1: the minimum context, not the
 * history), the requirement version the analysis proposes (§10.4: Sales
 * confirms before anything is treated as confirmed), and the note a person
 * reads — each decided here so a unit test executes it rather than reading
 * it off a prompt.
 *
 * §10.3 in one sentence: nothing that comes out of this is a fact. It is a
 * PROPOSED requirement version and an INTERNAL summary marked as inference,
 * with the evidence it was read from named, and a flag when the evidence was
 * too thin to read confidently.
 */

const line = (max: number) => z.string().trim().min(1).max(max);

export const OBJECTION_CATEGORIES = ['price', 'trust', 'timeline', 'scope', 'other'] as const;

export const meetingAnalysisSchema = z.object({
  /** §10.2 "Grounded conversation summary" — what the evidence supports, nothing more. */
  summary: line(2_000),
  /** "Explicit client requirements" — each with the words it rests on. */
  requirements: z.array(z.object({ title: line(200), detail: z.string().trim().max(2_000).optional(), source: z.string().trim().max(300).optional() })).max(50),
  /** "Requirements needing clarification". */
  needsClarification: z.array(line(500)).max(50),
  /** "Questions/doubts raised" by the client. */
  questions: z.array(line(500)).max(50),
  /** "Objections: price, trust, timeline, scope or other". */
  objections: z.array(z.object({ category: z.enum(OBJECTION_CATEGORIES), detail: line(500) })).max(20),
  /** "Stated budget signals where explicit" — the words, never a number the model computed. */
  budgetSignal: z.string().trim().max(300).optional(),
  /** "Stated timeline/urgency". */
  timeline: z.string().trim().max(300).optional(),
  /** "Decision-maker/stakeholder information where explicit". */
  stakeholders: z.array(line(200)).max(20),
  agencyCommitments: z.array(line(500)).max(20),
  clientCommitments: z.array(line(500)).max(20),
  nextAction: z.string().trim().max(500).optional(),
  agreedFollowUp: z.string().trim().max(200).optional(),
  unresolved: z.array(line(500)).max(50),
  /** "Confidence and provenance for extracted facts" — one grade for the read as a whole. */
  confidence: z.enum(['low', 'medium', 'high']),
  /** §10.3 "Ambiguous recordings/transcripts must be flagged". */
  ambiguous: z.boolean(),
});
export type MeetingAnalysis = z.infer<typeof meetingAnalysisSchema>;

export function meetingAnalysisJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(meetingAnalysisSchema)) as Record<string, unknown>;
}

export const MEETING_ANALYSIS_PROMPT = [
  'You read the evidence a completed sales meeting left behind — typed notes, a written summary, a transcript —',
  'and write down what the client said, for the colleague who will continue the conversation.',
  'Use ONLY what the evidence supports. Where the evidence is thin, contradictory or hard to read, say so',
  'by setting ambiguous to true and a low confidence, and leave the doubtful item under needsClarification',
  'rather than under requirements. Never invent a requirement, a decision, a number or a date:',
  'a budget or a timeline is recorded only in the words the client used.',
  'Nothing you write is a confirmed fact — a person confirms it with the client before it is treated as one.',
].join(' ');

/** The prefix that marks a summary evidence row as the agent's own output, so it is never read back as evidence. */
export const ANALYSIS_REFERENCE_PREFIX = 'agent_run:';

export type EvidenceRowLike = {
  id: string;
  kind: string;
  visibility: string;
  artifact_ref: string | null;
  body: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
};

export type MeetingLikeForAnalysis = {
  purpose: string | null;
  requested_mode: string;
  booked_mode: string | null;
  confirmed_start_at: string | null;
  timezone: string | null;
  outcome: string | null;
  completed_at: string | null;
};

/** How much of one evidence body the model is given; §10.1 asks for the minimum required context. */
export const MAX_EVIDENCE_CHARS = 20_000;
/** How many bodies, newest last. A meeting with more than this has a transcript in pieces, which is itself a finding. */
export const MAX_EVIDENCE_ROWS = 40;

/**
 * The document the model reads: the meeting's own facts, then each readable
 * body in the order it was filed, labelled with what it is and who filed it.
 *
 * What is EXCLUDED, and said in the return rather than silently dropped:
 * a row that carries only a reference (a recording nothing here can open —
 * G-229 leaves the store undecided), and the agent's own earlier summary,
 * which would make this a summary of a summary.
 */
export function analysisDocument(meeting: MeetingLikeForAnalysis, evidence: readonly EvidenceRowLike[]): {
  text: string;
  readable: number;
  referencesUnread: number;
  ownSummariesSkipped: number;
} {
  const facts = [
    `Meeting: ${meeting.booked_mode ?? meeting.requested_mode}${meeting.purpose ? ` — ${meeting.purpose}` : ''}.`,
    meeting.confirmed_start_at ? `Agreed time: ${meeting.confirmed_start_at}${meeting.timezone ? ` (${meeting.timezone})` : ''}.` : null,
    meeting.outcome ? `Outcome recorded by a person: ${meeting.outcome.replace(/_/g, ' ')}${meeting.completed_at ? ` at ${meeting.completed_at}` : ''}.` : null,
  ].filter((s): s is string => s !== null);

  let referencesUnread = 0;
  let ownSummariesSkipped = 0;
  const bodies: string[] = [];
  for (const row of evidence.slice(0, MAX_EVIDENCE_ROWS)) {
    if (row.artifact_ref?.startsWith(ANALYSIS_REFERENCE_PREFIX)) { ownSummariesSkipped += 1; continue; }
    const body = (row.body ?? '').trim();
    if (body === '') { referencesUnread += 1; continue; }
    const who = row.uploaded_by ? `filed by a person` : 'filed by the system';
    bodies.push(`[${row.kind}, ${row.visibility}, ${who}, ${row.uploaded_at}]\n${body.slice(0, MAX_EVIDENCE_CHARS)}`);
  }

  if (bodies.length === 0) return { text: '', readable: 0, referencesUnread, ownSummariesSkipped };

  const unread = referencesUnread > 0
    ? `\n\n(${referencesUnread} piece(s) of evidence exist only as references — a recording or a file — and were NOT read. Do not guess at their contents.)`
    : '';
  return {
    text: `${facts.join('\n')}\n\nEvidence, in the order it was filed:\n\n${bodies.join('\n\n')}${unread}`,
    readable: bodies.length,
    referencesUnread,
    ownSummariesSkipped,
  };
}

/**
 * The requirement version the analysis PROPOSES — the shape the thread's
 * versions already have, so the owner's existing review path (accept,
 * reject, the client confirmation message) applies unchanged. Bounded to
 * that schema's own limits, and validated against it before it is returned:
 * a mapping that produced a version the row refuses would fail in the
 * runner with a constraint's wording instead of here.
 */
export function analysisAsRequirementPayload(a: MeetingAnalysis): z.infer<typeof requirementPayloadSchema> {
  const constraints = [
    ...(a.budgetSignal ? [`Budget, in the client's words: ${a.budgetSignal}`] : []),
    ...(a.timeline ? [`Timeline, in the client's words: ${a.timeline}`] : []),
    ...a.clientCommitments.map((c) => `Client committed: ${c}`),
    ...a.agencyCommitments.map((c) => `Agency committed: ${c}`),
  ];
  const openQuestions = [
    ...a.needsClarification.map((q) => `Needs clarification: ${q}`),
    ...a.questions.map((q) => `Client asked: ${q}`),
    ...a.unresolved.map((u) => `Unresolved: ${u}`),
    ...a.objections.map((o) => `Objection (${o.category}): ${o.detail}`),
  ];
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return requirementPayloadSchema.parse({
    summary: cap(`${a.ambiguous ? '[AMBIGUOUS EVIDENCE — read with care] ' : ''}${a.summary}`, 2_000),
    scopeItems: a.requirements.slice(0, 50).map((r) => ({ title: cap(r.title, 200), ...(r.detail ? { detail: cap(r.detail, 2_000) } : {}) })),
    constraints: constraints.slice(0, 50).map((c) => cap(c, 500)),
    openQuestions: openQuestions.slice(0, 50).map((q) => cap(q, 500)),
  });
}

/**
 * The note a person reads on the meeting page, filed as INTERNAL summary
 * evidence. Opens with what it is — inference, proposed, not confirmed —
 * because an internal note shown as a fact is the failure §10.3 names.
 */
export function renderAnalysisSummary(a: MeetingAnalysis, provenance: { readable: number; referencesUnread: number; model: string }): string {
  const section = (title: string, items: readonly string[]) => (items.length ? `\n\n${title}\n${items.map((i) => `• ${i}`).join('\n')}` : '');
  return [
    `AI analysis — PROPOSED, not confirmed (Scheduler §10.3). Read from ${provenance.readable} piece(s) of typed evidence by ${provenance.model}; confidence ${a.confidence}${a.ambiguous ? '; the evidence was AMBIGUOUS' : ''}${provenance.referencesUnread ? `; ${provenance.referencesUnread} reference(s) were not read` : ''}.`,
    '',
    a.summary,
    section('Requirements (explicit)', a.requirements.map((r) => `${r.title}${r.detail ? ` — ${r.detail}` : ''}${r.source ? ` [${r.source}]` : ''}`)),
    section('Needs clarification', a.needsClarification),
    section('Questions the client raised', a.questions),
    section('Objections', a.objections.map((o) => `${o.category}: ${o.detail}`)),
    a.budgetSignal ? `\n\nBudget, in their words: ${a.budgetSignal}` : '',
    a.timeline ? `\n\nTimeline, in their words: ${a.timeline}` : '',
    section('Stakeholders', a.stakeholders),
    section('Agency committed to', a.agencyCommitments),
    section('Client committed to', a.clientCommitments),
    a.nextAction ? `\n\nNext action: ${a.nextAction}${a.agreedFollowUp ? ` (agreed: ${a.agreedFollowUp})` : ''}` : a.agreedFollowUp ? `\n\nAgreed follow-up: ${a.agreedFollowUp}` : '',
    section('Unresolved', a.unresolved),
  ].join('');
}

/**
 * The reason the thread is handed to a person with — §10.4, in the 300
 * characters `crm.hand_conversation_to_a_person` keeps. It is what the owner's
 * phone says and what the lead page's banner says, so it names the version
 * to open and says the one thing that matters: nothing here is agreed until
 * a person confirms it with the client.
 */
export function analysisHandoffReason(a: MeetingAnalysis, version: number | null): string {
  const counts = [
    `${a.requirements.length} requirement${a.requirements.length === 1 ? '' : 's'}`,
    ...(a.objections.length ? [`${a.objections.length} objection${a.objections.length === 1 ? '' : 's'}`] : []),
    ...(a.needsClarification.length + a.unresolved.length ? [`${a.needsClarification.length + a.unresolved.length} to clarify`] : []),
  ].join(', ');
  const head = `A meeting was analysed${version ? ` — requirement version ${version} proposed` : ''}: ${counts}${a.ambiguous ? '; the evidence was ambiguous' : ''}.`;
  const tail = ' Confirm with the client before anything is treated as agreed (§10.4).';
  const reason = head + tail;
  return reason.length <= 300 ? reason : `${reason.slice(0, 299)}…`;
}
