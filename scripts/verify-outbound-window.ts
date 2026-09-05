/**
 * Every outbound message asks the same question — gap G-214.
 *
 * G-213 taught ONE handler that WhatsApp carries free text only within 24
 * hours of the contact's last message. Nine other send sites never asked, and
 * two of them had already been refused in production: the approval
 * announcement (ADM-95 made the internal channel a PERSON, so the window
 * governs it) and the approved quotation, dispatched hours or days after the
 * client last wrote.
 *
 * This drives the real pieces:
 *
 *   crm.window_state             the four states, per NUMBER not per thread
 *   crm:dispatchApprovedQuotation the real handler, real approval row
 *   crm.defer_send / wake        the real park and the real wake
 *   crm.ingestInboundMessage     the real inbound path that wakes it
 *   HTTP provider boundary       a stub this script controls
 *
 *   npm run db:verify:window
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

process.env.WHATSAPP_ACCESS_TOKEN = 'verify-stub-token-not-a-real-credential';

import { createAdminClient } from '@/lib/db/admin';
import {
  deferSend,
  outreachAllowance,
  planOutbound,
  readWindowState,
} from '@/modules/crm/outbound-window';
import { ingestInboundMessage } from '@/modules/crm/ingest';

let hits = 0;
const wire: Record<string, unknown>[] = [];
const provider = createServer((req, res) => {
  hits += 1;
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { wire.push(JSON.parse(raw)); } catch { /* not JSON */ } });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ messages: [{ id: `wamid.stub-${hits}` }] }));
});

await new Promise<void>((resolve) => provider.listen(0, resolve));
const address = provider.address();
if (address === null || typeof address === 'string') throw new Error('the stub provider has no port');
process.env.WHATSAPP_GRAPH_BASE_URL = `http://127.0.0.1:${address.port}`;

const admin = createAdminClient();
const MARK = `zzwin-${randomUUID().slice(0, 8)}`;

let checks = 0;
let failures = 0;
function check(ok: boolean, description: string, detail = '') {
  checks += 1;
  if (ok) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

/**
 * The seeded organization, and the only place an approval request may live.
 *
 * `approvals.reject_delete` makes an approval row permanent, and a permanent
 * child makes its organization undeletable — which fails CI's first-owner
 * check two scripts later. Every throwaway org in this file holds none.
 */
const SEEDED_ORG = '00000000-0000-4000-8000-000000000001';
const SEEDED_NUMBER = `stub-${MARK}-seeded`;
let seededSettingsTouched = false;

let orgA = '';
let orgB = '';

let decider = '';

const made = {
  orgs: [] as string[],
  contacts: [] as string[],
  leads: [] as string[],
  conversations: [] as string[],
  opportunities: [] as string[],
  proposals: [] as string[],
  jobs: [] as string[],
  users: [] as string[],
};

/**
 * The rows the REAL ingest made, which this script did not create and would
 * otherwise leave behind.
 *
 * Not tidiness. A leftover `wa:+91…` conversation makes the next run's ingest
 * take its `on conflict do nothing` branch and adopt the stale row — whose
 * contact was set null by the previous cleanup's cascade — so the window
 * reads `never` and the run fails for a reason that has nothing to do with
 * the code. That is exactly how this was found.
 */
async function cleanupIngested(numbers: readonly string[]) {
  for (const number of numbers) {
    const ref = `wa:${number}`;
    const { data: convos } = await admin.schema('crm').from('conversations')
      .select('id, lead_id').eq('external_ref', ref);
    for (const c of convos ?? []) {
      await admin.schema('crm').from('conversation_messages').delete().eq('conversation_id', c.id);
      await admin.schema('core').from('jobs').delete().like('dedupe_key', `%${c.id}%`);
      await admin.schema('crm').from('conversations').delete().eq('id', c.id);
      if (c.lead_id) await admin.schema('crm').from('leads').delete().eq('id', c.lead_id);
    }
    await admin.schema('crm').from('contacts').delete()
      .eq('organization_id', SEEDED_ORG).eq('phone', number.replace(/^\+/, ''));
  }
}

async function cleanup() {
  await cleanupIngested(['+919000000402', '919000000402']);
  // Templates this script registered. The registry is per organization and the
  // seeded one is shared, so a left-behind row makes the next run's "nothing
  // is registered" section find something.
  await admin.schema('crm').from('whatsapp_templates').delete()
    .eq('organization_id', SEEDED_ORG).like('template_name', 'zz_%');
  for (const id of made.jobs) {
    await admin.schema('crm').from('deferred_sends').delete().eq('job_id', id);
    await admin.schema('core').from('jobs').delete().eq('id', id);
  }
  for (const id of made.proposals) await admin.schema('sales').from('proposals').delete().eq('id', id);
  for (const id of made.opportunities) await admin.schema('sales').from('opportunities').delete().eq('id', id);
  for (const id of made.conversations) {
    await admin.schema('crm').from('conversation_messages').delete().eq('conversation_id', id);
    await admin.schema('crm').from('conversations').delete().eq('id', id);
  }
  for (const id of made.leads) await admin.schema('crm').from('leads').delete().eq('id', id);
  for (const id of made.contacts) await admin.schema('crm').from('contacts').delete().eq('id', id);
  // Any org that ever held an approval request is undeletable by design
  // (approvals.reject_delete), which is why every approval below lives in the
  // SEEDED org and every throwaway org here holds none.
  for (const id of made.users) {
    await admin.schema('core').from('memberships').delete().eq('user_id', id);
    // The auth row's cascade takes core.users with it.
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      cache: 'no-store',
    });
  }
  for (const id of made.orgs) await admin.schema('core').from('organizations').delete().eq('id', id);
  // Back to the seed default: this deployment has not chosen a number and the
  // test must not choose one beyond its own lifetime.
  if (seededSettingsTouched) {
    await admin.schema('core').from('organizations').update({ settings: {} }).eq('id', SEEDED_ORG);
  }
}

async function makeOrg(label: string) {
  const { data } = await admin.schema('core').from('organizations')
    .insert({
      name: `${MARK} ${label}`, slug: `${MARK}-${label}`, timezone: 'Asia/Kolkata',
      settings: { whatsapp_phone_number_id: `stub-${MARK}-${label}` },
    }).select('id').single();
  made.orgs.push(data!.id);
  return data!.id;
}

/** A contact with a phone, a lead, a thread, and consent to be messaged. */
async function makeThread(org: string, label: string, phone: string) {
  const { data: contact } = await admin.schema('crm').from('contacts')
    .insert({ organization_id: org, full_name: `${MARK} ${label}`, phone }).select('id').single();
  made.contacts.push(contact!.id);

  await admin.schema('crm').from('communication_consent')
    .insert({ organization_id: org, contact_id: contact!.id, channel: 'whatsapp', status: 'granted', source: MARK });

  const { data: lead } = await admin.schema('crm').from('leads')
    .insert({ organization_id: org, title: `${MARK} ${label}`, contact_id: contact!.id, status: 'qualifying' })
    .select('id').single();
  made.leads.push(lead!.id);

  const { data: convo } = await admin.schema('crm').from('conversations')
    .insert({
      organization_id: org, lead_id: lead!.id, contact_id: contact!.id,
      kind: 'direct', channel: 'whatsapp', external_ref: `wa:${phone}:${label}`,
    }).select('id').single();
  made.conversations.push(convo!.id);

  return { contact: contact!.id, lead: lead!.id, conversation: convo!.id, phone };
}

/** A second thread for a contact who already exists — same number, new lead. */
async function secondThread(org: string, contactId: string, label: string) {
  const { data: lead } = await admin.schema('crm').from('leads')
    .insert({ organization_id: org, title: `${MARK} ${label}`, contact_id: contactId, status: 'qualifying' })
    .select('id').single();
  made.leads.push(lead!.id);

  const { data: convo } = await admin.schema('crm').from('conversations')
    .insert({
      organization_id: org, lead_id: lead!.id, contact_id: contactId,
      kind: 'direct', channel: 'whatsapp', external_ref: `wa:${MARK}:${label}`,
    }).select('id').single();
  made.conversations.push(convo!.id);
  return convo!.id;
}

async function clientWrote(org: string, conversationId: string, hoursAgo: number, seq = 0) {
  await admin.schema('crm').from('conversation_messages').insert({
    organization_id: org, conversation_id: conversationId, seq, author_type: 'client',
    body: 'hello', external_ref: `${MARK}-in-${randomUUID().slice(0, 8)}`,
    occurred_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  });
}

async function stateOf(conversationId: string) {
  const { data } = await admin.schema('crm').rpc('window_state', { p_conversation_id: conversationId });
  return (Array.isArray(data) ? data[0] : data) as string;
}

async function jobRow(id: string) {
  const { data } = await admin.schema('core').from('jobs')
    .select('status, run_at, attempts, last_error').eq('id', id).maybeSingle();
  return data as { status: string; run_at: string; attempts: number; last_error: string | null } | null;
}


/** A queued outbound job, standing in for whichever announcer parked it. */
async function makeJob(label: string) {
  const { data } = await admin.schema('core').from('jobs')
    .insert({
      organization_id: SEEDED_ORG,
      kind: 'proposal.dispatch',
      payload: { subjectId: randomUUID() },
      dedupe_key: `${MARK}:${label}:dispatch`,
      status: 'running',
      attempts: 1,
    }).select('id').single();
  made.jobs.push(data!.id);
  return data!.id as string;
}

async function deferredRow(jobId: string) {
  const { data } = await admin.schema('crm').from('deferred_sends')
    .select('id, reason, woken_at, counterpart_digits').eq('job_id', jobId).maybeSingle();
  return data as { id: string; reason: string; woken_at: string | null; counterpart_digits: string } | null;
}

async function windowSections() {
  /**
   * What these sections drive, and what they deliberately do not.
   *
   * `dispatchApprovedQuotation` cannot be imported here: it lazily loads
   * `@/modules/sales/service`, which reaches `next/navigation` through the
   * session helper, and that module does not load under a script runtime.
   * Mocking it would prove the mock. So the HANDLER's use of the gate is
   * proven in tests/every-outbound-message-asks.test.ts, where `mock.module`
   * is the honest tool, and what is driven HERE is the contract underneath
   * it — the real functions, on the real schema, against a real job row and
   * a real inbound message.
   */

  // ── 4. the plan, outside the window with nothing approved ──────────────
  console.log('\n4. Outside the window with nothing approved, the answer is WAIT');

  await admin.schema('core').from('organizations')
    .update({ settings: { whatsapp_phone_number_id: SEEDED_NUMBER } }).eq('id', SEEDED_ORG);
  seededSettingsTouched = true;

  const silent = await makeThread(SEEDED_ORG, 'quote-silent', '+919000000401');
  const job1Id = await makeJob('q1');

  const nothing = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: silent.conversation,
    situationKey: 'quotation_approved',
    jobId: job1Id,
  });
  check(nothing.mode === 'defer', 'the plan says defer, not send', nothing.mode);
  check(
    nothing.mode === 'defer' && nothing.reason.includes('never written'),
    'and says WHY in words an Admin can act on',
    nothing.mode === 'defer' ? nothing.reason : '',
  );
  check(hits === 0, 'nothing was handed to Meta, so there is no 400 to collect', `${hits}`);

  const parked = await deferSend(admin, {
    jobId: job1Id,
    conversationId: silent.conversation,
    reason: nothing.mode === 'defer' ? nothing.reason : 'unexpected',
    // Carried from the plan, exactly as the handler carries it — G-220. A
    // fixture that hand-wrote this would prove the fixture.
    ...(nothing.mode === 'defer' ? { blockedOn: nothing.blockedOn } : {}),
  });
  check(parked === 'deferred', 'the job parks', parked);

  const row = await deferredRow(job1Id);
  check(
    row?.counterpart_digits === '919000000401',
    'keyed by the number, digits only, so an inbound message can find it',
    row?.counterpart_digits,
  );

  const after = await jobRow(job1Id);
  check(after?.status === 'queued', 'the job is queued again, not succeeded — a succeeded job never wakes', after?.status);
  check(
    Boolean(after && new Date(after.run_at).getTime() > Date.now() + 20 * 86_400_000),
    'parked over the horizon rather than retried into the ground',
    after?.run_at,
  );
  check(after?.attempts === 0, 'and the attempt it spent discovering the shut window is given back', `${after?.attempts}`);

  // ── 5. with a template registered, the plan changes ────────────────────
  console.log('\n5. With an approved template, the plan is to send THAT — once');

  await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: SEEDED_ORG, situation_key: 'quotation_approved',
    template_name: 'zz_quotation_ready', language_code: 'en',
  });

  const silent2 = await makeThread(SEEDED_ORG, 'quote-silent-2', '+919000000402');
  const job2Id = await makeJob('q2');

  const withTemplate = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: silent2.conversation,
    situationKey: 'quotation_approved',
    jobId: job2Id,
  });
  check(withTemplate.mode === 'template', 'the plan is the approved template', withTemplate.mode);
  check(
    withTemplate.mode === 'template' && withTemplate.template.name === 'zz_quotation_ready',
    'named exactly as registered — this system never invents one',
    withTemplate.mode === 'template' ? withTemplate.template.name : '',
  );

  // Another organization's template is not this one's, and the lookup runs on
  // the service-role client that bypasses RLS — so the filter is the only
  // thing between two agencies.
  await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: orgA, situation_key: 'quotation_approved',
    template_name: 'zz_SOMEBODY_ELSES', language_code: 'en',
  });
  const foreignThread = await makeThread(orgA, 'foreign-tpl', '+919000000501');
  const foreignPlan = await planOutbound(admin, {
    organizationId: orgA,
    conversationId: foreignThread.conversation,
    situationKey: 'quotation_approved',
  });
  check(
    foreignPlan.mode === 'template' && foreignPlan.template.name === 'zz_SOMEBODY_ELSES',
    'each organization gets its own',
    foreignPlan.mode === 'template' ? foreignPlan.template.name : foreignPlan.mode,
  );

  await deferSend(admin, {
    jobId: job2Id,
    conversationId: silent2.conversation,
    reason: 'told once; the quotation itself waits for a reply',
    blockedOn: 'window',
  });

  const toldOnce = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: silent2.conversation,
    situationKey: 'quotation_approved',
    jobId: job2Id,
  });
  check(
    toldOnce.mode === 'defer',
    'and a job that already sent its template does not send a second one — the client hears about one quotation once',
    toldOnce.mode,
  );

  // ── 6. their reply wakes it ────────────────────────────────────────────
  console.log('\n6. Their reply wakes everything parked on their number');

  const inbound = await ingestInboundMessage(admin, {
    externalRef: `wamid.${MARK}-wake`,
    phoneNumberId: SEEDED_NUMBER,
    from: '919000000402',
    body: 'haan bhejo',
    occurredAt: new Date().toISOString(),
    profileName: `${MARK} quote-silent-2`,
  });
  check(inbound.ok, 'the inbound message goes through the real ingest path', JSON.stringify(inbound).slice(0, 200));

  const woken = await deferredRow(job2Id);
  check(Boolean(woken?.woken_at), 'the deferral is marked woken', String(woken?.woken_at));

  const job2 = await jobRow(job2Id);
  check(
    Boolean(job2 && new Date(job2.run_at).getTime() <= Date.now() + 5_000),
    'and the job is runnable now rather than in thirty days',
    job2?.run_at,
  );

  check(
    await stateOf(silent2.conversation) === 'open',
    'the window is open, because they wrote',
    await stateOf(silent2.conversation),
  );

  const nowSend = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: silent2.conversation,
    situationKey: 'quotation_approved',
    jobId: job2Id,
  });
  check(nowSend.mode === 'text', 'and the plan is now the wording itself, not another template', nowSend.mode);

  // The one that was never woken stays parked. A wake is for a number, not
  // for everything the organization is waiting on.
  const stillParked = await jobRow(job1Id);
  check(
    Boolean(stillParked && new Date(stillParked.run_at).getTime() > Date.now() + 20 * 86_400_000),
    'a different number\u2019s deferral is untouched — the wake is not a broadcast',
    stillParked?.run_at,
  );

  // ── 6b. what has to change, recorded where a person can count it ───────
  console.log('\n6b. A waiting send says WHAT it is waiting for (G-220)');
  {
    const blockedOf = async (jobId: string) => {
      const { data } = await admin.schema('crm').from('deferred_sends')
        .select('blocked_on').eq('job_id', jobId).maybeSingle();
      return (data as { blocked_on: string } | null)?.blocked_on;
    };

    // job1 was parked with nothing registered for its situation.
    check(
      await blockedOf(job1Id) === 'no_template',
      'a send with nothing approved to carry it is blocked on an ADMIN — nothing else will ever release it',
      await blockedOf(job1Id),
    );
    // job2 was told once and is waiting on the client.
    check(
      await blockedOf(job2Id) === 'window',
      'and one whose template already went is waiting on THEM',
      await blockedOf(job2Id),
    );

    // job2 was WOKEN in section 6, so it is no longer waiting — which is the
    // right answer and the wrong fixture for counting one. A fresh park,
    // blocked on the counterpart, gives the count something true to see.
    const stillWaiting = await makeJob('waiting');
    await deferSend(admin, {
      jobId: stillWaiting,
      conversationId: silent2.conversation,
      reason: 'told once; the rest waits for a reply',
      blockedOn: 'window',
    });

    /**
     * The distinction earns its keep here.
     *
     * A quotation waiting for a client to write back is the design working,
     * and an alert that fires on it teaches somebody to ignore alerts. Only
     * the first kind is counted into severity.
     */
    const { data: backlog } = await admin.schema('core').rpc('operational_backlog');
    const row = (Array.isArray(backlog) ? backlog[0] : backlog) as
      { sends_waiting_on_admin: number; sends_waiting_on_reply: number; stuck_queued_jobs: number } | null;
    check(
      Number(row?.sends_waiting_on_admin) >= 1,
      'the operational backlog counts the one an Admin must end',
      `${row?.sends_waiting_on_admin}`,
    );
    check(
      Number(row?.sends_waiting_on_reply) >= 1,
      'and counts the one that ends itself, separately',
      `${row?.sends_waiting_on_reply}`,
    );

    /**
     * A parked job is `queued`, which is the shape of a stuck one — and it is
     * not reported as stuck, because its `run_at` is in the future and the
     * count asks for jobs whose time came and went.
     *
     * Worth asserting even though nothing was written to make it true: it is
     * the property that lets a deferral exist at all without the alert firing
     * on the feature, and it would break silently if anybody widened that
     * clause.
     */
    check(
      Number(row?.stuck_queued_jobs) === 0,
      'a job parked for the future is not reported as stuck — a deferral must not read as a fault',
      `${row?.stuck_queued_jobs} stuck`,
    );
  }

  // ── 7. a deferral cannot cross the tenant line ─────────────────────────
  console.log('\n7. A deferral cannot park another organization\u2019s job');
  {
    const foreign = await makeThread(orgB, 'foreign', '+919000000701');
    const refused = await deferSend(admin, {
      jobId: job1Id,
      conversationId: foreign.conversation,
      reason: 'this must not be possible',
    });
    check(refused === 'wrong_tenant', 'a conversation in another organization is refused', refused);

    const { data: group } = await admin.schema('crm').from('conversations')
      .insert({ organization_id: SEEDED_ORG, kind: 'internal_group', channel: 'whatsapp', external_ref: `${MARK}-grp2` })
      .select('id').single();
    made.conversations.push(group!.id);
    const noWait = await deferSend(admin, {
      jobId: job1Id,
      conversationId: group!.id,
      reason: 'a group has nobody to wait for',
    });
    check(noWait === 'no_counterpart', 'and a group is refused, because nothing would ever wake it', noWait);
  }
}


async function variableSections() {
  // ── 8. a variable nobody filled ────────────────────────────────────────
  console.log('\n8. A template variable is a NAME this system fills, or the send does not go (G-215)');

  const named = await makeThread(SEEDED_ORG, 'named', '+919000000801');
  await admin.schema('crm').from('contacts')
    .update({ full_name: 'Priya Raman' }).eq('id', named.contact);

  // The registry refuses a name nothing can fill, at registration rather than
  // at send time against a real client.
  const { error: refused } = await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: SEEDED_ORG, situation_key: 'agent_message',
    template_name: 'zz_bad_variable', language_code: 'en', parameters: ['first_name'],
  });
  check(
    Boolean(refused),
    'a variable this system cannot fill is refused at REGISTRATION — `first_name` is not a name it holds',
    refused ? refused.message.slice(0, 80) : 'accepted',
  );

  await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: SEEDED_ORG, situation_key: 'agent_message',
    template_name: 'zz_named_nudge', language_code: 'en',
    parameters: ['contact_first_name', 'agency_name'],
  });

  const filled = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: named.conversation,
    situationKey: 'agent_message',
  });
  check(filled.mode === 'template', 'with every variable fillable, the template goes', filled.mode);
  check(
    filled.mode === 'template' && filled.template.parameters[0] === 'Priya',
    'carrying the VALUE, not the name — this is the defect G-215 exists for',
    filled.mode === 'template' ? JSON.stringify(filled.template.parameters) : '',
  );
  check(
    filled.mode === 'template' && !filled.template.parameters.includes('contact_first_name'),
    'and the word "contact_first_name" is nowhere on the wire',
  );

  // A contact whose WhatsApp profile name is their number — the commonest
  // shape in a real inbox, and the one a naive greeting embarrasses you with.
  const unnamed = await makeThread(SEEDED_ORG, 'unnamed', '+919000000802');
  await admin.schema('crm').from('contacts')
    .update({ full_name: '+919000000802' }).eq('id', unnamed.contact);

  const unfillable = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: unnamed.conversation,
    situationKey: 'agent_message',
  });
  check(
    unfillable.mode !== 'template',
    'a contact with no real name does NOT get a template with a blank in it',
    unfillable.mode,
  );
  check(
    unfillable.mode === 'defer' && unfillable.reason.includes('contact_first_name'),
    'and the reason names the fact that was missing, so somebody can fix it',
    unfillable.mode === 'defer' ? unfillable.reason : '',
  );

  // ── 9. only what Meta approved, and only while it says so ──────────────
  console.log('\n9. Status is Meta\u2019s word, and `active` is the Admin\u2019s — a send needs both');

  await admin.schema('crm').from('whatsapp_templates')
    .update({ status: 'paused' })
    .eq('organization_id', SEEDED_ORG).eq('situation_key', 'agent_message');

  const paused = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: named.conversation,
    situationKey: 'agent_message',
  });
  check(paused.mode !== 'template', 'a paused template is not sent', paused.mode);

  await admin.schema('crm').from('whatsapp_templates')
    .update({ status: 'approved' })
    .eq('organization_id', SEEDED_ORG).eq('situation_key', 'agent_message');
  const restored = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: named.conversation,
    situationKey: 'agent_message',
  });
  check(restored.mode === 'template', 'and approving it again makes it sendable — the positive twin', restored.mode);

  // ── 10. the history a typo cannot rewrite ──────────────────────────────
  console.log('\n10. Every change to a template is a version, so what was sent in March stays true in April');

  const { data: tpl } = await admin.schema('crm').from('whatsapp_templates')
    .select('id').eq('organization_id', SEEDED_ORG).eq('situation_key', 'agent_message').maybeSingle();

  const versions = async () => {
    const { data } = await admin.schema('crm').from('whatsapp_template_versions')
      .select('template_name, status, recorded_at').eq('template_id', tpl!.id).order('recorded_at');
    return data ?? [];
  };

  const before = await versions();
  check(before.length >= 3, 'creating it and each status change were recorded', `${before.length}`);

  await admin.schema('crm').from('whatsapp_templates')
    .update({ template_name: 'zz_named_nudge_v2' }).eq('id', tpl!.id);
  const afterRename = await versions();
  check(afterRename.length === before.length + 1, 'a rename adds one', `${before.length} → ${afterRename.length}`);
  check(
    afterRename.at(-1)?.template_name === 'zz_named_nudge_v2',
    'and the newest version is what would be sent now',
    String(afterRename.at(-1)?.template_name),
  );

  await admin.schema('crm').from('whatsapp_templates')
    .update({ template_name: 'zz_named_nudge_v2' }).eq('id', tpl!.id);
  check(
    (await versions()).length === afterRename.length,
    'a write that changes nothing writes no version — history is what happened, not what was saved',
  );
}


async function limitSections() {
  // ── 11. how often is too often ─────────────────────────────────────────
  console.log('\n11. Outreach is limited, and a reply is never outreach (G-216)');

  // Conservative defaults apply with no row at all — the property that makes
  // a deployment nobody configured safe rather than unlimited.
  await admin.schema('crm').from('outreach_limits').delete().eq('organization_id', SEEDED_ORG);

  const target = await makeThread(SEEDED_ORG, 'limits', '+919000001101');
  await admin.schema('crm').from('contacts')
    .update({ full_name: 'Asha Verma' }).eq('id', target.contact);

  check(await outreachAllowance(admin, target.conversation) === 'ok', 'a contact nobody has messaged may be messaged');

  const outreachAt = async (conversationId: string, org: string, seq: number, hoursAgo: number) => {
    const { data } = await admin.schema('crm').from('conversation_messages').insert({
      organization_id: org, conversation_id: conversationId, seq, author_type: 'agent',
      body: `${MARK} outreach ${seq}`, external_ref: `${MARK}-out-${seq}-${randomUUID().slice(0, 6)}`,
      occurred_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    }).select('id').single();
    await admin.schema('crm').rpc('mark_message_as_outreach', { p_message_id: data!.id });
    return data!.id as string;
  };

  await outreachAt(target.conversation, SEEDED_ORG, 1, 2);
  check(
    await outreachAllowance(admin, target.conversation) === 'per_contact_per_day',
    'one message today is the day\u2019s allowance, by default',
    await outreachAllowance(admin, target.conversation),
  );

  // The same person on a second thread is the same person.
  const second = await secondThread(SEEDED_ORG, target.contact, 'limits-2');
  check(
    await outreachAllowance(admin, second) === 'per_contact_per_day',
    'and a SECOND THREAD with the same person is not a way around it',
    await outreachAllowance(admin, second),
  );

  // A message nobody marked as outreach is an answer, and answers are free.
  const answering = await makeThread(SEEDED_ORG, 'answering', '+919000001102');
  await admin.schema('crm').from('conversation_messages').insert({
    organization_id: SEEDED_ORG, conversation_id: answering.conversation, seq: 0, author_type: 'client',
    body: 'question', external_ref: `${MARK}-ans-in`, occurred_at: new Date().toISOString(),
  });
  for (const seq of [1, 2, 3, 4, 5]) {
    await admin.schema('crm').from('conversation_messages').insert({
      organization_id: SEEDED_ORG, conversation_id: answering.conversation, seq, author_type: 'agent',
      body: `${MARK} answer ${seq}`, external_ref: `${MARK}-ans-${seq}`,
      occurred_at: new Date().toISOString(),
    });
  }
  check(
    await outreachAllowance(admin, answering.conversation) === 'ok',
    'five answers in one conversation spend nothing — a reply is not outreach',
    await outreachAllowance(admin, answering.conversation),
  );

  // ── 12. fatigue: three unanswered, then stop ───────────────────────────
  console.log('\n12. Three messages nobody answered, and outreach stops');

  const quiet = await makeThread(SEEDED_ORG, 'quiet', '+919000001201');
  await admin.schema('crm').from('outreach_limits').insert({
    organization_id: SEEDED_ORG,
    // Generous rates, so what refuses below is FATIGUE and not a rate. A test
    // whose subject is masked by another rule proves the other rule.
    per_contact_per_day: 20, per_contact_per_week: 60, per_organization_per_day: 100000,
    unanswered_before_cooldown: 3, cooldown_days: 30,
  });

  await outreachAt(quiet.conversation, SEEDED_ORG, 1, 72);
  await outreachAt(quiet.conversation, SEEDED_ORG, 2, 48);
  check(await outreachAllowance(admin, quiet.conversation) === 'ok', 'two unanswered is not yet fatigue');

  await outreachAt(quiet.conversation, SEEDED_ORG, 3, 24);
  check(
    await outreachAllowance(admin, quiet.conversation) === 'cooldown',
    'the third unanswered message starts a cooldown',
    await outreachAllowance(admin, quiet.conversation),
  );

  // One reply clears it completely, because they answered.
  await admin.schema('crm').from('conversation_messages').insert({
    organization_id: SEEDED_ORG, conversation_id: quiet.conversation, seq: 9, author_type: 'client',
    body: 'sorry, was travelling', external_ref: `${MARK}-quiet-in`,
    occurred_at: new Date().toISOString(),
  });
  check(
    await outreachAllowance(admin, quiet.conversation) === 'ok',
    'and one reply clears it completely — they answered, which is the whole point',
    await outreachAllowance(admin, quiet.conversation),
  );

  // ── 13. the decision layer refuses, and says when it clears ────────────
  console.log('\n13. A held send waits for the clock, not for a reply');

  await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: SEEDED_ORG, situation_key: 'inactive_lead',
    template_name: 'zz_reactivation', language_code: 'en',
  });

  // Back to one a day: section 12 loosened the rates so that FATIGUE was the
  // rule doing the refusing there, and leaving them loose here would mean this
  // section proved nothing.
  await admin.schema('crm').from('outreach_limits')
    .update({ per_contact_per_day: 1 }).eq('organization_id', SEEDED_ORG);

  const held = await makeThread(SEEDED_ORG, 'held', '+919000001301');
  await outreachAt(held.conversation, SEEDED_ORG, 1, 2);

  const plan = await planOutbound(admin, {
    organizationId: SEEDED_ORG,
    conversationId: held.conversation,
    situationKey: 'inactive_lead',
  });
  check(plan.mode === 'defer', 'a registered, approved template is still refused by the limit', plan.mode);
  check(
    plan.mode === 'defer' && Boolean(plan.until),
    'and the wait names WHEN it clears, because a clock clears a rate',
    plan.mode === 'defer' ? String(plan.until) : '',
  );
  check(
    plan.mode === 'defer' && plan.reason.includes('today'),
    'in words an operator can act on',
    plan.mode === 'defer' ? plan.reason : '',
  );

  const heldJob = await makeJob('held');
  await deferSend(admin, {
    jobId: heldJob,
    conversationId: held.conversation,
    reason: plan.mode === 'defer' ? plan.reason : 'x',
    ...(plan.mode === 'defer' && plan.until ? { until: plan.until } : {}),
  });
  const parkedRow = await jobRow(heldJob);
  const parkedAt = parkedRow ? new Date(parkedRow.run_at).getTime() : 0;
  check(
    parkedAt > Date.now() + 20 * 3_600_000 && parkedAt < Date.now() + 30 * 3_600_000,
    'the job waits about a day rather than the window\u2019s thirty',
    parkedRow?.run_at,
  );

  // And the org-wide ceiling, which is the one that stops a runaway campaign
  // reaching everybody before anybody notices.
  await admin.schema('crm').from('outreach_limits')
    .update({ per_contact_per_day: 20, per_organization_per_day: 0 })
    .eq('organization_id', SEEDED_ORG);
  const fresh = await makeThread(SEEDED_ORG, 'ceiling', '+919000001302');
  check(
    await outreachAllowance(admin, fresh.conversation) === 'per_organization_per_day',
    'a per-day ceiling of zero stops the whole agency, which is a legitimate way to pause',
    await outreachAllowance(admin, fresh.conversation),
  );

  await admin.schema('crm').from('outreach_limits').delete().eq('organization_id', SEEDED_ORG);
}


async function languageSections() {
  // ── 14. their language, or the fallback, never a guess ─────────────────
  console.log('\n14. A contact gets the template in the language they write in (G-217)');

  await admin.schema('crm').from('outreach_limits').delete().eq('organization_id', SEEDED_ORG);
  await admin.schema('crm').from('outreach_limits').insert({
    organization_id: SEEDED_ORG, per_contact_per_day: 20, per_contact_per_week: 60,
    per_organization_per_day: 100000, unanswered_before_cooldown: 20, cooldown_days: 1,
  });

  const hindi = await makeThread(SEEDED_ORG, 'hindi', '+919000001401');
  await admin.schema('crm').from('contacts')
    .update({ full_name: 'Rakesh Kumar', preferred_language: 'hi' }).eq('id', hindi.contact);

  const english = await makeThread(SEEDED_ORG, 'english', '+919000001402');
  await admin.schema('crm').from('contacts')
    .update({ full_name: 'Sarah Fernandes', preferred_language: 'en' }).eq('id', english.contact);

  // English only, to begin with — the state of an agency that has had one
  // template approved.
  await admin.schema('crm').from('whatsapp_templates').insert({
    organization_id: SEEDED_ORG, situation_key: 'post_project',
    template_name: 'zz_after_project_en', language_code: 'en',
  });

  const onlyEnglish = await planOutbound(admin, {
    organizationId: SEEDED_ORG, conversationId: hindi.conversation, situationKey: 'post_project',
  });
  check(
    onlyEnglish.mode === 'template' && onlyEnglish.template.name === 'zz_after_project_en',
    'with only English registered, a Hindi speaker gets the English one rather than nothing',
    onlyEnglish.mode === 'template' ? onlyEnglish.template.name : onlyEnglish.mode,
  );
  check(
    onlyEnglish.mode === 'template' && onlyEnglish.template.matchedLanguage === false,
    'and it is recorded as a FALLBACK, so a missing translation is visible rather than silent',
    onlyEnglish.mode === 'template' ? String(onlyEnglish.template.matchedLanguage) : '',
  );

  // Now the Hindi one, which must not overwrite the English one.
  await admin.schema('crm').rpc('set_whatsapp_template', {
    p_organization_id: SEEDED_ORG, p_situation_key: 'post_project',
    p_template_name: 'zz_after_project_hi', p_language_code: 'hi', p_parameters: [],
  });

  const { data: both } = await admin.schema('crm').from('whatsapp_templates')
    .select('language_code').eq('organization_id', SEEDED_ORG)
    .eq('situation_key', 'post_project').eq('active', true);
  check(
    (both ?? []).length === 2,
    'registering Hindi does NOT overwrite English — a situation holds one per language',
    `${(both ?? []).length} registered`,
  );

  const inHindi = await planOutbound(admin, {
    organizationId: SEEDED_ORG, conversationId: hindi.conversation, situationKey: 'post_project',
  });
  check(
    inHindi.mode === 'template' && inHindi.template.name === 'zz_after_project_hi',
    'and now the Hindi speaker gets the Hindi one',
    inHindi.mode === 'template' ? inHindi.template.name : inHindi.mode,
  );
  check(
    inHindi.mode === 'template' && inHindi.template.matchedLanguage === true,
    'matched, not fallen back',
    inHindi.mode === 'template' ? String(inHindi.template.matchedLanguage) : '',
  );

  const stillEnglish = await planOutbound(admin, {
    organizationId: SEEDED_ORG, conversationId: english.conversation, situationKey: 'post_project',
  });
  check(
    stillEnglish.mode === 'template' && stillEnglish.template.name === 'zz_after_project_en',
    'and the English speaker still gets English — the positive twin, without which this passes on a system that always picks Hindi',
    stillEnglish.mode === 'template' ? stillEnglish.template.name : stillEnglish.mode,
  );

  // ── 15. what actually went out, and how it did ─────────────────────────
  console.log('\n15. Performance is derived from the transcript, never counted');

  const { data: tpl } = await admin.schema('crm').from('whatsapp_templates')
    .select('id').eq('organization_id', SEEDED_ORG)
    .eq('situation_key', 'post_project').eq('language_code', 'hi').maybeSingle();

  const perf = async () => {
    const { data } = await admin.schema('crm').from('whatsapp_template_performance')
      .select('sent, delivered, read, replied').eq('template_id', tpl!.id).maybeSingle();
    return data as { sent: number; delivered: number; read: number; replied: number } | null;
  };

  check((await perf())?.sent === 0, 'a template nobody has sent reports nothing, rather than no row');

  const { data: msg } = await admin.schema('crm').from('conversation_messages').insert({
    organization_id: SEEDED_ORG, conversation_id: hindi.conversation, seq: 50, author_type: 'agent',
    body: `${MARK} the template went`, external_ref: `${MARK}-perf-1`,
    occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
  }).select('id').single();
  await admin.schema('crm').rpc('mark_message_as_outreach', {
    p_message_id: msg!.id, p_template_id: tpl!.id,
  });

  check((await perf())?.sent === 1, 'a send counts once', `${(await perf())?.sent}`);
  check((await perf())?.read === 0, 'and is not read until Meta says so');

  // Meta's own receipt, through the column the receipts write.
  await admin.schema('crm').from('conversation_messages')
    .update({ metadata: { outreach: true, template_id: tpl!.id, wire_status: 'read' } })
    .eq('id', msg!.id);
  const afterRead = await perf();
  check(afterRead?.read === 1, 'a read receipt makes it read', `${afterRead?.read}`);
  check(afterRead?.delivered === 1, 'and read implies delivered — the states are monotonic', `${afterRead?.delivered}`);
  check(afterRead?.replied === 0, 'nobody has replied yet');

  await admin.schema('crm').from('conversation_messages').insert({
    organization_id: SEEDED_ORG, conversation_id: hindi.conversation, seq: 51, author_type: 'client',
    body: 'haan boliye', external_ref: `${MARK}-perf-reply`,
    occurred_at: new Date().toISOString(),
  });
  check((await perf())?.replied === 1, 'and their reply within seven days counts as one', `${(await perf())?.replied}`);

  await admin.schema('crm').from('outreach_limits').delete().eq('organization_id', SEEDED_ORG);
}

async function main() {
  console.log('\n\x1b[1mAgencyOS — every outbound message asks the same question (G-214)\x1b[0m');

  /**
   * A real person to have decided the approval.
   *
   * `dispatchApprovedQuotation` reads the decider from the approval ROW and
   * authors the client message as them — ADM-22's rule that a price is quoted
   * by a person, not by an automation. A null decider stops the handler before
   * it ever reaches the window, which is how the first draft of this script
   * proved nothing while reporting a pass.
   */
  const authResponse = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARK}-owner@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  });
  const authUser = (await authResponse.json()) as { id?: string };
  if (!authUser.id) throw new Error(`could not create the deciding user: ${JSON.stringify(authUser).slice(0, 200)}`);
  decider = authUser.id;
  made.users.push(decider);
  // `core.users.id` references `auth.users(id)`, so the profile row comes second.
  await admin.schema('core').from('users')
    .insert({ id: decider, email: `${MARK}-owner@example.invalid`, full_name: `${MARK} owner` });
  await admin.schema('core').from('memberships')
    .insert({ organization_id: SEEDED_ORG, user_id: decider, role: 'owner', status: 'active' });

  orgA = await makeOrg('a');
  orgB = await makeOrg('b');

  // ── 1. the four states ──────────────────────────────────────────────────
  console.log('\n1. crm.window_state tells four things apart');
  {
    const fresh = await makeThread(orgA, 'fresh', '+919000000101');
    await clientWrote(orgA, fresh.conversation, 1);
    check(await stateOf(fresh.conversation) === 'open', 'an hour ago is OPEN');

    const stale = await makeThread(orgA, 'stale', '+919000000102');
    await clientWrote(orgA, stale.conversation, 30);
    check(await stateOf(stale.conversation) === 'closed', 'thirty hours ago is CLOSED');

    const silent = await makeThread(orgA, 'silent', '+919000000103');
    check(
      await stateOf(silent.conversation) === 'never',
      'and a contact who has NEVER written is NEVER, not closed — the state of every imported lead',
      await stateOf(silent.conversation),
    );

    const { data: group } = await admin.schema('crm').from('conversations')
      .insert({ organization_id: orgA, kind: 'internal_group', channel: 'whatsapp', external_ref: `${MARK}-grp` })
      .select('id').single();
    made.conversations.push(group!.id);
    check(await stateOf(group!.id) === 'group', 'a group has no counterpart and no window');

    // The distinction that decides a caller's behaviour, stated once.
    check(
      await readWindowState(admin, silent.conversation) === 'never'
        && await readWindowState(admin, stale.conversation) === 'closed',
      'and the TypeScript reader keeps them apart too',
    );
  }

  // ── 2. the window belongs to a NUMBER ───────────────────────────────────
  console.log('\n2. The window belongs to a number, not to a thread');
  {
    const phone = '+919000000201';
    const first = await makeThread(orgA, 'num-1', phone);
    // A second thread for the same contact — one number, two rows. This is
    // not a contrived shape: `crm.contacts` is unique on (organization, phone)
    // precisely because a number is one person, and that person can be a lead
    // twice.
    const second = await secondThread(orgA, first.contact, 'num-2');

    check(await stateOf(first.conversation) === 'never', 'both threads start with no window');
    check(await stateOf(second) === 'never', 'both threads start with no window (second)');

    await clientWrote(orgA, first.conversation, 1);

    check(
      await stateOf(second) === 'open',
      'a message on ONE thread opens the window on the OTHER — because Meta measures the number',
      await stateOf(second),
    );

    // And it does not leak across the tenant line.
    const otherTenant = await makeThread(orgB, 'num-3', phone);
    check(
      await stateOf(otherTenant.conversation) === 'never',
      'and another organization holding the same number sees nothing of it',
      await stateOf(otherTenant.conversation),
    );
  }

  // ── 3. an internal_direct channel is a person, and has a window ─────────
  console.log('\n3. The internal channel is a person (ADM-95), so it has a window');
  {
    const phone = '+919000000301';
    const owner = await makeThread(orgA, 'owner-lead', phone);

    const { data: channel } = await admin.schema('crm').from('conversations')
      .insert({
        organization_id: orgA, kind: 'internal_direct', channel: 'whatsapp',
        external_ref: `internal:${phone}`,
      }).select('id').single();
    made.conversations.push(channel!.id);

    check(await stateOf(channel!.id) === 'never', 'the announcement channel starts shut');

    await clientWrote(orgA, owner.conversation, 2);
    check(
      await stateOf(channel!.id) === 'open',
      'and the owner writing on their own lead thread opens it — the two rows are one number',
      await stateOf(channel!.id),
    );
  }

  await windowSections();
  await variableSections();
  await limitSections();
  await languageSections();

  console.log(`\n  ${checks} checks`);
}

try {
  await main();
} catch (cause) {
  failures += 1;
  console.error(`\n\x1b[31m✖ the verification itself failed\x1b[0m ${cause instanceof Error ? cause.stack : String(cause)}`);
} finally {
  await cleanup();
  provider.close();
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ The window is asked before every send\x1b[0m');
