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
 * Reads credentials from .env.local. No secrets are printed.
 *
 *   node scripts/verify-schema.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  let raw;
  try {
    raw = readFileSync(join(root, '.env.local'), 'utf8');
  } catch {
    fail('.env.local not found. Copy .env.example and fill it in.');
  }
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const env = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_BASE || !PUBLISHABLE || !SECRET) {
  fail('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must all be set in .env.local');
}

/** Tables to verify, grouped by the schema that owns them. */
const EXPECTED = {
  core: ['organizations', 'users', 'memberships', 'client_accounts', 'client_users', 'jobs', 'outbox_events'],
  audit: ['audit_log'],
  crm: ['contacts', 'leads', 'lead_activities'],
  sales: ['opportunities', 'proposals', 'proposal_items'],
  projects: ['projects', 'milestones', 'tasks'],
  finance: ['invoices', 'invoice_items', 'payments'],
  ai: ['agents', 'agent_runs', 'agent_steps', 'cost_ledger'],
};

/** Tenant tables that must return nothing to a caller with no org claim. */
const RLS_TARGETS = [
  ['crm', 'leads'],
  ['crm', 'contacts'],
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
