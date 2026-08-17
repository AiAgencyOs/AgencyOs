/**
 * The follow-up worker, executed — gap G-012, decision ADM-69.
 *
 * Everything before this exercised the *schema the worker refuses with*. This
 * runs `runFollowUps` itself, the real function from
 * `src/modules/crm/follow-up-worker.ts`, against a real database, and asserts
 * on rows rather than on logs.
 *
 * Nothing is mocked. The provider boundary does not need to be: the worker
 * ends at `crm.send_outbound_message`, which writes the message row and hands
 * the recipient back — the provider call happens later, in the outbound
 * dispatcher. So the whole worker path is exercisable for real, and what is
 * *not* proved here is delivery, which stays external.
 *
 *   npx tsx --conditions=react-server --import ./tests/_alias.mjs \
 *     scripts/verify-follow-up-worker.ts
 */

import { randomUUID } from 'node:crypto';

import { createAdminClient } from '@/lib/db/admin';
import { runFollowUps } from '@/modules/crm/follow-up-worker';

const admin = createAdminClient();
const MARK = `zzwrk-${randomUUID().slice(0, 8)}`;

let checks = 0;
let failures = 0;

function check(ok: boolean, description: string, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${description}`);
    return;
  }
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

/** Rows, never logs: the worker's own counters are not evidence about the database. */
async function attemptsFor(sequenceId: string) {
  const { data } = await admin
    .schema('crm')
    .from('follow_up_sends')
    .select('attempt, outcome, suppression_reason')
    .eq('sequence_id', sequenceId);
  return data ?? [];
}

async function messagesIn(conversationId: string) {
  const { data } = await admin
    .schema('crm')
    .from('conversation_messages')
    .select('id, external_ref, body, metadata')
    .eq('conversation_id', conversationId);
  return data ?? [];
}

async function sequenceRow(id: string) {
  const { data } = await admin
    .schema('crm')
    .from('follow_up_sequences')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  return data;
}

type Fixture = {
  org: string;
  contact: string;
  lead: string;
  conversation: string;
  sequence: string;
};

const made: {
  orgs: string[]; leads: string[]; conversations: string[]; contacts: string[];
  sequences: string[]; accounts?: string[]; projects?: string[];
} = { orgs: [], leads: [], conversations: [], contacts: [], sequences: [] };

/**
 * A lead that is genuinely eligible: consented contact, live thread, and a
 * trigger far enough back that Sales-Nurture's day 7 is comfortably past.
 */
async function makeFixture(label: string, opts: { consent: boolean; timezone: string | null }): Promise<Fixture> {
  const { data: org } = await admin
    .schema('core')
    .from('organizations')
    .insert({ name: `${MARK} ${label}`, slug: `${MARK}-${label}`.toLowerCase(), timezone: opts.timezone })
    .select('id')
    .single();
  made.orgs.push(org!.id);

  const { data: contact } = await admin
    .schema('crm')
    .from('contacts')
    .insert({ organization_id: org!.id, full_name: `${MARK} ${label}`, phone: `+9197${Date.now() % 100000000}` })
    .select('id')
    .single();
  made.contacts.push(contact!.id);

  if (opts.consent) {
    await admin.schema('crm').from('communication_consent').insert({
      organization_id: org!.id, contact_id: contact!.id, channel: 'whatsapp', status: 'granted',
    });
  }

  const { data: lead } = await admin
    .schema('crm')
    .from('leads')
    .insert({ organization_id: org!.id, title: `${MARK} ${label}`, contact_id: contact!.id, status: 'qualifying' })
    .select('id')
    .single();
  made.leads.push(lead!.id);

  const { data: conversation } = await admin
    .schema('crm')
    .from('conversations')
    .insert({
      organization_id: org!.id, kind: 'direct', channel: 'whatsapp',
      lead_id: lead!.id, contact_id: contact!.id,
    })
    .select('id')
    .single();
  made.conversations.push(conversation!.id);

  // Forty days back, so Sales-Nurture's day 7 is long past and only policy
  // stands between the sequence and a send.
  const { data: seq } = await admin.schema('crm').rpc('start_follow_up_sequence', {
    p_organization_id: org!.id,
    p_situation_key: 'inactive_lead',
    p_subject_type: 'lead',
    p_subject_id: lead!.id,
    p_triggered_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    p_conversation_id: conversation!.id,
  });
  const sequence = (Array.isArray(seq) ? seq[0] : seq) as { sequence_id: string };
  made.sequences.push(sequence.sequence_id);

  // Due in the past, so timing is not what is being tested here.
  await admin.schema('crm').from('follow_up_sequences')
    .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString() })
    .eq('id', sequence.sequence_id);

  return {
    org: org!.id, contact: contact!.id, lead: lead!.id,
    conversation: conversation!.id, sequence: sequence.sequence_id,
  };
}

/**
 * Sequences that existed before this script ran.
 *
 * This script drives the **real** worker, which starts sequences for every
 * eligible row in the database — including seed data it did not create. Left
 * behind, those make the next script's observer return nothing, which is how
 * `db:verify:followup` started failing on a green worker. Cleaning up only its
 * own fixtures was not enough: it has to undo what the worker did.
 */
let preexisting = new Set<string>();

async function snapshot() {
  const { data } = await admin.schema('crm').from('follow_up_sequences').select('id');
  preexisting = new Set((data ?? []).map((r) => r.id));
}


/**
 * Make a due sequence due again, as if its spacing had elapsed.
 *
 * The worker floors the next attempt at the rhythm's spacing after the message
 * that actually went — the fix for the catch-up flood. Driving a rhythm to
 * exhaustion in a test therefore means moving the clock, and the clock is in
 * two columns: `last_sent_at` and `next_due_at`.
 *
 * This changes only test-controlled timestamps. ADM-69's recorded day numbers
 * and maxima are untouched.
 */
async function makeDueAgain(sequenceId: string) {
  await admin.schema('crm').from('follow_up_sequences').update({
    last_sent_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
  }).eq('id', sequenceId);
}

/*
 * A post-project fixture used to live here and was removed after it found
 * G-139: a completed project has NO legal conversation to send on. `direct`
 * requires a lead, the project group is G-136, and the internal group is not
 * a client - so situation 8 is observable and undeliverable, which is a gap
 * rather than a fixture problem. Section 11 pins that state.
 */

async function cleanup() {
  // Everything the worker started that was not there before.
  const { data: now } = await admin.schema('crm').from('follow_up_sequences').select('id');
  for (const row of now ?? []) {
    if (preexisting.has(row.id)) continue;
    await admin.schema('crm').from('follow_up_sends').delete().eq('sequence_id', row.id);
    await admin.schema('crm').from('follow_up_sequences').delete().eq('id', row.id);
  }
  await admin.schema('core').from('outbox_events').delete().eq('type', 'followup.queued');

  for (const id of made.sequences) {
    await admin.schema('crm').from('follow_up_sends').delete().eq('sequence_id', id);
    await admin.schema('crm').from('follow_up_sequences').delete().eq('id', id);
  }
  for (const id of made.conversations) {
    await admin.schema('crm').from('conversation_messages').delete().eq('conversation_id', id);
    await admin.schema('crm').from('conversations').delete().eq('id', id);
  }
  for (const id of made.leads) await admin.schema('crm').from('leads').delete().eq('id', id);
  // The contact's cascade takes its consent with it — consent is no longer
  // separately deletable (20260815130000).
  for (const id of made.contacts) {
    await admin.schema('crm').from('contacts').delete().eq('id', id);
  }
  for (const id of made.projects ?? []) {
    await admin.schema('projects').from('handovers').delete().eq('project_id', id);
    await admin.schema('projects').from('projects').delete().eq('id', id);
  }
  for (const id of made.accounts ?? []) await admin.schema('core').from('client_accounts').delete().eq('id', id);
  for (const id of made.orgs) await admin.schema('core').from('organizations').delete().eq('id', id);
}

async function main() {
  console.log('\n\x1b[1mAgencyOS — the follow-up worker, executed (G-012)\x1b[0m');
  await snapshot();

  // ── 1. the whole path, for real ────────────────────────────────────────
  console.log('\n1. A consented lead in a zoned organization receives exactly one message');
  const live = await makeFixture('live', { consent: true, timezone: 'Asia/Kolkata' });
  {
    await runFollowUps(admin);

    const attempts = await attemptsFor(live.sequence);
    check(attempts.length === 1, 'exactly one attempt was claimed', `${attempts.length}`);
    check(attempts[0]?.attempt === 1, 'and it is attempt 1', `${attempts[0]?.attempt}`);
    check(attempts[0]?.outcome === 'sent', 'recorded as sent', `${attempts[0]?.outcome}`);

    const messages = await messagesIn(live.conversation);
    check(messages.length === 1, 'exactly one message exists in the thread', `${messages.length}`);
    check(
      messages[0]?.external_ref === `followup:${live.sequence}:1`,
      'with a derived dedupe key, not a random one',
      `${messages[0]?.external_ref}`,
    );

    const row = await sequenceRow(live.sequence);
    check(row?.attempts_sent === 1, 'the sequence advanced to one attempt', `${row?.attempts_sent}`);
    check(row?.last_block_reason === null, 'and carries no block reason', `${row?.last_block_reason}`);
    check(row?.next_due_at !== null, 'and has a next attempt scheduled');
  }

  // ── 1b. the message is actually handed onward ──────────────────────────
  //
  // `send_outbound_message` leaves a message `pending`; something has to give
  // it to the provider. Tracing that lifecycle is what found the defect: the
  // worker wrote the row and stopped, so a follow-up would have sat pending
  // forever while every counter said it had been sent.
  console.log('\n1b. And the message is queued for delivery, not left pending');
  {
    const { data: events } = await admin
      .schema('core')
      .from('outbox_events')
      .select('type, subject_id, payload')
      .eq('type', 'followup.queued')
      .eq('subject_id', live.sequence);
    check((events ?? []).length === 1, 'a followup.queued event was emitted', `${(events ?? []).length}`);
    const payload = (events ?? [])[0]?.payload as { externalRef?: string } | null;
    check(
      payload?.externalRef === `followup:${live.sequence}:1`,
      'carrying the same derived reference the message has',
      `${payload?.externalRef}`,
    );

    const messages = await messagesIn(live.conversation);
    const meta = (messages[0] as { metadata?: { delivery?: string } } | undefined)?.metadata;
    check(meta?.delivery === 'pending', 'and the message is pending, awaiting the provider', `${meta?.delivery}`);
  }

  // ── 2. run it again ────────────────────────────────────────────────────
  console.log('\n2. Running it again sends nothing more');
  {
    const before = (await messagesIn(live.conversation)).length;
    await runFollowUps(admin);
    const after = await messagesIn(live.conversation);
    check(after.length === before, 'no additional message', `${before} → ${after.length}`);
    const attempts = await attemptsFor(live.sequence);
    check(attempts.length === 1, 'and no additional attempt', `${attempts.length}`);
  }

  // ── 3. two workers at once ─────────────────────────────────────────────
  console.log('\n3. Two workers running concurrently produce one send');
  const race = await makeFixture('race', { consent: true, timezone: 'Asia/Kolkata' });
  {
    // Genuinely concurrent, not serialised: both see the same due sequence.
    await Promise.all([runFollowUps(admin), runFollowUps(admin)]);

    const attempts = await attemptsFor(race.sequence);
    check(attempts.length === 1, 'exactly one attempt exists', `${attempts.length}`);
    const messages = await messagesIn(race.conversation);
    check(messages.length === 1, 'and exactly one message', `${messages.length}`);
  }

  // ── 4. consent, as the worker sees it ──────────────────────────────────
  //
  // Honest scope, established by red-proofing: removing the consent guard from
  // `crm.send_outbound_message` leaves these checks **green**, because the
  // worker asks about consent before it claims. So this proves the worker's
  // pre-check, not the chokepoint.
  //
  // The chokepoint's own enforcement is proved separately by
  // `db:verify:consent`, which red-proofs green→red when the guard is dropped.
  // Two layers, verified in the two places they live — and if they ever
  // disagree, the chokepoint is right.
  console.log('\n4. No consent, no send — the worker declines before claiming');
  const quiet = await makeFixture('noconsent', { consent: false, timezone: 'Asia/Kolkata' });
  {
    await runFollowUps(admin);
    check((await messagesIn(quiet.conversation)).length === 0, 'a lead with no consent receives nothing');
    const row = await sequenceRow(quiet.sequence);
    check(row?.attempts_sent === 0, 'and no attempt is consumed by the refusal', `${row?.attempts_sent}`);
    check(row?.last_block_reason === 'no_consent', 'the reason is recorded', `${row?.last_block_reason}`);

    await admin.schema('crm').from('communication_consent').insert({
      organization_id: quiet.org, contact_id: quiet.contact, channel: 'whatsapp', status: 'granted',
    });
    await runFollowUps(admin);
    check((await messagesIn(quiet.conversation)).length === 1, 'granting consent makes it eligible');

    await admin.schema('crm').from('communication_consent')
      .update({ status: 'withdrawn' })
      .eq('contact_id', quiet.contact).eq('channel', 'whatsapp');
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString() })
      .eq('id', quiet.sequence);
    await runFollowUps(admin);
    check((await messagesIn(quiet.conversation)).length === 1, 'and withdrawing it stops the next one');
  }

  // ── 5. revalidation ────────────────────────────────────────────────────
  console.log('\n5. Observation is not authorization');
  {
    const converted = await makeFixture('converted', { consent: true, timezone: 'Asia/Kolkata' });
    await admin.schema('crm').from('leads')
      .update({ status: 'converted', converted_at: new Date().toISOString() })
      .eq('id', converted.lead);
    await runFollowUps(admin);
    check((await messagesIn(converted.conversation)).length === 0, 'a lead that converted receives nothing');
    const row = await sequenceRow(converted.sequence);
    check(row?.status === 'stopped', 'and its sequence is stopped', `${row?.status}`);
    check(Boolean(row?.stop_reason), 'with a reason', `${row?.stop_reason}`);

    const replied = await makeFixture('replied', { consent: true, timezone: 'Asia/Kolkata' });
    await admin.schema('crm').from('conversation_messages').insert({
      organization_id: replied.org, conversation_id: replied.conversation, seq: 0,
      author_type: 'client', body: 'still here', occurred_at: new Date().toISOString(),
      external_ref: `${MARK}-reply`,
    });
    await runFollowUps(admin);
    const after = await messagesIn(replied.conversation);
    check(after.length === 1, 'a lead that replied receives nothing further', `${after.length}`);
    check((await sequenceRow(replied.sequence))?.status === 'stopped', 'and its sequence stops');
  }

  // ── 6. no timezone, no send ────────────────────────────────────────────
  console.log('\n6. Without an agency timezone the worker refuses (G-137)');
  {
    const unzoned = await makeFixture('unzoned', { consent: true, timezone: null });
    await runFollowUps(admin);
    await runFollowUps(admin);
    await runFollowUps(admin);

    check((await messagesIn(unzoned.conversation)).length === 0, 'nothing is sent');
    const row = await sequenceRow(unzoned.sequence);
    check(row?.attempts_sent === 0, 'three runs consume no attempts', `${row?.attempts_sent}`);
    check(row?.last_block_reason === 'timezone_unavailable', 'and the reason names G-137', `${row?.last_block_reason}`);
    check(row?.status === 'active', 'the sequence is not escalated by repetition', `${row?.status}`);

    // ── and it RECOVERS once the timezone is set ─────────────────────────
    //
    // The subtler half: a sequence CREATED while there was no timezone was left
    // with next_due_at NULL (the create branch cannot compute a due time
    // without a zone). The observer will not re-create it and the due loop
    // excludes a null next_due_at, so it stays unscheduled until a zone exists —
    // but it must not be INVISIBLE while it waits: wedged_follow_ups now surfaces
    // the null-scheduled population (20260815410000), whose comment used to
    // claim it showed timezone_unavailable while the `< now()` filter silently
    // dropped exactly these NULL rows. Reproduce that exact NULL state
    // (makeFixture forces a past due time for the timing-agnostic tests, so null
    // it back), prove the monitor sees it, then prove the next tick schedules it
    // once a zone exists.
    const stranded = await makeFixture('stranded', { consent: true, timezone: null });
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: null }).eq('id', stranded.sequence);

    await runFollowUps(admin);
    let s = await sequenceRow(stranded.sequence);
    check(
      s?.next_due_at === null && s?.status === 'active',
      'a sequence created before a timezone stays unscheduled and active — not lost',
      `next_due_at ${s?.next_due_at}, status ${s?.status}`,
    );
    check(s?.last_block_reason === 'timezone_unavailable', 'and the worker keeps recording why', `${s?.last_block_reason}`);

    // The operator can SEE it wait. The monitor must count every active
    // timezone-blocked sequence, including the never-scheduled (next_due_at NULL)
    // ones the old `< now() - 15m` filter dropped — this assertion fails on the
    // old filter, which silently omitted `stranded`.
    const { data: wedged } = await admin.schema('core').rpc('wedged_follow_ups');
    const tz = (wedged ?? []).find((r: { reason: string }) => r.reason === 'timezone_unavailable') as
      | { wedged: number }
      | undefined;
    const { data: blocked } = await admin.schema('crm').from('follow_up_sequences')
      .select('next_due_at').eq('status', 'active').eq('last_block_reason', 'timezone_unavailable');
    const nullScheduled = (blocked ?? []).filter((r) => r.next_due_at === null).length;
    check(
      Boolean(tz) && tz!.wedged === (blocked ?? []).length && nullScheduled >= 1,
      'wedged_follow_ups counts every blocked sequence, including the never-scheduled (NULL) ones',
      `monitor ${tz?.wedged}, actual ${(blocked ?? []).length} (of which ${nullScheduled} never scheduled)`,
    );

    // The owner finally sets the timezone. The very next tick must schedule it.
    await admin.schema('core').from('organizations')
      .update({ timezone: 'Asia/Kolkata' }).eq('id', stranded.org);
    await runFollowUps(admin);
    s = await sequenceRow(stranded.sequence);
    check(
      s?.next_due_at !== null || (s?.attempts_sent ?? 0) > 0,
      'once a timezone is set, the stranded sequence is scheduled and moves — it recovers, it is not silent forever',
      `next_due_at ${s?.next_due_at}, attempts ${s?.attempts_sent}`,
    );
    check(
      s?.last_block_reason !== 'timezone_unavailable',
      'and the timezone block is cleared',
      `${s?.last_block_reason}`,
    );
  }

  // ── 7. tenant isolation ────────────────────────────────────────────────
  console.log('\n7. Nothing crosses a tenant');
  {
    const rows = await Promise.all(made.sequences.map(async (id) => {
      const seq = await sequenceRow(id);
      const { data: sends } = await admin
        .schema('crm').from('follow_up_sends').select('organization_id').eq('sequence_id', id);
      return { seq, sends: sends ?? [] };
    }));
    check(
      rows.every(({ seq, sends }) => sends.every((s) => s.organization_id === seq?.organization_id)),
      'every attempt carries its sequence’s organization',
    );

    const { data: crossed } = await admin
      .schema('crm')
      .from('conversation_messages')
      .select('organization_id, conversation_id')
      .in('conversation_id', made.conversations);
    const convOrg = new Map<string, string>();
    for (const id of made.conversations) {
      const { data } = await admin.schema('crm').from('conversations')
        .select('organization_id').eq('id', id).maybeSingle();
      if (data) convOrg.set(id, data.organization_id);
    }
    check(
      (crossed ?? []).every((m) => convOrg.get(m.conversation_id) === m.organization_id),
      'and every message carries its conversation’s organization',
    );
  }

  // ── 8. payment and the unresolved situations are never scheduled ───────
  console.log('\n8. What must never be scheduled, is not');
  {
    const { data: seqs } = await admin
      .schema('crm').from('follow_up_sequences').select('situation_key');
    const keys = new Set((seqs ?? []).map((s) => s.situation_key));
    check(!keys.has('pending_payment'), 'no payment sequence exists anywhere — ADM-69 defers it');
    check(
      !keys.has('no_response_after_requirements_request') && !keys.has('no_response_after_proposal'),
      'nor situations 2 and 3, collapsed into situation 1 by ADM-89 (G-138)',
    );
  }

  // ── 9. exhaustion, driven through the real worker ──────────────────────
  //
  // Sales-Nurture gives seven attempts. Each round moves only the two
  // test-controlled timestamps — `last_sent_at` and `next_due_at` — and runs
  // the real worker; ADM-69's recorded values are untouched. The first
  // version of this section used post-project, which found something better
  // than a pass: a completed project has NO legal conversation to send on,
  // raised as its own gap.
  console.log('\n9. A rhythm exhausts through the worker, and escalates once');
  const exhaust = await makeFixture('exhaust', { consent: true, timezone: 'Asia/Kolkata' });
  {
    // Sales-Nurture's last day is 49 BUSINESS days — roughly 68 calendar days.
    // The shared fixture's forty-day trigger leaves attempts 5–7 legitimately
    // in the future, which the first run of this section proved by stopping at
    // exactly four: the worker was right and the fixture was short.
    await admin.schema('crm').from('follow_up_sequences')
      .update({ triggered_at: new Date(Date.now() - 120 * 86_400_000).toISOString() })
      .eq('id', exhaust.sequence);

    for (let round = 1; round <= 7; round += 1) {
      await makeDueAgain(exhaust.sequence);
      await runFollowUps(admin);
      const soFar = await attemptsFor(exhaust.sequence);
      check(soFar.length === round, `attempt ${round} is claimed`, `${soFar.length}`);
    }

    // The eighth round: nothing to claim, and the worker escalates.
    await makeDueAgain(exhaust.sequence);
    await runFollowUps(admin);
    await runFollowUps(admin);

    const attempts = await attemptsFor(exhaust.sequence);
    check(attempts.length === 7, 'no attempt 8 exists, however often the worker runs', `${attempts.length}`);

    const row = await sequenceRow(exhaust.sequence);
    check(row?.status === 'escalated', 'the sequence escalated through the worker', `${row?.status}`);
    check(Boolean(row?.escalated_at), 'durably, with a timestamp');
    check(row?.stop_reason === 'rhythm exhausted', 'and says why', `${row?.stop_reason}`);

    const messages = await messagesIn(exhaust.conversation);
    check(messages.length === 7, 'exactly seven messages were written', `${messages.length}`);

    // ── the lifecycle is on the record (ADM-69 step 10) ──────────────────
    //
    // Read by action vocabulary and organization, not "some audit row
    // exists": the trigger fires on INSERT and STATUS changes only, so the
    // worker's per-tick bookkeeping must NOT appear here.
    const { data: audit } = await admin
      .schema('audit')
      .from('audit_log')
      .select('action, organization_id, subject_type')
      .in('subject_type', ['follow_up_sequence', 'follow_up_send'])
      .eq('subject_id', exhaust.sequence);
    const bySeq = (audit ?? []).filter((a) => a.subject_type === 'follow_up_sequence');
    check(
      bySeq.some((a) => a.action === 'followup.sequence_started'),
      'starting the sequence is audited',
    );
    check(
      bySeq.filter((a) => a.action === 'followup.sequence_escalated').length === 1,
      'escalation is audited exactly once',
      `${bySeq.filter((a) => a.action === 'followup.sequence_escalated').length}`,
    );
    const orgOk = (audit ?? []).every((a) => a.organization_id === (exhaust as { org: string }).org);
    check(orgOk, 'and every audit row carries the sequence’s own organization');

    // Scoped to THIS sequence's send rows. Review caught the first version
    // counting followup.attempt_claimed globally — a check any other test's
    // leftovers could satisfy — and its subject_id filter was dead for send
    // rows, whose audit subject is the send row's own id, not the sequence's.
    const { data: sendRows } = await admin
      .schema('crm').from('follow_up_sends').select('id').eq('sequence_id', exhaust.sequence);
    const sendIds = (sendRows ?? []).map((r) => r.id);
    const { data: claimAudit } = await admin
      .schema('audit')
      .from('audit_log')
      .select('action')
      .eq('subject_type', 'follow_up_send')
      .eq('action', 'followup.attempt_claimed')
      .in('subject_id', sendIds);
    check((claimAudit ?? []).length === 7, 'all seven attempt claims are audited, and only those', `${(claimAudit ?? []).length}`);

    check(
      !bySeq.some((a) => a.action === 'followup.sequence_updated'),
      'and the per-tick bookkeeping produced no audit noise',
    );
  }

  // ── 10. two workers at exhaustion ──────────────────────────────────────
  console.log('\n10. Two workers at exhaustion produce one escalation');
  {
    const race2 = await makeFixture('escrace', { consent: true, timezone: 'Asia/Kolkata' });
    await admin.schema('crm').from('follow_up_sequences').update({
      attempts_sent: 7,
      next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
    }).eq('id', race2.sequence);

    await Promise.all([runFollowUps(admin), runFollowUps(admin)]);

    const row = await sequenceRow(race2.sequence);
    check(row?.status === 'escalated', 'the sequence escalated', `${row?.status}`);
    check((await attemptsFor(race2.sequence)).length === 0, 'and no attempt was claimed at exhaustion');

    const again = await admin.schema('crm')
      .rpc('escalate_follow_up_sequence', { p_sequence_id: race2.sequence, p_reason: 'again' });
    check(again.data === false, 'a further escalation attempt changes nothing', `${again.data}`);
  }

  // ── 11. post-project resolves a client_account thread and sends ─────────
  //
  // G-139 / ADM-90. A completed project's client account outlives its leads, so
  // there was no `direct` thread to send on and the worker stopped it with
  // `no_conversation`. The `client_account` conversation kind fixes that: the
  // worker resolves-or-creates the one thread for the account (carrying the
  // account's contact, so the same consent chokepoint gates it) and sends.
  console.log('\n11. Post-project resolves a client-account thread and sends — G-139');
  {
    const { data: org } = await admin.schema('core').from('organizations')
      .insert({ name: `${MARK} g139`, slug: `${MARK}-g139`, timezone: 'Asia/Kolkata' }).select('id').single();
    made.orgs.push(org!.id);
    const { data: acct } = await admin.schema('core').from('client_accounts')
      .insert({ organization_id: org!.id, name: `${MARK} g139` }).select('id').single();
    made.accounts = made.accounts ?? [];
    made.accounts.push(acct!.id);
    const { data: contact } = await admin.schema('crm').from('contacts')
      .insert({ organization_id: org!.id, client_account_id: acct!.id, full_name: `${MARK} g139`,
                phone: `+9195${Date.now() % 100000000}` }).select('id').single();
    made.contacts.push(contact!.id);
    await admin.schema('crm').from('communication_consent').insert({
      organization_id: org!.id, contact_id: contact!.id, channel: 'whatsapp', status: 'granted' });
    const { data: proj } = await admin.schema('projects').from('projects')
      .insert({ organization_id: org!.id, client_account_id: acct!.id, name: `${MARK} g139`,
                status: 'completed', completed_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .select('id').single();
    made.projects = made.projects ?? [];
    made.projects.push(proj!.id);

    await runFollowUps(admin);
    const { data: seqs } = await admin.schema('crm').from('follow_up_sequences')
      .select('id, contact_id, conversation_id, status, stop_reason')
      .eq('subject_id', proj!.id);
    const seq = (seqs ?? [])[0];
    check(Boolean(seq), 'the observer discovers a completed project');
    if (seq) made.sequences.push(seq.id);
    check(seq?.contact_id === contact!.id, 'and carries the contact the observer identified');
    check(seq?.conversation_id === null, 'the sequence starts with no conversation — the observer selects none');

    // Due now: the worker resolves-or-creates the client_account thread and sends.
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString() }).eq('id', seq!.id);
    await runFollowUps(admin);

    const { data: thread } = await admin.schema('crm').from('conversations')
      .select('id, kind, client_account_id, contact_id')
      .eq('client_account_id', acct!.id).eq('kind', 'client_account').maybeSingle();
    if (thread?.id) made.conversations.push(thread.id);
    check(Boolean(thread?.id), 'a client_account thread is resolved for the account');
    check(thread?.contact_id === contact!.id, 'carrying the account contact so consent can gate it');

    const attempts = await attemptsFor(seq!.id);
    check(attempts.length >= 1 && attempts[0]?.outcome === 'sent', 'the post-project message is sent, not stopped', JSON.stringify(attempts));

    const row = await sequenceRow(seq!.id);
    check(!(row?.status === 'stopped' && row?.stop_reason === 'no_conversation'), 'the sequence is no longer dead-ended on no_conversation', `${row?.status}/${row?.stop_reason}`);
  }

  // ── 12. a crash between the claim and the send does not drop the attempt ──
  //
  // The claim writes `follow_up_sends` optimistically as `sent` before the
  // message is created or the delivery event emitted. A hard kill in that
  // window — a serverless timeout — leaves an orphan `sent` row whose sequence
  // counter never advanced. Every later tick recomputes the same attempt,
  // loses the unique-constraint race to that row, and reconciles. Reconciliation
  // used to only *record* the attempt, advancing the counter past a message
  // that never went out — a silently dropped follow-up, while a code comment
  // claimed a re-emit that did not exist. Now reconciliation re-drives the send
  // (idempotent on the derived external_ref), so the dropped attempt is
  // delivered. Seeded directly as the crash state: an orphan claim, no message.
  console.log('\n12. A crash after the claim, before the send, is recovered — not dropped');
  {
    const crashed = await makeFixture('crashed', { consent: true, timezone: 'Asia/Kolkata' });
    // The exact crash residue: attempt 1 claimed `sent`, counter still 0, no message.
    await admin.schema('crm').from('follow_up_sends').insert({
      organization_id: crashed.org,
      sequence_id: crashed.sequence,
      attempt: 1,
      outcome: 'sent',
      scheduled_for: new Date(Date.now() - 3_600_000).toISOString(),
    });
    check((await messagesIn(crashed.conversation)).length === 0, 'precondition: the orphan claim has no message');

    await runFollowUps(admin);

    // With the fix the reconciliation re-drove the send: the message now exists
    // and is queued. Without it, the counter advances to 1 with zero messages —
    // this assertion is the red-proof and fails on the old behaviour.
    const messages = await messagesIn(crashed.conversation);
    check(messages.length === 1, 'the dropped attempt is delivered on reconciliation, not skipped', `${messages.length}`);
    check(
      messages[0]?.external_ref === `followup:${crashed.sequence}:1`,
      'and carries the attempt’s derived reference',
      `${messages[0]?.external_ref}`,
    );
    const { data: events } = await admin.schema('core').from('outbox_events')
      .select('subject_id').eq('type', 'followup.queued').eq('subject_id', crashed.sequence);
    check((events ?? []).length === 1, 'a followup.queued event was emitted for it', `${(events ?? []).length}`);
    const row = await sequenceRow(crashed.sequence);
    check(row?.attempts_sent === 1, 'and only then does the counter advance', `${row?.attempts_sent}`);

    // Idempotent under repeat: running again neither re-sends nor double-counts.
    await runFollowUps(admin);
    check((await messagesIn(crashed.conversation)).length === 1, 'a further run sends nothing more');
  }

  console.log(`\n  ${checks} checks`);
}

main()
  .then(async () => {
    await cleanup();
    if (failures === 0) {
      console.log('\n\x1b[32m✔ The worker runs, sends once, and refuses for the right reasons\x1b[0m\n');
      process.exit(0);
    }
    console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
    process.exit(1);
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error('\n\x1b[31m✖ the verification itself failed\x1b[0m', error);
    process.exit(1);
  });
