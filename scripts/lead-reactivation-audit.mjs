/**
 * Lead reactivation audit — a READ-ONLY segmentation of the lead database.
 *
 * The sales-reactivation question is "which historical leads may we re-engage,
 * and through what?". This answers it from real database facts and writes
 * NOTHING: no lead is touched, no sequence is started, no message is sent. It
 * is the report the reactivation mandate requires before anything is sent.
 *
 * It runs against whichever database the verify target points at
 * (`.env.verify.local`, else `.env.local`) and prints that database's URL
 * fingerprint first, so a run always says which data it read — the same G-083
 * discipline the live scripts use. Point it at production (with the production
 * env) to segment the real 1,200-lead history; against the local stack it
 * segments the seed.
 *
 * Eligibility is transcribed from the engine, not invented. A lead is
 * re-engageable exactly when the existing `crm.observe_follow_up_candidates`
 * `inactive_lead` branch would emit it AND the send chokepoint
 * (`crm.send_outbound_message`) would permit the send:
 *   status in (new, qualifying, qualified), not soft-deleted,
 *   AND its contact has a `granted` whatsapp `communication_consent` row.
 * No consent row → not eligible (surfaced, never manufactured).
 *
 * Priority is reported as DESCRIPTIVE fact-tiers (previously replied / quoted /
 * conversed / cold), not a numeric score: the repository has no approved
 * scoring model, and inventing one is out of scope (raise it as a decision).
 */

import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { resolveTarget, announceTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false });
const fingerprint = createHash('sha256').update(target.url).digest('hex').slice(0, 12);

const db = createClient(target.url, target.serviceKey, {
  auth: { persistSession: false },
});

/** Page through a table fully (PostgREST caps a response at 1000 rows). */
async function fetchAll(schema, table, columns) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .schema(schema)
      .from(table)
      .select(columns)
      .range(from, from + page - 1);
    if (error) fail(`reading ${schema}.${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

// Which author_type values are the lead/client side of a thread (an inbound
// "reply"), vs. the agency side. Documented and conservative: anything not
// clearly the agency is treated as the counterparty. Adjust if a real export
// uses other labels — the value is surfaced below so a mis-mapping is visible.
const AGENCY_AUTHORS = new Set(['agent', 'user', 'system', 'owner', 'staff']);
const isInbound = (author_type) => !AGENCY_AUTHORS.has(author_type);

console.log(`\n\x1b[1mLead reactivation audit\x1b[0m`);
console.log(`  db fingerprint: ${fingerprint}`);
announceTarget(target);
console.log('  (read-only — nothing is written, nothing is sent)\n');

// ── pull the bounded facts ────────────────────────────────────────────────
const leads = await fetchAll('crm', 'leads',
  'id,status,qualified_at,converted_at,disqualified_reason,contact_id,source,score,created_at,updated_at,deleted_at,next_follow_up_at');
const contacts = await fetchAll('crm', 'contacts', 'id,phone,client_account_id');
const consent = await fetchAll('crm', 'communication_consent', 'contact_id,channel,status');
const conversations = await fetchAll('crm', 'conversations', 'id,lead_id,kind,status');
const messages = await fetchAll('crm', 'conversation_messages', 'conversation_id,author_type,occurred_at');
const sequences = await fetchAll('crm', 'follow_up_sequences', 'situation_key,subject_type,subject_id,status');
const opportunities = await fetchAll('sales', 'opportunities', 'id,lead_id');
const proposals = await fetchAll('sales', 'proposals', 'opportunity_id,status');
const projects = await fetchAll('projects', 'projects', 'client_account_id,status');

// ── indexes ───────────────────────────────────────────────────────────────
const contactById = new Map(contacts.map((c) => [c.id, c]));
const whatsappGranted = new Set(
  consent.filter((c) => c.channel === 'whatsapp' && c.status === 'granted').map((c) => c.contact_id),
);
const convByLead = new Map();
for (const cv of conversations) if (cv.lead_id) (convByLead.get(cv.lead_id) ?? convByLead.set(cv.lead_id, []).get(cv.lead_id)).push(cv);
const inboundConvs = new Set();
const anyMsgConvs = new Set();
for (const m of messages) { anyMsgConvs.add(m.conversation_id); if (isInbound(m.author_type)) inboundConvs.add(m.conversation_id); }
const oppByLead = new Map(opportunities.map((o) => [o.id, o.lead_id]));
const leadsWithProposal = new Set(
  proposals.map((p) => oppByLead.get(p.opportunity_id)).filter(Boolean),
);
const clientAcctsWithProject = new Set(projects.map((p) => p.client_account_id));
const phoneCounts = new Map();
for (const c of contacts) if (c.phone) phoneCounts.set(c.phone, (phoneCounts.get(c.phone) ?? 0) + 1);

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const table = (title, m) => {
  console.log(`\x1b[1m${title}\x1b[0m`);
  const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const w = Math.max(...entries.map(([k]) => String(k).length), 0);
  for (const [k, v] of entries) console.log(`  ${String(k).padEnd(w)}  ${v}`);
  if (!entries.length) console.log('  (none)');
  console.log('');
};

const live = leads.filter((l) => !l.deleted_at);
const byStatus = new Map();
const bySource = new Map();
let qualified = 0, converted = 0, disqualified = 0, neverQualified = 0;
let repliedLeads = 0, hasConvLeads = 0, hasOutboundLeads = 0;
const priority = new Map([['1 · eligible + previously quoted', 0], ['2 · eligible + previously replied', 0], ['3 · eligible + has conversation', 0], ['4 · eligible, no prior engagement', 0]]);
let eligibleNow = 0, eligByStatus = 0, eligNoConsent = 0, eligNoPhone = 0, activeClient = 0;

for (const l of live) {
  bump(byStatus, l.status);
  bump(bySource, l.source ?? '(unset)');
  if (l.qualified_at) qualified++;
  if (l.converted_at) converted++;
  if (l.status === 'disqualified') disqualified++;
  if (!l.qualified_at && l.status !== 'disqualified') neverQualified++;

  const convs = convByLead.get(l.id) ?? [];
  const convIds = convs.map((c) => c.id);
  const replied = convIds.some((id) => inboundConvs.has(id));
  const hasOutbound = convIds.some((id) => anyMsgConvs.has(id) && !inboundConvs.has(id));
  if (convs.length) hasConvLeads++;
  if (replied) repliedLeads++;
  if (hasOutbound) hasOutboundLeads++;

  const contact = l.contact_id ? contactById.get(l.contact_id) : null;
  if (contact?.client_account_id && clientAcctsWithProject.has(contact.client_account_id)) activeClient++;

  const statusEligible = ['new', 'qualifying', 'qualified'].includes(l.status);
  if (statusEligible) {
    eligByStatus++;
    const hasPhone = Boolean(contact?.phone);
    const hasConsent = l.contact_id && whatsappGranted.has(l.contact_id);
    if (!hasPhone) eligNoPhone++;
    if (!hasConsent) eligNoConsent++;
    if (hasPhone && hasConsent) {
      eligibleNow++;
      if (leadsWithProposal.has(l.id)) bump(priority, '1 · eligible + previously quoted');
      else if (replied) bump(priority, '2 · eligible + previously replied');
      else if (convs.length) bump(priority, '3 · eligible + has conversation');
      else bump(priority, '4 · eligible, no prior engagement');
    }
  }
}

const inactiveSeq = new Map();
for (const s of sequences) if (s.situation_key === 'inactive_lead') bump(inactiveSeq, s.status);
const dupPhones = [...phoneCounts.values()].filter((n) => n > 1).length;
const noPhone = contacts.filter((c) => !c.phone).length;

console.log(`\x1b[1m── VOLUME ──\x1b[0m`);
console.log(`  leads (live): ${live.length}   including soft-deleted: ${leads.length}`);
console.log(`  contacts: ${contacts.length}   whatsapp-consent granted: ${whatsappGranted.size}`);
console.log(`  conversations: ${conversations.length}   messages: ${messages.length}\n`);
table('── LEAD STATUS ──', byStatus);
console.log(`\x1b[1m── QUALIFICATION ──\x1b[0m`);
console.log(`  qualified: ${qualified}   converted: ${converted}   disqualified: ${disqualified}   never-qualified: ${neverQualified}\n`);
table('── SOURCE ──', bySource);
console.log(`\x1b[1m── ENGAGEMENT HISTORY ──\x1b[0m`);
console.log(`  leads with a conversation: ${hasConvLeads}`);
console.log(`  leads that previously replied (inbound): ${repliedLeads}`);
console.log(`  leads previously messaged (outbound): ${hasOutboundLeads}`);
console.log(`  leads with a proposal/quotation: ${leadsWithProposal.size}`);
console.log(`  leads whose account has a project (existing client): ${activeClient}\n`);
console.log(`\x1b[1m── CONTACTABILITY / DATA QUALITY ──\x1b[0m`);
console.log(`  contacts without a phone (invalid/missing number): ${noPhone}`);
console.log(`  phone numbers shared by >1 contact (duplicates): ${dupPhones}\n`);
console.log(`\x1b[1m── REACTIVATION ELIGIBILITY (the send gate) ──\x1b[0m`);
console.log(`  eligible by status (new/qualifying/qualified): ${eligByStatus}`);
console.log(`    └ blocked: no phone number:        ${eligNoPhone}`);
console.log(`    └ blocked: no whatsapp consent:     ${eligNoConsent}`);
console.log(`  \x1b[32mELIGIBLE NOW (status + phone + granted consent): ${eligibleNow}\x1b[0m\n`);
table('── PRIORITY TIERS (descriptive, from existing facts — not a scored model) ──', priority);
table('── EXISTING inactive_lead SEQUENCES (by status) ──', inactiveSeq);
console.log(`  author_type labels treated as AGENCY (outbound): ${[...AGENCY_AUTHORS].join(', ')}`);
console.log(`  \x1b[2m(a real export using other author labels should be re-checked against this set)\x1b[0m\n`);
console.log(`\x1b[32m✔ audit complete — read-only, nothing written or sent.\x1b[0m\n`);
