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
import { readdirSync, readFileSync, statSync } from 'node:fs';

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

// ── 0. One id, one meaning ─────────────────────────────────────────────────
//
// Numbered zero because every count below it assumes an id appears once. This
// checker has always counted `adminDecisions.length` and compared it to a
// number in the plan; both agreed at 72 while six of those entries were second
// definitions of an id already used. Agreement is not correctness when both
// sides count the same duplicates.
//
// ADM-62 through ADM-67 each carry two meanings: a merge approval granted on
// 2026-08-13 for PRs #71-#76, and an open business question raised later the
// same day. Both are real and both are wanted. What is not wanted is that an
// answer addressed to "ADM-64" cannot be resolved to one of them.
//
// The six are listed rather than fixed, on the owner's instruction: renumbering
// changes the identifiers they are about to answer by, so it is theirs to
// approve. The list is deliberately exact - each entry names the gap the OPEN
// definition blocks - so that it cannot quietly cover a seventh collision, and
// so that it fails once the renumbering lands and the entry goes stale.
//
// The same shape as the ADM-38 exception below: a known anomaly is recorded
// with its reason, and everything unknown still fails.

// Empty since 2026-08-14, and deliberately kept rather than deleted. The six
// collisions it named were renumbered on the owner's approval - the open
// questions became ADM-71-ADM-76, the granted merge approvals kept ADM-62-67 -
// and the staleness check below is what required this map to be emptied in the
// same change. An empty allowlist is the resting state: every duplicate now
// fails, and a future collision has to be argued for here rather than
// discovered by an owner whose answer could not be resolved to a question.
const KNOWN_DUPLICATE_DECISIONS = new Map([]);

/** Every id that appears more than once, with the entries that share it. */
const collisions = (records) => {
  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, []);
    byId.get(record.id).push(record);
  }
  return new Map([...byId].filter(([, entries]) => entries.length > 1));
};

const gapCollisions = collisions(roadmap.gaps);
for (const [id, entries] of gapCollisions) {
  bad(`gap ${id} is defined ${entries.length} times in ${ROADMAP} — a gap id must name one gap`);
}
if (gapCollisions.size === 0) ok(`gap ids are unique: ${roadmap.gaps.length} records, ${roadmap.gaps.length} ids`);

const admCollisions = collisions(roadmap.adminDecisions);
const failuresBeforeAdmIds = failures;

for (const [id, entries] of admCollisions) {
  if (!KNOWN_DUPLICATE_DECISIONS.has(id)) {
    bad(
      `decision ${id} is defined ${entries.length} times in ${ROADMAP} and is not a recorded collision — ` +
        `an answer addressed to ${id} could not be resolved to one of them`,
    );
    continue;
  }

  // A recorded collision is only tolerated in the exact shape that was
  // recorded. Two entries, one granted and one open, and the open one blocking
  // the gap named above — anything else is a new problem wearing an old name.
  const statuses = entries.map((d) => d.status).sort();
  const openEntry = entries.find((d) => d.status === 'open');
  const expectedGap = KNOWN_DUPLICATE_DECISIONS.get(id);

  if (entries.length !== 2 || statuses.join() !== 'granted,open') {
    bad(
      `decision ${id} is a recorded collision but no longer reads granted + open ` +
        `(${entries.length} entries: ${statuses.join(', ')}) — re-check it before trusting the record`,
    );
  } else if (!(openEntry.blocks ?? []).includes(expectedGap)) {
    bad(
      `decision ${id}'s open definition should block ${expectedGap} and blocks ` +
        `${(openEntry.blocks ?? []).join(', ') || 'nothing'} — the recorded collision is stale`,
    );
  }
}

for (const [id, gap] of KNOWN_DUPLICATE_DECISIONS) {
  if (!admCollisions.has(id)) {
    bad(
      `decision ${id} is listed as a recorded collision but appears once — if the renumbering has landed, ` +
        `drop it from KNOWN_DUPLICATE_DECISIONS (it blocked ${gap})`,
    );
  }
}

// Only summarise if nothing above failed. A green line reading "6 recorded
// collisions" printed beside a red one saying one of them is stale is a
// checker contradicting itself in its own output.
const uniqueAdmIds = new Set(roadmap.adminDecisions.map((d) => d.id)).size;
if (failures > failuresBeforeAdmIds) {
  // The failures above said it; a summary would only soften them.
} else if (admCollisions.size > 0) {
  ok(
    `decision ids: ${roadmap.adminDecisions.length} records over ${uniqueAdmIds} ids — ` +
      `${admCollisions.size} recorded collisions awaiting the owner's renumbering ` +
      `(${[...admCollisions.keys()].join(', ')})`,
  );
} else if (admCollisions.size === 0) {
  ok(`decision ids are unique: ${roadmap.adminDecisions.length} records, ${uniqueAdmIds} ids`);
}

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

  /**
   * ── and the row names its OWN merge ─────────────────────────────────────
   *
   * The check above asks whether every merged pull request appears SOMEWHERE
   * in §10. That is not the same question as whether the row naming #378 is
   * the row describing what #378 did, and the difference is not academic:
   * a marker converter that derived the gap id from the pull request number
   * arithmetically stamped **G-209's row with #378's hash** — #378 having
   * closed G-210 — and everything above went green, because #378 did appear.
   *
   * A row with a plausible hash and the wrong change behind it is worse than
   * a missing row. A missing row is visibly missing; this one reads as a
   * record, and the next person to trust it is reading a lie about which
   * commit to look at.
   *
   * Two things are compared, and the second is the one that catches it. An
   * abbreviated hash is hard to eyeball and easy to accept; `G-209` in the row
   * against `(G-210)` in the commit's own subject is a flat contradiction.
   */
  const byPr = new Map();
  for (const line of (git(['log', '--format=%h\t%s']) ?? '').split('\n')) {
    const [hash, subject = ''] = line.split('\t');
    const pr = /\(#(\d+)\)$/.exec(subject.trim())?.[1];
    if (pr && !byPr.has(Number(pr))) byPr.set(Number(pr), { hash, subject });
  }

  const stamped = [...changeLog.matchAll(/^\|[^|]*\|\s*`([0-9a-f]{7,40})`\s*\(PR #(\d+)\)\s*\|(.*)$/gm)];
  const mismatched = [];

  for (const [, hash, prText, body] of stamped) {
    const pr = Number(prText);
    const commit = byPr.get(pr);
    // A merge older than this clone, or a row naming a range: nothing to
    // compare against, and inventing a failure from an absence is the mistake
    // the shallow-clone branch above exists to avoid.
    if (!commit) continue;

    if (!commit.hash.startsWith(hash) && !hash.startsWith(commit.hash)) {
      mismatched.push(`#${pr}: the row says ${hash}, the merge is ${commit.hash}`);
      continue;
    }

    /**
     * From the row's BOLD TITLE, never from its prose.
     *
     * The first draft took the first `G-NNN` anywhere in the row and flagged
     * seven historical entries that were perfectly correct — a row about
     * G-126 opens by discussing G-026, and a row whose title names no gap at
     * all borrowed one from its own argument. The subject of a row is what
     * its title says it is; everything after that is the row citing its
     * neighbours, which is exactly what a good change log does.
     */
    const title = /\*\*(.+?)\*\*/.exec(body)?.[1] ?? '';
    const rowGap = /\bG-(\d+)\b/.exec(title)?.[1];
    const commitGap = /\(G-(\d+)\)/.exec(commit.subject)?.[1];
    if (rowGap && commitGap && rowGap !== commitGap) {
      mismatched.push(`#${pr}: the row describes G-${rowGap}, the merge closed G-${commitGap}`);
    }
  }

  if (mismatched.length > 0) {
    bad(
      `§10 rows whose hash does not belong to the change they describe: ${mismatched.join('; ')} — ` +
        'a row with a plausible hash and the wrong change behind it is worse than a missing row, ' +
        'because it reads as a record',
    );
  } else {
    ok(`every §10 row that names a hash names its own merge (${stamped.length} checked)`);
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
// The first version of this check allowed two readings — the work is done and
// the class is stale, or it waits on something never written down — and
// demanded a human resolve it either way. That was wrong within a day.
//
// On 2026-08-13 the Admin answered twenty-five decisions in one sitting, and
// twenty gaps went from blocked to **ready to build** at once. That is a third
// state, it is the normal one after any decision is answered, and the check
// called all twenty a defect. A check that fires on the healthy case is a check
// people learn to skip.
//
// So the record has to say which it is. `ready: true` means somebody looked and
// confirmed the gap is implementable now — the queue, not a puzzle. What the
// check still refuses is the ambiguous middle: a gap whose decisions are all
// answered and which nobody has marked ready, because that is where G-052 and
// G-101 sat, each pointing at a decision that settled a different question.

const decisionStatus = new Map(roadmap.adminDecisions.map((d) => [d.id, d.status]));
const gapClass = new Map(roadmap.gaps.map((g) => [g.id, g.class]));

/**
 * Waiting on a gap that is itself still open.
 *
 * The message below has always ended "or waiting on something nobody raised".
 * Raising it was the intended answer, and until 2026-08-14 there was no way to
 * say so: the only shape the check accepted was an ungranted decision, which
 * would have meant inventing a decision to describe a thing that is not one.
 *
 * ADM-57 was the first case. It is granted, so G-091's decision is settled -
 * but its design cannot be fixed until Meta's current Embedded Signup
 * requirements are read, which is neither a business decision nor a coding
 * task. That is G-123, and G-122 waits on G-091 in the same way.
 *
 * A dependency only counts while it is open. Once it closes to class A the
 * excuse expires and the gap has to say ready, or say what else.
 */
const waitsOnOpenGap = (g) =>
  (g.dependsOn ?? []).some((id) => gapClass.has(id) && gapClass.get(id) !== 'A');

const unresolved = roadmap.gaps.filter((g) => {
  if (g.class === 'A' || g.ready === true) return false;
  if (waitsOnOpenGap(g)) return false;
  const named = g.adminDecisions ?? [];
  return named.length > 0 && named.every((id) => decisionStatus.get(id) === 'granted');
});

if (unresolved.length > 0) {
  for (const g of unresolved) {
    bad(
      `${g.id} is class ${g.class}, every decision it names (${(g.adminDecisions ?? []).join(', ')}) is granted, ` +
        'and it is not marked ready — so it is done, or ready to build, or waiting on something nobody raised. Say which',
    );
  }
} else {
  const ready = roadmap.gaps.filter((g) => g.class !== 'A' && g.ready === true).length;
  ok(`no gap is stranded between an answered decision and no plan (${ready} marked ready to build)`);
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

// ── 11. A merge approval is bookkeeping, and must not be cited as a rule ───
//
// G-124. The 2026-08-14 renumbering moved six open questions off ids that six
// granted merge approvals also held. It renumbered the register and not the
// eleven references to it living in migrations, services, tests and verify
// scripts — each of which then named a merge approval where it meant a
// question. §2 could not catch it: it compares the plan against roadmap.json
// and reads nothing else, and every id involved existed in both.
//
// The invariant is sharper than "renumbering must be complete", and it is what
// makes this checkable at all: **a decision that approves a merge is
// bookkeeping about a pull request.** It is not a rule about the product, so no
// migration, service, test or script has any reason to cite one. A product
// decision explains why the code is shaped as it is; "merge approval for PR
// #73" explains nothing to anybody reading code.
//
// So any bookkeeping id appearing outside the record is either a stale
// reference or a category error, and both are worth failing on.

const BOOKKEEPING = new Set(
  roadmap.adminDecisions
    .filter((d) => /^Merge approval for PR/i.test(d.title ?? ''))
    .map((d) => d.id),
);

// The record itself may name them — roadmap.json defines them and the plan's
// change log records the merges. This file may too: a checker is allowed to
// name the ids it exists to police. `_bundle.sql` is the frozen snapshot ADM-40
// kept unsupported, and rewriting history inside it is not cleanup.
const CITES_LEGITIMATELY = new Set([ROADMAP, PLAN, 'scripts/check-record.mjs', BUNDLE]);

const searchable = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) out.push(...searchable(full));
    else if (/\.(ts|tsx|mjs|js|sql|md)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const miscitations = [];
for (const file of ['src', 'app', 'tests', 'scripts', 'supabase', 'docs'].flatMap(searchable)) {
  if (CITES_LEGITIMATELY.has(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const id of line.match(/ADM-\d+/g) ?? []) {
      if (BOOKKEEPING.has(id)) miscitations.push(`${file}:${i + 1} cites ${id}`);
    }
  });
}

if (miscitations.length > 0) {
  for (const where of miscitations) {
    bad(`${where}, which is a merge approval — code cites product decisions, never bookkeeping`);
  }
} else {
  ok(`no merge approval is cited outside the record (${BOOKKEEPING.size} are bookkeeping)`);
}

// ── 12. Every named id exists ──────────────────────────────────────────────
//
// Narrow on purpose, and the narrowness is the point.
//
// `decision.blocks` and `gap.adminDecisions` look like inverses and are not.
// `blocks` names the gap a decision was *raised for*; `adminDecisions` names
// the decisions a gap *depends on*. ADM-13 was raised for G-026, and G-100
// depends on it — both true, neither derivable from the other. Checking them
// for symmetry was tried on 2026-08-14 and would have fired on 57 healthy
// rows, which is the failure §8 already warns about: a check that fires on the
// healthy case is a check people learn to skip.
//
// What is unambiguously wrong is a reference to something that does not exist.
// A gap naming a decision nobody raised, or a decision blocking a gap nobody
// recorded, is a typo or a deletion — never a difference of meaning. None
// exists today; this keeps it that way through the renumberings still to come,
// which is when dangling references get made.

const gapIds = new Set(roadmap.gaps.map((g) => g.id));
const admIds = new Set(roadmap.adminDecisions.map((d) => d.id));
const dangling = [];

for (const g of roadmap.gaps) {
  for (const id of g.adminDecisions ?? []) {
    if (!admIds.has(id)) dangling.push(`${g.id} names ${id}, which no decision record defines`);
  }
}
for (const d of roadmap.adminDecisions) {
  for (const id of d.blocks ?? []) {
    if (!gapIds.has(id)) dangling.push(`${d.id} blocks ${id}, which no gap record defines`);
  }
}

if (dangling.length > 0) dangling.forEach(bad);
else ok(`every id a gap or decision names exists (${gapIds.size} gaps, ${admIds.size} decisions)`);

// ── 13. The dependency graph is acyclic ────────────────────────────────────
//
// G-127. Traversing `dependsOn` across all 115 gaps on 2026-08-14 returned
// exactly one cycle: G-017 → G-026 → G-017. Both gaps were closed, so nothing
// was blocked and no ordering was affected — which is exactly why it survived
// long enough to be found by a graph traversal rather than by anybody reading.
//
// §12 checks that every named id *exists*. It cannot see a cycle, because both
// ends of one always exist. A cycle is a different defect: the data stops being
// a graph anybody can order, and the first tool to topologically sort it hangs
// rather than fails.
//
// Closed gaps are still traversed. A cycle between two closed gaps is dormant,
// not absent — reopening either one wakes it.

const edges = new Map(roadmap.gaps.map((g) => [g.id, (g.dependsOn ?? []).filter((id) => gapIds.has(id))]));
const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map([...edges.keys()].map((id) => [id, WHITE]));
const found = [];

const visit = (node, path) => {
  colour.set(node, GREY);
  path.push(node);
  for (const next of edges.get(node) ?? []) {
    if (colour.get(next) === GREY) found.push([...path.slice(path.indexOf(next)), next]);
    else if (colour.get(next) === WHITE) visit(next, path);
  }
  path.pop();
  colour.set(node, BLACK);
};

for (const id of edges.keys()) if (colour.get(id) === WHITE) visit(id, []);

if (found.length > 0) {
  for (const cycle of found) {
    bad(`dependency cycle: ${cycle.join(' → ')} — the graph cannot be ordered, and a tool that tries will not terminate`);
  }
} else {
  ok(`the dependency graph is acyclic (${edges.size} gaps traversed)`);
}

// ── 14. An enabled agent has a definition ──────────────────────────────────
//
// G-125, decisions ADM-82 and ADM-83. The rule that binds `ai.agents` to
// `src/modules/agents/registry.ts`: **an enabled row whose key has no
// definition cannot run, and the build fails.**
//
// This is the check that would have caught the original defect. `seed.sql`
// registered three enabled agents while the job runner reached one by a
// hard-coded key, and nothing anywhere compared the two — so an Admin reading
// the registry saw three working agents and had one, for as long as anybody
// cared to look.
//
// Read from the INSTALLER rather than from a live database, because the
// installer is what every environment starts from and is the thing a reviewer
// can see in a diff.
//
// That installer used to be `supabase/seed.sql`, and reading it was how this
// check came to pass against a state production did not share: seed.sql runs
// under `supabase db reset` and nowhere else, so the rows it registers reached
// CI and never reached production. The roster now lives in a migration
// (20260821150000) for that reason, and this check follows it there.

// EVERY migration that installs agent reference data, not one named file.
// The first version matched a single filename, and the moment layer 1 gained
// its remaining two agents in a second migration it reported them as installed
// by nothing — a check that is right about the world only while the world has
// one file in it.
const AGENT_INSTALLERS = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => `supabase/migrations/${f}`)
  .filter((f) => {
    const sql = readFileSync(f, 'utf8');
    // A migration that CHANGES agent reference data is an installer too. The
    // first version matched only inserts, so the migration that enabled
    // `support` — which installs nothing and updates one row — was outside the
    // set entirely, and §14 counted one enabled agent while the database had
    // two. Same shape as the single-filename version this replaced.
    return (
      /insert into ai\.(agents|agent_handoff_targets|agent_verifiers)/.test(sql) ||
      /update ai\.agents/.test(sql)
    );
  });

const AGENT_INSTALLER = AGENT_INSTALLERS[0];
const seed = AGENT_INSTALLERS.map((f) => readFileSync(f, 'utf8')).join('\n');
const registry = readFileSync('src/modules/agents/registry.ts', 'utf8');

const seededAgents = [
  ...seed.matchAll(/\(\s*'([a-z][a-z0-9_]{2,48})',\s*'[^']*',\s*'[^']*(?:''[^']*)*',\s*'(L[012])',\s*(true|false)/g),
].map((m) => ({ key: m[1], autonomy: m[2], enabled: m[3] === 'true' }));

const defined = new Set([...registry.matchAll(/^\s*key:\s*'([a-z][a-z0-9_]{2,48})'/gm)].map((m) => m[1]));

if (AGENT_INSTALLERS.length === 0) {
  bad('no migration installs ai.agents — §14 cannot verify a roster it cannot find');
} else if (seededAgents.length === 0) {
  bad(`no agents were found across ${AGENT_INSTALLERS.length} installer migration(s) — the parser drifted, and a check that finds nothing passes for the wrong reason`);
} else {
  // The effective state, not the INSERT tuple. An agent is installed disabled
  // by the roster migration and turned on by a later `update ai.agents set
  // enabled = true` — which is the order ADM-83 asks for, and which this
  // filter could not see. The COUNT below already learned that (its comment
  // says so in as many words); this check, three lines away, did not. So §14
  // reported "definitions and installed rows agree in both directions" while
  // `lead_qualifier` — an agent G-125's closure condition 11 says must never
  // be enabled — was on. The live `verify-agent-definitions` caught it, which
  // is the only reason it was not shipped.
  const enabledInAMigration = new Set([
    ...seededAgents.filter((a) => a.enabled).map((a) => a.key),
    ...[...seed.matchAll(/update ai\.agents\s*\n\s*set enabled = true,[\s\S]{0,300}?where key = '([a-z_]+)'/g)].map(
      (m) => m[1],
    ),
  ]);
  const stranded = [...enabledInAMigration].filter((k) => !defined.has(k)).map((k) => ({ key: k }));
  if (stranded.length > 0) {
    for (const a of stranded) {
      bad(
        `agent "${a.key}" is enabled in a migration and has no definition in src/modules/agents/registry.ts — ` +
          'an enabled agent with no architectural definition cannot run, and an Admin reading the registry would believe it does',
      );
    }
  }

  // The converse, and the half that was missing. §14 asked whether every
  // enabled ROW has a definition and never whether every DEFINITION has a row —
  // so `quality_assurance` could be defined in the registry, relied on by the
  // verification contract, and absent from the database, which is exactly what
  // production turned out to be. A definition with no row is an agent that
  // `verdictFor` refuses as undefined the moment anything calls it.
  const installed = new Set(seededAgents.map((a) => a.key));
  const unregistered = [...defined].filter((k) => !installed.has(k));
  if (unregistered.length > 0) {
    for (const k of unregistered) {
      bad(
        `agent "${k}" is defined in src/modules/agents/registry.ts and installed by no migration — ` +
          'the definition and the deployment are the two halves ADM-83 requires, and a definition alone cannot be reached from the database',
      );
    }
  }

  // ADM-82 gives verification authority to QA and withholds it from everyone
  // else BY NAME: "THE ORCHESTRATOR MUST NOT judge completion, act as QA,
  // override QA, or certify delivery." `verdictFor` checks that the DECLARED
  // verifier is the one speaking — which a definition writing
  // `verifiedBy: 'orchestrator'` would satisfy while breaking the rule. So the
  // declaration itself is checked here, where it is written.
  const mayVerify = new Set(
    [...registry.matchAll(/key:\s*'([a-z][a-z0-9_]{2,48})'[\s\S]*?mayVerify:\s*(true|false)/g)]
      .filter((m) => m[2] === 'true')
      .map((m) => m[1]),
  );
  const declared = [
    ...registry.matchAll(/key:\s*'([a-z][a-z0-9_]{2,48})'[\s\S]*?verifiedBy:\s*(?:'([a-z][a-z0-9_]{2,48})'|null)/g),
  ]
    .filter((m) => m[2])
    .map((m) => ({ producer: m[1], verifier: m[2] }));

  const illegitimate = declared.filter((d) => !mayVerify.has(d.verifier));
  for (const d of illegitimate) {
    bad(
      `${d.producer} declares "${d.verifier}" as its verifier, and ${d.verifier} does not carry mayVerify — ` +
        "ADM-82 gives verification authority to QA alone, and being named does not confer it",
    );
  }
  if (illegitimate.length === 0 && declared.length > 0) {
    ok(
      `every declared verifier is entitled to verify (${declared.length} producers, ` +
        `${mayVerify.size} agent${mayVerify.size === 1 ? '' : 's'} may verify)`,
    );
  }

  // Both halves of ADM-82's distinction, derived. `aiAgentsRegistered` used to
  // be one hand-maintained number here saying `1`, and it survived the roster
  // growing from one agent to thirteen because nothing read it and nothing
  // derived it. One number also could not express the distinction the whole
  // grant rests on: thirteen agents EXIST and one is ALLOWED TO RUN. A single
  // count has to pick one of those and be wrong about the other.
  const facts = JSON.parse(readFileSync('docs/roadmap/roadmap.json', 'utf8')).baseline ?? {};
  // Installed enabled, PLUS enabled later by an UPDATE.
  //
  // A migration may turn an agent on once it has something to do — `support`
  // was installed disabled and enabled by the change that gave it a workflow,
  // which is the order ADM-83 asks for. Counting only the INSERT form read
  // that as one enabled agent while the database had two, and a derived
  // number that undercounts is worse than one nobody derives: it looks
  // checked.
  // The same set `stranded` is derived from, so the number and the check
  // cannot disagree about which agents are on — which is exactly how they
  // came to disagree.
  const enabledCount = enabledInAMigration.size;
  for (const [field, actual, what] of [
    ['aiAgentsDefined', defined.size, 'defined in src/modules/agents/registry.ts'],
    ['aiAgentsEnabled', enabledCount, 'enabled in a migration'],
  ]) {
    if (facts[field] !== actual) {
      bad(`${field}: docs/roadmap/roadmap.json says ${facts[field]}, ${actual} are ${what}`);
    }
  }

  if (stranded.length === 0 && unregistered.length === 0) {
    // The same widened count the field above is checked against, so the two
    // lines cannot disagree about how many agents are on.
    const on = enabledCount;
    ok(
      `definitions and installed rows agree in both directions (${on} enabled of ${seededAgents.length} installed, ${defined.size} defined)`,
    );
  }

  // A disabled agent explains itself. The database constraint says the same
  // thing; this catches a seed that would fail to apply before it is applied.
  //
  // Checks the *column*, not the wording. A first draft matched the two
  // reasons that happened to exist — so any third agent disabled with new
  // wording failed a check that was really asserting "your reason is one of
  // the two I have seen". `disabled_reason` is last in the insert, so the
  // tuple ends with a quoted string when a reason is present and with `null`
  // when it is not.
  for (const a of seededAgents.filter((x) => !x.enabled)) {
    const start = seed.indexOf(`('${a.key}'`);
    const end = seed.indexOf('),', start);
    const tuple = end > start ? seed.slice(start, end) : seed.slice(start, start + 1200);
    if (/,\s*null\s*$/.test(tuple.trimEnd())) {
      bad(`agent "${a.key}" is disabled in the seed with no recorded reason — ADM-83 requires one, and the constraint will refuse the insert`);
    }
  }
}

// No agent may be *described* as pricing. ADM-22 and business rules 08 §5.1
// forbid an agent inventing a price at any level and state that approval does
// not make it permissible — so "requires owner approval" beside "pricing" is
// not a mitigation, it is the forbidden thing with a queue in front. This is
// G-125's condition 10, and it was live in the seed until this change.
//
// Scoped to the fields that *describe an agent* — seeded `description` values
// and registry `purpose` values — and not to prose. The first draft matched any
// line containing "price" and flagged this file's own quotation of the rule it
// enforces. A check that fires on the documentation of a prohibition is one
// people learn to skip, which is worse than not having it.

const describesPricing = (text) =>
  /\b(pric(e|ing)|discount|quote)\b/i.test(text) && !/never|not an agent|forbid|human/i.test(text);

const agentDescriptions = [
  ...[...seed.matchAll(/\(\s*'[a-z][a-z0-9_]{2,48}',\s*'[^']*',\s*'((?:[^']|'')*)'/g)].map((m) => [
    m[1].replace(/''/g, "'"),
    AGENT_INSTALLER,
  ]),
  ...[...registry.matchAll(/purpose:\s*\n?\s*'((?:[^']|\\')*)'/g)].map((m) => [m[1], 'src/modules/agents/registry.ts']),
];

const pricing = agentDescriptions.filter(([text]) => describesPricing(text));
if (pricing.length > 0) {
  for (const [text, where] of pricing) {
    bad(`${where}: an agent is described as pricing — ADM-22 forbids it at any level: "${text.slice(0, 80)}…"`);
  }
} else {
  ok(`no agent is described as pricing (${agentDescriptions.length} descriptions checked)`);
}

// ── 15. Every bound tool is implemented ────────────────────────────────────
//
// G-125 condition 5, decision ADM-83. The registry says which tools an agent
// may call; `tools.ts` says which tools exist. A definition naming a tool
// nothing implements is the same class of defect G-125 was raised for — a
// registry describing capability the runtime does not have — told one layer
// up.
//
// `resolveTool` already refuses it at runtime with an INTERNAL error, which is
// the right behaviour for a caller and the wrong place to *discover* it. This
// refuses it before deployment.

const tools = readFileSync('src/modules/agents/tools.ts', 'utf8');

// Tool names are camelCase — `crm.sendMessage`, not `crm.send_message`. A
// first draft matched only [a-z0-9_.] and so found nothing to check: it passed
// green while an agent was bound to a tool that did not exist. Proving it red
// is what caught it, which is the whole argument for proving it red.
const TOOL_NAME = "[a-z][A-Za-z0-9_.]*";

const implemented = new Set(
  [...tools.matchAll(new RegExp(`^\\s*name:\\s*'(${TOOL_NAME})'`, 'gm'))].map((m) => m[1]),
);
const bound = [...registry.matchAll(/tools:\s*\[([^\]]*)\]/g)].flatMap((m) =>
  [...m[1].matchAll(new RegExp(`'(${TOOL_NAME})'`, 'g'))].map((t) => t[1]),
);

const unimplemented = bound.filter((t) => !implemented.has(t));
if (unimplemented.length > 0) {
  for (const t of unimplemented) {
    bad(`an agent is bound to tool "${t}", which src/modules/agents/tools.ts does not implement`);
  }
} else {
  ok(`every bound tool is implemented (${bound.length} bindings over ${implemented.size} tools)`);
}

// ── 16. The handoff mirror matches the registry ────────────────────────────
//
// G-125 condition 6, decision ADM-83. `ai.agent_handoff_targets` exists because
// Postgres cannot read TypeScript, and the rule it enforces — the receiver must
// be a declared target in the *sender's* definition — has to hold in the
// database rather than only in the application.
//
// **A mirror nobody checks is worse than no mirror**, because it looks
// authoritative while drifting. This is the load-bearing half: the definitions
// are the source, the table is the copy, and they must say the same thing.
//
// One pair on each side: `requirement_collector` declares `quality_assurance`
// as its only target, and the migration installs exactly that. The check fails
// the moment one side gains or loses a pair the other does not.

const handoffMigration = readdirSync('supabase/migrations')
  .filter((f) => f.includes('a_handoff_goes_where_it_is_allowed'))
  .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
  .join('\n');

if (!handoffMigration) {
  bad('the handoff migration is missing — §16 cannot verify a mirror it cannot find');
} else {
  const declared = [...registry.matchAll(/handoffTargets:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(new RegExp(`'(${TOOL_NAME})'`, 'g'))].map((t) => t[1]),
  );
  // Read from the migration that installs the roster. This used to read the
  // seed, justified as "the pairs reference ai.agents(key) and migrations run
  // first, so they cannot be inserted there" — true only of a migration
  // written before the agents exist. Inside one migration the order is ours,
  // and the cost of the mistaken reading was that production held neither the
  // agents nor the pairs while this check reported a matching mirror.
  const mirrored = [
    ...seed.matchAll(/insert into ai\.agent_handoff_targets[\s\S]*?;/g),
  ].flatMap((block) => [...block[0].matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((p) => `${p[1]}→${p[2]}`));

  if (declared.length === 0 && mirrored.length === 0) {
    ok('the handoff mirror matches the registry (both empty — no agent declares a target yet)');
  } else if (declared.length !== mirrored.length) {
    bad(
      `the handoff mirror and the registry disagree: ${declared.length} targets declared in ` +
        `src/modules/agents/registry.ts, ${mirrored.length} seeded into ai.agent_handoff_targets`,
    );
  } else {
    ok(`the handoff mirror matches the registry (${mirrored.length} pairs)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §17. An open gap may not quote code that no longer exists
// ═══════════════════════════════════════════════════════════════════════════
//
// G-110 described its remaining work by quoting the line it wanted changed:
// `announcementFor() ends with "Reply quoting <reference>."`. That line was
// changed by PR #112 and the gap's record was never updated, so for two weeks
// the record sent a reader to redo finished work — and, worse, misstated *why*
// the gap was open, implying two blockers when only external verification
// remained.
//
// Nothing here derives from a number, so no existing section could catch it.
// This one is narrow on purpose: when an open gap quotes a literal in double
// quotes inside a REMAINING clause, that literal is a claim about the current
// repository, and a claim about the repository can be checked against it.
//
// Short and punctuation-only quotes are skipped — they are prose, not code,
// and matching them would make this fire on ordinary writing.

{
  // Comments are stripped, and that is the load-bearing part rather than
  // tidiness. The wording this section exists to catch survives in two comments
  // that explain its *removal* — `schema.ts` and the announcement test both
  // quote the old line to say why it is gone. Searching raw text would find
  // those and report the record accurate, which is the check passing for the
  // exact reason it should fail. A claim about code is checked against code.
  //
  // This file is excluded for the same reason one directory up: the paragraph
  // above quotes G-110's wording, and a check that reads its own documentation
  // is asserting that it wrote itself.
  const stripComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1')
      .replace(/(^|\s)--[^\n]*/g, '$1');

  const repo = [
    'src', 'tests', 'scripts', 'supabase/migrations', 'supabase/seed.sql',
  ].flatMap((entry) => {
    const walk = (path) => {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        return [];
      }
      if (!stat.isDirectory()) {
        if (path.endsWith('check-record.mjs')) return [];
        return [stripComments(readFileSync(path, 'utf8'))];
      }
      return readdirSync(path).flatMap((child) => walk(`${path}/${child}`));
    };
    return walk(entry);
  }).join('\n');

  const stale = [];
  for (const gap of roadmap.gaps) {
    if (gap.status.startsWith('CLOSED')) continue;

    const text = `${gap.implementationState ?? ''} ${gap.status ?? ''}`;
    const remaining = text.match(/REMAINING:([\s\S]*)/);
    if (!remaining) continue;

    for (const [, quoted] of remaining[1].matchAll(/"([^"]{8,})"/g)) {
      // A quotation the repository no longer contains is a statement about
      // code that is gone.
      if (!repo.includes(quoted)) stale.push(`${gap.id} quotes "${quoted}"`);
    }
  }

  if (stale.length > 0) {
    for (const s of stale) {
      bad(`${s}, which appears nowhere in the repository — the work may already be done`);
    }
  } else {
    ok('no open gap quotes code that no longer exists');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// §18. A verification nobody runs
// ═══════════════════════════════════════════════════════════════════════════
//
// `db:verify:journey` walks one lead from an inbound WhatsApp message all the
// way to handover and asserts at every seam that the identity the message
// established is still the identity being handed over. It is the only script
// that proves the joints CONNECT rather than proving one joint in isolation,
// and it was in `package.json` and in no workflow. For as long as that was
// true it could have broken in any of the fifty-odd changes since it was
// written and nothing would have said so.
//
// It had not broken. That is luck, not evidence — a verification nobody runs
// is a verification that has already stopped being true; it just has not been
// asked yet. Found while wiring ADM-82's layers 2 and 3, the first change big
// enough to plausibly have broken it.
//
// Checked against `package.json` rather than against a list, because a list
// here would need adding to by the same person who forgot the workflow.

{
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const workflows = readdirSync('.github/workflows')
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(`.github/workflows/${f}`, 'utf8'))
    .join('\n');

  const verifiers = Object.keys(pkg.scripts ?? {}).filter((k) => k.startsWith('db:verify'));
  // Word-boundary at the end, so `db:verify:proposal` is not counted as run by
  // a workflow that only mentions `db:verify:proposals`. A prefix match here
  // would report coverage that does not exist, which is this section's own
  // failure mode.
  const unrun = verifiers.filter((k) => !new RegExp(`${k.replace(/[:.]/g, '\\$&')}(?![\\w:-])`).test(workflows));

  if (verifiers.length === 0) {
    bad('no db:verify script was found in package.json — §18 cannot check coverage it cannot find');
  } else if (unrun.length > 0) {
    for (const k of unrun) {
      bad(
        `npm run ${k} is defined and no workflow runs it — a verification nobody runs has ` +
          'already stopped being true, it just has not been asked yet',
      );
    }
  } else {
    ok(`every live verification runs in CI (${verifiers.length} scripts)`);
  }
}


// ── 17. an open gap says why it is still open (G-101) ──────────────────────
//
// The change log declares a gap closed and the gap table keeps it OPEN, and
// both readings are defensible: a change can close the code half of a gap
// whose other half waits on somebody outside the repository. Three do exactly
// that today, and each says so — *"EXTERNAL VERIFICATION REQUIRED"*,
// *"provider capability UNVERIFIED"*, *"the list is empty"*. A reader can tell
// what is left.
//
// G-101 could not be read that way. It said  and nothing else, while the
// change log for PR #282 said it closed — and its own stated reason, *"there
// is no L2 agent, and the only agent registered is L1"*, had been false since
// the designer ran. An operator reading the gap table was told the platform
// could not do something it had been doing for a day.
//
// This is the same staleness §14 was extended for and the same one PR #262
// recorded about G-137: a claim about the WORLD, which the derived numbers
// cannot see. It is checkable in one narrow case, which is this one — the
// record contradicting itself. A gap the change log says closed must either be
// closed, or say why it is not.
{
  const changeLog = plan.slice(plan.indexOf('## 10. Change log'));
  const claimed = new Set();
  for (const m of changeLog.matchAll(/\*\*(G-\d+)[^*]{0,80}?clos/g)) claimed.add(m[1]);
  for (const m of changeLog.matchAll(/(G-\d+)\s+clos(?:es|ed)/g)) claimed.add(m[1]);

  const contradictory = roadmap.gaps.filter(
    (g) => claimed.has(g.id) && /^OPEN\s*$/i.test(String(g.status ?? '')),
  );

  if (contradictory.length > 0) {
    for (const g of contradictory) {
      bad(
        `${g.id} is marked OPEN with no reason, and the change log says it closed — ` +
          'one of the two is stale, and a reader cannot tell which',
      );
    }
  } else {
    ok(`every gap the change log closes is closed or says why not (${claimed.size} claimed)`);
  }
}


// ── 18. a readiness blocker does not cite a gap that closed (G-101's class) ─
//
// `docs/deployment/production-readiness.md` is the single authoritative answer
// to "is AgencyOS production ready?", and its own rule is that a row is ticked
// only with evidence named in-line. Nothing checked the other direction: a row
// marked 🔴 stays 🔴 until somebody re-reads it, and a blocker that has since
// been cleared reads exactly like one that has not.
//
// Five rows were wrong on 2026-08-22, all in that direction. C9 said agents
// were not activated while eight ran on production; B3, B4, B5 and B6 each
// cited G-136, G-137, G-138 and G-139, all four of which had closed. The
// document had been stamped five days and forty-one migrations earlier.
//
// Same class as §17 and as PR #262's note about G-137 — a claim about the
// world, which the derived numbers cannot see — and checkable in the one case
// where the record contradicts itself: a blocker naming a gap this repository
// calls closed.
{
  const readiness = readFileSync('docs/deployment/production-readiness.md', 'utf8');
  const closed = new Set(
    roadmap.gaps.filter((g) => String(g.status ?? '').toUpperCase().startsWith('CLOSED')).map((g) => g.id),
  );

  const contradictions = [];
  for (const line of readiness.split('\n')) {
    if (!line.startsWith('|') || !line.includes('🔴')) continue;
    // Struck-through ids are the corrected form: the row records what it used
    // to wait for and no longer does.
    const live = line.replace(/~~[^~]*~~/g, '');
    for (const m of live.matchAll(/\b(G-\d+)\b/g)) {
      if (closed.has(m[1])) contradictions.push(`${m[1]} in "${line.slice(2, 40).trim()}"`);
    }
  }

  if (contradictions.length > 0) {
    for (const c of contradictions) {
      bad(
        `production-readiness.md marks a row blocked on ${c}, which the record calls closed — ` +
          'one of the two is stale, and an owner reading the gate cannot tell which',
      );
    }
  } else {
    ok(`no readiness blocker cites a closed gap (${closed.size} closed)`);
  }
}


// ───────────────────────────────────────────────────────────────────────────
// §19. A number nobody derived
//
// `baseline.eventSubscriptions` said 14 while `src/lib/events/catalog.ts`
// declared 15, and nothing anywhere would have said so. It is the same shape
// §14's comment describes about `aiAgentsRegistered`: *"one hand-maintained
// number here saying 1, and it survived the roster growing from one agent to
// thirteen because nothing read it and nothing derived it."*
//
// The event catalog is the one place a subscription can be declared, so the
// count is a `grep` rather than a memory. Derived from the HANDLERS list, which
// is what `HANDLER_JOB_KIND` and `SUBSCRIPTIONS` are both keyed by — a handler
// that exists and is subscribed to nothing is already refused by the type.
{
  const catalog = readFileSync('src/lib/events/catalog.ts', 'utf8');
  const block = catalog.slice(catalog.indexOf('export const HANDLERS'));
  const declared = [...block.slice(0, block.indexOf('] as const')).matchAll(/'[a-z_]+:[A-Za-z]+'/g)].length;

  if (declared === 0) {
    bad('no handlers were found in src/lib/events/catalog.ts — §19 cannot count what it cannot find');
  } else if (roadmap.baseline.eventSubscriptions !== declared) {
    bad(
      `event subscriptions: docs/roadmap/roadmap.json says ${roadmap.baseline.eventSubscriptions}, ` +
        `src/lib/events/catalog.ts declares ${declared}`,
    );
  } else {
    ok(`event subscriptions: ${declared}`);
  }
}


if (failures === 0) {
  console.log('\n\x1b[32m✔ The record matches the repository\x1b[0m\n');
  process.exit(0);
}

console.error(`\n\x1b[31m✖ ${failures} disagreement(s) between the record and the repository\x1b[0m`);
console.error('  Fix the document, not this check — the numbers here are all derived.\n');
process.exit(1);
