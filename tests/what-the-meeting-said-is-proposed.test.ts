import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ANALYSIS_REFERENCE_PREFIX,
  MAX_EVIDENCE_ROWS,
  analysisAsRequirementPayload,
  analysisDocument,
  analysisHandoffReason,
  meetingAnalysisJsonSchema,
  meetingAnalysisSchema,
  renderAnalysisSummary,
  type MeetingAnalysis,
} from '../src/modules/crm/meeting-analysis.ts';
import { requirementPayloadSchema } from '../src/modules/crm/schema.ts';
import { RUNNER_SOURCE } from './_runner-source.ts';

/**
 * What the meeting said is PROPOSED — G-239, the half of G-229 that waited
 * on BLK-001. Executed throughout: the schema, the document the model reads,
 * the version it proposes and the note a person reads are all run here; the
 * runner is read only for where its controls sit, the way every workflow
 * test in this repository does.
 */

const FULL: MeetingAnalysis = {
  summary: 'The client wants a booking app for two clinics.',
  requirements: [{ title: 'Online booking', detail: 'per clinic', source: 'notes: "book online for both branches"' }],
  needsClarification: ['Whether reminders go by WhatsApp or SMS'],
  questions: ['Can it launch before Diwali?'],
  objections: [{ category: 'price', detail: 'Last vendor quoted less' }],
  budgetSignal: '"around two lakh, maybe a bit more"',
  timeline: '"before Diwali"',
  stakeholders: ['Dr. Mehta decides'],
  agencyCommitments: ['Send a quotation by Friday'],
  clientCommitments: ['Share the clinic logos'],
  nextAction: 'Send the quotation',
  agreedFollowUp: 'Friday',
  unresolved: ['Second clinic address'],
  confidence: 'medium',
  ambiguous: false,
};

const meeting = { purpose: 'Discovery call', requested_mode: 'call', booked_mode: 'video_meeting', confirmed_start_at: '2026-09-12T10:00:00Z', timezone: 'Asia/Kolkata', outcome: 'follow_up_required', completed_at: '2026-09-12T10:35:00Z' };
const row = (over: Partial<{ id: string; kind: string; visibility: string; artifact_ref: string | null; body: string | null; uploaded_by: string | null; uploaded_at: string }>) => ({
  id: 'e1', kind: 'notes', visibility: 'internal', artifact_ref: null, body: 'They want online booking for both branches.', uploaded_by: 'u1', uploaded_at: '2026-09-12T10:40:00Z', ...over,
});

describe('A. the shape is §10.2, bounded, and decoder-safe', () => {
  test('a full analysis parses; the JSON schema names every output', () => {
    assert.ok(meetingAnalysisSchema.safeParse(FULL).success);
    const schema = meetingAnalysisJsonSchema() as { properties: Record<string, unknown>; required?: string[] };
    for (const key of ['summary', 'requirements', 'needsClarification', 'questions', 'objections', 'budgetSignal', 'timeline', 'stakeholders', 'agencyCommitments', 'clientCommitments', 'nextAction', 'agreedFollowUp', 'unresolved', 'confidence', 'ambiguous']) {
      assert.ok(key in schema.properties, `${key} is in the schema`);
    }
  });

  test('a number the model computed has nowhere to go: budget and timeline are words, and an unknown objection category is refused', () => {
    assert.equal(meetingAnalysisSchema.safeParse({ ...FULL, budgetSignal: 200000 }).success, false);
    assert.equal(meetingAnalysisSchema.safeParse({ ...FULL, objections: [{ category: 'budget', detail: 'x' }] }).success, false);
    assert.equal(meetingAnalysisSchema.safeParse({ ...FULL, confidence: 'certain' }).success, false);
  });
});

describe('B. the document the model reads is the minimum context (§10.1), and says what it left out', () => {
  test('the meeting’s facts, then each readable body labelled; references are counted, not guessed at', () => {
    const doc = analysisDocument(meeting, [
      row({}),
      row({ id: 'e2', kind: 'recording', artifact_ref: 'ref://rec/1', body: null }),
      row({ id: 'e3', kind: 'summary', visibility: 'client_visible', uploaded_by: null, body: 'Agreed: demo Tuesday' }),
    ]);
    assert.equal(doc.readable, 2);
    assert.equal(doc.referencesUnread, 1);
    assert.match(doc.text, /^Meeting: video_meeting — Discovery call\./);
    assert.match(doc.text, /Outcome recorded by a person: follow up required at 2026-09-12T10:35:00Z/);
    assert.match(doc.text, /\[notes, internal, filed by a person, 2026-09-12T10:40:00Z\]\nThey want online booking/);
    assert.match(doc.text, /\[summary, client_visible, filed by the system/);
    assert.match(doc.text, /1 piece\(s\) of evidence exist only as references .* were NOT read\. Do not guess/);
  });

  test('the agent’s own earlier summary is never read back as evidence, and it is counted as skipped', () => {
    const doc = analysisDocument(meeting, [row({}), row({ id: 'e9', kind: 'summary', artifact_ref: `${ANALYSIS_REFERENCE_PREFIX}run-1`, body: 'AI analysis — PROPOSED …', uploaded_by: null })]);
    assert.equal(doc.readable, 1);
    assert.equal(doc.ownSummariesSkipped, 1);
    assert.doesNotMatch(doc.text, /AI analysis — PROPOSED/);
  });

  test('nothing readable is an empty document, said by the counts', () => {
    const doc = analysisDocument(meeting, [row({ body: null, artifact_ref: 'ref://x' }), row({ body: '   ', artifact_ref: 'ref://y' })]);
    assert.equal(doc.text, '');
    assert.equal(doc.readable, 0);
    assert.equal(doc.referencesUnread, 2);
  });

  test('the row count is bounded', () => {
    const many = Array.from({ length: MAX_EVIDENCE_ROWS + 5 }, (_, i) => row({ id: `e${i}`, body: `note ${i}` }));
    assert.equal(analysisDocument(meeting, many).readable, MAX_EVIDENCE_ROWS);
  });
});

describe('C. the version it proposes is the shape the thread already has, and every fact is labelled as what it is', () => {
  test('requirements become scope items; budget, timeline and commitments become constraints in the client’s words; doubts and objections become open questions', () => {
    const payload = analysisAsRequirementPayload(FULL);
    assert.ok(requirementPayloadSchema.safeParse(payload).success);
    assert.deepEqual(payload.scopeItems, [{ title: 'Online booking', detail: 'per clinic' }]);
    assert.deepEqual(payload.constraints, [
      'Budget, in the client\'s words: "around two lakh, maybe a bit more"',
      'Timeline, in the client\'s words: "before Diwali"',
      'Client committed: Share the clinic logos',
      'Agency committed: Send a quotation by Friday',
    ]);
    assert.deepEqual(payload.openQuestions, [
      'Needs clarification: Whether reminders go by WhatsApp or SMS',
      'Client asked: Can it launch before Diwali?',
      'Unresolved: Second clinic address',
      'Objection (price): Last vendor quoted less',
    ]);
    assert.equal(payload.summary, FULL.summary);
  });

  test('ambiguous evidence is stamped on the summary itself, where the reviewer reads first', () => {
    assert.match(analysisAsRequirementPayload({ ...FULL, ambiguous: true }).summary, /^\[AMBIGUOUS EVIDENCE — read with care\] /);
  });

  test('the model’s bounds are wider than the version’s in places, and the mapping caps rather than fails', () => {
    const wide: MeetingAnalysis = { ...FULL, needsClarification: Array.from({ length: 50 }, (_, i) => `q${i}`), questions: Array.from({ length: 50 }, (_, i) => `a${i}`) };
    const payload = analysisAsRequirementPayload(wide);
    assert.equal(payload.openQuestions.length, 50);
    assert.ok(requirementPayloadSchema.safeParse(payload).success);
  });
});

describe('D. the note a person reads opens with what it is', () => {
  test('inference, proposed, not confirmed — with its provenance and the ambiguity flag', () => {
    const note = renderAnalysisSummary({ ...FULL, ambiguous: true }, { readable: 2, referencesUnread: 1, model: 'claude-sonnet-5' });
    assert.match(note, /^AI analysis — PROPOSED, not confirmed \(Scheduler §10\.3\)\. Read from 2 piece\(s\) of typed evidence by claude-sonnet-5; confidence medium; the evidence was AMBIGUOUS; 1 reference\(s\) were not read\./);
    assert.match(note, /Objections\n• price: Last vendor quoted less/);
    assert.match(note, /Next action: Send the quotation \(agreed: Friday\)/);
    assert.match(note, /Budget, in their words: "around two lakh/);
  });
});

describe('E. where the runner’s controls sit', () => {
  const start = RUNNER_SOURCE.indexOf('const MEETING_ANALYSIS: AgentWorkflow = {');
  const body = RUNNER_SOURCE.slice(start, RUNNER_SOURCE.indexOf('\n};\n', start));

  test('registered, under requirement_collector, as draft work', () => {
    assert.ok(start > 0);
    assert.match(body, /jobKind: 'meeting\.analysis'/);
    assert.match(body, /agentKey: 'requirement_collector'/);
    assert.match(body, /workClass: 'draft'/);
    assert.match(RUNNER_SOURCE, /THREAD_SUMMARY,\n {2}MEETING_ANALYSIS,\n\]/);
  });

  test('the idempotency read and the no-readable-evidence parking both come BEFORE the model call', () => {
    const call = body.indexOf('callModel(ctx, this');
    assert.ok(body.indexOf("trigger', `job:${job.id}`") < call, 'an earlier succeeded run settles the job without a call');
    assert.ok(body.indexOf("status: 'dead'") < call, 'no readable evidence parks the job without a call');
    assert.match(body, /then requeue this job from the Operations page/, 'the way back is the one that works: the gate holds the key for a parked job too');
    assert.match(body, /finishRun\(admin, runId, 'cancelled', 'superseded:/, 'a lost race closes the run with a status the table admits');
  });

  test('what is written: an internal summary marked as the agent’s own, a PROPOSED version, the thread handed to a person, the event, and an audit row', () => {
    assert.match(body, /kind: 'summary',\s+visibility: 'internal',\s+artifact_ref: `\$\{ANALYSIS_REFERENCE_PREFIX\}/);
    assert.match(body, /p_status: 'proposed'/);
    assert.match(RUNNER_SOURCE, /p_action: 'meeting\.analysis_completed'/);
    assert.match(body, /no conversation is linked to this meeting, so no requirement version was proposed/);
    // G-240: §10.4 through the door that exists — its trigger emits
    // conversation.escalated and the existing announcer tells the owner.
    // The tail — handover, event, audit — is ONE function, and it is reached
    // from the normal path, the "already analysed" branch and the lost race,
    // so a handover the last attempt could not make is finished from what
    // was stored (review of the first draft: a swallowed error or a crash
    // between the version and the handover lost it forever).
    const tailStart = RUNNER_SOURCE.indexOf('async function finishMeetingAnalysis(');
    const tail = RUNNER_SOURCE.slice(tailStart, RUNNER_SOURCE.indexOf('\n}\n', tailStart));
    const handover = tail.indexOf("rpc('hand_conversation_to_a_person'");
    const emit = tail.indexOf("p_type: 'meeting.analysed'");
    const audit = tail.indexOf("p_action: 'meeting.analysis_completed'");
    assert.ok(handover > 0 && handover < emit && emit < audit, 'the handover, then the event, then the audit row');
    assert.match(tail, /handedOver = paused \? 'handed_over' : 'already_waiting'/, 'a thread already waiting is one handover, said');
    assert.match(tail, /\.eq\('action', 'meeting\.analysis_completed'\)[\s\S]*if \(!existing\)/, 'the event is emitted once per meeting, guarded by the audit row written with it');
    assert.equal((body.match(/finishMeetingAnalysis\(ctx, meeting/g) ?? []).length, 3, 'the normal path, the already-analysed branch and the lost race all finish the tail');
    assert.match(body, /analysed, but the thread could not be handed over/, 'a handover that fails fails the JOB, after the run succeeded, so the queue brings it back');
    assert.doesNotMatch(body + tail, /send_outbound_message|sendWhatsAppText/, 'no second notifier: the announcement rides the escalation');
  });

  test('the reason the thread is handed over with names the version, counts what was found, and says nothing is agreed yet — in 300 characters', () => {
    const reason = analysisHandoffReason(FULL, 3);
    assert.equal(reason, 'A meeting was analysed — requirement version 3 proposed: 1 requirement, 1 objection, 2 to clarify. Confirm with the client before anything is treated as agreed (§10.4).');
    assert.match(analysisHandoffReason({ ...FULL, ambiguous: true, objections: [], needsClarification: [], unresolved: [] }, null), /^A meeting was analysed: 1 requirement; the evidence was ambiguous\. Confirm/);
    const many: MeetingAnalysis = { ...FULL, requirements: Array.from({ length: 50 }, (_, i) => ({ title: `r${i}` })) };
    assert.ok(analysisHandoffReason(many, 12345678).length <= 300);
  });
});
