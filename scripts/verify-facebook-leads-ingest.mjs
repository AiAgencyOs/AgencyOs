#!/usr/bin/env node
/**
 * Inbound Facebook/Instagram Lead Ads ingest, verified against the real
 * database — audit step 1.1.
 *
 *   • an unrecognised page_id is refused, and creates nothing
 *   • a submission with neither email nor phone is refused
 *   • a first submission creates organization → contact → lead → activity,
 *     with campaign attribution (ad_id/ad_name) in the columns 20260904180000
 *     added for WhatsApp's Click-to-WhatsApp referral
 *   • no conversation and no extraction job — a form has no narrative
 *   • redelivering the same leadgen_id writes nothing a second time
 *   • two organizations never see each other's rows
 *
 * Every row is created under a temporary organization and removed afterwards.
 *
 *   npm run verify:db:up
 *   npm run db:verify:fbleads
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

const SLUG_A = 'zztest-fbleads-a';
const SLUG_B = 'zztest-fbleads-b';
const PAGE_A = 'ZZTEST_PAGE_A';
const PAGE_B = 'ZZTEST_PAGE_B';

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

async function ingest(args) {
  const res = await request('POST', 'crm', 'rpc/ingest_facebook_lead', {
    body: {
      p_page_id: args.pageId,
      p_leadgen_id: args.leadgenId,
      ...(args.fullName ? { p_full_name: args.fullName } : {}),
      ...(args.email ? { p_email: args.email } : {}),
      ...(args.phone ? { p_phone: args.phone } : {}),
      ...(args.adId ? { p_ad_id: args.adId } : {}),
      ...(args.adName ? { p_ad_name: args.adName } : {}),
      ...(args.formId ? { p_form_id: args.formId } : {}),
      ...(args.formName ? { p_form_name: args.formName } : {}),
      ...(args.fieldData ? { p_field_data: args.fieldData } : {}),
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

console.log('\n\x1b[1mInbound Facebook/Instagram Lead Ads ingest — against the real database\x1b[0m');

section('0. Preflight');
announceTarget(target);
const probe = await select('crm', 'leads?select=campaign_source_type&limit=1');
check(probe.ok, 'crm.leads.campaign_source_type exists (migrations applied)');
if (!probe.ok) fail(`the ingest migration is not applied: ${probe.text}`);
await dropOrganizations();

section('1. Fixture');
const orgA = await insert('core', 'organizations', { name: 'ZZTEST FB Leads A', slug: SLUG_A, settings: { facebook_page_id: PAGE_A } });
const orgB = await insert('core', 'organizations', { name: 'ZZTEST FB Leads B', slug: SLUG_B, settings: { facebook_page_id: PAGE_B } });
const ORG_A = orgA.json?.[0]?.id;
const ORG_B = orgB.json?.[0]?.id;
if (!ORG_A || !ORG_B) fail(`could not create the temporary organizations: ${orgA.text} ${orgB.text}`);
check(Boolean(ORG_A && ORG_B), 'two organizations exist, each claiming its own Page id');

section('2. An unrecognised page id');
const unknown = await ingest({ pageId: 'ZZTEST_PAGE_NOBODY', leadgenId: 'zztest-lg-unknown', email: 'zztest-a@example.com' });
check(unknown?.status === 'unknown_page_id', 'refused by status, not by an error');
check(unknown?.organization_id === null, 'no organization is guessed');

section('3. A submission with neither email nor phone');
const bare = await ingest({ pageId: PAGE_A, leadgenId: 'zztest-lg-bare' });
check(bare?.status === 'not_reachable', 'refused — a contact must be reachable');

section('4. A first submission');
const first = await ingest({
  pageId: PAGE_A,
  leadgenId: 'zztest-lg-1',
  fullName: 'Rahul',
  email: 'zztest-rahul@example.com',
  adId: 'zztest-ad-1',
  adName: 'Summer Promo',
  formId: 'zztest-form-1',
  formName: 'Contact Us',
  fieldData: { budget: '50k' },
});
check(first?.status === 'ingested', 'it is ingested');
check(first?.organization_id === ORG_A, 'under the organization that claims the Page');
check(Boolean(first?.activity_id), 'and a lead_activities row records the raw submission');

const contact = (await select('crm', `contacts?id=eq.${first?.contact_id}&select=*`)).json?.[0];
check(contact?.email === 'zztest-rahul@example.com', 'the contact is stored by email');

const lead = (await select('crm', `leads?id=eq.${first?.lead_id}&select=*`)).json?.[0];
check(lead?.source === 'facebook_lead_ads', 'the lead is facebook_lead_ads-sourced');
check(lead?.source_ref === 'zztest-lg-1', 'keyed by leadgen_id, for idempotent ingest');
check(lead?.campaign_source_type === 'ad', 'campaign_source_type is "ad"');
check(lead?.campaign_source_id === 'zztest-ad-1', 'campaign_source_id carries the ad id — which advertisement brought them');
check(lead?.campaign_headline === 'Summer Promo', 'campaign_headline carries the ad name');
check(lead?.requirements?.lead_ad_field_data?.budget === '50k', 'the raw field answers are kept on the lead');

check(
  (await countOf('crm', `conversations?lead_id=eq.${first?.lead_id}&select=id`)) === 0,
  'no conversation is created — a form submission carries no narrative',
);
check(
  (await countOf('core', `jobs?organization_id=eq.${ORG_A}&select=id`)) === 0,
  'no extraction job is queued',
);

const activity = (await select('crm', `lead_activities?id=eq.${first?.activity_id}&select=*`)).json?.[0];
check(activity?.kind === 'message_in', 'the activity is recorded as an inbound message');
check(activity?.metadata?.leadgen_id === 'zztest-lg-1', 'and carries the provider id for traceability');

section('5. Redelivery of the same leadgen_id');
const replay = await ingest({ pageId: PAGE_A, leadgenId: 'zztest-lg-1', email: 'zztest-rahul@example.com' });
check(replay?.status === 'replayed', 'it reports a replay rather than failing');
check(replay?.lead_id === first?.lead_id, 'returning the lead already recorded');
check(
  (await countOf('crm', `leads?organization_id=eq.${ORG_A}&select=id`)) === 1,
  'no duplicate lead was created',
);

section('6. Two organizations never see each other\'s rows');
const forB = await ingest({ pageId: PAGE_B, leadgenId: 'zztest-lg-b1', email: 'zztest-other@example.com' });
check(forB?.organization_id === ORG_B, 'a submission to Page B lands under organization B');

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
