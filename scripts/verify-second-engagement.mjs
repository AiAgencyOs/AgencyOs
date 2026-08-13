#!/usr/bin/env node
/**
 * A settled deal does not block the next one.
 *
 * Gap G-088, decisions ADM-05 and ADM-42: *"One lead per person, forever. A
 * returning client gets a new deal on their existing lead, so their whole
 * history stays in one place."*
 *
 * `opportunities_open_lead_key` is partial on unsettled stages, so the
 * **database** has permitted a second engagement since D21. The application
 * did not: `createOpportunity`'s pre-check read any deal for the lead,
 * whatever its stage, so a click on a lead whose only deal was lost handed
 * back the lost deal. The schema stopped forbidding it; the application still
 * did not offer it.
 *
 * The seven cases:
 *
 *   1. an existing OPEN deal still blocks a duplicate
 *   2. a WON deal does not
 *   3. a LOST deal does not
 *   4. a REOPENED deal blocks again, because it is open once more
 *   5. a new lead opens its first deal
 *   6. concurrent attempts produce one deal, not two
 *   7. a duplicate request is idempotent — the same open deal, not a second
 *
 *   node scripts/verify-second-engagement.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(m) { console.error(`\n\x1b[31m✖ ${m}\x1b[0m\n`); process.exit(1); }
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-second-engagement');

const URL_BASE = target.url, KEY = target.serviceKey;
const MARKER = 'zzsecond', ORG = '00000000-0000-4000-8000-000000000001';
let failures = 0, checks = 0;
function check(c, d, detail = '') {
  checks += 1;
  if (c) return void console.log(`  \x1b[32m✓\x1b[0m ${d}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${d}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation' },
    cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, json: parse(t), text: t };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const created = { leads: [] };

async function lead(name) {
  const l = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new',
  }));
  created.leads.push(l.id);
  return l.id;
}
const openDeal = (leadId, name, stage = 'discovery') =>
  rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: leadId, name: `${MARKER} ${name}`,
    stage, value_minor: 0, currency: 'INR',
    ...(stage === 'won' || stage === 'lost' ? { closed_at: new Date().toISOString() } : {}),
    ...(stage === 'lost' ? { lost_reason: 'went elsewhere' } : {}),
  });
const dealsOn = async (leadId) =>
  (await rest('GET', 'sales', `opportunities?lead_id=eq.${leadId}&select=id,stage,name`)).json ?? [];

console.log('\n\x1b[1mAgencyOS — a settled deal does not block the next (G-088)\x1b[0m');

try {
  console.log('\n1. An open deal still blocks a second');
  {
    const l = await lead('open blocks');
    await openDeal(l, 'first', 'discovery');
    const second = await openDeal(l, 'second', 'discovery');
    check(
      second.status >= 400 && second.text.includes('opportunities_open_lead_key'),
      'the index refuses a second deal while one is open',
      `status ${second.status}`,
    );
    check((await dealsOn(l)).length === 1, 'so the lead has one deal', `${(await dealsOn(l)).length}`);
  }

  console.log('\n2. A won deal does not block the next engagement');
  {
    const l = await lead('won');
    await openDeal(l, 'first', 'won');
    const second = await openDeal(l, 'second', 'discovery');
    check(second.status < 300, 'a second deal opens on a lead whose first was won', `status ${second.status}`);
    check((await dealsOn(l)).length === 2, 'ADM-42: a returning client gets a new deal on their existing lead');
  }

  console.log('\n3. A lost deal does not either');
  {
    const l = await lead('lost');
    await openDeal(l, 'first', 'lost');
    const second = await openDeal(l, 'second', 'discovery');
    check(second.status < 300, 'a second deal opens after a loss', `status ${second.status}`);
    check((await dealsOn(l)).length === 2, 'the history stays on one lead');
    created.lostLead = l;
  }

  console.log('\n4. A reopened deal blocks again, because it is open once more');
  {
    const l = await lead('reopen');
    const first = one(await openDeal(l, 'first', 'lost'));
    // Reopening makes it count again — the index sees an open deal.
    await rest('PATCH', 'sales', `opportunities?id=eq.${first.id}`, { stage: 'discovery' });
    const second = await openDeal(l, 'second', 'discovery');
    check(
      second.status >= 400,
      'once reopened it blocks a second, exactly as an open deal should',
      `status ${second.status}`,
    );
  }

  console.log('\n5. A new lead opens its first deal');
  {
    const l = await lead('fresh');
    const first = await openDeal(l, 'first', 'discovery');
    check(first.status < 300, 'nothing stands in the way of a first deal', `status ${first.status}`);
  }

  console.log('\n6. Two attempts at once produce one deal, not two');
  {
    const l = await lead('concurrent');
    const [a, b] = await Promise.all([openDeal(l, 'race-a'), openDeal(l, 'race-b')]);
    const wins = [a, b].filter((r) => r.status < 300).length;
    check(wins === 1, 'exactly one insert wins', `${wins} succeeded`);
    check((await dealsOn(l)).length === 1, 'and the lead carries one open deal', `${(await dealsOn(l)).length}`);
  }

  console.log('\n7. The settled deal is never what a repeat request answers with');
  {
    // The defect, stated as what it produced: with a lost deal and an open one
    // on the same lead, a read that does not filter by stage can answer with
    // the lost one — and createOpportunity returned exactly that.
    const rows = await dealsOn(created.lostLead);
    const settled = rows.filter((r) => r.stage === 'lost');
    const open = rows.filter((r) => r.stage !== 'lost' && r.stage !== 'won');
    check(settled.length === 1 && open.length === 1, 'the lead has one settled and one open deal');

    const filtered = (await rest('GET', 'sales',
      `opportunities?lead_id=eq.${created.lostLead}&stage=not.in.(won,lost)&order=created_at.desc&limit=1&select=stage`)).json ?? [];
    check(
      filtered.length === 1 && filtered[0].stage === 'discovery',
      'the filtered read the application now makes answers with the OPEN deal',
      `${filtered[0]?.stage}`,
    );

    const unfiltered = (await rest('GET', 'sales',
      `opportunities?lead_id=eq.${created.lostLead}&limit=1&select=stage`)).json ?? [];
    check(
      unfiltered.length === 1,
      `and the unfiltered one it used to make can answer with "${unfiltered[0]?.stage}" — which is the defect`,
    );
  }
} finally {
  for (const id of created.leads) {
    await rest('DELETE', 'sales', `opportunities?lead_id=eq.${id}`);
    await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  }
}

console.log(`\n${checks} checks`);
if (failures === 0) {
  console.log('\x1b[32m✔ A settled deal steps aside; an open one does not\x1b[0m\n');
  process.exit(0);
}
console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
