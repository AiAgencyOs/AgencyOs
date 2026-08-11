#!/usr/bin/env node
/**
 * Secret scan, over what git actually tracks.
 *
 * Gap G-051. `.env.local` and `.env.verify.local` are gitignored, and nothing
 * verified that — a `git add -f`, a rename, or an edit to `.gitignore` would
 * have gone unnoticed, and the directive's rule (§40: no secrets in source,
 * tests, migrations, PR descriptions or logs) had no enforcement behind it.
 *
 * Deliberately repo-owned rather than a third-party action. This runs on every
 * push to a repository that handles money, so its supply chain is worth
 * keeping at zero; adopting a dedicated scanner (gitleaks, trufflehog) is a
 * better long-term answer and is recorded as a decision for the Admin rather
 * than taken here.
 *
 * It scans `git ls-files`, not the working tree, because an untracked file
 * full of keys is not a leak — committing one is.
 *
 *   node scripts/scan-secrets.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/**
 * Files that must never be tracked, whatever .gitignore currently says.
 *
 * Checked by name rather than by content: the point is that the file itself
 * does not enter history, and an empty one today can be a full one tomorrow.
 */
const NEVER_TRACKED = [/^\.env$/, /^\.env\.local$/, /^\.env\..*\.local$/, /^\.env\.production$/];

/**
 * Patterns worth failing a build over.
 *
 * Each is a shape that is only ever produced by a real credential — no generic
 * "password" matching, which produces noise the scan gets ignored for.
 */
const PATTERNS = [
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{12,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
];

/**
 * Paths whose matches are not credentials.
 *
 * `.env.example` files exist to show the *shape* of a value, and this scanner
 * is itself a file full of credential shapes. Both are listed explicitly, so
 * adding an exemption is a visible edit rather than a silent one.
 */
const ALLOWED = [/^\.env(\..*)?\.example$/, /^scripts\/scan-secrets\.mjs$/];

/** Binary and lockfile noise. Nothing here holds hand-written secrets. */
const SKIP = /\.(png|jpe?g|gif|webp|ico|svg|pdf|woff2?|ttf|eot|zip|gz)$/i;
const MAX_BYTES = 2_000_000;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

let failures = 0;
const bad = (message) => {
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  failures += 1;
};

console.log('\n\x1b[1mAgencyOS — secret scan\x1b[0m');
console.log(`  scanning ${tracked.length} tracked files\n`);

// ── 1. files that must not be in history at all ────────────────────────────
for (const file of tracked) {
  if (NEVER_TRACKED.some((re) => re.test(file))) {
    bad(`${file} is tracked by git — this file holds real credentials`);
  }
}

// ── 2. credential shapes in tracked content ────────────────────────────────
let scanned = 0;
for (const file of tracked) {
  if (SKIP.test(file)) continue;
  if (ALLOWED.some((re) => re.test(file))) continue;

  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // deleted-but-staged, or a submodule pointer
  }
  if (size > MAX_BYTES) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;
  scanned += 1;

  const lines = content.split('\n');
  for (const { name, re } of PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        // The finding is reported; the value never is.
        bad(`${file}:${i + 1} — ${name}`);
      }
    }
  }
}

// ── 3. the scan is capable of finding something ────────────────────────────
//
// A scanner that silently matched nothing would pass an empty repository and a
// compromised one identically. This proves the patterns still fire.
const CANARY = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature',
  'sb_secret_abcdefghijklmnop',
  'sk-ant-api03-abcdefghijklmnopqrst',
  'AKIAIOSFODNN7EXAMPLE',
  '-----BEGIN RSA PRIVATE KEY-----',
];
const misfires = CANARY.filter((sample) => !PATTERNS.some(({ re }) => re.test(sample)));
if (misfires.length > 0) {
  bad(`the scan no longer detects ${misfires.length} known credential shape(s)`);
} else {
  console.log(`  \x1b[32m✓\x1b[0m patterns still detect all ${CANARY.length} known shapes`);
}

if (failures === 0) {
  console.log(`  \x1b[32m✓\x1b[0m no credentials found in ${scanned} scanned files\n`);
  console.log('\x1b[32m✔ Secret scan passed\x1b[0m\n');
  process.exit(0);
}

console.error(`\n\x1b[31m✖ ${failures} finding(s)\x1b[0m\n`);
process.exit(1);
