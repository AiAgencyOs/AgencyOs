#!/usr/bin/env node
/**
 * A won deal implies a qualified lead, verified against a real database.
 *
 * Gap G-086, decision ADM-41: *"A won deal implies its lead was qualified. The
 * system fills in the qualification date rather than leaving a hole in the
 * history."*
 *
 * `qualified_at` was stamped in one place — the move into `qualified` — and the
 * constraint bound that status alone. A lead going straight from `new` to
 * `converted` was therefore a **client with no record of ever having been
 * qualified**: harmless to the database, wrong in every funnel report that
 * measures qualification, and wrong in the direction that makes the step look
 * skipped for deals that were actually won.
 *
 * What it proves:
 *
 *   1. A lead converted from `new` gets the date filled.
 *   2. An existing date is never overwritten — qualified in March, converted
 *      in June, keeps March. The date records when it happened.
 *   3. `disqualified` is untouched: ADM-41 speaks about a won deal, and a
 *      disqualified lead was never qualified.
 *   4. It holds on every path, including a write straight through PostgREST.
 *   5. The constraint states the invariant, so it survives a disabled trigger.
 *
 *   node scripts/verify-qualification-stamp.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-qualification-stamp');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zzqual';
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
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const created = [];

async function lead(title, fields = {}) {
  const row = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, source: 'manual', title: `${MARKER} ${title}`, status: 'new', ...fields,
  }));
  created.push(row.id);
  return row;
}

const read = async (id) =>
  one(await rest('GET', 'crm', `leads?id=eq.${id}&select=status,qualified_at,converted_at`));

console.log('\n\x1b[1mAgencyOS — a won deal implies a qualified lead (G-086)\x1b[0m');

try {
  console.log('\n1. A lead converted from new gets the date filled');
  {
    const l = await lead('straight to won');
    check(l.qualified_at === null, 'it starts with no qualification date');

    const at = new Date().toISOString();
    await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, { status: 'converted', converted_at: at });

    const after = await read(l.id);
    check(after?.status === 'converted', 'it converts');
    check(
      after?.qualified_at !== null,
      'and no longer has a hole where its qualification should be',
      `${after?.qualified_at}`,
    );
    check(
      after?.qualified_at === after?.converted_at,
      'the date used is the conversion moment, not an invented one',
    );
  }

  console.log('\n2. A date that exists is never replaced');
  {
    const march = '2026-03-01T09:00:00.000Z';
    const l = await lead('qualified in march', { status: 'qualified', qualified_at: march });

    await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, {
      status: 'converted', converted_at: new Date().toISOString(),
    });

    const after = await read(l.id);
    // Compared as instants. Postgres answers `+00:00` where the input said
    // `.000Z`; the same moment, a different spelling, and a string comparison
    // would fail on the formatting rather than on the fact.
    check(
      new Date(after?.qualified_at ?? 0).getTime() === new Date(march).getTime(),
      'qualified in March and converted in June keeps March',
      `${after?.qualified_at}`,
    );
  }

  console.log('\n3. A disqualified lead is left alone');
  {
    const l = await lead('not a fit');
    await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, {
      status: 'disqualified', disqualified_reason: 'no budget',
    });

    const after = await read(l.id);
    check(
      after?.qualified_at === null,
      'ADM-41 speaks about a won deal; a disqualified lead was never qualified',
      `${after?.qualified_at}`,
    );
  }

  console.log('\n4. It holds on the paths a service check would miss');
  {
    // Straight through PostgREST with no status transition helper in sight.
    // `leads_converted_at_set` has always required converted_at alongside the
    // status, so a PATCH without it is refused for that reason and proves
    // nothing about this trigger. Supplied here so the test measures what it
    // claims to.
    const l = await lead('raw patch');
    await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, {
      status: 'converted', converted_at: new Date().toISOString(),
    });
    const after = await read(l.id);
    check(
      after?.qualified_at !== null,
      'a raw PostgREST write is stamped like any other',
      `${after?.qualified_at}`,
    );

    // Converting a lead that was already qualifying, not new.
    const q = await lead('mid funnel', { status: 'qualifying' });
    await rest('PATCH', 'crm', `leads?id=eq.${q.id}`, {
      status: 'converted', converted_at: new Date().toISOString(),
    });
    check((await read(q.id))?.qualified_at !== null, 'and so is one converted from qualifying');
  }

  console.log('\n5. The constraint states it, so it holds where the trigger does not');
  {
    // The trigger fires only on the ARRIVAL at converted — `old.status is
    // distinct from 'converted'`. So an update to an already-converted row is
    // exactly the path it does not cover, and the constraint is what stands
    // there. Nulling the date on a converted lead must be refused.
    const l = await lead('constraint probe');
    await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, {
      status: 'converted', converted_at: new Date().toISOString(),
    });
    check((await read(l.id))?.qualified_at !== null, 'the lead converts with a date');

    const nulled = await rest('PATCH', 'crm', `leads?id=eq.${l.id}`, { qualified_at: null });
    check(
      nulled.status >= 400 && nulled.text.includes('leads_qualified_at_set'),
      'and the date cannot afterwards be removed — the constraint refuses it',
      `status ${nulled.status}`,
    );
    check(
      (await read(l.id))?.qualified_at !== null,
      'so the row still carries it',
    );
  }

} finally {
  for (const id of created) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  void randomUUID;
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A won deal leaves no hole where its qualification should be\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
