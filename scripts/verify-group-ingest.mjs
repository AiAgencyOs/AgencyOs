#!/usr/bin/env node
/**
 * Inbound group messages, verified against a real database.
 *
 * Gap G-115. `crm.ingest_whatsapp_message` creates a contact, a lead and a
 * `direct` conversation unconditionally — it has no notion of `kind`, because
 * when it was written every conversation was 1:1. G-109 then added groups as
 * an outbound channel, so nothing had ever routed an inbound group message and
 * nothing had broken.
 *
 * What it proves:
 *
 *   1. A group message lands in its group, at the next position.
 *   2. **It creates no lead and no contact**, measured as a delta rather than
 *      a total. That is the whole defect: a colleague typing "morning" in the
 *      internal approval group would otherwise open a sales lead on themselves.
 *   3. And no extraction job — internal chatter must not become a requirement.
 *   4. Redelivery is free, as it is on the 1:1 path.
 *   5. A group belonging to another tenant is not reachable by knowing its id.
 *   6. An untracked group is acknowledged rather than refused.
 *   7. The 1:1 path is untouched: it still creates the lead it always did.
 *
 *   node scripts/verify-group-ingest.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-group-ingest');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-groupin';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const countOf = async (schema, path) =>
  ((await rest('GET', schema, `${path}?select=id`)).json ?? []).length;

const ingest = (groupId, from, ref, body, media) =>
  rest('POST', 'crm', 'rpc/ingest_group_message', {
    p_phone_number_id: `${MARKER}-pn`,
    p_group_id: groupId,
    p_from: from,
    p_external_ref: ref,
    p_body: body,
    ...(media ?? {}),
  });

const created = { conversations: [], projects: [], accounts: [], orgs: [] };
let previousSettings = null;

console.log('\n\x1b[1mAgencyOS — a message in a group (G-115)\x1b[0m');

try {
  // The organization has to claim the number this run sends to. Its previous
  // settings are put back in the finally block.
  previousSettings = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`))?.settings ?? {};
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
    settings: { ...previousSettings, whatsapp_phone_number_id: `${MARKER}-pn` },
  });

  const groupId = `${MARKER}-capi-${randomUUID().slice(0, 8)}`;
  const group = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      channel: 'whatsapp',
      kind: 'internal_group',
      status: 'active',
      external_ref: groupId,
    }),
  );
  if (!group?.id) throw new Error(`could not create the group fixture: ${JSON.stringify(group)}`);
  created.conversations.push(group.id);

  // ── 1, 2, 3. it lands, and creates nothing it should not ────────────────
  console.log('\n1. A group message lands in the group, and makes nobody a lead');
  {
    const before = {
      leads: await countOf('crm', 'leads'),
      contacts: await countOf('crm', 'contacts'),
      jobs: await countOf('core', 'jobs'),
    };

    const first = one(await ingest(groupId, '919000000000', `${MARKER}-m1`, 'morning all'));
    check(first?.status === 'ingested', 'the message is recorded', `status ${first?.status}`);
    check(first?.message_seq === 0, 'at the first position in the thread', `seq ${first?.message_seq}`);
    check(
      first?.conversation_id === group.id,
      'in the group it was sent in, not a new conversation',
    );

    const after = {
      leads: await countOf('crm', 'leads'),
      contacts: await countOf('crm', 'contacts'),
      jobs: await countOf('core', 'jobs'),
    };

    check(
      after.leads === before.leads,
      'and creates NO lead — the defect this exists to prevent',
      `${before.leads} → ${after.leads}`,
    );
    check(
      after.contacts === before.contacts,
      'and no contact either',
      `${before.contacts} → ${after.contacts}`,
    );
    check(
      after.jobs === before.jobs,
      'and queues no extraction — internal chatter is not a requirement',
      `${before.jobs} → ${after.jobs}`,
    );

    const row = one(
      await rest('GET', 'crm', `conversation_messages?id=eq.${first.message_id}&select=author_type,metadata,author_id`),
    );
    check(
      row?.author_type === 'user',
      'the internal group’s audience is staff, so the author type says so',
      `${row?.author_type}`,
    );
    check(
      row?.author_id === null,
      'and it names no person — users have no phone to match against',
    );
    check(
      row?.metadata?.from === '+919000000000',
      'the sender is kept, so attribution stays possible later',
      `${row?.metadata?.from}`,
    );
  }

  // ── 4. redelivery ───────────────────────────────────────────────────────
  console.log('\n2. Redelivery is free');
  {
    const again = one(await ingest(groupId, '919000000000', `${MARKER}-m1`, 'morning all'));
    check(again?.status === 'replayed', 'the same provider id records nothing new', `status ${again?.status}`);
    check(again?.message_seq === 0, 'and answers with the position it already had');

    const next = one(await ingest(groupId, '919000000001', `${MARKER}-m2`, 'and again'));
    check(next?.message_seq === 1, 'a genuinely new message takes the next position', `seq ${next?.message_seq}`);
  }

  // ── 5. another tenant's group ───────────────────────────────────────────
  console.log('\n3. Knowing a group id does not reach into another tenant');
  {
    const other = one(
      await rest('POST', 'core', 'organizations', {
        name: `${MARKER} other agency`,
        slug: `${MARKER}-other-${randomUUID().slice(0, 8)}`,
        settings: { whatsapp_phone_number_id: `${MARKER}-pn-other` },
      }),
    );
    created.orgs.push(other.id);

    const otherGroupId = `${MARKER}-capi-other-${randomUUID().slice(0, 8)}`;
    const otherGroup = one(
      await rest('POST', 'crm', 'conversations', {
        organization_id: other.id,
        channel: 'whatsapp',
        kind: 'internal_group',
        status: 'active',
        external_ref: otherGroupId,
      }),
    );
    created.conversations.push(otherGroup.id);

    // This organization's number, that organization's group id.
    const crossed = one(await ingest(otherGroupId, '919000000000', `${MARKER}-m3`, 'not for you'));
    check(
      crossed?.status === 'unknown_group',
      'a group id from another tenant resolves to nothing',
      `status ${crossed?.status}`,
    );

    const leaked = (
      await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${otherGroup.id}&select=id`)
    ).json ?? [];
    check(leaked.length === 0, 'and nothing was written into their transcript', `${leaked.length} rows`);
  }

  // ── 6. an untracked group ───────────────────────────────────────────────
  console.log('\n4. An untracked group is acknowledged, not refused');
  {
    const untracked = one(await ingest(`${MARKER}-never-linked`, '919000000000', `${MARKER}-m4`, 'hello'));
    check(
      untracked?.status === 'unknown_group',
      'a number can be in groups nobody linked, and that is not an error',
      `status ${untracked?.status}`,
    );

    // ── G-181: a file posted into the group is KEPT ────────────────────
    //
    // The webhook used to count it as somebody else's traffic and throw it
    // away, which made a client's screenshot indistinguishable from a message
    // for a number nobody claims.
    const withFile = one(await ingest(groupId, '919000000000', `${MARKER}-m-file`, '', {
      p_media_type: 'image', p_media_id: 'MEDIA.GROUP.1', p_caption: 'the bug on my screen',
    }));
    check(withFile?.status === 'ingested', 'a file posted into the group is recorded, not dropped', String(withFile?.status));

    const fileRow = one(await rest('GET', 'crm',
      `conversation_messages?external_ref=eq.${MARKER}-m-file&select=metadata,seq,author_type`));
    check(
      fileRow?.metadata?.media_type === 'image' && fileRow?.metadata?.media_id === 'MEDIA.GROUP.1',
      'with the envelope the 1:1 path stores — the type and the id',
      `${fileRow?.metadata?.media_type}/${fileRow?.metadata?.media_id}`,
    );
    check(
      fileRow?.metadata?.caption === 'the bug on my screen',
      'and the words they sent with it',
      String(fileRow?.metadata?.caption),
    );
    check(
      fileRow?.metadata?.group_id === groupId && fileRow?.metadata?.direction === 'inbound',
      'still keyed to the group, still inbound — the envelope is added, not replaced',
    );

    // The compatibility claim, asserted rather than assumed: a text message's
    // metadata must be byte-for-byte what it was before this change.
    const plain = one(await ingest(groupId, '919000000000', `${MARKER}-m-plain`, 'just words'));
    check(plain?.status === 'ingested', 'and a plain text message is still just a message');
    const plainRow = one(await rest('GET', 'crm',
      `conversation_messages?external_ref=eq.${MARKER}-m-plain&select=metadata`));
    check(
      !('media_type' in (plainRow?.metadata ?? {})) &&
        !('media_id' in (plainRow?.metadata ?? {})) &&
        !('caption' in (plainRow?.metadata ?? {})),
      'with no empty media keys invented on it',
      JSON.stringify(plainRow?.metadata ?? {}),
    );

    const unknownNumber = one(
      await rest('POST', 'crm', 'rpc/ingest_group_message', {
        p_phone_number_id: `${MARKER}-not-a-number`,
        p_group_id: groupId,
        p_from: '919000000000',
        p_external_ref: `${MARKER}-m5`,
        p_body: 'hello',
      }),
    );
    check(
      unknownNumber?.status === 'unknown_phone_number_id',
      'while an unrecognised business number is refused as it always was',
      `status ${unknownNumber?.status}`,
    );
  }

  // ── 7. the 1:1 path is untouched ────────────────────────────────────────
  console.log('\n5. The 1:1 path still does exactly what it did');
  {
    const before = await countOf('crm', 'leads');
    const direct = one(
      await rest('POST', 'crm', 'rpc/ingest_whatsapp_message', {
        p_phone_number_id: `${MARKER}-pn`,
        p_from: '919000000009',
        p_external_ref: `${MARKER}-direct-1`,
        p_body: 'I need an app',
      }),
    );
    check(direct?.status === 'ingested', 'a 1:1 message is ingested', `status ${direct?.status}`);
    check(direct?.lead_id !== null, 'and still opens a lead, which is the point of that path');
    check(
      (await countOf('crm', 'leads')) === before + 1,
      'exactly one, as before',
    );

    created.directLead = direct?.lead_id;
    created.directContact = direct?.contact_id;
    created.directConversation = direct?.conversation_id;
  }
} finally {
  if (created.directConversation) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${created.directConversation}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${created.directConversation}`);
  }
  await rest('DELETE', 'core', `jobs?organization_id=eq.${ORG}`);
  if (created.directLead) await rest('DELETE', 'crm', `leads?id=eq.${created.directLead}`);
  if (created.directContact) await rest('DELETE', 'crm', `contacts?id=eq.${created.directContact}`);

  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);

  // The number claim is put back exactly as it was: other scripts in the CI
  // sequence resolve tenancy through it, and leaving this run's marker on it
  // would make their ingests land here.
  if (previousSettings !== null) {
    await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: previousSettings });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A message in a group belongs to the group, and makes nobody a lead\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
