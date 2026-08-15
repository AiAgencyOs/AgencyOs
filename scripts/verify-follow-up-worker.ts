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
    .select('id, external_ref, body')
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

const made: { orgs: string[]; leads: string[]; conversations: string[]; contacts: string[]; sequences: string[] } = {
  orgs: [], leads: [], conversations: [], contacts: [], sequences: [],
};

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

async function cleanup() {
  for (const id of made.sequences) {
    await admin.schema('crm').from('follow_up_sends').delete().eq('sequence_id', id);
    await admin.schema('crm').from('follow_up_sequences').delete().eq('id', id);
  }
  for (const id of made.conversations) {
    await admin.schema('crm').from('conversation_messages').delete().eq('conversation_id', id);
    await admin.schema('crm').from('conversations').delete().eq('id', id);
  }
  for (const id of made.leads) await admin.schema('crm').from('leads').delete().eq('id', id);
  for (const id of made.contacts) {
    await admin.schema('crm').from('communication_consent').delete().eq('contact_id', id);
    await admin.schema('crm').from('contacts').delete().eq('id', id);
  }
  for (const id of made.orgs) await admin.schema('core').from('organizations').delete().eq('id', id);
}

async function main() {
  console.log('\n\x1b[1mAgencyOS — the follow-up worker, executed (G-012)\x1b[0m');

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
      'nor either situation blocked by G-138',
    );
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
