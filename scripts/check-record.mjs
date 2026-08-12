#!/usr/bin/env node
/**
 * The record, checked against the repository it describes.
 *
 * Gap G-094. `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` §4.8 claimed its totals were
 * "regenerated from the gap records whenever one changes" and "not maintained
 * by hand". No generator existed and CI ran none, so both copies drifted twice:
 * totals read 81 against 82 records, the baseline block read 30 migrations and
 * 694 tests against an actual 36 and 895, and all seven of D16–D22 were listed
 * open after every one of them had merged.
 *
 * A document that reports its own staleness as fact is the hazard directive §42
 * names, and it cannot be fixed by fixing the numbers one more time. This is the
 * generator's cheaper sibling: it does not write the documents, it refuses to
 * let them disagree — with each other, or with the repository.
 *
 * Every number it checks is one that was wrong at some point. Nothing here is
 * hypothetical.
 *
 *   node scripts/check-record.mjs
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const ROADMAP = 'docs/roadmap/roadmap.json';
const PLAN = 'AGENCYOS_MASTER_DEVELOPMENT_PLAN.md';
const BUNDLE = 'supabase/_bundle.sql';

const roadmap = JSON.parse(readFileSync(ROADMAP, 'utf8'));
const plan = readFileSync(PLAN, 'utf8');
const readme = readFileSync('README.md', 'utf8');

let failures = 0;

const ok = (message) => console.log(`  \x1b[32m✓\x1b[0m ${message}`);

const bad = (message) => {
  console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  failures += 1;
};

/** Assert two numbers agree, naming both sides so the fix is obvious. */
const same = (label, claimed, actual, claimedBy, actualBy) => {
  if (claimed === actual) return ok(`${label}: ${actual}`);
  bad(`${label}: ${claimedBy} says ${claimed}, ${actualBy} says ${actual}`);
};

/** Pull one capture group out of a document, or fail rather than skip. */
const capture = (source, sourceName, re, label) => {
  const match = source.match(re);
  if (match) return match;
  bad(`${label}: not found in ${sourceName} — the checker cannot verify what it cannot locate`);
  return null;
};

console.log('\n\x1b[1mAgencyOS — the record against the repository\x1b[0m\n');

// ── 1. The totals, against the records they summarise ──────────────────────
//
// This is the drift that happened twice: gapTotals is a hand-written summary of
// the gaps array sitting three screens above it in the same file.

const tally = (key) =>
  roadmap.gaps.reduce((acc, gap) => ((acc[gap[key]] = (acc[gap[key]] || 0) + 1), acc), {});

const byClass = tally('class');
const byRisk = tally('risk');

same('gapTotals.total', roadmap.gapTotals.total, roadmap.gaps.length, 'the summary', 'the records');

for (const [cls, claimed] of Object.entries(roadmap.gapTotals.byClass)) {
  same(`gapTotals.byClass.${cls}`, claimed, byClass[cls] || 0, 'the summary', 'the records');
}

for (const [risk, claimed] of Object.entries(roadmap.gapTotals.byRisk)) {
  same(`gapTotals.byRisk.${risk}`, claimed, byRisk[risk] || 0, 'the summary', 'the records');
}

// ── 2. The two copies, against each other ──────────────────────────────────
//
// G-078 and G-094 each existed in one copy and not the other. An id that
// appears in the machine-readable roadmap and nowhere in the document it is a
// copy of is a gap nobody reading the plan can see.

const planGapIds = new Set(plan.match(/G-\d{3}/g) || []);
const planAdmIds = new Set(plan.match(/ADM-\d+/g) || []);

const missingGaps = roadmap.gaps.map((g) => g.id).filter((id) => !planGapIds.has(id));
const strayGaps = [...planGapIds].filter((id) => !roadmap.gaps.some((g) => g.id === id));
const missingAdm = roadmap.adminDecisions.map((d) => d.id).filter((id) => !planAdmIds.has(id));
const strayAdm = [...planAdmIds].filter(
  (id) => id !== 'ADM-38' && !roadmap.adminDecisions.some((d) => d.id === id),
);

if (missingGaps.length > 0) bad(`gaps in ${ROADMAP} that ${PLAN} never mentions: ${missingGaps.join(', ')}`);
if (strayGaps.length > 0) bad(`gaps in ${PLAN} with no record in ${ROADMAP}: ${strayGaps.join(', ')}`);
if (missingAdm.length > 0) bad(`decisions in ${ROADMAP} that ${PLAN} never lists: ${missingAdm.join(', ')}`);
if (strayAdm.length > 0) bad(`decisions in ${PLAN} with no record in ${ROADMAP}: ${strayAdm.join(', ')}`);
if (missingGaps.length + strayGaps.length + missingAdm.length + strayAdm.length === 0) {
  ok(`both copies carry the same ${roadmap.gaps.length} gaps and ${roadmap.adminDecisions.length} decisions`);
}

// ── 3. The prose, against the totals ───────────────────────────────────────

const planTotal = capture(plan, PLAN, /\| \*\*Total\*\* \| \*\*(\d+)\*\* \|/, '§4.8 total');
if (planTotal) same('§4.8 total', Number(planTotal[1]), roadmap.gaps.length, PLAN, 'the records');

for (const [cls, label] of [
  ['A', 'already implemented or fixed'],
  ['B', 'partial'],
  ['C', 'missing'],
  ['D', 'incorrect'],
  ['E', 'blocked on an Admin decision'],
]) {
  const row = plan.match(new RegExp(`\\| ${cls} — ${label} \\| (\\d+) \\|`));
  if (!row) bad(`§4.8 class row for ${cls} not found in ${PLAN}`);
  else same(`§4.8 class ${cls}`, Number(row[1]), byClass[cls] || 0, PLAN, 'the records');
}

for (const risk of ['P0', 'P1', 'P2', 'P3']) {
  const row = plan.match(new RegExp(`\\| ${risk} \\| \\*?\\*?(\\d+)`));
  if (!row) bad(`§4.8 risk row for ${risk} not found in ${PLAN}`);
  else same(`§4.8 risk ${risk}`, Number(row[1]), byRisk[risk] || 0, PLAN, 'the records');
}

const granted = roadmap.adminDecisions.filter((d) => d.status === 'granted').length;
const open = roadmap.adminDecisions.length - granted;

const admTotal = capture(plan, PLAN, /\*\*(\d+) Admin decisions\*\*/, '§4.8 decision count');
if (admTotal) same('§4.8 decision count', Number(admTotal[1]), roadmap.adminDecisions.length, PLAN, 'the records');

const admSplit = capture(plan, PLAN, /\*\*(\d+) are granted, (\d+)\n?remain open\*\*/, '§4.8 granted/open split');
if (admSplit) {
  same('§4.8 granted', Number(admSplit[1]), granted, PLAN, 'the records');
  same('§4.8 open', Number(admSplit[2]), open, PLAN, 'the records');
}

// README carried "47 gaps" for fifty-one commits, through four re-counts.
const readmeGaps = capture(readme, 'README.md', /\[?(\d+) gaps/, 'README gap count');
if (readmeGaps) same('README gap count', Number(readmeGaps[1]), roadmap.gaps.length, 'README.md', 'the records');

// ── 4. The baseline, against the filesystem ────────────────────────────────

const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).length;
same('migrations', roadmap.baseline.migrations, migrations, ROADMAP, 'supabase/migrations/');

const testFiles = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).length;
same('test files', roadmap.baseline.testFiles, testFiles, ROADMAP, 'tests/');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const liveScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith('db:verify')).length;
same('live verification scripts', roadmap.baseline.liveVerificationScripts, liveScripts, ROADMAP, 'package.json');

const sql = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
  .join('\n')
  .toLowerCase();

const tables = new Set([...sql.matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/g)].map((m) => m[1]));
same('tables', roadmap.baseline.tables, tables.size, ROADMAP, 'the migrations');

// The alignment in the migrations is columnar, so the whitespace before
// `enable` varies — matching a single space silently found nine of twenty-seven.
const rls = new Set(
  [...sql.matchAll(/alter table\s+([a-z_]+\.[a-z_]+)\s+enable row level security/g)].map((m) => m[1]),
);
same('tables with RLS', roadmap.baseline.tablesWithRls, rls.size, ROADMAP, 'the migrations');

// ── 5. The test counts, against a run ──────────────────────────────────────
//
// The suite is about two seconds, so running it a second time to prove a number
// is cheap. A count nobody re-derives is exactly the kind that drifted by 201.

let output = '';
try {
  output = execFileSync('npm', ['test', '--silent'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  output = error.stdout || '';
}

const counted = (label) => {
  const match = output.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
};

const tests = counted('tests');
const suites = counted('suites');
const passing = counted('pass');

if (tests === null || suites === null || passing === null) {
  bad('could not read the test summary — the counts in the roadmap are unverified');
} else {
  same('tests', roadmap.baseline.tests, tests, ROADMAP, 'the run');
  same('suites', roadmap.baseline.testSuites, suites, ROADMAP, 'the run');
  same('tests passing', roadmap.baseline.testsPassing, passing, ROADMAP, 'the run');
}

// ── 6. ADM-40, pinned ──────────────────────────────────────────────────────
//
// The Admin decided the bundle stays as a marked-unsupported snapshot. A header
// is a weak guard — G-095 — so at minimum the marking itself cannot silently
// come off.

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const bundle = read(BUNDLE);

if (bundle === '') {
  ok(`${BUNDLE} is gone — nothing to mark`);
} else if (!bundle.includes('NOT AN INSTALL PATH')) {
  bad(`${BUNDLE} no longer carries its unsupported marking (ADM-40, G-095)`);
} else if (/^\s*begin;/m.test(bundle.slice(0, bundle.indexOf('NOT AN INSTALL PATH')))) {
  bad(`${BUNDLE} opens its transaction before the marking a reader would see first`);
} else {
  ok(`${BUNDLE} is marked unsupported, as ADM-40 decided`);
}

// ───────────────────────────────────────────────────────────────────────────

if (failures === 0) {
  console.log('\n\x1b[32m✔ The record matches the repository\x1b[0m\n');
  process.exit(0);
}

console.error(`\n\x1b[31m✖ ${failures} disagreement(s) between the record and the repository\x1b[0m`);
console.error('  Fix the document, not this check — the numbers here are all derived.\n');
process.exit(1);
