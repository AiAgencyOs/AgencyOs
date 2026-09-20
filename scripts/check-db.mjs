#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// The tenancy/RLS/autonomy safety net, runnable locally — G-309.
//
// `npm run check` never touches a database: typecheck, lint, the mocked unit
// suite, a secret scan, and check:record. Every one of the ~90 `db:verify:*`
// scripts that actually drives the guards this codebase depends on most —
// tenancy isolation (`db:verify:tenancyguards`), RLS ownership
// (`db:verify:invokerrls`), the L0/L1/L2 autonomy gate (`db:verify:autonomy`),
// job claim atomicity (`db:verify:claims`) — runs ONLY in CI
// (.github/workflows/verify.yml), against a Supabase stack CI stands up for
// itself. A developer running `npm run check` before pushing gets zero
// coverage of any of it, and finds out only when CI runs twenty minutes
// later.
//
// This runs the same chain locally. It does not replace CI — CI still runs
// each script as its own step so a failure is attributed by name in the
// Actions log — but it means the same regression can be caught before a push
// rather than after one.
//
// The list of scripts to run is read from package.json rather than
// duplicated here, so a script added to CI's job is covered here without a
// second place to remember it.
//
//   npm run verify:db:up   — start a local Supabase stack and reset its schema
//   npm run check:db       — this script
//   npm run verify:db:down — stop it
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// `db:verify` (the schema check) and every `db:verify:*` script, in the order
// package.json lists them — the same order CI's job runs them in.
const keys = Object.keys(pkg.scripts).filter((k) => k === 'db:verify' || k.startsWith('db:verify:'));

if (keys.length === 0) {
  fail('no db:verify* scripts found in package.json — the parser drifted from the schema it reads');
}

console.log(`▶ running ${keys.length} database verification scripts`);
console.log('  (expects a reachable Supabase stack — run `npm run verify:db:up` first if this is a cold start)');

let ran = 0;
for (const key of keys) {
  process.stdout.write(`  ${key} … `);
  const result = spawnSync('npm', ['run', '--silent', key], { cwd: root, encoding: 'utf8' });

  if (result.status !== 0) {
    console.log('\x1b[31mFAILED\x1b[0m');
    console.log();
    console.log(`✖ ${key} failed (${ran}/${keys.length} passed before it)`);
    console.log((result.stdout ?? '') + (result.stderr ?? ''));
    process.exit(1);
  }

  ran += 1;
  console.log('\x1b[32m✓\x1b[0m');
}

console.log();
console.log(`✔ ${ran}/${ran} database verification scripts passed`);
