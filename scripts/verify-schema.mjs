#!/usr/bin/env node
/**
 * Post-migration verification.
 *
 * Checks three things that matter and that a migration "succeeded" message
 * does not actually prove:
 *
 *   1. Every expected table exists and is reachable through PostgREST
 *      (i.e. the schema was created AND exposed to the API).
 *   2. public.health_check() executes, upgrading /api/health to a real
 *      database round trip.
 *   3. RLS actually denies. This is the important one: it queries tenant
 *      tables with the publishable key, which carries no organization claim,
 *      and asserts zero rows come back. A schema whose RLS is misconfigured
 *      leaks every tenant's data, and nothing else in the pipeline catches it.
 *
 * Reads credentials from .env.verify.local when it exists, otherwise
 * .env.local — the same rule as the other verification scripts, and printed on
 * the first line so the reader knows which database was checked. No secrets are
 * printed.
 *
 *   node scripts/verify-schema.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/**
 * Resolved the same way as every other verification script.
 *
 * It read `.env.local` directly until this change, which meant the one script
 * that never plants a fixture was also the only one that ignored
 * `.env.verify.local` — so a green run described whichever database the app
 * happens to use, not the one just built to be verified.
 *
 * No CRON_SECRET: nothing here calls the job runner. The publishable key is
 * required rather than optional, because section 3 is the point of the script
 * and it is the key carrying no organization claim that proves RLS denies.
 */
const target = resolveTarget(fail, { cron: false, anon: true });
const URL_BASE = target.url;
const PUBLISHABLE = target.anonKey;
const SECRET = target.serviceKey;

/** Tables to verify, grouped by the schema that owns them. */
const EXPECTED = {
  core: ['organizations', 'users', 'memberships', 'client_accounts', 'client_users', 'jobs', 'outbox_events'],
  audit: ['audit_log'],
  crm: [
    'contacts',
    'leads',
    'lead_activities',
    'conversations',
    'conversation_messages',
    'requirement_versions',
  ],
  sales: ['opportunities', 'proposals', 'proposal_items'],
  projects: ['projects', 'milestones', 'tasks'],
  finance: ['invoices', 'invoice_items', 'payments'],
  ai: ['agents', 'agent_runs', 'agent_steps', 'cost_ledger'],
};

/** Tenant tables that must return nothing to a caller with no org claim. */
const RLS_TARGETS = [
  ['crm', 'leads'],
  ['crm', 'contacts'],
  ['crm', 'conversations'],
  ['crm', 'conversation_messages'],
  ['crm', 'requirement_versions'],
  ['core', 'organizations'],
  ['core', 'client_accounts'],
  ['projects', 'projects'],
  ['finance', 'invoices'],
  ['audit', 'audit_log'],
];

const headers = (key, schema) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  ...(schema && schema !== 'public' ? { 'Accept-Profile': schema } : {}),
});

async function select(schema, table, key, extra = '') {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=*${extra}`, {
    headers: headers(key, schema),
    cache: 'no-store',
  });
  const body = await res.text();
  return { status: res.status, body };
}

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};

console.log('\n\x1b[1mAgencyOS — schema verification\x1b[0m');
announceTarget(target);

// ── 1. health_check() ─────────────────────────────────────────────────────
console.log('\n1. Database probe');
{
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/health_check`, {
    method: 'POST',
    headers: { ...headers(PUBLISHABLE), 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.ok) {
    pass('public.health_check() executes — /api/health now uses the "rpc" probe');
  } else {
    bad(`public.health_check() returned ${res.status} (migration 009 not applied?)`);
  }
}

// ── 2. Tables exist and are exposed ───────────────────────────────────────
console.log('\n2. Tables reachable through PostgREST');
for (const [schema, tables] of Object.entries(EXPECTED)) {
  const missing = [];
  let notExposed = false;

  for (const table of tables) {
    const { status, body } = await select(schema, table, SECRET, '&limit=0');

    // PGRST106 (HTTP 406) = the schema is not on PostgREST's exposed list.
    // This masks every table in the schema, so report it once and stop:
    // treating it as "table present" was a false pass in an earlier version.
    if (status === 406 || body.includes('PGRST106')) {
      notExposed = true;
      break;
    }
    // PGRST205 = schema exposed, but no such table in the cache.
    if (status === 404 || body.includes('PGRST205')) missing.push(table);
    else if (status === 401 || status === 403) missing.push(`${table} (key rejected)`);
  }

  if (notExposed) {
    bad(`${schema} — SCHEMA NOT EXPOSED to PostgREST (PGRST106); table state unknown`);
  } else if (missing.length === 0) {
    pass(`${schema} — ${tables.length} tables`);
  } else {
    bad(`${schema} — missing: ${missing.join(', ')}`);
  }
}

// ── 3. RLS denies callers with no organization claim ──────────────────────
console.log('\n3. Row Level Security (publishable key, no organization claim)');
for (const [schema, table] of RLS_TARGETS) {
  const { status, body } = await select(schema, table, PUBLISHABLE, '&limit=5');
  if (status === 200) {
    let rows;
    try {
      rows = JSON.parse(body);
    } catch {
      bad(`${schema}.${table} — unparseable response`);
      continue;
    }
    if (Array.isArray(rows) && rows.length === 0) {
      pass(`${schema}.${table} — 0 rows leaked`);
    } else {
      bad(`${schema}.${table} — LEAKED ${rows.length} ROW(S) to an unauthenticated caller`);
    }
  } else if (status === 401 || status === 403) {
    pass(`${schema}.${table} — access denied (${status})`);
  } else {
    bad(`${schema}.${table} — unexpected status ${status}`);
  }
}

// ── 4. Seed data ──────────────────────────────────────────────────────────
console.log('\n4. Seed data (service role)');
for (const [schema, table, min] of [
  ['core', 'organizations', 1],
  ['core', 'client_accounts', 2],
  ['crm', 'contacts', 3],
  ['crm', 'leads', 4],
  ['ai', 'agents', 3],
]) {
  const { status, body } = await select(schema, table, SECRET, '&limit=100');
  if (status !== 200) {
    bad(`${schema}.${table} — status ${status}`);
    continue;
  }
  const rows = JSON.parse(body);
  if (rows.length >= min) pass(`${schema}.${table} — ${rows.length} row(s)`);
  else bad(`${schema}.${table} — expected at least ${min}, found ${rows.length} (seed not applied?)`);
}

// ── 5. Uniqueness invariants the application leans on ─────────────────────
//
// The first section of this script that writes. It has to: a unique index is
// the one thing an application check cannot substitute for, and the only way
// to know it refuses is to give it something to refuse. Everything created
// here is removed in the `finally`, and nothing seeded is touched.
//
// Audit finding D21. createOpportunity reads sales.opportunities by lead_id
// and returns the existing deal if it finds one — but that read and the insert
// that follows are two statements, and only a NON-unique index sat behind them
// (20260807120005_sales.sql:37). Two clicks both read nothing and both insert.
//
// The second deal is not merely a duplicate row: the lead page renders one, so
// the other is invisible while still being counted, and each can be won and
// converted independently — projects_opportunity_key is keyed on the
// *opportunity*, so it permits both, giving one prospect two projects and two
// client accounts. That is the outcome D9 exists to prevent, reached through
// the door D9 did not cover.
console.log('\n5. Uniqueness invariants (service role)');
{
  const MARKER = 'ZZTEST d21 one-deal-per-lead';
  const write = (method, schema, table, body, extra = '') =>
    fetch(`${URL_BASE}/rest/v1/${table}${extra}`, {
      method,
      headers: {
        ...headers(SECRET, schema),
        'Content-Type': 'application/json',
        ...(schema && schema !== 'public' ? { 'Content-Profile': schema } : {}),
        ...(method === 'POST' ? { Prefer: 'return=representation' } : {}),
      },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (r) => ({ status: r.status, body: await r.text() }));

  let leadId = null;

  try {
    const orgs = JSON.parse((await select('core', 'organizations', SECRET, '&limit=1')).body);
    const organizationId = orgs?.[0]?.id ?? null;

    const lead = await write('POST', 'crm', 'leads', {
      organization_id: organizationId,
      title: `${MARKER} lead`,
    });
    leadId = JSON.parse(lead.body || '[]')?.[0]?.id ?? null;

    if (!leadId) {
      bad(`could not create a lead to test against — ${lead.body.slice(0, 120)}`);
    } else {
      const deal = (name) => ({
        organization_id: organizationId,
        lead_id: leadId,
        name: `${MARKER} ${name}`,
        stage: 'discovery',
      });

      // Fired together, exactly as two clicks on "Open deal" would be.
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => write('POST', 'sales', 'opportunities', deal(`deal ${n}`))),
      );

      const landed = results.filter((r) => r.status === 201).length;
      const refused = results.filter((r) => r.body.includes('opportunities_open_lead_key')).length;

      if (landed === 1) pass('five simultaneous deals on one lead — exactly one lands');
      else bad(`five simultaneous deals on one lead — ${landed} landed, expected 1`);

      if (refused === 4) pass('and the other four are refused by opportunities_open_lead_key, by name');
      else bad(`expected 4 refusals naming opportunities_open_lead_key, saw ${refused}`);

      // Settling the survivor frees the slot. This is the half that
      // distinguishes the shipped index from the one-deal-per-lead-EVER
      // version it replaced: without the stage predicate this insert is
      // refused, so it fails on the broader design rather than passing on
      // both.
      const survivor = results.find((r) => r.status === 201);
      const survivorId = JSON.parse(survivor?.body || '[]')?.[0]?.id ?? null;
      if (survivorId) {
        await write('PATCH', 'sales', 'opportunities',
          { stage: 'lost', closed_at: new Date().toISOString(), lost_reason: `${MARKER} settled` },
          `?id=eq.${survivorId}`);
        const second = await write('POST', 'sales', 'opportunities', deal('second engagement'));
        if (second.status === 201) {
          pass('and once that deal is settled, the lead can carry a new one');
        } else {
          bad(`a settled deal did not free the slot — ${second.body.slice(0, 140)}`);
        }
      } else {
        bad('no survivor to settle, so the stage predicate is untested');
      }

      // A deal raised without a lead is a real thing, and the index is partial
      // so that many of them are allowed. Without the `where` clause this
      // would still pass — Postgres does not conflict on nulls — so it is
      // asserted as the documented behaviour rather than as proof of the
      // clause.
      const orphans = await Promise.all(
        [1, 2].map((n) =>
          write('POST', 'sales', 'opportunities', {
            organization_id: organizationId,
            name: `${MARKER} orphan ${n}`,
            stage: 'discovery',
          }),
        ),
      );
      if (orphans.every((r) => r.status === 201)) {
        pass('two deals with no lead are both allowed');
      } else {
        bad(`a deal without a lead was refused — ${orphans.map((r) => r.status).join(', ')}`);
      }
      await write('DELETE', 'sales', 'opportunities', undefined, `?name=like.${encodeURIComponent(`${MARKER}%`)}`);
    }

    // ── D22: one organization per WhatsApp phone number id ────────────────
    //
    // crm.ingest_whatsapp_message resolves tenancy with
    // `where settings->>'whatsapp_phone_number_id' = $1 limit 1` and no ORDER
    // BY. Two organizations claiming one number is an accepted state today,
    // and when it happens the inbound message lands in whichever row came
    // back first — so a customer's number, name and message text are written
    // into another agency's tenant, where that agency's RLS then correctly
    // shows it to them.
    //
    // The index makes the ambiguity unrepresentable rather than making the
    // lookup pick a side: with at most one match, `limit 1` has nothing left
    // to order.
    const NUMBER = `zztest-d22-${Date.now()}`;
    // The slug CHECK caps the whole value at 50 characters and requires it to
    // start and end alphanumeric, so it is built short rather than from MARKER.
    const stamp = Date.now().toString(36);
    const org = (slug, settings) => ({
      name: `${MARKER} ${slug}`,
      slug: `zztest-d22-${slug}-${stamp}`,
      settings,
    });

    const first = await write('POST', 'core', 'organizations', org('wa-a', {
      whatsapp_phone_number_id: NUMBER,
    }));
    if (first.status !== 201) {
      bad(`could not create an organization to test against — ${first.body.slice(0, 140)}`);
    } else {
      const second = await write('POST', 'core', 'organizations', org('wa-b', {
        whatsapp_phone_number_id: NUMBER,
      }));

      // Status as well as body: a 500 whose message happened to echo the
      // index name would otherwise read as a refusal by the index.
      if (second.status === 409 && second.body.includes('organizations_whatsapp_number_key')) {
        pass('a second organization cannot claim the same WhatsApp number');
      } else {
        bad(
          `a second organization claimed the same WhatsApp number — status ${second.status}, ` +
            `body ${second.body.slice(0, 120)}`,
        );
      }

      // The control: the index is partial, so the many organizations with no
      // WhatsApp number configured must not collide with each other.
      const blanks = await Promise.all([
        write('POST', 'core', 'organizations', org('wa-none-1', {})),
        write('POST', 'core', 'organizations', org('wa-none-2', {})),
      ]);
      if (blanks.every((r) => r.status === 201)) {
        pass('and two organizations with no WhatsApp number are both allowed');
      } else {
        bad(`an organization with no WhatsApp number was refused — ${blanks.map((r) => r.status).join(', ')}`);
      }
    }
  } catch (error) {
    bad(`uniqueness section failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await write('DELETE', 'sales', 'opportunities', undefined, `?name=like.${encodeURIComponent(`${MARKER}%`)}`);
    if (leadId) await write('DELETE', 'crm', 'leads', undefined, `?id=eq.${leadId}`);
    await write('DELETE', 'core', 'organizations', undefined, `?name=like.${encodeURIComponent(`${MARKER}%`)}`);
  }
}

// ── 6. The job claim, and who may call it ─────────────────────────────────
//
// Gap G-082 moved both claim sites onto core.claim_jobs. That makes one
// function SECURITY DEFINER, `returns setof core.jobs`, and therefore able to
// read and write every tenant's queue with RLS bypassed — and `core` is on
// PostgREST's exposed list, so it is reachable over HTTP.
//
// The only thing between an authenticated user and that is the REVOKE in the
// migration. PostgreSQL grants EXECUTE to PUBLIC by default on every CREATE
// FUNCTION, so a future `create or replace` with a changed signature silently
// re-opens it. Nothing asserted the grant until now; a source scan cannot,
// because the question is what the database ended up with.
console.log('\n6. The job claim (service role, and who else)');
{
  const MARKER = 'zztest-g082';
  const rpc = (key, body) =>
    fetch(`${URL_BASE}/rest/v1/rpc/claim_jobs`, {
      method: 'POST',
      headers: {
        ...headers(key, 'core'),
        'Content-Type': 'application/json',
        'Content-Profile': 'core',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.text() }));

  const write = (method, schema, table, body, extra = '') =>
    fetch(`${URL_BASE}/rest/v1/${table}${extra}`, {
      method,
      headers: {
        ...headers(SECRET, schema),
        'Content-Type': 'application/json',
        'Content-Profile': schema,
        ...(method === 'POST' ? { Prefer: 'return=representation' } : {}),
      },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (r) => ({ status: r.status, body: await r.text() }));

  try {
    const orgs = JSON.parse((await select('core', 'organizations', SECRET, '&limit=1')).body);
    const organizationId = orgs?.[0]?.id ?? null;

    // Two jobs of different kinds, both due.
    const planted = await write('POST', 'core', 'jobs', [
      { organization_id: organizationId, kind: `${MARKER}.alpha`, payload: {}, dedupe_key: `${MARKER}-a` },
      { organization_id: organizationId, kind: `${MARKER}.beta`, payload: {}, dedupe_key: `${MARKER}-b` },
    ]);
    const rows = JSON.parse(planted.body || '[]');
    if (rows.length !== 2) {
      bad(`could not plant two jobs to claim — ${planted.body.slice(0, 140)}`);
    } else {
      // The grant. An unauthenticated caller must not reach a function that
      // bypasses RLS over every tenant's queue.
      const asAnon = await rpc(PUBLISHABLE, {
        p_worker_id: MARKER,
        p_kind: `${MARKER}.alpha`,
        p_batch_size: 1,
      });
      if (asAnon.status === 401 || asAnon.status === 403 || asAnon.body.includes('PGRST202')) {
        pass('the publishable key cannot execute core.claim_jobs');
      } else {
        bad(`an unauthenticated caller reached core.claim_jobs — status ${asAnon.status}`);
      }

      // And the kind filter, which is the whole of G-082: without it this
      // claim would return the beta job and the wrong handler would run it.
      const claimed = await rpc(SECRET, {
        p_worker_id: MARKER,
        p_kind: `${MARKER}.alpha`,
        p_batch_size: 5,
      });
      const got = JSON.parse(claimed.body || '[]');
      if (got.length === 1 && got[0]?.kind === `${MARKER}.alpha`) {
        pass('a claim returns only the kind it asked for');
      } else {
        bad(`the claim crossed kinds — got ${got.map((j) => j.kind).join(', ') || claimed.body.slice(0, 120)}`);
      }

      if (got[0]?.status === 'running' && got[0]?.attempts === 1 && got[0]?.locked_by === MARKER) {
        pass('and it returns the row it locked, with the attempt already counted');
      } else {
        bad(`the claim did not lock and count — ${JSON.stringify(got[0] ?? null).slice(0, 140)}`);
      }

      // Claiming again takes nothing: the row it locked is no longer queued,
      // and the other kind is still not this kind.
      const again = await rpc(SECRET, { p_worker_id: MARKER, p_kind: `${MARKER}.alpha`, p_batch_size: 5 });
      if (JSON.parse(again.body || '[]').length === 0) {
        pass('a second claim of the same kind takes nothing');
      } else {
        bad('a claimed job was claimed twice');
      }

      const beta = await rpc(SECRET, { p_worker_id: MARKER, p_kind: `${MARKER}.beta`, p_batch_size: 5 });
      if (JSON.parse(beta.body || '[]').length === 1) {
        pass('while the other kind is still there, untouched');
      } else {
        bad('the other kind was consumed by the first claim');
      }
    }
  } catch (error) {
    bad(`claim section failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await write('DELETE', 'core', 'jobs', undefined, `?dedupe_key=like.${MARKER}*`);
  }
}

// ── Result ────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
