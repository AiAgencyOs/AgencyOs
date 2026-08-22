#!/usr/bin/env node
/**
 * Repricing a deal, and a reopened one forgetting how it closed.
 *
 * Gaps G-092 and the open half of G-089, decision ADM-43: *"An open deal's
 * value may be changed by the owner or an ops admin. Every change is written
 * to the audit log with the old and new amount."*
 *
 * A deal had **no update path at all**: value, name and expected close date
 * were written once at insert and never again. So a deal lost at one value and
 * re-won at another converted into a project budgeted at the old one — and
 * since G-017 that number is what the accepted quotation is measured against.
 *
 * And `closed_at` / `lost_reason` were cleared by exactly one service
 * function, so a reopen written any other way left a `discovery` deal carrying
 * the day it closed and why it was lost — which every report of "why do we
 * lose deals" then counted as a live loss.
 *
 *   node scripts/verify-deal-terms.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) { console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`); process.exit(1); }

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-deal-terms');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzterms';
const ORG = '00000000-0000-4000-8000-000000000001';

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
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const created = { leads: [], deals: [] };

async function deal(name, stage = 'discovery', value = 100000) {
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new',
  }));
  created.leads.push(lead.id);
  const o = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${name}`,
    stage, value_minor: value, currency: 'INR',
    ...(stage === 'won' || stage === 'lost' ? { closed_at: new Date().toISOString() } : {}),
    // Doc 09 §38 - a lost deal records both the sentence and the category
    // §37 counts. `opportunities_lost_says_why` holds it at the row now.
    ...(stage === 'lost' ? { lost_reason: 'went elsewhere', lost_category: 'chose_competitor' } : {}),
  }));
  created.deals.push(o.id);
  return o;
}
const terms = (id, args) => rest('POST', 'sales', 'rpc/set_opportunity_terms', { p_opportunity_id: id, ...args });
const read = async (id) => one(await rest('GET', 'sales', `opportunities?id=eq.${id}&select=stage,value_minor,name,expected_close_on,closed_at,lost_reason`));

console.log('\n\x1b[1mAgencyOS — repricing a deal (G-092, G-089)\x1b[0m');

try {
  console.log('\n1. An open deal can be corrected');
  {
    const o = await deal('open');
    const r = one(await terms(o.id, { p_value_minor: 250000, p_name: `${MARKER} renamed` }));
    check(r?.outcome === 'updated', 'the value and name are changed', `outcome ${r?.outcome}`);
    check(r?.value_minor === 250000, 'to the amount asked for', `${r?.value_minor}`);

    const after = await read(o.id);
    check(after?.value_minor === 250000 && after?.name === `${MARKER} renamed`, 'and the row carries both');
    created.open = o.id;
  }

  console.log('\n2. ADM-43’s audit requirement is met by the trigger that already existed');
  {
    const log = (await rest('GET', 'audit',
      `audit_log?subject_type=eq.opportunity&subject_id=eq.${created.open}&action=eq.opportunity.value_changed&select=before,after`)).json ?? [];
    check(log.length >= 1, 'the change is in the audit log', `${log.length} rows`);
    const e = log[0];
    check(
      e?.before?.value_minor === 100000 && e?.after?.value_minor === 250000,
      'with the old and new amount, as ADM-43 requires',
      `${e?.before?.value_minor} → ${e?.after?.value_minor}`,
    );
  }

  console.log('\n3. A null means leave alone, not clear');
  {
    const r = one(await terms(created.open, { p_value_minor: 300000 }));
    check(r?.outcome === 'updated' && r?.name === `${MARKER} renamed`, 'correcting a price keeps the name', `${r?.name}`);
  }

  console.log('\n4. A change that changes nothing is answered, not written');
  {
    const before = (await rest('GET', 'audit',
      `audit_log?subject_type=eq.opportunity&subject_id=eq.${created.open}&select=id`)).json ?? [];
    const r = one(await terms(created.open, { p_value_minor: 300000 }));
    check(r?.outcome === 'nothing_to_change', 'the no-op says so', `outcome ${r?.outcome}`);
    const after = (await rest('GET', 'audit',
      `audit_log?subject_type=eq.opportunity&subject_id=eq.${created.open}&select=id`)).json ?? [];
    check(after.length === before.length, 'and writes no audit row for an edit that did not happen', `${before.length} → ${after.length}`);
  }

  console.log('\n5. A settled deal keeps the terms it was settled on');
  {
    const won = await deal('won', 'won', 500000);
    const r = one(await terms(won.id, { p_value_minor: 999999 }));
    check(r?.outcome === 'settled', 'a won deal is refused', `outcome ${r?.outcome}`);
    check((await read(won.id))?.value_minor === 500000, 'and its value is untouched');

    const lost = await deal('lost', 'lost', 400000);
    check(one(await terms(lost.id, { p_value_minor: 1 }))?.outcome === 'settled', 'so is a lost one');
    created.lost = lost.id;
  }

  console.log('\n6. A reopened deal forgets how it closed — on every path');
  {
    // Straight through PostgREST, which the service-level clearing never saw.
    await rest('PATCH', 'sales', `opportunities?id=eq.${created.lost}`, { stage: 'discovery' });
    const after = await read(created.lost);
    check(after?.stage === 'discovery', 'the deal reopens');
    check(after?.closed_at === null, 'and no longer carries the day it closed', `${after?.closed_at}`);
    check(after?.lost_reason === null, 'nor why it was lost', `${after?.lost_reason}`);

    // And now it is open, so it can be repriced — the two halves meeting.
    const r = one(await terms(created.lost, { p_value_minor: 750000 }));
    check(r?.outcome === 'updated', 'a reopened deal can be repriced for the new engagement', `outcome ${r?.outcome}`);
  }

  console.log('\n7. Settling still records how it ended');
  {
    const o = await deal('settling');
    await rest('PATCH', 'sales', `opportunities?id=eq.${o.id}`, {
      stage: 'lost', closed_at: new Date().toISOString(), lost_reason: 'price',
      lost_category: 'price_too_high',
    });
    const after = await read(o.id);
    check(after?.closed_at !== null && after?.lost_reason === 'price',
      'the trigger clears on the way out, never on the way in', `${after?.lost_reason}`);
  }
} finally {
  for (const id of created.deals) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
}

console.log(`\n${checks} checks`);
if (failures === 0) {
  console.log('\x1b[32m✔ An open deal can be corrected, and a reopened one forgets how it closed\x1b[0m\n');
  process.exit(0);
}
console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
