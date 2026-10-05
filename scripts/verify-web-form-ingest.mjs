#!/usr/bin/env node
/**
 * Inbound web-form ingest, verified against the real database — audit step
 * 1.1. Same reason scripts/verify-whatsapp-ingest.mjs gives for existing:
 * `crm.ingest_web_form_lead` does several inserts across tables that must be
 * atomic and idempotent, which a mock proves nothing about.
 *
 *   • an unrecognised form_key is refused, and creates nothing
 *   • a first submission creates organization → contact → lead →
 *     conversation → message, and queues one extraction
 *   • a submission with neither email nor phone is refused
 *   • a second submission from the same identity continues the same contact,
 *     lead and conversation — a thread, not a duplicate inquiry
 *   • campaign attribution (utm_source/utm_campaign/page_url) lands in the
 *     columns 20260904180000 added for WhatsApp's Click-to-WhatsApp referral
 *   • two organizations never see each other's rows
 *
 * Every row is created under a temporary organization and removed afterwards.
 *
 *   npm run verify:db:up
 *   npm run db:verify:webform
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

const SLUG_A = 'zztest-webform-a';
const SLUG_B = 'zztest-webform-b';
const FORM_KEY_A = 'ZZTEST_WFK_A';
const FORM_KEY_B = 'ZZTEST_WFK_B';
const EMAIL = 'zztest-asha@example.com';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: false });
const URL_BASE = target.url;
const SECRET = target.serviceKey;

async function request(method, schema, path, { body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET' ? { 'Accept-Profile': schema } : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* reported through text */ }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path) => request('GET', schema, path);
const insert = (schema, table, body) => request('POST', schema, table, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);
const countOf = async (schema, path) => (await select(schema, path)).json?.length ?? 0;

async function submit(args) {
  const res = await request('POST', 'crm', 'rpc/ingest_web_form_lead', {
    body: {
      p_form_key: args.formKey,
      p_full_name: args.fullName ?? 'Asha',
      ...(args.email ? { p_email: args.email } : {}),
      ...(args.phone ? { p_phone: args.phone } : {}),
      ...(args.message ? { p_message: args.message } : {}),
      ...(args.pageUrl ? { p_page_url: args.pageUrl } : {}),
      ...(args.utmSource ? { p_utm_source: args.utmSource } : {}),
      ...(args.utmCampaign ? { p_utm_campaign: args.utmCampaign } : {}),
    },
  });
  if (!res.ok) fail(`ingest failed (${res.status}): ${res.text}`);
  return (Array.isArray(res.json) ? res.json[0] : res.json) ?? null;
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const check = (cond, m) => (cond ? pass(m) : bad(m));
const section = (m) => console.log(`\n${m}`);

async function dropOrganizations() {
  for (const slug of [SLUG_A, SLUG_B]) await remove('core', `organizations?slug=eq.${slug}`);
}

console.log('\n\x1b[1mInbound web-form ingest — against the real database\x1b[0m');

section('0. Preflight');
announceTarget(target);
const probe = await select('crm', 'leads?select=campaign_source_type&limit=1');
check(probe.ok, 'crm.leads.campaign_source_type exists (migrations applied)');
if (!probe.ok) fail(`the ingest migration is not applied: ${probe.text}`);
await dropOrganizations();

section('1. Fixture');
const orgA = await insert('core', 'organizations', { name: 'ZZTEST Web Form A', slug: SLUG_A, settings: { web_form_key: FORM_KEY_A } });
const orgB = await insert('core', 'organizations', { name: 'ZZTEST Web Form B', slug: SLUG_B, settings: { web_form_key: FORM_KEY_B } });
const ORG_A = orgA.json?.[0]?.id;
const ORG_B = orgB.json?.[0]?.id;
if (!ORG_A || !ORG_B) fail(`could not create the temporary organizations: ${orgA.text} ${orgB.text}`);
check(Boolean(ORG_A && ORG_B), 'two organizations exist, each claiming its own form key');

section('2. An unrecognised form key');
const unknown = await submit({ formKey: 'ZZTEST_WFK_NOBODY', email: EMAIL, message: 'hi' });
check(unknown?.status === 'unknown_form_key', 'refused by status, not by an error');
check(unknown?.organization_id === null, 'no organization is guessed');

section('3. A submission with neither email nor phone');
const bare = await submit({ formKey: FORM_KEY_A, email: undefined, message: 'hi' });
check(bare?.status === 'not_reachable', 'refused — a contact must be reachable');

section('4. A first submission');
const first = await submit({
  formKey: FORM_KEY_A,
  fullName: 'Asha',
  email: EMAIL,
  message: 'Need a website',
  pageUrl: 'https://agency.test/contact',
  utmSource: 'google',
  utmCampaign: 'summer-promo',
});
check(first?.status === 'ingested', 'it is ingested');
check(first?.organization_id === ORG_A, 'under the organization that claims the form key');
check(first?.message_seq === 0, 'at position 0');
check(Boolean(first?.job_id), 'and one extraction is queued');

const contact = (await select('crm', `contacts?id=eq.${first?.contact_id}&select=*`)).json?.[0];
check(contact?.email === EMAIL, 'the contact is stored by email');
check(contact?.organization_id === ORG_A, 'and belongs to the right organization');

const lead = (await select('crm', `leads?id=eq.${first?.lead_id}&select=*`)).json?.[0];
check(lead?.source === 'web_form', 'the lead is web_form-sourced');
check(lead?.source_ref === `web:${EMAIL}`, 'keyed by identity, for idempotent thread continuation');
check(lead?.campaign_source_type === 'ad', 'campaign_source_type recorded from the UTM pair');
check(lead?.campaign_source_id === 'summer-promo', 'campaign_source_id carries utm_campaign');
check(lead?.campaign_source_url === 'https://agency.test/contact', 'campaign_source_url carries page_url');
check(lead?.campaign_headline === 'google', 'campaign_headline carries utm_source');

const conversation = (await select('crm', `conversations?id=eq.${first?.conversation_id}&select=*`)).json?.[0];
check(conversation?.channel === 'web_form', 'the conversation is on the web_form channel');

section('5. A second submission, same identity — continues the thread');
const second = await submit({ formKey: FORM_KEY_A, fullName: 'Asha', email: EMAIL, message: 'Also need a logo' });
check(second?.contact_id === first?.contact_id, 'same contact, not a duplicate');
check(second?.lead_id === first?.lead_id, 'same lead — one open thread per identity');
check(second?.conversation_id === first?.conversation_id, 'same conversation');
check(second?.message_seq === 1, 'the transcript continues at position 1');
check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'exactly one lead exists for this organization',
);

section('6. Two organizations never see each other\'s rows');
const forB = await submit({ formKey: FORM_KEY_B, fullName: 'Someone Else', email: 'zztest-other@example.com', message: 'hi' });
check(forB?.organization_id === ORG_B, 'a submission to form B lands under organization B');
check(
  (await countOf('crm', `contacts?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'organization A still has exactly one contact',
);

section('7. Cleanup');
await dropOrganizations();
const leftA = await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`);
const leftB = await countOf('crm', `leads?organization_id=eq.${ORG_B}&select=id`);
check(leftA === 0 && leftB === 0, 'temporary organizations and everything under them removed');

if (failures > 0) {
  console.log(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
