/**
 * Live proof for the historical-lead import (crm.import_records / crm.commit_import_record).
 *
 * The mandate's Phase 6 asks for negative proofs, not assurances. This drives a
 * real database and proves, by construction, that the import:
 *   • is idempotent — committing a record twice yields one contact and one lead;
 *   • cannot duplicate — a phone already known is reused, never re-created;
 *   • cannot cross a tenant — an owner of org B cannot commit org A's record;
 *   • cannot manufacture consent from NOTHING — a record with no transcript
 *     writes no communication_consent row (G-218 narrowed this from "ever":
 *     ADM-92 infers consent from a person's OWN inbound messages, and the
 *     import now keeps them instead of discarding the evidence);
 *   • cannot trigger a send — no job is created and nothing reaches a provider,
 *     which is still true with the transcript imported;
 *   • refuses name-only rows — only a phone-keyed exact/new commits;
 *   • cannot be forged — a direct PATCH of committed_* is refused (no RLS UPDATE);
 *   • is audited — every commit writes a lead.imported row.
 *
 * Follows the G-083 discipline of the other verifiers: it announces which
 * database it ran against, seeds under the service role, exercises policy under
 * a minted owner JWT, and cleans up after itself.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const fail = (m) => {
  console.error(`\x1b[31m${m}\x1b[0m`);
  process.exit(1);
};
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target);

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest-import-${randomUUID().slice(0, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';
const ORG2 = randomUUID();

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}
const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, org, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({ sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: org, role }, iat: now, exp: now + 900 });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const commit = (token, recordId) => call(token, 'POST', 'crm', 'rpc/commit_import_record', { p_record_id: recordId });
const outcomeOf = (r) => one(r)?.outcome;

const created = { users: [], leads: [], contacts: [], batches: [] };
const P1 = `+9199${Math.floor(Math.random() * 1e8)}`;
const P2 = `+9198${Math.floor(Math.random() * 1e8)}`;
const P4 = `+9197${Math.floor(Math.random() * 1e8)}`;

console.log('\n\x1b[1mAgencyOS — historical-lead import (staging + idempotent commit)\x1b[0m');

try {
  // An owner of ORG, for the authority + policy proofs.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email: `${MARKER}@example.invalid`, password: randomUUID(), email_confirm: true }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active' });
  const owner = mint(authUser.id, ORG, 'owner');
  const foreignOwner = mint(randomUUID(), ORG2, 'owner'); // an owner of a DIFFERENT org

  // An existing contact, so R_exact resolves to it rather than creating a twin.
  const c1 = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} existing`, phone: P1 }));
  created.contacts.push(c1.id);

  const batch = one(await rest('POST', 'crm', 'import_batches', { organization_id: ORG, source_label: `${MARKER} export` }));
  created.batches.push(batch.id);

  const stage = async (over) => one(await rest('POST', 'crm', 'import_records', {
    batch_id: batch.id, organization_id: ORG, message_count: 3, source_label: `${MARKER} export`, ...over,
  }));
  const rExact = await stage({ phone: P1, display_name: 'Exact Co', classification: 'exact', auto_importable: true, matched_contact_id: c1.id });
  const rNew = await stage({ phone: P2, display_name: 'New Co', classification: 'new', auto_importable: true });
  const rNew2 = await stage({ phone: P4, display_name: 'Foreign Attempt', classification: 'new', auto_importable: true });
  const rProb = await stage({ phone: null, display_name: 'Name Only', classification: 'probable', auto_importable: false });

  const contactsWithPhone = async (p) =>
    (await rest('GET', 'crm', `contacts?organization_id=eq.${ORG}&phone=eq.${encodeURIComponent(p)}&select=id`)).json?.length ?? 0;

  console.log('\n1. An exact phone match reuses the existing contact, never a twin');
  const e1 = await commit(owner, rExact.id);
  check(outcomeOf(e1) === 'committed', 'commit returns committed', outcomeOf(e1));
  check(one(e1)?.contact_id === c1.id, 'it resolved to the EXISTING contact, not a new one');
  check((await contactsWithPhone(P1)) === 1, 'still exactly one contact for that phone');
  const leadExact = one(e1)?.lead_id;
  if (leadExact) created.leads.push(leadExact);

  console.log('\n2. Committing the same record again is idempotent');
  const e2 = await commit(owner, rExact.id);
  check(outcomeOf(e2) === 'already_committed', 'a second commit is a no-op that returns the same ids', outcomeOf(e2));
  check(one(e2)?.lead_id === leadExact, 'same lead id');
  check((await contactsWithPhone(P1)) === 1, 'no duplicate contact appeared');

  console.log('\n3. A new phone creates one contact + one lead, and re-runs safely');
  const n1 = await commit(owner, rNew.id);
  check(outcomeOf(n1) === 'committed', 'a new phone commits', outcomeOf(n1));
  if (one(n1)?.lead_id) created.leads.push(one(n1).lead_id);
  if (one(n1)?.contact_id) created.contacts.push(one(n1).contact_id);
  const n2 = await commit(owner, rNew.id);
  check(outcomeOf(n2) === 'already_committed' && (await contactsWithPhone(P2)) === 1,
    're-committing creates no duplicate', `${outcomeOf(n2)}/${await contactsWithPhone(P2)}`);

  console.log('\n4. A name-only (not auto-importable) record is refused, not created');
  const p1 = await commit(owner, rProb.id);
  check(outcomeOf(p1) === 'not_importable', 'a probable/name-only row cannot be committed', outcomeOf(p1));
  const probRow = one(await rest('GET', 'crm', `import_records?id=eq.${rProb.id}&select=committed_at`));
  check((probRow?.committed_at ?? null) === null, 'and it stays uncommitted');

  console.log('\n5. Cross-tenant: an owner of another org cannot commit this org’s record');
  const x = await commit(foreignOwner, rNew2.id);
  check(outcomeOf(x) === 'forbidden', 'the commit is forbidden', outcomeOf(x));
  check((await contactsWithPhone(P4)) === 0, 'and no contact was created for it');

  console.log('\n6. A record with NO transcript manufactures no consent');
  //
  // G-218 narrowed this claim rather than removing it. It used to read "an
  // import never manufactures consent", and that was right when the import
  // discarded the transcript. ADM-92 says being written to IS consent, with
  // the message as evidence — so what must remain impossible is consent from
  // NOTHING: a name and a number, with no message behind them.
  const consentRows = (await rest('GET', 'crm',
    `communication_consent?contact_id=in.(${[c1.id, one(n1)?.contact_id].filter(Boolean).join(',')})&select=contact_id`)).json?.length ?? 0;
  check(consentRows === 0, 'no communication_consent row exists for a record staged without messages', `${consentRows}`);

  console.log('\n7. And creates no conversation, because there was nothing to put in one');
  const convs = (await rest('GET', 'crm', `conversations?lead_id=in.(${created.leads.join(',')})&select=id`)).json?.length ?? 0;
  check(convs === 0, 'no conversation was created for the imported leads', `${convs}`);

  console.log('\n8. Every commit is audited');
  const audit = (await rest('GET', 'audit',
    `audit_log?action=eq.lead.imported&subject_id=in.(${created.leads.join(',')})&select=id`)).json?.length ?? 0;
  check(audit >= 2, 'a lead.imported audit row exists for each committed lead', `${audit}`);

  console.log('\n9. Committed state cannot be forged by a direct write');
  const patch = await call(owner, 'PATCH', 'crm', `import_records?id=eq.${rProb.id}`, { committed_at: new Date().toISOString() });
  const stillNull = (one(await rest('GET', 'crm', `import_records?id=eq.${rProb.id}&select=committed_at`))?.committed_at ?? null) === null;
  check(stillNull, 'a direct PATCH of committed_at changes nothing (no RLS UPDATE path)', `status ${patch.status}`);

  // The browser-upload write path (crm.commit uses the RPC; staging uses the
  // RLS insert policies). Prove an owner may stage a batch for their OWN org but
  // RLS refuses one for another org — so an Admin upload cannot cross a tenant.
  console.log('\n10. Browser-upload staging: RLS refuses a cross-tenant batch insert');
  const own = await call(owner, 'POST', 'crm', 'import_batches', { organization_id: ORG, source_label: `${MARKER} own` });
  check(own.status >= 200 && own.status < 300, 'an owner may stage a batch for their own org', `status ${own.status}`);
  if (one(own)?.id) created.batches.push(one(own).id);
  const foreign = await call(owner, 'POST', 'crm', 'import_batches', { organization_id: ORG2, source_label: `${MARKER} foreign` });
  check(foreign.status >= 400, 'the same owner cannot stage a batch for another org (RLS with_check)', `status ${foreign.status}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n10b. The import brings the conversation with it (G-218)');
  //
  // The decision this rests on is ADM-92: being written to IS consent, with
  // the message as evidence. The import used to parse the transcript, count
  // it and throw it away — so every imported lead arrived with no consent and
  // no history, which meant ADM-70's chokepoint refused to send to them and
  // `window_state` answered `never`. Twelve hundred leads, unreachable by a
  // design that was reading the wrong document.
  // ═══════════════════════════════════════════════════════════════════════

  const tPhone = `+9196${String(Date.now()).slice(-8)}`;
  const tBatch = one(await rest('POST', 'crm', 'import_batches', {
    organization_id: ORG, source_label: `${MARKER} transcript`,
  }));
  created.batches.push(tBatch.id);

  const tRecord = one(await rest('POST', 'crm', 'import_records', {
    batch_id: tBatch.id, organization_id: ORG, phone: tPhone, display_name: 'Transcript Co',
    message_count: 4, source_label: `${MARKER} transcript`, classification: 'new', auto_importable: true,
  }));

  // Four months old, which is what a historical export is. Local wall-clock,
  // because that is all a WhatsApp export states.
  const monthsAgo = (n, h) => {
    const d = new Date(Date.now() - n * 30 * 86_400_000);
    d.setUTCHours(h, 0, 0, 0);
    return d.toISOString().replace('Z', '');
  };
  await rest('POST', 'crm', 'import_messages', [
    { organization_id: ORG, record_id: tRecord.id, ordinal: 0, direction: 'inbound',
      occurred_at_local: monthsAgo(4, 9), body: 'Hi, I need an app for my business' },
    { organization_id: ORG, record_id: tRecord.id, ordinal: 1, direction: 'outbound',
      occurred_at_local: monthsAgo(4, 10), body: 'Happy to help — what does it need to do?' },
    { organization_id: ORG, record_id: tRecord.id, ordinal: 2, direction: 'inbound',
      occurred_at_local: monthsAgo(4, 11), body: 'Booking and payments mainly' },
    { organization_id: ORG, record_id: tRecord.id, ordinal: 3, direction: 'outbound',
      occurred_at_local: monthsAgo(3, 9), body: 'Sent you a quotation' },
  ]);

  // The organization must say where those wall-clock times were written, or
  // nothing can be placed on a timeline — G-137's fact, needed here for the
  // window's sake.
  const orgTz = one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=timezone`))?.timezone ?? null;
  if (!orgTz) {
    const refused = await commit(owner, tRecord.id);
    check(outcomeOf(refused) === 'no_timezone',
      'without an agency timezone the transcript is REFUSED rather than dated as UTC',
      outcomeOf(refused));
    await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { timezone: 'Asia/Kolkata' });
  }

  const tCommit = await commit(owner, tRecord.id);
  check(outcomeOf(tCommit) === 'committed', 'the record commits', outcomeOf(tCommit));
  check(one(tCommit)?.messages_imported === 4, 'and all four messages came with it', `${one(tCommit)?.messages_imported}`);

  const tConvo = one(await rest('GET', 'crm',
    `conversations?external_ref=eq.${encodeURIComponent(`wa:${tPhone}`)}&select=id`));
  check(Boolean(tConvo?.id), 'the conversation the export was of now exists');

  const tMsgs = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${tConvo.id}&select=seq,author_type,body,occurred_at&order=seq`)).json ?? [];
  check(tMsgs.length === 4, 'with the whole transcript in it', `${tMsgs.length}`);
  check(
    tMsgs.map((m) => m.author_type).join(',') === 'client,agent,client,agent',
    'THEIR messages are the client and ours are the agent — the attribution consent rests on',
    tMsgs.map((m) => m.author_type).join(','),
  );
  check(
    tMsgs[0] && new Date(tMsgs[0].occurred_at).getTime() < Date.now() - 100 * 86_400_000,
    'dated when they were written, not when they were imported',
    tMsgs[0]?.occurred_at,
  );

  // ADM-92, from the evidence rather than from a checkbox.
  const tConsent = one(await rest('GET', 'crm',
    `communication_consent?contact_id=eq.${one(tCommit).contact_id}&channel=eq.whatsapp&select=status,source,note`));
  check(tConsent?.status === 'granted', 'consent is recorded, because they wrote to this agency', `${tConsent?.status}`);
  check(
    tConsent?.source === 'inbound_message',
    'and its source says the system INFERRED it — an operator can see nobody typed it in',
    `${tConsent?.source}`,
  );

  /**
   * And the evidence is one of THEIR messages.
   *
   * Red-proving the attribution — flipping inbound and outbound — left every
   * other check here green: consent was still granted, from the AGENCY'S OWN
   * words. Consent inferred from what we said to somebody is not consent, and
   * nothing was looking. The trigger writes the message id into `note`, so
   * this reads it back and insists it is a client line.
   */
  const evidenceId = String(tConsent?.note ?? '').split(' ').pop();
  const evidence = one(await rest('GET', 'crm',
    `conversation_messages?id=eq.${evidenceId}&select=author_type,body`));
  /**
   * Compared against what was STAGED as theirs, not against the label.
   *
   * The first version asserted `author_type === 'client'`, which the trigger
   * guarantees by construction — it only fires on a client row — so it stayed
   * green under a flipped attribution and proved nothing. What must be true
   * is that the evidence is a line the CONTACT sent, and the only independent
   * record of that is the staged transcript's own direction.
   */
  const stagedInbound = (await rest('GET', 'crm',
    `import_messages?record_id=eq.${tRecord.id}&direction=eq.inbound&select=body&order=ordinal`)).json ?? [];
  check(
    stagedInbound.some((m) => m.body === evidence?.body),
    'and the evidence is a line THEY sent — matched against what the export attributed to them',
    `${String(evidence?.body).slice(0, 48)}`,
  );

  // The window is the other half, and it must read SHUT: these people wrote
  // months ago, so only an approved template can reach them.
  const tWindow = await fetch(`${URL_BASE}/rest/v1/rpc/window_state`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Content-Profile': 'crm' },
    body: JSON.stringify({ p_conversation_id: tConvo.id }),
  }).then((r) => r.text()).then((t) => t.replace(/"/g, ''));
  check(
    tWindow === 'closed',
    'and the 24-hour window reads SHUT — an imported lead is reachable only by an approved template',
    tWindow,
  );

  // Still no send. The import creates history; it does not start a conversation.
  const tJobs = (await rest('GET', 'core',
    `jobs?payload->>conversationId=eq.${tConvo.id}&select=id`)).json?.length ?? 0;
  check(tJobs === 0, 'and no job was queued — an import still cannot cause a send', `${tJobs}`);

  // A live thread wins: an export must never be interleaved into a real one.
  const liveRecord = one(await rest('POST', 'crm', 'import_records', {
    batch_id: tBatch.id, organization_id: ORG, phone: `+9195${String(Date.now()).slice(-8)}`,
    display_name: 'Live Thread Co', message_count: 1, source_label: `${MARKER} transcript`,
    classification: 'new', auto_importable: true,
  }));
  const livePhone = one(await rest('GET', 'crm', `import_records?id=eq.${liveRecord.id}&select=phone`)).phone;
  const liveContact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} live`, phone: livePhone,
  }));
  created.contacts.push(liveContact.id);
  const liveLead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: liveContact.id, title: `${MARKER} live`, status: 'new',
  }));
  created.leads.push(liveLead.id);
  const liveConvo = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: liveLead.id, contact_id: liveContact.id, kind: 'direct',
    channel: 'whatsapp', external_ref: `wa:${livePhone}`, status: 'active',
  }));
  await rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: liveConvo.id, seq: 0, author_type: 'client',
    body: `${MARKER} written here, not imported`, occurred_at: new Date().toISOString(),
  });
  await rest('POST', 'crm', 'import_messages', {
    organization_id: ORG, record_id: liveRecord.id, ordinal: 0, direction: 'inbound',
    occurred_at_local: monthsAgo(6, 9), body: 'an old line from an export',
  });

  const liveCommit = await commit(owner, liveRecord.id);
  check(outcomeOf(liveCommit) === 'committed', 'a record whose thread is already live still commits');
  check(
    one(liveCommit)?.messages_imported === 0,
    'but its transcript is SKIPPED — interleaving an old export into a live thread writes a history that never happened',
    `${one(liveCommit)?.messages_imported}`,
  );
  const liveCount = (await rest('GET', 'crm',
    `conversation_messages?conversation_id=eq.${liveConvo.id}&select=id`)).json?.length ?? 0;
  check(liveCount === 1, 'and the live thread still holds only what was written in it', `${liveCount}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n11. Who this contact already is (G-210)');
  //
  // The matcher above answers "is this the same person?". This answers the
  // question an operator asks before a campaign: "who is this to us already?"
  // Every class is a FACT with a row behind it — there is no hot and no warm,
  // because a judgement rendered as a label is the invented score ADM-88
  // refused.
  // ═══════════════════════════════════════════════════════════════════════

  const relPhone = `+9198${String(Date.now()).slice(-8)}`;
  const relContact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} relationship`, phone: relPhone,
  }));
  created.contacts.push(relContact.id);

  const relOf = async () => {
    const r = await fetch(`${URL_BASE}/rest/v1/rpc/contact_relationship`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Content-Profile': 'crm' },
      body: JSON.stringify({ p_contact_id: relContact.id }),
    });
    return (await r.text()).replace(/"/g, '');
  };

  check(await relOf() === 'cold', 'a contact with no history is cold — an absence, not a judgement', await relOf());

  const relLead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: relContact.id, title: `${MARKER} rel`,
    source: 'whatsapp', source_ref: `${MARKER}:rel`, status: 'new',
  }));
  created.leads.push(relLead.id);

  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, { status: 'qualifying' });
  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, {
    status: 'nurture', nurture_reason: 'budget_later',
    next_follow_up_at: new Date(Date.now() + 30 * 864e5).toISOString(),
  });
  check(await relOf() === 'nurture', 'a lead waiting for an agreed date is nurture', await relOf());

  // The safety property, stated as the thing it protects: we agreed a date
  // with them, and writing before it is breaking that agreement.
  const nurtureContactable = await fetch(`${URL_BASE}/rest/v1/rpc/relationship_is_contactable`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Content-Profile': 'crm' },
    body: JSON.stringify({ p_relationship: 'nurture' }),
  }).then(async (r) => (await r.text()).trim());
  check(nurtureContactable === 'false', 'and nurture is NOT contactable', nurtureContactable);

  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, { status: 'disqualified', disqualified_reason: 'went elsewhere' });
  check(await relOf() === 'lost', 'a lead that said no is lost', await relOf());

  const lostContactable = await fetch(`${URL_BASE}/rest/v1/rpc/relationship_is_contactable`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Content-Profile': 'crm' },
    body: JSON.stringify({ p_relationship: 'lost' }),
  }).then(async (r) => (await r.text()).trim());
  // And lost IS contactable — a lost deal is the ordinary subject of the whole
  // re-engagement campaign. Excluding it would exclude the point.
  check(lostContactable === 'true', 'and lost IS contactable — it is what re-engagement is FOR', lostContactable);

  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, { status: 'qualifying' });
  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, { status: 'qualified', qualified_at: new Date().toISOString() });
  await rest('PATCH', 'crm', `leads?id=eq.${relLead.id}`, { status: 'converted', converted_at: new Date().toISOString() });
  check(await relOf() === 'client', 'a converted lead makes the contact a CLIENT', await relOf());

  const clientContactable = await fetch(`${URL_BASE}/rest/v1/rpc/relationship_is_contactable`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'Content-Profile': 'crm' },
    body: JSON.stringify({ p_relationship: 'client' }),
  }).then(async (r) => (await r.text()).trim());
  check(clientContactable === 'false', 'and a client is NEVER contactable by a sales campaign', clientContactable);

} finally {
  // Cleanup — service role, best effort.
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.batches) await rest('DELETE', 'crm', `import_batches?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users)
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
