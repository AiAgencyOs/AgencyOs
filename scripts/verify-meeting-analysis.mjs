// ═══════════════════════════════════════════════════════════════════════════
// What the meeting said is proposed — G-239
//
// Scheduler §9.3 (MARK COMPLETED → VALIDATE EVIDENCE → LINK ARTIFACTS →
// CREATE AI ANALYSIS TASK) and §10 (the analysis: minimum context, §10.2's
// outputs, §10.3's guardrails — inference is not a fact, nothing is
// invented, ambiguity is flagged). G-229 built the gate and left the worker
// to BLK-001; this drives the worker through the REAL job runner against a
// stub model on the port the app is pointed at (ANTHROPIC_BASE_URL).
//
// Every section asserts a row that exists or a refusal by name, with its
// positive twin: the note filed and marked as the agent's own, the version
// PROPOSED (never accepted), the audit row, the job settled once and only
// once, a meeting with nothing readable parked with the reason, a model
// answer the schema refuses failed and retried, and the retry succeeding.
//
//   node scripts/verify-meeting-analysis.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

const STUB_PORT = 54399;

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}
function abort(message) {
  throw new Error(message);
}

const target = resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'what the meeting said is proposed, never confirmed');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zztest-analysis-${randomUUID().slice(0, 8)}`;
const APP = target.app;
const fx = fixturesFor(target, ORG);
const { rest, one, call } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const rpc = (fn, args, token) => (token ? call(token, 'POST', 'crm', `rpc/${fn}`, args) : rest('POST', 'crm', `rpc/${fn}`, args));
const HOURS = 3_600_000;

// ── the stub model ─────────────────────────────────────────────────────────

/** Must satisfy meetingAnalysisSchema exactly — the runner refuses anything else. */
const ANALYSIS = {
  summary: 'The client wants an online booking app for two dental clinics.',
  requirements: [{ title: 'Online appointment booking', detail: 'for both branches', source: 'notes' }],
  needsClarification: ['Reminders by WhatsApp or SMS'],
  questions: ['Can it be live before Diwali?'],
  objections: [{ category: 'price', detail: 'The last vendor quoted less' }],
  budgetSignal: '"around two lakh"',
  timeline: '"before Diwali"',
  stakeholders: ['Dr. Mehta decides'],
  agencyCommitments: ['Quotation by Friday'],
  clientCommitments: ['Share the clinic logos'],
  nextAction: 'Send the quotation',
  agreedFollowUp: 'Friday',
  unresolved: ['Second clinic address'],
  confidence: 'medium',
  ambiguous: false,
};

let stubMode = 'ok';
/** Calls made FOR THIS WORKFLOW. The shared CI project may hold other queued agent work that the same ticks claim and the same stub answers; CI's first run counted three calls for one analysis. Told apart by the schema the runner asks for. */
let modelCalls = 0;
let otherCalls = 0;
let lastPrompt = '';
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { /* counted as other */ }
    const mine = JSON.stringify(parsed).includes('completed sales meeting');
    if (mine) { modelCalls += 1; lastPrompt = JSON.stringify(parsed.messages ?? []); } else { otherCalls += 1; }
    const text = mine && stubMode === 'garbage' ? JSON.stringify({ summary: 42, confidence: 'certain' }) : JSON.stringify(ANALYSIS);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text }], usage: { input_tokens: 40, output_tokens: 30 },
    }));
  });
});
await new Promise((resolve, reject) => { stub.on('error', reject); stub.listen(STUB_PORT, '127.0.0.1', resolve); })
  .catch((error) => fail(`could not bind the model stub on ${STUB_PORT}: ${error.message}`));

/** One tick of the real job runner. */
async function tick() {
  const res = await fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const jobRow = async (id) => one(await rest('GET', 'core', `jobs?id=eq.${id}&select=id,status,attempts,last_error,run_at`));
/**
 * Ticks until the runner has CLAIMED the job once more than before (the claim
 * increments attempts), then reports the row as settled by that attempt — a
 * failed attempt is requeued with a backoff, so "left queued" is not the
 * signal. Other queued work in the shared project may be claimed first; a
 * tick that is not 200 is reported as such rather than read as an outcome.
 */
async function runUntilClaimed(jobId, maxTicks = 12) {
  const before = (await jobRow(jobId))?.attempts ?? 0;
  for (let i = 0; i < maxTicks; i += 1) {
    const t = await tick();
    if (t.status !== 200) return { job: await jobRow(jobId), tickFailed: t.status };
    const job = await jobRow(jobId);
    if (job && job.attempts > before && job.status !== 'running') return { job, tickFailed: null };
    await delay(400);
  }
  return { job: await jobRow(jobId), tickFailed: null, gaveUp: true };
}

const created = { contacts: [], leads: [], conversations: [], meetings: [], jobs: [], users: [] };

async function person(role) {
  const authUser = await fetch(`${target.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}-${role}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  if (!authUser?.id) abort(`could not create an auth user: ${JSON.stringify(authUser).slice(0, 200)}`);
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role, status: 'active' });
  return { id: authUser.id, token: fx.mint(authUser.id, role) };
}

/** A completed meeting on a real thread, concluded by the owner with `note` (or without one). */
async function completedMeeting(name, owner, { note, withConversation = true } = {}) {
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} ${name}`, phone: `+9198${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-8)}`, preferred_language: 'hi' }));
  created.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, source: 'manual', title: `${MARKER} ${name}`, status: 'new' }));
  created.leads.push(lead.id);
  let conversationId = null;
  if (withConversation) {
    const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, channel: 'whatsapp', external_ref: `${MARKER}:${name}`, status: 'active' }));
    if (!conv?.id) abort(`could not create a conversation: ${JSON.stringify(conv).slice(0, 200)}`);
    created.conversations.push(conv.id);
    conversationId = conv.id;
  }
  const m = one(await rest('POST', 'crm', 'meetings', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id, ...(conversationId ? { conversation_id: conversationId } : {}),
    requested_mode: 'call', status: 'proposed', purpose: 'Discovery call', availability_source: 'google:primary', availability_read_at: new Date().toISOString(),
  }));
  if (!m?.id) abort(`could not create a meeting: ${JSON.stringify(m).slice(0, 200)}`);
  created.meetings.push(m.id);
  const start = new Date(Date.now() + HOURS);
  const booked = one(await rpc('book_meeting', { p_meeting_id: m.id, p_booking_key: `${MARKER}-${name}`, p_start_at: start.toISOString(), p_end_at: new Date(start.getTime() + HOURS / 2).toISOString(), p_timezone: 'Asia/Kolkata', p_mode: 'call' }));
  if (booked?.outcome !== 'booked') abort(`could not book ${name}: ${booked?.outcome}`);
  await rest('PATCH', 'crm', `meetings?id=eq.${m.id}`, { confirmed_start_at: new Date(Date.now() - 2 * HOURS).toISOString(), confirmed_end_at: new Date(Date.now() - HOURS).toISOString() });
  const done = one(await rpc('complete_meeting', { p_meeting_id: m.id, p_outcome: 'follow_up_required', ...(note ? { p_note: note } : {}) }, owner.token));
  if (done?.outcome !== 'completed') abort(`could not complete ${name}: ${done?.outcome}`);
  return { meeting: m, lead, conversationId, analysis: done.analysis };
}

const analysisJob = async (meetingId) => one(await rest('GET', 'core', `jobs?kind=eq.meeting.analysis&payload->>meeting_id=eq.${meetingId}&select=id,status,attempts,last_error,run_at`));
const evidenceRows = async (meetingId) => (await rest('GET', 'crm', `meeting_evidence?meeting_id=eq.${meetingId}&select=id,kind,visibility,artifact_ref,body,uploaded_by&order=uploaded_at.asc`)).json ?? [];
const runsFor = async (jobId) => (await rest('GET', 'ai', `agent_runs?trigger=eq.job:${jobId}&select=id,status,agent_key,subject_type,subject_id,work_class,output`)).json ?? [];
const versionsFor = async (jobId) => (await rest('GET', 'crm', `requirement_versions?source_job_id=eq.${jobId}&select=id,version,status,payload,conversation_id`)).json ?? [];
const auditsFor = async (meetingId) => (await rest('GET', 'audit', `audit_log?subject_type=eq.meeting&subject_id=eq.${meetingId}&action=eq.meeting.analysis_completed&select=id,actor_type,after`)).json ?? [];

console.log('\n\x1b[1mAgencyOS — what the meeting said is proposed (G-239)\x1b[0m');

try {
  const owner = await person('owner');

  // ── 1. the chain, end to end ─────────────────────────────────────────────
  console.log('\n1. A completed meeting with a typed note, analysed by the real runner');
  {
    const { meeting, conversationId, analysis } = await completedMeeting('chain', owner, { note: 'Client wants online booking for both branches. Budget around two lakh. Wants it before Diwali.' });
    check(analysis === 'queued', 'completing with a note queued the analysis (§9.3)', `analysis ${analysis}`);
    const job = await analysisJob(meeting.id);
    check(Boolean(job?.id) && job.status === 'queued', 'the meeting.analysis job exists and is queued');
    created.jobs.push(job.id);

    const before = modelCalls;
    const { job: settled, tickFailed, gaveUp } = await runUntilClaimed(job.id);
    check(!tickFailed && !gaveUp, 'the runner ticked and claimed the job', tickFailed ? `tick answered ${tickFailed}` : gaveUp ? 'not claimed within the ticks allowed' : '');
    check(settled?.status === 'succeeded', 'the runner settled the job as succeeded', `status ${settled?.status}${settled?.last_error ? ` — ${settled.last_error}` : ''}`);
    check(modelCalls === before + 1, 'exactly one model call was made for this analysis', `${modelCalls - before} (and ${otherCalls} for other queued work the same ticks claimed)`);
    check(/Client wants online booking for both branches/.test(lastPrompt), 'the model was given the typed note, not the conversation');
    check(/Outcome recorded by a person: follow up required/.test(lastPrompt), 'and the meeting’s own facts');

    const runs = await runsFor(job.id);
    check(runs.length === 1 && runs[0].status === 'succeeded', 'one agent run, succeeded', JSON.stringify(runs.map((r) => r.status)));
    check(runs[0]?.agent_key === 'requirement_collector' && runs[0]?.work_class === 'draft', 'under requirement_collector, as draft work (ADM-61 §2)', `${runs[0]?.agent_key} / ${runs[0]?.work_class}`);
    check(runs[0]?.subject_type === 'crm.meeting' && runs[0]?.subject_id === meeting.id, 'the run’s subject is the meeting');
    check(runs[0]?.output?.summary === ANALYSIS.summary, 'the run’s output is the analysis the model returned');

    const ev = await evidenceRows(meeting.id);
    const note = ev.find((e) => e.kind === 'summary');
    check(ev.length === 2, 'the meeting now carries the note and the analysis', `${ev.length} rows`);
    check(Boolean(note) && note.visibility === 'internal' && note.uploaded_by === null, 'the analysis is INTERNAL summary evidence filed by the system');
    check(note?.artifact_ref === `agent_run:${runs[0]?.id}`, 'and marked as the agent’s own, referencing its run', note?.artifact_ref);
    check(/^AI analysis — PROPOSED, not confirmed \(Scheduler §10\.3\)/.test(note?.body ?? ''), 'its first line says what it is');
    check(/Budget, in their words: "around two lakh"/.test(note?.body ?? ''), 'the budget is the client’s words, never a number');

    const versions = await versionsFor(job.id);
    check(versions.length === 1 && versions[0].status === 'proposed', 'a requirement version is PROPOSED on the thread — never accepted by the agent', JSON.stringify(versions.map((v) => v.status)));
    check(versions[0]?.conversation_id === conversationId, 'on the meeting’s own conversation');
    check(versions[0]?.payload?.scopeItems?.[0]?.title === 'Online appointment booking', 'in the shape the thread’s versions already have');
    check((versions[0]?.payload?.openQuestions ?? []).some((q) => /^Objection \(price\)/.test(q)), 'with the objection carried as an open question');

    const audits = await auditsFor(meeting.id);
    check(audits.length === 1 && audits[0].actor_type === 'system', 'audited as meeting.analysis_completed by the system');
    check(audits[0]?.after?.version === versions[0]?.version && audits[0]?.after?.evidence_id === note?.id, 'the audit row names the version and the note');

    // Idempotent on the job: put it back in the queue and tick again.
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, { status: 'queued', run_at: new Date().toISOString(), locked_at: null, locked_by: null });
    const before2 = modelCalls;
    const { job: again } = await runUntilClaimed(job.id);
    check(again?.status === 'succeeded', 'run again, the job settles', `status ${again?.status}`);
    check(modelCalls === before2, 'without a second model call for this analysis');
    check((await evidenceRows(meeting.id)).filter((e) => e.kind === 'summary').length === 1 && (await versionsFor(job.id)).length === 1, 'and without a second note or version');

    const gate = one(await rpc('request_meeting_analysis', { p_meeting_id: meeting.id }, owner.token));
    check(gate?.outcome === 'already_queued', 'asking the gate again answers already_queued: one analysis per meeting', `outcome ${gate?.outcome}`);
  }

  // ── 2. nothing readable ──────────────────────────────────────────────────
  console.log('\n2. A meeting whose only evidence is a reference');
  {
    const { meeting, analysis } = await completedMeeting('reference', owner, { note: null });
    check(analysis === 'no_evidence', 'completing without a note queues nothing (§10.1)', `analysis ${analysis}`);
    const filed = one(await rpc('add_meeting_evidence', { p_meeting_id: meeting.id, p_kind: 'recording', p_artifact_ref: 'ref://recording/1' }));
    check(filed?.outcome === 'attached', 'the worker files a recording by reference');
    const gate = one(await rpc('request_meeting_analysis', { p_meeting_id: meeting.id }, owner.token));
    check(gate?.outcome === 'queued', 'the gate counts it as evidence and queues', `outcome ${gate?.outcome}`);
    const job = await analysisJob(meeting.id);
    created.jobs.push(job.id);
    const before = modelCalls;
    const { job: settled } = await runUntilClaimed(job.id);
    check(settled?.status === 'dead', 'the runner PARKS it: nothing here can open a recording', `status ${settled?.status}`);
    check(/nothing readable: 1 reference\(s\)/.test(settled?.last_error ?? '') && /requeue this job from the Operations page/.test(settled?.last_error ?? ''), 'with the reason a person can act on, and the way back that works', settled?.last_error);
    const again = one(await rpc('request_meeting_analysis', { p_meeting_id: meeting.id }, owner.token));
    check(again?.outcome === 'already_queued', 'the gate holds the key for a parked job too (G-229: a person requeues it)', `outcome ${again?.outcome}`);
    check(modelCalls === before, 'and no model was asked to guess at it (for this analysis)');
    check((await runsFor(job.id)).length === 0 && (await evidenceRows(meeting.id)).length === 1, 'no run, no note');
  }

  // ── 3. an answer the schema refuses, then the retry ─────────────────────
  console.log('\n3. A model answer the schema refuses');
  {
    const { meeting } = await completedMeeting('garbage', owner, { note: 'Short call; they will send the brief.' });
    const job = await analysisJob(meeting.id);
    created.jobs.push(job.id);
    stubMode = 'garbage';
    const { job: failed } = await runUntilClaimed(job.id);
    check(failed?.status === 'queued' && failed?.attempts === 1 && /schema validation/.test(failed?.last_error ?? ''), 'refused by the schema (§6.6), requeued for a later tick', `${failed?.status} / attempt ${failed?.attempts} / ${failed?.last_error}`);
    const runs = await runsFor(job.id);
    check(runs.length === 1 && runs[0].status === 'failed', 'the run records the failure');
    check((await evidenceRows(meeting.id)).filter((e) => e.kind === 'summary').length === 0 && (await versionsFor(job.id)).length === 0, 'nothing was filed from a refused answer');

    stubMode = 'ok';
    await rest('PATCH', 'core', `jobs?id=eq.${job.id}`, { run_at: new Date().toISOString() });
    const { job: retried } = await runUntilClaimed(job.id);
    check(retried?.status === 'succeeded', 'the retry, answered properly, succeeds (the positive twin)', `status ${retried?.status}`);
    check((await runsFor(job.id)).filter((r) => r.status === 'succeeded').length === 1, 'with a second run, succeeded');
    check((await evidenceRows(meeting.id)).filter((e) => e.kind === 'summary').length === 1 && (await versionsFor(job.id)).length === 1, 'and the note and version filed once');
  }

  // ── 4. a meeting with no thread ──────────────────────────────────────────
  console.log('\n4. A meeting not linked to a conversation');
  {
    const { meeting } = await completedMeeting('threadless', owner, { note: 'Walk-in; wants a website.', withConversation: false });
    const job = await analysisJob(meeting.id);
    created.jobs.push(job.id);
    const { job: settled } = await runUntilClaimed(job.id);
    check(settled?.status === 'succeeded', 'analysed', `status ${settled?.status}`);
    check((await evidenceRows(meeting.id)).filter((e) => e.kind === 'summary').length === 1, 'the note is filed');
    check((await versionsFor(job.id)).length === 0, 'no requirement version is invented for a thread that does not exist');
    const audits = await auditsFor(meeting.id);
    check(/no conversation is linked/.test(String(audits[0]?.after?.note)), 'and the audit row says so');
  }
} catch (error) {
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m the run stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  stub.close();
  for (const id of created.jobs) {
    await rest('DELETE', 'crm', `requirement_versions?source_job_id=eq.${id}`);
    const runs = await runsFor(id);
    for (const r of runs) { await rest('DELETE', 'ai', `agent_steps?run_id=eq.${r.id}`); await rest('DELETE', 'ai', `agent_runs?id=eq.${r.id}`); }
    await rest('DELETE', 'core', `jobs?id=eq.${id}`);
  }
  for (const id of created.meetings) {
    await rest('DELETE', 'core', `jobs?kind=in.(meeting.reminder,meeting.analysis)&payload->>meeting_id=eq.${id}`);
    await rest('DELETE', 'crm', `meetings?id=eq.${id}`);
  }
  for (const id of created.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${target.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}` }, cache: 'no-store' }).catch(() => {});
  }
  await fx.cleanup();
}

console.log(
  failures === 0
    ? `\n\x1b[32m✔ ${checks} checks passed — what the meeting said is proposed, never confirmed\x1b[0m\n`
    : `\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
