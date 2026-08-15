/**
 * The delivery path, driven — gap G-012, decision ADM-69.
 *
 * The worker script proves everything up to the message row. This proves what
 * happens after it, through the **real** pieces of the delivery chain:
 *
 *   followup.queued            emitted by the real worker
 *   → dispatchOutbox           the real dispatcher, real dedupe keys
 *   → core.claim_jobs          the real claim
 *   → crm:deliverFollowUp      the real handler
 *   → HTTP provider boundary   a stub server this script controls
 *
 * The provider is the only substitution, and it is substituted at the HTTP
 * boundary rather than in code: `WHATSAPP_GRAPH_BASE_URL` exists for exactly
 * this (the same pattern the extraction path uses with ANTHROPIC_BASE_URL).
 * What a stub cannot prove — Meta accepting, delivering, a real webhook — is
 * external verification and stays recorded as such.
 *
 * What the Next route wrapper adds (claim loop, backoff, parking) is proven
 * generically by verify-job-claims / job-retry-backoff / dead-job-signal and
 * exercised over HTTP by verify-approval-announcements for the identical
 * generic drain. This script proves the follow-up handler returns the shapes
 * that engage that machinery, and what each shape does to the record.
 *
 *   npm run db:verify:delivery
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// The stub's port is the kernel's to pick. A fixed 54398 sat inside Linux's
// ephemeral range (32768-60999), where any outbound socket on the host can
// squat it by chance — which one CI run proved with EADDRINUSE after five
// green runs of pure luck. listen(0) cannot collide; see the stub block below
// for why the base URL must be written where it is.
process.env.WHATSAPP_ACCESS_TOKEN = 'verify-stub-token-not-a-real-credential';

import { createAdminClient } from '@/lib/db/admin';
import { dispatchOutbox } from '@/lib/events/dispatch';
import { deliverFollowUp } from '@/modules/crm/handlers';
import { runFollowUps } from '@/modules/crm/follow-up-worker';

// ── the stub provider, listening BEFORE anything can memoize env ──────────
//
// Order is the whole safety here, and it is subtler than it looks: ESM hoists
// imports, so every module below is loaded before any statement in this file
// runs — and `createAdminClient()` two statements down memoizes `serverEnv()`
// on the spot. The base URL must therefore be in process.env BEFORE that
// line, or every send in this script goes to the real Graph API. That is not
// hypothetical: the first draft of the dynamic port set the URL inside
// main(), and the run's 401s came back with fbtrace_ids.

let mode: 'ok' | 'http500' | 'okNoId' = 'ok';
let hits = 0;
const provider = createServer((req, res) => {
  hits += 1;
  if (mode === 'http500') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stub transient failure' } }));
    return;
  }
  if (mode === 'okNoId') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ messages: [{ id: `wamid.stub-${hits}` }] }));
});

await new Promise<void>((resolve) => provider.listen(0, resolve));
const providerAddress = provider.address();
if (providerAddress === null || typeof providerAddress === 'string') {
  throw new Error('the stub provider has no port');
}
process.env.WHATSAPP_GRAPH_BASE_URL = `http://127.0.0.1:${providerAddress.port}`;

const admin = createAdminClient();
const MARK = `zzdlv-${randomUUID().slice(0, 8)}`;

/**
 * The seeded organization. Section 4's approval fixture lives HERE, not in a
 * throwaway org, because approval requests are undeletable by design —
 * `approvals.reject_delete` fires even on the org-delete cascade — so any
 * throwaway org that ever held one can never be removed. CI's first-owner
 * check requires exactly one organization, and two leaked `appr` orgs were
 * how that was learned.
 */
const SEEDED_ORG = '00000000-0000-4000-8000-000000000001';
let seededTimezoneTouched = false;

let checks = 0;
let failures = 0;
function check(ok: boolean, description: string, detail = '') {
  checks += 1;
  if (ok) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

/** The stub provider. `mode` decides the next answer; every hit is counted. */
const made = {
  orgs: [] as string[], contacts: [] as string[], leads: [] as string[],
  conversations: [] as string[], opportunities: [] as string[], proposals: [] as string[],
};
let preexisting = new Set<string>();
let foreignUnpublished: number[] = [];

async function snapshot() {
  const { data } = await admin.schema('crm').from('follow_up_sequences').select('id');
  preexisting = new Set((data ?? []).map((r) => r.id));
  // Unpublished events that were already in the outbox belong to earlier
  // verify scripts. This script runs the REAL dispatcher, and the real
  // dispatcher dispatches the whole outbox — so without a restore, a foreign
  // event gets fossilized into a foreign job that nothing here drains and no
  // later sweep deletes. CI caught exactly that: verify-refunds leaves its
  // approval.requested event unpublished for verify-whatsapp-groups' global
  // sweep to delete — which runs AFTER this script, too late to stop the
  // dispatch. The jobs, not the events, are what the final zero-jobs check
  // finds.
  const { data: events } = await admin.schema('core').from('outbox_events')
    .select('id').is('published_at', null);
  foreignUnpublished = (events ?? []).map((r) => r.id as number);
}

async function cleanup() {
  const { data: now } = await admin.schema('crm').from('follow_up_sequences').select('id');
  for (const row of now ?? []) {
    if (preexisting.has(row.id)) continue;
    await admin.schema('crm').from('follow_up_sends').delete().eq('sequence_id', row.id);
    await admin.schema('crm').from('follow_up_sequences').delete().eq('id', row.id);
  }
  // Scoped to this script's organizations — its own plus the seeded one,
  // whose followup rows it also produces. Review caught the first version
  // deleting globally; CI caught the second version's approval fixture
  // leaking whole organizations, because approval rows are undeletable by
  // design and take their org's deletability with them.
  const touched = [...made.orgs, SEEDED_ORG];
  await admin.schema('core').from('outbox_events').delete()
    .eq('type', 'followup.queued').in('organization_id', touched);
  await admin.schema('core').from('jobs').delete()
    .eq('kind', 'followup.deliver').in('organization_id', touched);
  // Foreign events this script's dispatches touched go back exactly as they
  // were found: the job each one spawned is removed, the event is unpublished
  // again. Anything less leaves another script's event frozen as a job.
  for (const id of foreignUnpublished) {
    await admin.schema('core').from('jobs').delete().like('dedupe_key', `evt:${id}:%`);
    await admin.schema('core').from('outbox_events').update({ published_at: null }).eq('id', id);
  }
  if (seededTimezoneTouched) {
    await admin.schema('core').from('organizations')
      .update({ timezone: null }).eq('id', SEEDED_ORG);
  }
  for (const id of made.proposals) await admin.schema('sales').from('proposals').delete().eq('id', id);
  for (const id of made.opportunities) await admin.schema('sales').from('opportunities').delete().eq('id', id);
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
  for (const id of made.orgs) await admin.schema('core').from('organizations').delete().eq('id', id);
}

/** An organization that can actually send: timezone and a WhatsApp number. */
async function makeOrg(label: string) {
  const { data: org } = await admin.schema('core').from('organizations')
    .insert({
      name: `${MARK} ${label}`, slug: `${MARK}-${label}`, timezone: 'Asia/Kolkata',
      settings: { whatsapp_phone_number_id: `stub-${MARK}-${label}` },
    }).select('id').single();
  made.orgs.push(org!.id);
  return org!.id;
}

async function makeLeadThread(org: string, label: string) {
  const { data: contact } = await admin.schema('crm').from('contacts')
    .insert({ organization_id: org, full_name: `${MARK} ${label}`, phone: `+9194${Date.now() % 100000000}` })
    .select('id').single();
  made.contacts.push(contact!.id);
  await admin.schema('crm').from('communication_consent').insert({
    organization_id: org, contact_id: contact!.id, channel: 'whatsapp', status: 'granted',
  });
  const { data: lead } = await admin.schema('crm').from('leads')
    .insert({ organization_id: org, title: `${MARK} ${label}`, contact_id: contact!.id, status: 'qualifying' })
    .select('id').single();
  made.leads.push(lead!.id);
  const { data: conversation } = await admin.schema('crm').from('conversations')
    .insert({ organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: lead!.id, contact_id: contact!.id })
    .select('id').single();
  made.conversations.push(conversation!.id);
  return { contact: contact!.id, lead: lead!.id, conversation: conversation!.id };
}

/**
 * By subject AND situation: one lead legitimately runs two situations at once
 * (inactive_lead and abandoned_conversation), so subject alone is ambiguous —
 * the first draft used maybeSingle() on it and got null the moment both
 * existed.
 */
async function sequenceFor(subjectId: string, situationKey: string) {
  const { data } = await admin.schema('crm').from('follow_up_sequences')
    .select('*').eq('subject_id', subjectId).eq('situation_key', situationKey).maybeSingle();
  return data;
}

async function jobsOf(kind: string) {
  const { data } = await admin.schema('core').from('jobs')
    .select('id, organization_id, status, payload, dedupe_key, attempts')
    .eq('kind', kind).order('created_at');
  return data ?? [];
}

async function claimOne() {
  const { data } = await admin.schema('core').rpc('claim_jobs', {
    p_worker_id: `verify-${MARK}`, p_kind: 'followup.deliver', p_batch_size: 1,
  });
  const rows = (Array.isArray(data) ? data : []) as { id: string; organization_id: string; payload: unknown; correlation_id: string | null }[];
  return rows[0] ?? null;
}

async function messageState(conversationId: string) {
  const { data } = await admin.schema('crm').from('conversation_messages')
    .select('id, external_ref, metadata').eq('conversation_id', conversationId).order('seq');
  return (data ?? []) as { id: string; external_ref: string; metadata: { delivery?: string; provider_ref?: string } }[];
}

async function main() {
  console.log('\n\x1b[1mAgencyOS — the delivery path, driven (G-012)\x1b[0m');
  await snapshot();

  // ── 1. situation 1, end to end ──────────────────────────────────────────
  console.log('\n1. No response after quotation: observer → worker → dispatcher → job → provider');
  const org1 = await makeOrg('s1');
  const s1 = await makeLeadThread(org1, 's1');
  {
    const { data: opp } = await admin.schema('sales').from('opportunities')
      .insert({ organization_id: org1, lead_id: s1.lead, name: `${MARK} deal`, stage: 'proposal' })
      .select('id').single();
    made.opportunities.push(opp!.id);
    const { data: proposal } = await admin.schema('sales').from('proposals')
      .insert({
        organization_id: org1, opportunity_id: opp!.id, version: 1, title: `${MARK} quote`,
        status: 'sent', sent_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        conversation_id: s1.conversation,
        subtotal_minor: 100000, discount_minor: 0, tax_minor: 0, total_minor: 100000,
      }).select('id').single();
    made.proposals.push(proposal!.id);

    // One tick both starts the sequence and claims attempt 1: the trigger is
    // twenty days old, so Sales-Active's day 2 is already past when the due
    // loop runs in the same invocation. The first draft forced a second due
    // date and then failed its own "exactly one attempt" check — the worker
    // had been right both times.
    await runFollowUps(admin);
    const seq = await sequenceFor(proposal!.id, 'no_response_after_quotation');
    check(Boolean(seq), 'the observer discovered the sent quotation');
    check(seq?.organization_id === org1, 'in its own organization');
    check(seq?.conversation_id === s1.conversation, 'on the quotation’s own thread');

    const { data: sends } = await admin.schema('crm').from('follow_up_sends')
      .select('attempt, outcome').eq('sequence_id', seq!.id);
    check((sends ?? []).length === 1, 'exactly one attempt was claimed', `${(sends ?? []).length}`);

    // The real dispatcher turns the event into exactly one job, twice over.
    const first = await dispatchOutbox(admin, { batchSize: 50 });
    check(first.enqueued >= 1, 'the dispatcher enqueued the delivery job', `${first.enqueued}`);
    // An ordinary second pass is guarded by `published_at` — proven by red
    // proof to NOT depend on the dedupe key, which made the first version of
    // this check decorative. The window the key actually protects is a
    // dispatcher that crashed after enqueuing and before marking the event
    // published, simulated here by unpublishing the event and dispatching
    // again: the re-enqueue must fail on the unique key and be counted a
    // duplicate, never inserted twice.
    await admin.schema('core').from('outbox_events')
      .update({ published_at: null }).eq('type', 'followup.queued');
    const crashed = await dispatchOutbox(admin, { batchSize: 50 });
    check(crashed.enqueued === 0, 'a crashed-dispatcher replay enqueues nothing new', `${crashed.enqueued}`);
    check(crashed.duplicates >= 1, 'and is counted as the duplicate it is', `${crashed.duplicates}`);

    const jobs = await jobsOf('followup.deliver');
    check(jobs.length === 1, 'exactly one delivery job exists', `${jobs.length}`);
    check(jobs[0]?.organization_id === org1, 'in the right organization');
    check(/^evt:\d+:crm:deliverFollowUp$/.test(jobs[0]?.dedupe_key ?? ''), 'keyed on the event', `${jobs[0]?.dedupe_key}`);

    // The real claim, then the real handler against a healthy provider.
    const job = await claimOne();
    check(Boolean(job), 'the real claim returns the job');
    mode = 'ok'; hits = 0;
    const result = await deliverFollowUp(admin, job as never);
    check(result.status === 'succeeded', 'the handler delivers', JSON.stringify(result));
    check(hits === 1, 'with exactly one provider submission', `${hits}`);

    const msgs = await messageState(s1.conversation);
    check(msgs.length === 1, 'one message exists');
    check(msgs[0]?.metadata.delivery === 'sent', 'recorded as sent', `${msgs[0]?.metadata.delivery}`);
    check(Boolean(msgs[0]?.metadata.provider_ref), 'with the provider’s reference', `${msgs[0]?.metadata.provider_ref}`);

    // Duplicate handler execution after the row is already `sent`. The job
    // layer normally prevents this; when it happens anyway — a reaped job —
    // the handler must NOT hit the provider again. Before this fix it did, and
    // a client was double-messaged on the wire; now the `sent` row short-
    // circuits and the second run reports the delivery that already happened.
    hits = 0;
    const rerun = await deliverFollowUp(admin, job as never);
    check(rerun.status === 'succeeded', 're-running the handler still succeeds');
    check((await messageState(s1.conversation)).length === 1, 'and no second message row exists');
    check(hits === 0, 'and the provider is NOT submitted to again — the double-send is closed', `${hits}`);
    check(rerun.status === 'succeeded' && rerun.outcome === 'delivered', 'the re-run reports the delivery that already happened', JSON.stringify(rerun));

    // The genuinely unavoidable window is narrower and still honest: a crash
    // AFTER the provider accepted but BEFORE the local settle leaves the row
    // `pending`, and a re-run then does submit again — provider delivery
    // semantics are provider-dependent, and this measures rather than hides it.
    await admin.schema('crm').from('conversation_messages')
      .update({ metadata: { channel: 'whatsapp', direction: 'outbound', delivery: 'pending' } })
      .eq('id', msgs[0]!.id);
    hits = 0;
    const afterCrash = await deliverFollowUp(admin, job as never);
    check(afterCrash.status === 'succeeded', 'a re-run over a still-pending row delivers');
    check(hits === 1, 'and the provider IS submitted to — the pending crash window, measured not hidden', `${hits}`);
  }

  // ── 2. transient failure, and the retry that tells the truth ───────────
  console.log('\n2. A transient provider failure retries, and the record ends truthful');
  const org2 = await makeOrg('s4');
  const s4 = await makeLeadThread(org2, 's4');
  {
    // Situation 4: a real inbound message, fifteen days silent — comfortably
    // past Sales-Nurture's day 7 in business days, so the tick that starts the
    // sequence also claims attempt 1. (The same lead is legitimately offered
    // as inactive_lead too; that sibling's trigger is its creation moment, so
    // its first attempt is days away and it stays quiet here.)
    await admin.schema('crm').from('conversation_messages').insert({
      organization_id: org2, conversation_id: s4.conversation, seq: 0, author_type: 'client',
      body: 'hello', occurred_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      external_ref: `${MARK}-s4-in`,
    });

    await runFollowUps(admin);
    const seq = await sequenceFor(s4.lead, 'abandoned_conversation');
    check(Boolean(seq), 'the observer files silence as situation 4');
    await dispatchOutbox(admin, { batchSize: 50 });

    const job = await claimOne();
    check(Boolean(job), 'the delivery job is claimed');

    mode = 'http500'; hits = 0;
    const failed = await deliverFollowUp(admin, job as never);
    check(
      failed.status === 'failed' && (failed as { permanent: boolean }).permanent === false,
      'a 500 comes back retryable, never permanent',
      JSON.stringify(failed),
    );
    check(
      /provider/i.test((failed as { detail?: string }).detail ?? ''),
      'and the failure names the provider, so a parked job says why',
      (failed as { detail?: string }).detail,
    );

    const after500 = await messageState(s4.conversation);
    const outbound = after500.find((m) => m.external_ref.startsWith('followup:'));
    check(outbound?.metadata.delivery === 'failed', 'the failure is durable on the message', `${outbound?.metadata.delivery}`);
    check((await admin.schema('crm').from('follow_up_sends').select('attempt').eq('sequence_id', seq!.id)).data?.length === 1,
      'and the logical attempt remains one');

    // The runner would retry this job with backoff (proven generically). The
    // retry re-runs the same handler; the provider now succeeds.
    mode = 'ok'; hits = 0;
    const retried = await deliverFollowUp(admin, job as never);
    check(retried.status === 'succeeded', 'the retry delivers', JSON.stringify(retried));
    const afterRetry = await messageState(s4.conversation);
    const corrected = afterRetry.find((m) => m.external_ref.startsWith('followup:'));
    check(
      corrected?.metadata.delivery === 'sent',
      'and failed → sent is corrected: the record ends truthful',
      `${corrected?.metadata.delivery}`,
    );
    check((await admin.schema('crm').from('follow_up_sends').select('attempt').eq('sequence_id', seq!.id)).data?.length === 1,
      'still exactly one logical attempt');

    // Sent is terminal: a re-run over the now-`sent` row short-circuits and
    // never reaches the provider, so a later ambiguous response cannot overturn
    // it. (This is the double-send fix again, at the delivery boundary.)
    mode = 'okNoId';
    const overSent = await deliverFollowUp(admin, job as never);
    check(overSent.status === 'succeeded' && (overSent as { outcome?: string }).outcome === 'delivered',
      'a re-run over a sent row is a no-op delivery, not a fresh provider call', JSON.stringify(overSent));
    check(
      (await messageState(s4.conversation)).find((m) => m.external_ref.startsWith('followup:'))?.metadata.delivery === 'sent',
      'and the sent record stands — sent is terminal',
    );

    // The okNoId classification itself, on a genuinely PENDING row (the crash
    // window): a 200 with no message id is a failure nobody can reconcile, so
    // it is retryable, not counted as delivered.
    const outboundId = (await messageState(s4.conversation)).find((m) => m.external_ref.startsWith('followup:'))!.id;
    await admin.schema('crm').from('conversation_messages')
      .update({ metadata: { channel: 'whatsapp', direction: 'outbound', delivery: 'pending' } })
      .eq('id', outboundId);
    const ambiguous = await deliverFollowUp(admin, job as never);
    check(
      ambiguous.status === 'failed' && (ambiguous as { permanent: boolean }).permanent === false,
      'a 200 with no message id is refused as retryable, not counted as delivered',
      JSON.stringify(ambiguous),
    );
    check(
      (await messageState(s4.conversation)).find((m) => m.external_ref.startsWith('followup:'))?.metadata.delivery === 'failed',
      'and the ambiguous attempt is recorded as failed, not sent',
    );
  }

  // ── 3. consent withdrawn between claim and delivery ────────────────────
  console.log('\n3. Consent withdrawn after the claim is suppressed at the chokepoint');
  const org3 = await makeOrg('wd');
  const wd = await makeLeadThread(org3, 'wd');
  {
    await runFollowUps(admin);
    const seq = await sequenceFor(wd.lead, 'inactive_lead');
    // Backdated trigger as well as due time: the contract recomputes the
    // schedule from day 0 and refuses a job that merely surfaced early —
    // which is correct, and the first draft of this section proved it by
    // accident.
    await admin.schema('crm').from('follow_up_sequences')
      .update({
        triggered_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
      }).eq('id', seq!.id);
    await runFollowUps(admin);
    await dispatchOutbox(admin, { batchSize: 50 });
    const job = await claimOne();
    check(Boolean(job), 'attempt claimed and delivery job queued while consent existed');
    if (!job) throw new Error('no delivery job to withdraw consent against');

    // The message row exists from the claim; now the client withdraws, and a
    // NEW conversation without a message forces the chokepoint's own check.
    await admin.schema('crm').from('conversation_messages').delete()
      .eq('conversation_id', wd.conversation);
    await admin.schema('crm').from('communication_consent')
      .update({ status: 'withdrawn' }).eq('contact_id', wd.contact).eq('channel', 'whatsapp');

    mode = 'ok'; hits = 0;
    const result = await deliverFollowUp(admin, job as never);
    check(
      result.status === 'succeeded' && (result as { outcome?: string }).outcome === 'suppressed',
      'the handler reports suppressed, not delivered',
      JSON.stringify(result),
    );
    check(hits === 0, 'and the provider was never called', `${hits}`);
    check((await messageState(wd.conversation)).length === 0, 'no message exists');
  }

  // ── 4. the internal-approval reminder reaches the internal group ────────
  mode = 'ok';
  console.log('\n4. An internal approval reminder resolves the internal group — no consent anywhere');
  {
    // The seeded org's timezone is null by design (G-137); the reminder needs
    // one, so it is set for this section and restored to null by cleanup —
    // this deployment has not chosen one, and the test must not choose it
    // either beyond its own lifetime.
    await admin.schema('core').from('organizations')
      .update({ timezone: 'Asia/Kolkata' }).eq('id', SEEDED_ORG);
    seededTimezoneTouched = true;

    const reference = Array.from({ length: 6 }, () =>
      'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
    const { data: request } = await admin.schema('approvals').from('approval_requests')
      .insert({
        organization_id: SEEDED_ORG, subject_type: 'proposal', subject_id: randomUUID(),
        requested_by_type: 'system', audience: 'internal', state: 'pending',
        summary: `${MARK} needs deciding`, required_role: 'owner', reference,
        sla_due_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      }).select('id').single();

    await runFollowUps(admin);
    const seq = await sequenceFor(request!.id, 'pending_approval');
    check(seq?.situation_key === 'pending_approval', 'the pending approval is observed', `${seq?.situation_key}`);

    await admin.schema('crm').from('follow_up_sequences')
      .update({
        triggered_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
      }).eq('id', seq!.id);

    // No group linked yet: the reminder must BLOCK and wait, never stop. An
    // organization that links its group tomorrow gets reminders for approvals
    // already pending today; a permanent stop here would deny it forever, in
    // silence. Review caught the first version doing exactly that.
    await runFollowUps(admin);
    const blocked = await sequenceFor(request!.id, 'pending_approval');
    check(blocked?.status === 'active', 'with no group linked, the sequence stays active', `${blocked?.status}`);
    check(blocked?.last_block_reason === 'no_internal_group', 'blocked with the honest reason', `${blocked?.last_block_reason}`);
    check(
      (await admin.schema('crm').from('follow_up_sends').select('id').eq('sequence_id', seq!.id)).data?.length === 0,
      'and no attempt was spent on the block',
    );

    const { data: group } = await admin.schema('crm').from('conversations')
      .insert({ organization_id: SEEDED_ORG, kind: 'internal_group', channel: 'whatsapp', external_ref: `${MARK}-grp` })
      .select('id').single();
    made.conversations.push(group!.id);

    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString() }).eq('id', seq!.id);
    await runFollowUps(admin);

    const { data: sends } = await admin.schema('crm').from('follow_up_sends')
      .select('attempt, outcome').eq('sequence_id', seq!.id);
    check((sends ?? []).length === 1, 'a reminder attempt is claimed with no consent record anywhere', `${(sends ?? []).length}`);

    const msgs = await messageState(group!.id);
    check(msgs.length === 1, 'and the message went to the internal group', `${msgs.length}`);

    await admin.schema('approvals').from('approval_requests')
      .update({ state: 'approved', decided_at: new Date().toISOString() }).eq('id', request!.id);
    // The row itself stays: approval requests are undeletable by design, and
    // decided is the state that leaves nothing pending behind this script.
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString() }).eq('id', seq!.id);
    await runFollowUps(admin);
    const row = await sequenceFor(request!.id, 'pending_approval');
    check(row?.status === 'stopped', 'a decided approval stops the reminders', `${row?.status}`);
  }

  // ── 5. stop conditions for situations 1 and 4, at the worker ───────────
  console.log('\n5. An answered quotation and a replied thread both stop');
  {
    const answered = made.proposals[0]!;
    await admin.schema('sales').from('proposals')
      .update({ status: 'accepted', decided_at: new Date().toISOString() }).eq('id', answered);
    const seq1 = await sequenceFor(answered, 'no_response_after_quotation');
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
                last_sent_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .eq('id', seq1!.id);
    await runFollowUps(admin);
    check((await sequenceFor(answered, 'no_response_after_quotation'))?.status === 'stopped', 'an accepted quotation stops situation 1');

    const seq4 = await sequenceFor(s4.lead, 'abandoned_conversation');
    await admin.schema('crm').from('conversation_messages').insert({
      organization_id: org2, conversation_id: s4.conversation, seq: 5, author_type: 'client',
      body: 'sorry, was away', occurred_at: new Date().toISOString(), external_ref: `${MARK}-s4-reply`,
    });
    await admin.schema('crm').from('follow_up_sequences')
      .update({ next_due_at: new Date(Date.now() - 3_600_000).toISOString(),
                last_sent_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .eq('id', seq4!.id);
    await runFollowUps(admin);
    check((await sequenceFor(s4.lead, 'abandoned_conversation'))?.status === 'stopped', 'a reply stops situation 4');
  }

  console.log(`\n  ${checks} checks`);
}

main()
  .then(async () => {
    await cleanup();
    provider.close();
    if (failures === 0) {
      console.log('\n\x1b[32m✔ Delivery retries, tells the truth, and stops when told\x1b[0m\n');
      process.exit(0);
    }
    console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
    process.exit(1);
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    provider.close();
    console.error('\n\x1b[31m✖ the verification itself failed\x1b[0m', error);
    process.exit(1);
  });
