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

// ── Result ────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
