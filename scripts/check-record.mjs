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

// ── 6. every schema the application reads is exposed (G-097) ───────────────
//
// The approvals schema shipped unreachable: PostgREST answers 406 PGRST106 for
// a schema not named in `pgrst.db_schemas`, a migration that creates one does
// not appear there, and the failure is invisible until something calls it. The
// migration now appends itself, and the qa schema does the same — but nothing
// checked the general case, so the next one would have found out the same way.
//
// `supabase/config.toml` is what seeds a fresh stack, so it is the list that
// has to be right. A schema the application reads and config.toml does not
// name is a 406 waiting for whoever recreates the database.

const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(path);
    } else if (/\.tsx?$/.test(entry.name)) {
      sources.push(readFileSync(path, 'utf8'));
    }
  }
};
walk('src');
walk('app');

const used = new Set(
  sources.flatMap((source) => [...source.matchAll(/\.schema\('([a-z_]+)'\)/g)].map((m) => m[1])),
);

const configured = new Set(
  (readFileSync('supabase/config.toml', 'utf8').match(/^schemas = \[(.*)\]$/m)?.[1] ?? '')
    .split(',')
    .map((part) => part.trim().replace(/"/g, ''))
    .filter(Boolean),
);

const unexposed = [...used].filter((schema) => !configured.has(schema));

if (unexposed.length > 0) {
  bad(
    `schemas the application reads but supabase/config.toml does not expose: ${unexposed.join(', ')} — ` +
      'every call to them answers 406 PGRST106 on a stack built from that file',
  );
} else {
  ok(`all ${used.size} schemas the application reads are exposed`);
}

// ── 7. every merged pull request has a change-log row (G-104) ──────────────
//
// G-094 was closed by re-deriving every *number* in the record. It said nothing
// about *events*, and that is the half that went stale next: twenty-three pull
// requests merged without a change-log row, and the log's last entry described
// itself as "(this change)" for a change that had landed a day earlier.
//
// The convention this project follows is that a pull request cannot record its
// own merge approval — the next change records it. That convention only holds
// if the next change is actually written, and nothing checked that it was.
//
// The number in a commit subject is the authority here, not the log: `(#64)` on
// a commit that is on this branch is a merge that happened, whatever the
// document says about it.

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' });
  } catch {
    return null;
  }
};

const subjects = git(['log', '--format=%s']);

// A shallow clone answers `git log` with one subject and no error, so this
// check would report "covers all 0 merges" and go green on a log that had
// stopped being kept — the catch → success shape directive §33 forbids, in the
// one check whose whole job is to notice an absence. Measured, not assumed: run
// against a depth-1 clone of this branch, that is exactly what it printed.
const shallow = (git(['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';

if (subjects === null) {
  bad(
    'git log is unreadable, so the change log cannot be checked against the merges it describes — ' +
      'this check needs a real repository, not an export',
  );
} else if (shallow) {
  bad(
    'this is a shallow clone, so the merges the change log should account for are not present — ' +
      'the check would pass on any log at all. CI asks for fetch-depth: 0 for exactly this reason',
  );
} else {
  const merged = new Set([...subjects.matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1])));

  // The newest merge is exempt, and this is not a softening — it is the
  // convention the check exists to enforce, stated exactly. A pull request
  // cannot record its own merge approval, so the row for it is written by the
  // change that comes after. Demanding it immediately made `main` red the
  // moment G-104 merged: the first thing this check did on the branch it
  // shipped in was fail for doing its job. A red main between every merge and
  // the next change is how a team learns to merge past a red check, which is
  // the same failure as the alert nobody reads.
  //
  // The exemption cannot be held open. One more merge and the previous number
  // is no longer newest, so it must be recorded by then — at most one merge may
  // be outstanding, which is the convention written as an invariant. The
  // twenty-three that went unlogged would still fail here, twenty-two times.
  const newest = Number(subjects.match(/\(#(\d+)\)/)?.[1] ?? NaN);

  const changeLog = plan.slice(plan.indexOf('## 10. Change log'));

  // A row may name one pull request or a range of them. The range form exists
  // because eleven PRs went unlogged once already and were recorded as a range
  // with the reason, rather than reconstructed from guessed dates.
  const logged = new Set([...changeLog.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  for (const [, from, to] of changeLog.matchAll(/#(\d+)\s*[–—-]\s*#?(\d+)/g)) {
    for (let n = Number(from); n <= Number(to); n += 1) logged.add(n);
  }

  const unlogged = [...merged]
    .filter((n) => !logged.has(n) && n !== newest)
    .sort((a, b) => a - b);

  if (unlogged.length > 0) {
    bad(
      `merged but absent from §10: ${unlogged.map((n) => `#${n}`).join(', ')} — ` +
        'a change log that stops being kept is how a merge approval goes unrecorded. ' +
        `Only the newest merge (#${newest}) may be outstanding, because the change after it records it`,
    );
  } else {
    const outstanding = merged.has(newest) && !logged.has(newest);
    ok(
      `change log covers all ${merged.size - (outstanding ? 1 : 0)} merges that name their pull request` +
        (outstanding ? `, with #${newest} outstanding for the next change to record` : ''),
    );
  }
}

// ── 8. a required decision can be found (G-107) ─────────────────────────────
//
// §4's gap table has a column for whether the Admin must decide something. Two
// rows said **Yes** and named nothing: G-091 and G-095. A decision that is
// required and has no id is invisible to every list of what the Admin owes —
// §5 does not carry it, `adminDecisions` does not count it, and a reader
// grouping the open gaps by their blocking decision files it under "none",
// which reads as *unblocked*.
//
// That is not hypothetical. It happened while this session was choosing what
// to work on next: G-091 was picked up as available work on exactly that
// reading, and only reading the row itself showed it needed an answer first.
//
// What counts as findable is deliberately wider than an ADM id. Twenty-four
// rows cite a specific pull request's merge approval instead — those merges
// predate the one-decision-per-PR convention, and inventing ADM numbers for
// them now would be writing history rather than recording it. A cited PR is
// something a reader can go and look at; a bare "Yes" is not.

const decisionColumn = (row) => {
  const cells = row.split('|').map((cell) => cell.trim());
  // …| decision | phase |  — the phase is last, the decision before it.
  return cells[cells.length - 3] ?? '';
};

const unfindable = [];

for (const row of plan.split('\n')) {
  const id = row.match(/^\| \*\*(G-\d{3})\*\* \|/)?.[1];
  if (!id) continue;

  const cell = decisionColumn(row);
  if (!/yes/i.test(cell)) continue;

  const named = /ADM-\d+/.test(cell) || /#\d+/.test(cell);
  const inRecord = (roadmap.gaps.find((g) => g.id === id)?.adminDecisions ?? []).length > 0;

  if (!named && !inRecord) unfindable.push(id);
}

if (unfindable.length > 0) {
  bad(
    `gaps that require an Admin decision but name none: ${unfindable.join(', ')} — ` +
      'a decision with no id is one nobody can find, and an open gap that lists no blocker reads as unblocked',
  );
} else {
  ok('every gap that requires a decision names one');
}

// ── 9. an unfinished gap does not point at an answered decision (G-108) ─────
//
// §8's mirror. There the failure was a gap that needed an answer and named
// none, so it read as unblocked. Here it is a gap that names a decision which
// has *already been granted* — which reads as unblocked just as convincingly,
// and is worse, because the id makes it look checked.
//
// Two were carrying it: G-052 pointed at ADM-20, granted, while what it is
// actually waiting for is the production Supabase and Vercel details nobody has
// supplied; G-101 pointed at ADM-08, granted, while what it asks — what L2
// autonomy permits an agent to do — has never been put to anybody.
//
// Either reading is a real state and the check does not guess between them. A
// gap here is one of two things, and both need a human: the work is finished
// and the class is stale, or it is waiting on something that was never written
// down. What it is not is blocked by the decision it names.

const decisionStatus = new Map(roadmap.adminDecisions.map((d) => [d.id, d.status]));

const answered = roadmap.gaps.filter((g) => {
  if (g.class === 'A') return false;
  const named = g.adminDecisions ?? [];
  return named.length > 0 && named.every((id) => decisionStatus.get(id) === 'granted');
});

if (answered.length > 0) {
  for (const g of answered) {
    bad(
      `${g.id} is class ${g.class} but every decision it names (${(g.adminDecisions ?? []).join(', ')}) ` +
        'is granted — either the work is done and the class is stale, or it waits on something nobody has raised',
    );
  }
} else {
  ok('no unfinished gap is blocked by a decision that has already been answered');
}

// ── 10. the superseded planning documents stay marked (G-056) ───────────────
//
// Closed by two headers, which is the same weak guard ADM-40 accepted for the
// bundle and for the same reason: the documents are retained as history, and
// history that stops saying it is history becomes instructions again. Both
// describe an `apps/`/`services/` layout this repository has never had.

for (const path of ['docs/implementation-backlog.md', 'docs/documentation-roadmap.md']) {
  const doc = readFileSync(path, 'utf8');
  if (!doc.includes('**SUPERSEDED')) {
    bad(`${path} no longer marks itself superseded (G-056) — it reads as a plan again`);
  } else {
    ok(`${path} is marked superseded`);
  }
}

// ── 11. a gate is not still open once the work it gated has landed (G-104) ──
//
// ADM-47 and ADM-48 were carried open for a day after the pull requests they
// gated merged, while §4.8 said in the same document that both were granted.
// Either reading is defensible on its own; holding both is how "never interpret
// absence of response as approval" (directive §29) quietly becomes untrue.
//
// The signal is narrow on purpose: only decisions that are *merge* gates, and
// only when every gap they block is already classed A. A policy question whose
// gap closed on a rule that predates it — ADM-02 and G-004 — is a different
// argument, and this check does not make it.

const classOf = new Map(roadmap.gaps.map((g) => [g.id, g.class]));

const landedButOpen = roadmap.adminDecisions.filter(
  (d) =>
    d.status !== 'granted' &&
    /^merge approval/i.test(d.title ?? '') &&
    (d.blocks ?? []).length > 0 &&
    (d.blocks ?? []).every((gap) => classOf.get(gap) === 'A'),
);

if (landedButOpen.length > 0) {
  for (const d of landedButOpen) {
    bad(
      `${d.id} is a merge gate recorded '${d.status}', but every gap it blocks (${(d.blocks ?? []).join(', ')}) ` +
        'is classed A — the work it gated is recorded as landed, so the record disagrees with itself',
    );
  }
} else {
  ok('no merge gate is open on work the record already counts as landed');
}

// ── 12. ADM-40, pinned ──────────────────────────────────────────────────────
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
