#!/usr/bin/env node
/**
 * Email outreach (info@) governance - against the real database and the running app.
 *
 *   node scripts/verify-email-outreach.mjs
 *
 * The SENDING is proved in tests/email-outreach.test.ts (a fake mailbox). This proves the thing a unit test cannot:
 * that the database - the only place a rule cannot be bypassed - refuses what must be refused, in both directions.
 *
 *   1. settings: only an admin saves them; only the OWNER can switch cold outreach on
 *   2. the list: provenance is required, duplicates and suppressed addresses are skipped, consent needs a known contact
 *   3. templates: no price / AI tooling / fake unsubscribe / unknown placeholder; the author cannot approve; approved is frozen
 *   4. campaigns: unapproved wording cannot be used; the creator cannot approve; no identity, no approval; the audience is FROZEN
 *   5. the chokepoint: the owner's stop switch, the warm-up cap, a suppressed address, a stopped prospect, a replied prospect,
 *      a reservation that cannot be taken twice, a follow-up that waits, a reply that cancels it
 *   6. outcomes: a hard bounce suppresses the address for good; a bouncing run pauses ITSELF and tells a person; resuming needs a reason
 *   7. the public unsubscribe: a GET changes nothing; a POST with a valid token suppresses permanently; a forged token is refused
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { signUnsubscribe } from '../src/modules/crm/outreach/unsubscribe-token.ts';
import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'info@ outreach, governed');

const ORG = '00000000-0000-4000-8000-000000000001';
const APP = target.appUrl ?? 'http://localhost:3000';
const MARKER = `zztest-outreach-${randomUUID().slice(0, 8)}`;
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

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = readFileSync('.env.verify.local', 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const SIGNING_KEY = envValue('VAULT_ENCRYPTION_KEY') || envValue('CRON_SECRET');

// The database's own clock (a local Docker VM can run hours behind this machine's).
const dbNow = async () => new Date((await fetch(`${target.url}/rest/v1/`, { headers: { apikey: target.serviceKey } })).headers.get('date') ?? Date.now());

const email = (n) => `${MARKER}-${n}@example.invalid`;
const rpc = (schema, fn, args) => rest('POST', schema, `rpc/${fn}`, args);

const savedSettings = one(await rest('GET', 'crm', `outreach_settings?organization_id=eq.${ORG}&select=*`));
const created = { campaigns: [], contacts: [] };

try {
  const creator = await fx.bootstrapOwner(`${MARKER}-a`);   // a real user; we mint DIFFERENT roles for them below
  const approver = await fx.bootstrapOwner(`${MARKER}-b`);
  const owner = approver.token; // owner
  const ownerId = approver.id;
  const ops = fx.mint(ownerId, 'ops_admin');
  const writer = fx.mint(creator.id, 'delivery_lead'); // can write, is not an admin
  const writerCall = (fn, args) => fx.call(writer, 'POST', 'crm', `rpc/${fn}`, args);
  const opsCall = (fn, args) => fx.call(ops, 'POST', 'crm', `rpc/${fn}`, args);
  const ownerCall = (fn, args) => fx.call(owner, 'POST', 'crm', `rpc/${fn}`, args);

  // Start from a known state: no settings row, kill switch released.
  await rest('DELETE', 'crm', `email_outreach_sends?organization_id=eq.${ORG}`);
  await rest('PATCH', 'crm', `outreach_settings?organization_id=eq.${ORG}`, { first_send_on: null });

  // ── 1. settings ─────────────────────────────────────────────────────────
  section('1. Settings: an admin saves them; only the owner takes the legal position');
  const memberSave = one(await writerCall('set_outreach_settings', { p_sender_name: 'X', p_postal_address: '1 Example Road, Delhi', p_reply_to: '', p_daily_cap: 50, p_bounce_pause_percent: 5 }));
  check(memberSave?.outcome === 'forbidden', 'a delivery lead cannot change the outreach settings', String(memberSave?.outcome));
  const opsCold = one(await opsCall('set_outreach_settings', { p_sender_name: 'Sonu Shah', p_postal_address: '12 Example Road, Delhi 110001', p_reply_to: '', p_daily_cap: 200, p_bounce_pause_percent: 5, p_cold_basis_enabled: true }));
  check(opsCold?.outcome === 'owner_only', 'an ops admin cannot switch cold business outreach on - it is the owner\'s alone', String(opsCold?.outcome));
  const opsSave = one(await opsCall('set_outreach_settings', { p_sender_name: 'Sonu Shah', p_postal_address: '12 Example Road, Delhi 110001', p_reply_to: '', p_daily_cap: 200, p_bounce_pause_percent: 5 }));
  check(opsSave?.outcome === 'saved', 'an ops admin saves the sender identity and the cap', String(opsSave?.outcome));
  const afterOps = one(await rest('GET', 'crm', `outreach_settings?organization_id=eq.${ORG}&select=cold_basis_enabled,daily_cap`));
  check(afterOps?.cold_basis_enabled === false && afterOps?.daily_cap === 200, 'cold outreach is OFF by default and stays off', JSON.stringify(afterOps));
  const badCap = one(await opsCall('set_outreach_settings', { p_sender_name: 'S', p_postal_address: '12 Example Road', p_reply_to: '', p_daily_cap: 9999, p_bounce_pause_percent: 5 }));
  check(badCap?.outcome === 'invalid', 'an absurd cap is refused', String(badCap?.outcome));

  // ── 2. the list ─────────────────────────────────────────────────────────
  section('2. The list: where each address came from, and what it may be used for');
  const known = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} Known`, email: email('known') }));
  created.contacts.push(known.id);
  const cold = Array.from({ length: 14 }, (_, i) => ({ email: email(`cold${i}`), fullName: `Cold ${i}`, company: `Co ${i}`, provenance: 'Business directory, checked today', lawfulBasis: 'b2b_legitimate_interest', tags: [MARKER] }));
  const rows = [
    { email: email('known'), fullName: 'Known', provenance: 'Asked to hear from us on the website', lawfulBasis: 'consent' },
    ...cold,
    { email: email('cold0'), provenance: 'Business directory', lawfulBasis: 'b2b_legitimate_interest' },       // duplicate
    { email: 'not-an-email', provenance: 'x list', lawfulBasis: 'b2b_legitimate_interest' },                      // invalid
    { email: email('nosource'), provenance: '', lawfulBasis: 'b2b_legitimate_interest' },                         // no provenance
    { email: email('stranger'), provenance: 'They said yes', lawfulBasis: 'consent' },                            // consent, but no known contact
  ];
  await fx.call(owner, 'POST', 'crm', 'rpc/suppress_email', { p_email: email('banned'), p_reason: 'manual', p_note: 'asked us to stop' });
  rows.push({ email: email('banned'), provenance: 'Directory', lawfulBasis: 'b2b_legitimate_interest' });          // already suppressed
  const added = one(await writerCall('add_outreach_prospects', { p_rows: rows }));
  check(added?.inserted === 15 && added?.duplicates === 1 && added?.suppressed === 1 && added?.invalid === 3, 'imports 15; skips the duplicate and the suppressed; refuses 3 (bad address, no provenance, consent without a known contact)', JSON.stringify({ i: added?.inserted, d: added?.duplicates, s: added?.suppressed, v: added?.invalid }));

  // ── 3. templates ────────────────────────────────────────────────────────
  section('3. Templates: words to strangers are checked and read by a second person');
  const tpl = async (subject, body) => one(await writerCall('create_email_template', { p_name: `${MARKER} t`, p_language: 'en', p_subject: subject, p_body: body }));
  const good = { subject: 'A note for {{company}}', body: 'Hi {{first_name}},\n\nWe build ordering apps for pharmacies and thought of {{company}}. Would a short call help?\n\n{{sender_name}}' };
  for (const [what, subject, body, expect] of [
    ['states a price', good.subject, 'Hi {{first_name}}, our apps start at ₹50,000 for a pharmacy like yours.', /price/],
    ['promises a discount', good.subject, 'Hi {{first_name}}, we are offering a discount for pharmacies this month, reply to claim it.', /price|discount/],
    ['names the AI tooling', good.subject, 'Hi {{first_name}}, this message was written by ChatGPT for your pharmacy.', /AI tooling/],
    ['fakes its own unsubscribe line', good.subject, 'Hi {{first_name}}, we build apps for pharmacies. To unsubscribe reply STOP at any time.', /unsubscribe/],
    ['uses an unknown placeholder', good.subject, 'Hi {{first_name}}, we have an offer for {{deal_value}} just for you today.', /placeholder|only use/],
  ]) {
    const r = await tpl(subject, body);
    check(String(r?.outcome).startsWith('refused') && expect.test(String(r?.outcome)), `a template that ${what} is refused`, String(r?.outcome).slice(0, 70));
  }
  const draft = await tpl(good.subject, good.body);
  check(draft?.outcome === 'created', 'a clean template is saved as a draft', String(draft?.outcome));
  const authorOwner = one(await fx.call(fx.mint(creator.id, 'owner'), 'POST', 'crm', 'rpc/approve_email_template', { p_template_id: draft.template_id }));
  check(authorOwner?.outcome === 'author_cannot_approve', 'the author cannot approve their own template, even as an owner', String(authorOwner?.outcome));
  const memberApprove = one(await writerCall('approve_email_template', { p_template_id: draft.template_id }));
  check(memberApprove?.outcome === 'forbidden', 'a delivery lead cannot approve', String(memberApprove?.outcome));
  const selfApprove = one(await ownerCall('approve_email_template', { p_template_id: draft.template_id }));
  check(selfApprove?.outcome === 'approved', 'a second person (an admin) approves it', String(selfApprove?.outcome));
  const edit = await rest('PATCH', 'crm', `email_templates?id=eq.${draft.template_id}`, { body: 'Hi {{first_name}}, a completely different message that nobody approved at all.' });
  check(!edit.ok, 'an approved template cannot be edited behind the approval', `HTTP ${edit.status}`);
  const draft2 = await tpl('Following up', 'Hi {{first_name}}, a short follow-up in case my last note got buried. Happy to answer any questions.');
  await ownerCall('approve_email_template', { p_template_id: draft2.template_id });

  // ── 4. campaigns ────────────────────────────────────────────────────────
  section('4. Campaigns: approved wording only, a second person approves, and the audience is frozen');
  const unapproved = await tpl('Draft only', 'Hi {{first_name}}, this one is still a draft and nobody has read it yet at all.');
  const useDraft = one(await writerCall('create_email_campaign', { p_name: `${MARKER} bad`, p_audience: {}, p_steps: [{ templateId: unapproved.template_id, delayDays: 0 }] }));
  check(useDraft?.outcome === 'template_not_approved', 'a campaign cannot use a template nobody approved', String(useDraft?.outcome));
  const camp = one(await writerCall('create_email_campaign', { p_name: `${MARKER} A`, p_audience: { statuses: ['new'], tags: [MARKER] }, p_steps: [{ templateId: draft.template_id, delayDays: 0 }, { templateId: draft2.template_id, delayDays: 3 }] }));
  created.campaigns.push(camp.campaign_id);
  check(camp?.outcome === 'created', 'two steps (a follow-up three days later) are created as a draft', String(camp?.outcome));
  const selfApproveCamp = one(await fx.call(fx.mint(creator.id, 'owner'), 'POST', 'crm', 'rpc/approve_email_campaign', { p_campaign_id: camp.campaign_id }));
  check(selfApproveCamp?.outcome === 'creator_cannot_approve', 'the creator cannot approve their own campaign', String(selfApproveCamp?.outcome));
  const preview = one(await ownerCall('preview_email_campaign', { p_campaign_id: camp.campaign_id }));
  check(preview?.reachable === 0 && preview?.cold_not_enabled === 14, 'with cold outreach OFF the preview says 14 people cannot be reached for that reason', JSON.stringify(preview));
  const nobody = one(await ownerCall('approve_email_campaign', { p_campaign_id: camp.campaign_id }));
  check(nobody?.outcome === 'nobody_reachable', 'and approval refuses a campaign nobody can lawfully receive', String(nobody?.outcome));

  // The owner takes the position; the audience becomes reachable, and is frozen at approval.
  const on = one(await ownerCall('set_outreach_settings', { p_sender_name: 'Sonu Shah', p_postal_address: '12 Example Road, Delhi 110001', p_reply_to: '', p_daily_cap: 200, p_bounce_pause_percent: 5, p_cold_basis_enabled: true }));
  check(on?.outcome === 'saved', 'the owner switches cold business outreach ON', String(on?.outcome));
  const approved = one(await ownerCall('approve_email_campaign', { p_campaign_id: camp.campaign_id }));
  check(approved?.outcome === 'approved' && approved?.recipient_count === 14, 'approval freezes exactly 14 people', `${approved?.outcome} ${approved?.recipient_count}`);
  await rest('POST', 'crm', 'outreach_prospects', { organization_id: ORG, email: email('late'), provenance: 'Added after approval', lawful_basis: 'b2b_legitimate_interest', tags: [MARKER] });
  const frozen = (await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&select=id`)).json ?? [];
  check(frozen.length === 14, 'someone added AFTER approval is not in the campaign - the count read is the count that goes', `${frozen.length}`);
  const noIdentityLater = one(await ownerCall('approve_email_campaign', { p_campaign_id: camp.campaign_id }));
  check(noIdentityLater?.outcome === 'not_a_draft', 'approving twice is refused', String(noIdentityLater?.outcome));

  // ── 5. the chokepoint ───────────────────────────────────────────────────
  section('5. The chokepoint: every gate, then a reservation');
  const claim = async (limit = 50) => {
    const r = await rpc('crm', 'claim_outreach_sends', { p_organization_id: ORG, p_limit: limit });
    if (!Array.isArray(r.json)) throw new Error(`claim_outreach_sends answered ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
    return r.json;
  };
  check((await claim()).length === 0, 'an APPROVED campaign sends nothing until a person starts it');
  const started = one(await ownerCall('set_email_campaign_state', { p_campaign_id: camp.campaign_id, p_to: 'running' }));
  check(started?.outcome === 'running', 'a person starts it', String(started?.outcome));

  const sw = await fx.call(owner, 'POST', 'core', 'rpc/set_kill_switch', { p_switch: 'outbound_paused', p_active: true, p_reason: `${MARKER} stop` });
  check(sw.ok && (await claim()).length === 0, 'the owner\'s outbound stop switch halts it at the chokepoint', `switch ${sw.ok ? 'set' : sw.status}`);
  await fx.call(owner, 'POST', 'core', 'rpc/set_kill_switch', { p_switch: 'outbound_paused', p_active: false, p_reason: `${MARKER} release` });
  await rest('PATCH', 'core', `kill_switches?organization_id=eq.${ORG}&switch=eq.outbound_paused`, { active: false });

  // suppression and a stopped prospect are refused at the moment of sending, not only at approval
  const target1 = frozen[0].id;
  const r1 = one(await rest('GET', 'crm', `email_campaign_recipients?id=eq.${target1}&select=email,prospect_id`));
  await ownerCall('suppress_email', { p_email: r1.email, p_reason: 'complaint', p_note: 'reported spam' });
  const r2 = (await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&email=neq.${r1.email}&select=id,email,prospect_id&limit=2`)).json;
  await rest('PATCH', 'crm', `outreach_prospects?id=eq.${r2[0].prospect_id}`, { status: 'replied' });
  // A suppression that arrives by a path that did NOT tidy the pending rows (an import, a migration, a restored backup):
  // the chokepoint itself must still catch it. This is the gate under test, not the tidy-up.
  const r3 = (await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&email=not.in.(${r1.email},${r2[0].email})&select=id,email,prospect_id&limit=1`)).json[0];
  await rest('POST', 'crm', 'email_suppressions', { organization_id: ORG, email: r3.email, reason: 'manual', source: 'direct-insert fixture' });

  const first = await claim(50);
  check(first.length === 10, 'warm-up: a new mailbox is held to 10 on its first day, however many are due', `${first.length} claimed`);
  const refused = (await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&status=eq.refused&select=email,refusal_reason`)).json ?? [];
  check(refused.some((x) => x.email === r1.email && x.refusal_reason === 'suppressed'), 'a suppressed address is refused at send time (suppressed)');
  check(refused.some((x) => x.email === r2[0].email && x.refusal_reason === 'prospect_stopped'), 'a prospect who already replied is refused (prospect_stopped)');
  check(first.every((c) => c.sender_name === 'Sonu Shah' && /Example Road/.test(c.postal_address)), 'every claimed send carries the sender identity');
  check(refused.some((x) => x.email === r3.email && x.refusal_reason === 'suppressed'), 'a suppression that bypassed every tidy-up is STILL caught at the chokepoint');
  check(!first.some((c) => [r1.email, r2[0].email, r3.email].includes(c.email)), 'and none of the three stopped addresses is in the batch');
  check((await claim()).length === 0, 'the cap is spent and a second claim cannot take the same people twice', 'reserved');

  const reserved = (await rest('GET', 'crm', `email_outreach_sends?campaign_id=eq.${camp.campaign_id}&select=id,status`)).json ?? [];
  check(reserved.length === 10 && reserved.every((s) => s.status === 'reserved'), '10 reservations exist before anything was sent', `${reserved.length}`);

  // ── 6. outcomes ─────────────────────────────────────────────────────────
  section('6. Outcomes: a bounce suppresses for good; a bouncing run stops itself');
  const [a, b, c] = first;
  const sent = one(await rpc('crm', 'record_outreach_result', { p_send_id: a.send_id, p_outcome: 'sent', p_message_ref: 'Q1', p_error: '' }));
  check(sent?.outcome === 'recorded', 'a sent result is recorded', String(sent?.outcome));
  const after = one(await rest('GET', 'crm', `email_campaign_recipients?id=eq.${a.recipient_id}&select=step_number,status,next_send_at`));
  check(after?.step_number === 2 && after?.status === 'pending' && new Date(after.next_send_at) > new Date((await dbNow()).getTime() + 2 * 86_400_000), 'step 2 waits three days', JSON.stringify(after));
  const prospect = one(await rest('GET', 'crm', `outreach_prospects?email=eq.${a.email}&select=status`));
  check(prospect?.status === 'contacted', 'and the person is now contacted');

  await rest('PATCH', 'crm', `email_campaign_recipients?id=eq.${a.recipient_id}`, { next_send_at: new Date((await dbNow()).getTime() - 60_000).toISOString() });
  await rest('PATCH', 'crm', `outreach_settings?organization_id=eq.${ORG}`, { first_send_on: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10) });
  const dueRow = one(await rest('GET', 'crm', `email_campaign_recipients?id=eq.${a.recipient_id}&select=status,step_number,next_send_at`));
  const second = await claim(50);
  check(second.some((x) => x.recipient_id === a.recipient_id && x.step_number === 2), 'the follow-up becomes due and is claimed as step 2', `${JSON.stringify(dueRow)} claimed ${second.length}`);

  const bad = one(await rpc('crm', 'record_outreach_result', { p_send_id: b.send_id, p_outcome: 'bounced', p_message_ref: '', p_error: 'RCPT TO → 550 user unknown' }));
  const sup = one(await rest('GET', 'crm', `email_suppressions?email=eq.${b.email}&select=reason`));
  check(bad?.outcome === 'recorded' && sup?.reason === 'hard_bounce', 'a hard bounce suppresses the address for good', String(sup?.reason));
  const del = await rest('DELETE', 'crm', `email_suppressions?email=eq.${b.email}`);
  const upd = await rest('PATCH', 'crm', `email_suppressions?email=eq.${b.email}`, { reason: 'manual' });
  check(!del.ok && !upd.ok, 'and a suppression can be neither deleted nor edited, even by the service role', `${del.status}/${upd.status}`);

  const replied = one(await writerCall('mark_prospect_replied', { p_prospect_id: (await rest('GET', 'crm', `outreach_prospects?email=eq.${c.email}&select=id`)).json[0].id }));
  check(replied?.outcome === 'replied', 'a person marks a reply - the sequence to them is cancelled', String(replied?.outcome));

  // The brake: enough bounces and the whole run pauses itself.
  const rest10 = first.slice(3);
  let n = 0;
  for (const it of rest10) {
    n += 1;
    await rpc('crm', 'record_outreach_result', { p_send_id: it.send_id, p_outcome: n <= 4 ? 'bounced' : 'sent', p_message_ref: 'Q', p_error: 'RCPT TO → 550 user unknown' });
  }
  // Pad to the 20-send floor with fixture sends so the rate is judged.
  const any = one(await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&select=id&limit=1`));
  for (let i = 0; i < 14; i += 1) {
    await rest('POST', 'crm', 'email_outreach_sends', { organization_id: ORG, campaign_id: camp.campaign_id, recipient_id: any.id, step_number: 90 + i, email: email(`pad${i}`), status: 'sent', sent_at: new Date().toISOString() });
  }
  await rpc('crm', 'record_outreach_result', { p_send_id: first[2].send_id, p_outcome: 'bounced', p_message_ref: '', p_error: 'RCPT TO → 550 user unknown' });
  const status = one(await rest('GET', 'crm', `email_campaigns?id=eq.${camp.campaign_id}&select=status,paused_reason`));
  check(status?.status === 'paused' && /Paused automatically/.test(status?.paused_reason ?? ''), 'a run that bounces past the threshold PAUSES ITSELF', String(status?.paused_reason).slice(0, 70));
  const alert = (await rest('GET', 'core', `alerts?fingerprint=eq.outreach-bounce-pause:${camp.campaign_id}&select=id`)).json ?? [];
  check(alert.length >= 1, 'and a person is told');
  check((await claim()).length === 0, 'a paused campaign sends nothing');
  const resumeNoNote = one(await ownerCall('set_email_campaign_state', { p_campaign_id: camp.campaign_id, p_to: 'running' }));
  check(resumeNoNote?.outcome === 'needs_note', 'resuming a run that stopped itself needs a reason', String(resumeNoNote?.outcome));

  // ── 7. the public unsubscribe ───────────────────────────────────────────
  section('7. The public unsubscribe: a link scanner cannot unsubscribe anybody; a real click always works');
  const victim = a.email;
  const token = signUnsubscribe({ organizationId: ORG, email: victim }, SIGNING_KEY);
  const getPage = await fetch(`${APP}/unsubscribe/${token}`, { redirect: 'manual' });
  check(getPage.status === 200, 'the confirmation page opens without a login', `HTTP ${getPage.status}`);
  check(((await rest('GET', 'crm', `email_suppressions?email=eq.${victim}&select=id`)).json ?? []).length === 0, 'and opening it unsubscribed nobody (a mail scanner fetches links)');
  const getApi = await fetch(`${APP}/api/outreach/unsubscribe/${token}`);
  check(getApi.status === 405, 'a GET to the one-click endpoint is refused', `HTTP ${getApi.status}`);
  const forged = await fetch(`${APP}/api/outreach/unsubscribe/${token.slice(0, -3)}abc`, { method: 'POST' });
  check(forged.status === 400, 'a forged token is refused', `HTTP ${forged.status}`);
  const other = signUnsubscribe({ organizationId: ORG, email: email('someone-else') }, 'a-different-key');
  check((await fetch(`${APP}/api/outreach/unsubscribe/${other}`, { method: 'POST' })).status === 400, 'a token signed with another key is refused');
  const click = await fetch(`${APP}/api/outreach/unsubscribe/${token}`, { method: 'POST' });
  check(click.status === 200, 'the one-click POST succeeds', `HTTP ${click.status}`);
  const supp = one(await rest('GET', 'crm', `email_suppressions?email=eq.${victim}&select=reason,source`));
  check(supp?.reason === 'unsubscribed', 'the address is suppressed for good, as unsubscribed', JSON.stringify(supp));
  const pr = one(await rest('GET', 'crm', `outreach_prospects?email=eq.${victim}&select=status`));
  const rc = one(await rest('GET', 'crm', `email_campaign_recipients?campaign_id=eq.${camp.campaign_id}&email=eq.${victim}&select=status`));
  check(pr?.status === 'do_not_contact' && ['unsubscribed', 'done'].includes(rc?.status), 'their prospect row and any pending step are stopped', `${pr?.status}/${rc?.status}`);
  const again = await fetch(`${APP}/api/outreach/unsubscribe/${token}`, { method: 'POST' });
  check(again.status === 200, 'unsubscribing twice is harmless', `HTTP ${again.status}`);
  const addAgain = one(await writerCall('add_outreach_prospects', { p_rows: [{ email: victim, provenance: 'Re-imported from an old list', lawfulBasis: 'b2b_legitimate_interest' }] }));
  check(addAgain?.suppressed === 1 && addAgain?.inserted === 0, 'and re-importing them from an old list does not bring them back', JSON.stringify({ i: addAgain?.inserted, s: addAgain?.suppressed }));
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  // Leave the org as found: the settings row, the kill switch, the fixtures.
  await rest('PATCH', 'core', `kill_switches?organization_id=eq.${ORG}&switch=eq.outbound_paused`, { active: false }).catch(() => {});
  for (const id of created.campaigns) await rest('PATCH', 'crm', `email_campaigns?id=eq.${id}`, { status: 'cancelled' }).catch(() => {});
  if (savedSettings) await rest('PATCH', 'crm', `outreach_settings?organization_id=eq.${ORG}`, { sender_name: savedSettings.sender_name, postal_address: savedSettings.postal_address, cold_basis_enabled: savedSettings.cold_basis_enabled, daily_cap: savedSettings.daily_cap, first_send_on: savedSettings.first_send_on }).catch(() => {});
  else await rest('PATCH', 'crm', `outreach_settings?organization_id=eq.${ORG}`, { cold_basis_enabled: false, first_send_on: null }).catch(() => {});
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
