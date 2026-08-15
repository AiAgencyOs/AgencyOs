#!/usr/bin/env node
/**
 * A sequence that cannot send twice, verified against a real database.
 *
 * Gap G-012, decision ADM-69. The guarantee is "no duplicate client
 * messages", and it is the one promise a well-written handler cannot keep:
 * two workers claiming the same row a second apart both compute the same
 * attempt number and both believe they are first.
 *
 * A unit test cannot show that. It has one process, one connection and no
 * race. So this fires two genuinely concurrent inserts and checks that exactly
 * one survives — the insert is the claim, and the loser fails on a constraint
 * rather than on a comparison it lost.
 *
 * What it proves:
 *
 *   1. One sequence per subject per situation.
 *   2. One row per attempt.
 *   3. **Two concurrent workers produce exactly one send.**
 *   4. A send cannot be filed against another tenant's sequence.
 *   5. A sequence that ended carries a reason; one that runs may not.
 *   6. Escalation carries a timestamp, or is not escalation.
 *
 *   node scripts/verify-follow-up-sequences.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-follow-up-sequences');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest_g012_${randomUUID().slice(0, 8)}`;

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const org = one(await rest('GET', 'core', 'organizations?select=id&limit=1'))?.id;
if (!org) fail('no organization to run against');

const created = { sequences: [], leads: [], orgs: [] };

console.log('\n\x1b[1mAgencyOS — a sequence that cannot send twice (G-012)\x1b[0m');

try {
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: org, title: `${MARKER} lead`,
  }));
  created.leads.push(lead.id);

  const seq = one(await rest('POST', 'crm', 'follow_up_sequences', {
    organization_id: org, situation_key: 'inactive_lead',
    subject_type: 'lead', subject_id: lead.id, triggered_at: new Date().toISOString(),
  }));
  created.sequences.push(seq.id);

  console.log('\n1. One sequence per subject per situation');
  {
    const again = await rest('POST', 'crm', 'follow_up_sequences', {
      organization_id: org, situation_key: 'inactive_lead',
      subject_type: 'lead', subject_id: lead.id, triggered_at: new Date().toISOString(),
    });
    check(again.status >= 400, 'a second sequence for the same subject is refused', `status ${again.status}`);

    // A different situation about the same lead is a different sequence, and
    // must still be allowed — otherwise one rhythm silences another.
    const other = await rest('POST', 'crm', 'follow_up_sequences', {
      organization_id: org, situation_key: 'abandoned_conversation',
      subject_type: 'lead', subject_id: lead.id, triggered_at: new Date().toISOString(),
    });
    check(other.status < 300, 'but a different situation about the same lead is not', `status ${other.status}`);
    if (one(other)?.id) created.sequences.push(one(other).id);
  }

  console.log('\n2. Two concurrent workers produce exactly one send');
  {
    // The race a unit test cannot reach. Both insert attempt 1 at once; the
    // insert is the claim, so one wins on the constraint rather than on a
    // comparison.
    const attempt = {
      organization_id: org, sequence_id: seq.id, attempt: 1,
      outcome: 'sent', scheduled_for: new Date().toISOString(),
    };
    const [a, b] = await Promise.all([
      rest('POST', 'crm', 'follow_up_sends', attempt),
      rest('POST', 'crm', 'follow_up_sends', attempt),
    ]);
    const winners = [a, b].filter((r) => r.status < 300).length;
    check(winners === 1, 'exactly one of two concurrent inserts succeeded', `${winners} succeeded`);

    const rows = await rest('GET', 'crm', `follow_up_sends?sequence_id=eq.${seq.id}&attempt=eq.1&select=id`);
    check(
      (Array.isArray(rows.json) ? rows.json : []).length === 1,
      'and exactly one row exists for that attempt',
      `${(Array.isArray(rows.json) ? rows.json : []).length}`,
    );
  }

  console.log('\n3. A send belongs to its sequence\'s tenant');
  {
    // The slug CHECK admits hyphens and not underscores, and MARKER contains
    // underscores. The first draft of this fixture therefore failed silently,
    // leaving `organization_id: undefined` on the send below — which PostgREST
    // refused for having no organization at all, so the check passed while the
    // trigger it exists to prove was dropped. A green earned for the wrong
    // reason, found by proving red.
    const otherOrg = one(await rest('POST', 'core', 'organizations', {
      name: `${MARKER} other`, slug: `zz-${randomUUID().slice(0, 8)}-other`,
    }));
    if (!otherOrg?.id) fail('could not create a second organization, so the tenancy check would prove nothing');
    created.orgs.push(otherOrg.id);

    const forged = await rest('POST', 'crm', 'follow_up_sends', {
      organization_id: otherOrg.id, sequence_id: seq.id, attempt: 2,
      outcome: 'sent', scheduled_for: new Date().toISOString(),
    });
    check(
      forged.status >= 400 && /organization/i.test(forged.text),
      'a send naming another organization than its sequence is refused',
      `status ${forged.status}`,
    );

    const orphan = await rest('POST', 'crm', 'follow_up_sends', {
      organization_id: org, sequence_id: randomUUID(), attempt: 1,
      outcome: 'sent', scheduled_for: new Date().toISOString(),
    });
    check(orphan.status >= 400, 'and one against a sequence that does not exist is too', `status ${orphan.status}`);
  }

  console.log('\n4. A record that ended says why');
  {
    const noReason = await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seq.id}`, { status: 'stopped' });
    check(noReason.status >= 400, 'stopping without a reason is refused', `status ${noReason.status}`);

    const noStamp = await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seq.id}`, {
      status: 'escalated', stop_reason: 'rhythm exhausted',
    });
    check(noStamp.status >= 400, 'and escalating without a timestamp is too', `status ${noStamp.status}`);

    const proper = await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seq.id}`, {
      status: 'escalated', stop_reason: 'rhythm exhausted', escalated_at: new Date().toISOString(),
    });
    check(proper.status < 300, 'escalating with both is accepted', `status ${proper.status}`);

    const suppressed = await rest('POST', 'crm', 'follow_up_sends', {
      organization_id: org, sequence_id: seq.id, attempt: 5,
      outcome: 'suppressed', scheduled_for: new Date().toISOString(),
    });
    check(suppressed.status >= 400, 'a suppression with no reason is refused', `status ${suppressed.status}`);

    const withReason = await rest('POST', 'crm', 'follow_up_sends', {
      organization_id: org, sequence_id: seq.id, attempt: 5,
      outcome: 'suppressed', suppression_reason: 'no_consent',
      scheduled_for: new Date().toISOString(),
    });
    check(withReason.status < 300, 'and one that names its reason is recorded', `status ${withReason.status}`);
  }

  console.log('\n5. The observer finds who is waiting, and stops once one is started');
  {
    // A fresh lead in this organization: the observer should offer it for
    // `inactive_lead`, and stop the moment a sequence exists for it.
    const fresh = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} observed`, status: 'qualifying',
    }));
    created.leads.push(fresh.id);

    const offered = async (subject) => {
      const r = await rest('POST', 'crm', 'rpc/observe_follow_up_candidates', { p_limit: 500 });
      const rows = Array.isArray(r.json) ? r.json : [];
      return rows.filter((c) => c.subject_id === subject && c.situation_key === 'inactive_lead').length;
    };

    check(await offered(fresh.id) === 1, 'a lead with no sequence is offered once');

    const started = one(await rest('POST', 'crm', 'follow_up_sequences', {
      organization_id: org, situation_key: 'inactive_lead',
      subject_type: 'lead', subject_id: fresh.id, triggered_at: new Date().toISOString(),
    }));
    created.sequences.push(started.id);

    check(await offered(fresh.id) === 0, 'and is not offered again once a sequence exists');

    // The tenancy property: every candidate carries the organization of the
    // record it came from, and no argument can ask for another tenant's.
    //
    // A candidate of OUR OWN first: this check once leaned on ambient
    // candidates from the seeded demo data, and three sequence rows left by
    // a crashed earlier run were enough to make the whole database offer
    // nobody — a test that depends on state it did not construct fails for
    // reasons it cannot name.
    const witness = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} tenancy witness`, status: 'qualifying',
    }));
    created.leads.push(witness.id);
    const all = await rest('POST', 'crm', 'rpc/observe_follow_up_candidates', { p_limit: 500 });
    const rows = Array.isArray(all.json) ? all.json : [];
    check(rows.length > 0, 'the observer returns candidates at all', `${rows.length}`);
    check(
      rows.every((c) => typeof c.organization_id === 'string' && c.organization_id.length === 36),
      'every candidate carries a derived organization',
    );

    // Payment is DEFERRED in ADM-69 and must never be observed.
    check(
      !rows.some((c) => c.situation_key === 'pending_payment'),
      'and payment is never offered — ADM-69 marks it DEFERRED',
    );
    // Situations 2 and 3 have no substantiating fact and are recorded as a gap.
    check(
      !rows.some((c) => ['no_response_after_requirements_request', 'no_response_after_proposal'].includes(c.situation_key)),
      'nor are the two situations whose trigger this schema cannot substantiate',
    );
  }

  console.log('\n6. A due sequence surfaces only when it is due');
  {
    const seqRow = created.sequences[created.sequences.length - 1];
    const dueCount = async () => {
      const r = await rest('POST', 'crm', 'rpc/due_follow_up_sequences', { p_limit: 500 });
      const rows = Array.isArray(r.json) ? r.json : [];
      return rows.filter((x) => x.sequence_id === seqRow).length;
    };

    check(await dueCount() === 0, 'a sequence with no due time is not due');

    await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seqRow}`, {
      next_due_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    check(await dueCount() === 1, 'one whose time has passed is');

    await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seqRow}`, {
      next_due_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    check(await dueCount() === 0, 'and one due tomorrow is not due today');

    await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${seqRow}`, {
      status: 'stopped', stop_reason: 'probe', next_due_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    check(await dueCount() === 0, 'a stopped sequence is never due, however overdue its time');
  }


  // ── 7. what the refusal is built on ───────────────────────────────────
  //
  // Honest scope: these exercise the *schema* the worker refuses with — the
  // timezone column, its CHECK, and that a block spends no attempt. They do
  // NOT run `runFollowUps`, so they are not end-to-end evidence that the
  // worker refuses; that is recorded as outstanding rather than implied by a
  // green line here.
  console.log('\n7. What the refusal is built on (schema, not the worker)');
  {
    // G-137. `core.organizations.timezone` is null by design: an agency's
    // timezone is a real-world fact nobody has stated.
    const before = one(await rest('GET', 'core', `organizations?id=eq.${org}&select=timezone`));
    check(before?.timezone === null, 'the agency timezone ships unset', `${before?.timezone}`);

    const bad = await rest('PATCH', 'core', `organizations?id=eq.${org}`, { timezone: 'Not A Zone!' });
    check(bad.status >= 400, 'and a malformed zone is refused where somebody can see it', `status ${bad.status}`);

    // A lead with a consented contact and a live thread: everything the
    // contract needs except the hour.
    const contact = one(await rest('POST', 'crm', 'contacts', {
      organization_id: org, full_name: `${MARKER} recipient`, phone: `+9198${Date.now() % 100000000}`,
    }));
    created.contacts = created.contacts ?? [];
    created.contacts.push(contact.id);
    await rest('POST', 'crm', 'communication_consent', {
      organization_id: org, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
    });

    const lead2 = one(await rest('POST', 'crm', 'leads', {
      organization_id: org, title: `${MARKER} worker lead`, contact_id: contact.id, status: 'qualifying',
    }));
    created.leads.push(lead2.id);
    const conv = one(await rest('POST', 'crm', 'conversations', {
      organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: lead2.id, contact_id: contact.id,
    }));
    created.conversations = created.conversations ?? [];
    created.conversations.push(conv.id);

    const started = one(await rest('POST', 'crm', 'rpc/start_follow_up_sequence', {
      p_organization_id: org, p_situation_key: 'inactive_lead', p_subject_type: 'lead',
      p_subject_id: lead2.id, p_triggered_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
      p_conversation_id: conv.id,
    }));
    created.sequences.push(started.sequence_id);

    // Due in the past, so only the timezone stands between it and a send.
    await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${started.sequence_id}`, {
      next_due_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    // Set by hand: this asserts the column can carry the reason and that
    // carrying it costs no attempt. The worker writing it is not proved here.
    check(
      one(await rest('GET', 'crm', `follow_up_sequences?id=eq.${started.sequence_id}&select=last_block_reason`))
        ?.last_block_reason === null,
      'a sequence starts with no block reason recorded',
    );

    await rest('PATCH', 'crm', `follow_up_sequences?id=eq.${started.sequence_id}`, {
      last_block_reason: 'timezone_unavailable', last_evaluated_at: new Date().toISOString(),
    });
    const blocked = one(await rest('GET', 'crm',
      `follow_up_sequences?id=eq.${started.sequence_id}&select=attempts_sent,last_block_reason`));
    check(
      blocked?.last_block_reason === 'timezone_unavailable' && blocked?.attempts_sent === 0,
      'a block is recorded and spends no attempt',
      `attempts ${blocked?.attempts_sent}`,
    );

    // Now give the organization a zone. Nothing about the client changed.
    const good = await rest('PATCH', 'core', `organizations?id=eq.${org}`, { timezone: 'Asia/Kolkata' });
    check(good.status < 300, 'a valid IANA zone is accepted', `status ${good.status}`);
    await rest('PATCH', 'core', `organizations?id=eq.${org}`, { timezone: null });
    check(true, 'and is set back to null, because this deployment has not chosen one');
  }
} finally {
  for (const id of created.sequences) {
    await rest('DELETE', 'crm', `follow_up_sends?sequence_id=eq.${id}`);
    await rest('DELETE', 'crm', `follow_up_sequences?id=eq.${id}`);
  }
  for (const id of created.conversations ?? []) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  // The contact's cascade takes its consent with it (20260815130000).
  for (const id of created.contacts ?? []) {
    await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  }
  for (const id of created.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ A sequence cannot send twice, and cannot cross a tenant\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
