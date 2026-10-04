#!/usr/bin/env node
/**
 * Inbound email, against the real database: what a received reply, bounce or unsubscribe DOES.
 *
 *   node scripts/verify-inbound-email.mjs
 *
 * The reading of a mailbox (IMAP) and of a message (MIME) are proved in tests/imap-client.test.ts and tests/inbound-email-parse.test.ts.
 * This proves what only the database can: that ONE door records each message once, acts on it in the right place and nowhere else,
 * cannot be reached by a signed-in user, and leaves a history nobody can edit.
 *
 *   1. a prospect's reply stops their sequence (pending -> replied), marks them replied and tells a person - and only them
 *   2. "unsubscribe" suppresses the address for good and stops the prospect
 *   3. a hard bounce suppresses the address that bounced; one with no readable address suppresses nothing
 *   4. an auto-reply changes nothing
 *   5. a client's email lands in their own thread as a client message, and wakes the same machinery a WhatsApp message does
 *   6. an unknown sender is recorded, raised once, and put nowhere
 *   7. the same message read twice changes nothing
 *   8. another organization's prospect is not matched; a record is history; a signed-in user cannot call the door
 */

import { randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'inbound email');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zzin${randomUUID().slice(0, 6)}`;
const fx = fixturesFor(target, ORG);
const { rest, one } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const door = async (args) => one(await rest('POST', 'crm', 'rpc/ingest_inbound_email', {
  p_organization_id: ORG, p_lane: 'outreach', p_message_id: `<${randomUUID()}@${MARKER}>`, p_from: '', p_subject: 'Re: hello', p_body: 'text',
  p_received_at: new Date().toISOString(), p_kind: 'reply', p_bounced_email: null, ...args,
}));

let owner;
const made = { campaigns: [], prospects: [], clients: [], contacts: [], leads: [], convs: [] };
try {
  owner = await fx.bootstrapOwner(MARKER);
  const campaign = one(await rest('POST', 'crm', 'email_campaigns', { organization_id: ORG, name: `${MARKER} camp`, status: 'running', created_by: owner.id }));
  if (!campaign?.id) fail(`could not create a campaign fixture: ${JSON.stringify(campaign)}`);
  made.campaigns.push(campaign.id);

  const prospect = async (label) => {
    const email = `${MARKER}-${label}@prospect.example`;
    const p = one(await rest('POST', 'crm', 'outreach_prospects', { organization_id: ORG, email, provenance: 'verifier fixture', lawful_basis: 'b2b_legitimate_interest', language: 'en' }));
    made.prospects.push(p.id);
    const r = one(await rest('POST', 'crm', 'email_campaign_recipients', { organization_id: ORG, campaign_id: campaign.id, prospect_id: p.id, email, status: 'pending', step_number: 1, next_send_at: new Date(Date.now() + 86_400_000).toISOString() }));
    return { id: p.id, email, recipient: r?.id };
  };
  const recipientStatus = async (id) => one(await rest('GET', 'crm', `email_campaign_recipients?id=eq.${id}&select=status`))?.status;
  const prospectStatus = async (id) => one(await rest('GET', 'crm', `outreach_prospects?id=eq.${id}&select=status`))?.status;
  const suppressed = async (email) => (await rest('GET', 'crm', `email_suppressions?organization_id=eq.${ORG}&email=eq.${email}&select=reason,source`)).json ?? [];

  // ── 1 ──
  section('1. A prospect replies');
  const a = await prospect('reply');
  const bystander = await prospect('bystander');
  const reply = await door({ p_from: a.email, p_body: 'Interesting, can we talk Thursday?' });
  check(reply?.outcome === 'prospect_replied', 'the reply is recognised', String(reply?.outcome));
  check((await recipientStatus(a.recipient)) === 'replied', 'their sequence stops: pending -> replied');
  check((await prospectStatus(a.id)) === 'replied', 'and the prospect is marked replied');
  check((await recipientStatus(bystander.recipient)) === 'pending' && (await prospectStatus(bystander.id)) === 'new', 'nobody else is touched');
  const alert = (await rest('GET', 'core', `alerts?fingerprint=eq.outreach-reply:${a.id}&select=summary`)).json ?? [];
  check(alert.length === 1, 'a person is told, once', String(alert[0]?.summary).slice(0, 60));
  check((await suppressed(a.email)).length === 0, 'a reply is NOT a reason to suppress');

  // ── 2 ──
  section('2. A prospect asks to stop');
  const b = await prospect('stop');
  const stop = await door({ p_from: b.email, p_kind: 'unsubscribe', p_body: 'please unsubscribe me' });
  check(stop?.outcome === 'unsubscribed', 'recognised', String(stop?.outcome));
  const sup = await suppressed(b.email);
  check(sup.length === 1 && sup[0].reason === 'unsubscribed' && /^inbound_email:/.test(sup[0].source), 'suppressed for good, with where it came from', JSON.stringify(sup[0]));
  check((await recipientStatus(b.recipient)) === 'unsubscribed' && (await prospectStatus(b.id)) === 'do_not_contact', 'the sequence stops and the prospect is do-not-contact');

  // ── 3 ──
  section('3. A hard bounce');
  const c = await prospect('bounce');
  const bounce = await door({ p_from: 'mailer-daemon@mx.example', p_kind: 'hard_bounce', p_bounced_email: c.email, p_subject: 'Undelivered Mail Returned to Sender' });
  check(bounce?.outcome === 'bounce_suppressed', 'recognised', String(bounce?.outcome));
  const bsup = await suppressed(c.email);
  check(bsup.length === 1 && bsup[0].reason === 'hard_bounce', 'the address that bounced is suppressed - not the mailer-daemon', JSON.stringify(bsup[0]));
  check((await recipientStatus(c.recipient)) === 'bounced', 'its pending send is stopped, and the record says why: bounced');
  check((await suppressed('mailer-daemon@mx.example')).length === 0, 'and the daemon itself is not');
  const unreadable = await door({ p_from: 'mailer-daemon@mx.example', p_kind: 'hard_bounce', p_bounced_email: null });
  check(unreadable?.outcome === 'bounce_unreadable', 'a bounce with no readable address suppresses nothing', String(unreadable?.outcome));

  // ── 4 ──
  section('4. An auto-reply');
  const d = await prospect('ooo');
  const ooo = await door({ p_from: d.email, p_kind: 'auto_reply', p_body: 'I am out of office' });
  check(ooo?.outcome === 'ignored_auto_reply' && (await recipientStatus(d.recipient)) === 'pending' && (await prospectStatus(d.id)) === 'new', 'changes nothing', String(ooo?.outcome));

  // ── 5 / 6 ──
  section('5. A client replies by email');
  const clientEmail = `${MARKER}-client@client.example`;
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  made.clients.push(account.id);
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: account.id, full_name: `${MARKER} contact`, email: clientEmail }));
  made.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, title: `${MARKER} lead`, source: 'web_form', source_ref: `${MARKER}:lead`, status: 'new' }));
  made.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct', channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active' }));
  made.convs.push(conv.id);
  const mid = `<${randomUUID()}@client.example>`;
  const said = await door({ p_lane: 'client', p_from: clientEmail.toUpperCase(), p_message_id: mid, p_subject: 'Re: your quotation', p_body: 'Please go ahead with option two.' });
  check(said?.outcome === 'recorded_to_thread' && said?.conversation_id === conv.id, 'it lands in THEIR thread (sender matched without regard to case)', String(said?.outcome));
  const msgs = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&select=id,author_type,body,metadata,external_ref`)).json ?? [];
  const msgRow = msgs[0];
  check(msgs.length === 1 && msgs[0].author_type === 'client' && msgs[0].metadata?.channel === 'email' && /^email:/.test(msgs[0].external_ref ?? ''), 'as a client message that says it came by email', JSON.stringify(msgs[0]?.metadata));
  const events = (await rest('GET', 'core', `outbox_events?organization_id=eq.${ORG}&subject_id=eq.${msgRow?.id}&select=type,payload`)).json ?? [];
  check(events.some((e) => e.type === 'message.received' && e.payload?.conversation_id === conv.id), 'and it wakes what a WhatsApp message wakes (message.received)', `${events.length} event(s)`);

  section('6. Somebody we do not know');
  const stranger = `${MARKER}-stranger@nowhere.example`;
  const s1 = await door({ p_lane: 'client', p_from: stranger, p_body: 'hello?' });
  check(s1?.outcome === 'unmatched' && !s1?.conversation_id, 'recorded, and put in no thread', String(s1?.outcome));
  const sAlert = (await rest('GET', 'core', `alerts?fingerprint=eq.inbound-unmatched:${stranger}&select=summary`)).json ?? [];
  check(sAlert.length === 1, 'raised for a person - once');
  const s2 = await door({ p_lane: 'client', p_from: stranger, p_body: 'hello again?' });
  const sAlert2 = (await rest('GET', 'core', `alerts?fingerprint=eq.inbound-unmatched:${stranger}&select=summary`)).json ?? [];
  check(s2?.outcome === 'unmatched' && sAlert2.length === 1, 'a second message from them bumps the same alert, not a second one');
  const empty = await door({ p_lane: 'client', p_from: clientEmail, p_body: '   ' });
  check(empty?.outcome === 'empty', 'an empty body is recorded and added to nothing', String(empty?.outcome));

  // ── 7 ──
  section('7. Reading the same message twice');
  const again = await door({ p_lane: 'client', p_from: clientEmail, p_message_id: mid, p_body: 'Please go ahead with option two.' });
  const msgsAfter = (await rest('GET', 'crm', `conversation_messages?conversation_id=eq.${conv.id}&select=id`)).json ?? [];
  check(again?.outcome === 'duplicate' && msgsAfter.length === 1, 'is a duplicate and adds nothing', String(again?.outcome));

  // ── 8 ──
  section('8. Boundaries');
  const other = await door({ p_organization_id: '00000000-0000-4000-8000-0000000000ff', p_from: a.email });
  check(other?.outcome === 'unknown_organization', 'an unknown organization is refused', String(other?.outcome));
  const rows = (await rest('GET', 'crm', `inbound_emails?organization_id=eq.${ORG}&from_email=eq.${a.email}&select=id`)).json ?? [];
  const id = rows[0]?.id;
  const upd = await rest('PATCH', 'crm', `inbound_emails?id=eq.${id}`, { outcome: 'tampered' });
  const del = await rest('DELETE', 'crm', `inbound_emails?id=eq.${id}`);
  check(Boolean(id) && !upd.ok && !del.ok, 'a record of a message is history: neither edited nor removed, even by the service role', `update ${upd.status}, delete ${del.status}`);
  const asUser = await fx.call(owner.token, 'POST', 'crm', 'rpc/ingest_inbound_email', { p_organization_id: ORG, p_lane: 'outreach', p_message_id: '<x@y>', p_from: 'a@b.co', p_subject: 's', p_body: 'b', p_received_at: new Date().toISOString(), p_kind: 'reply' });
  check(!asUser.ok && [401, 403, 404].includes(asUser.status), 'a signed-in owner cannot call the door - only the system can', `HTTP ${asUser.status}`);
  const asUserRead = await fx.call(owner.token, 'GET', 'crm', 'inbound_emails?select=id&limit=1');
  check(asUserRead.ok, 'but an admin can read what was received');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  for (const id of made.convs) await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`).catch(() => {});
  for (const id of made.convs) await rest('DELETE', 'crm', `conversations?id=eq.${id}`).catch(() => {});
  for (const id of made.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`).catch(() => {});
  for (const id of made.campaigns) await rest('PATCH', 'crm', `email_campaigns?id=eq.${id}`, { status: 'cancelled' }).catch(() => {});
  await rest('DELETE', 'core', `alerts?fingerprint=like.*${MARKER}*`).catch(() => {});
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
