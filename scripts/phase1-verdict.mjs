#!/usr/bin/env node
/**
 * P1-DOD-117 ("the system can prove the Definition of Done is satisfied rather than describe it"): an aggregator that reads the Phase 1-3 traceability
 * matrix and prints a verdict computed from its rows, not written by hand.
 *
 *   node scripts/phase1-verdict.mjs            print the verdict and the per-section table (exit 0 whatever the verdict: it informs)
 *   node scripts/phase1-verdict.mjs --strict   exit 1 when the verdict is BLOCKED (for a release gate)
 *   node scripts/phase1-verdict.mjs --json     machine-readable
 *
 * Rules (DoD section 35): COMPLETE only when no row is MISSING or PARTIAL while still BUILDABLE. A PARTIAL or MISSING row whose evidence names
 * EXTERNAL(...) (owner decision, credentials, funded model) or whose status is MANUAL_EXTERNAL does not block, but it is listed: it is waiting on a
 * person, not on code. A row with an unrecognised status BLOCKS (an unreadable matrix is not a passing one).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROW = /^\|\s*(P[123]-[A-Z0-9]+-\d+[A-Za-z]?)\s*\|(.*)\|\s*$/;
const KNOWN = new Set(['EXISTS', 'PARTIAL', 'MISSING', 'MANUAL_EXTERNAL']);

export function parseMatrix(markdown) {
  const rows = [];
  let section = '(top)';
  for (const line of markdown.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const m = ROW.exec(line);
    if (!m) continue;
    const cells = m[2].split(/\s\|\s/).map((c) => c.trim());
    // ID | Source | Requirement | Status | Evidence  -> after the ID: source, requirement, status, evidence...
    const statusIndex = cells.findIndex((c) => KNOWN.has(c.replace(/\*/g, '')) || /^(EXISTS|PARTIAL|MISSING|MANUAL_EXTERNAL)\b/.test(c));
    const raw = statusIndex >= 0 ? cells[statusIndex].replace(/\*/g, '') : '';
    const status = (/^(EXISTS|PARTIAL|MISSING|MANUAL_EXTERNAL)\b/.exec(raw) ?? [])[1] ?? 'UNKNOWN';
    const evidence = statusIndex >= 0 ? cells.slice(statusIndex + 1).join(' | ') : '';
    rows.push({ id: m[1], section, status, evidence });
  }
  return rows;
}

export function classify(row) {
  if (row.status === 'EXISTS') return 'done';
  if (row.status === 'MANUAL_EXTERNAL') return 'waiting_on_a_person';
  if (row.status === 'PARTIAL' || row.status === 'MISSING') {
    const external = /EXTERNAL\(/.test(row.evidence);
    const buildable = /BUILDABLE/.test(row.evidence);
    if (external && !buildable) return 'waiting_on_a_person';
    if (buildable) return 'buildable_open';
    return 'open_unclassified'; // neither tag: nobody has said what it is waiting on
  }
  return 'unreadable';
}

export function verdict(rows) {
  const counts = { done: 0, waiting_on_a_person: 0, buildable_open: 0, open_unclassified: 0, unreadable: 0 };
  const bySection = new Map();
  for (const r of rows) {
    const c = classify(r);
    counts[c] += 1;
    const s = bySection.get(r.section) ?? { rows: 0, done: 0, waiting_on_a_person: 0, buildable_open: 0, open_unclassified: 0, unreadable: 0 };
    s.rows += 1;
    s[c] += 1;
    bySection.set(r.section, s);
  }
  const blocking = counts.buildable_open + counts.open_unclassified + counts.unreadable;
  return { verdict: rows.length > 0 && blocking === 0 ? 'COMPLETE' : 'BLOCKED', rows: rows.length, counts, blocking, bySection: Object.fromEntries(bySection) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = new URL('../docs/phase-1-3-implementation-traceability.md', import.meta.url);
  const result = verdict(parseMatrix(readFileSync(file, 'utf8')));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Phase 1-3 verdict: ${result.verdict} (${result.rows} rows; ${result.blocking} blocking)`);
    console.log(`  done ${result.counts.done}, waiting on a person ${result.counts.waiting_on_a_person}, buildable and open ${result.counts.buildable_open}, open and unclassified ${result.counts.open_unclassified}, unreadable ${result.counts.unreadable}`);
    for (const [name, s] of Object.entries(result.bySection)) console.log(`  ${name}: ${s.rows} rows, ${s.buildable_open + s.open_unclassified + s.unreadable} blocking`);
  }
  if (process.argv.includes('--strict') && result.verdict !== 'COMPLETE') process.exit(1);
}
