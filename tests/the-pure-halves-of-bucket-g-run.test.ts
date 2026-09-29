import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyReactivationCohortFilter,
  daysQuiet,
  DEFAULT_REACTIVATION_INACTIVE_DAYS,
  isReactivationCohortFilter,
  quietCutoff,
  selectReactivationCohort,
  type ReactivationCohortRow,
} from '../src/modules/crm/reactivation-types.ts';
import { lastSeverityChange, resolutionWithoutSeverityLines, severityChanges } from '../src/modules/qa/defect-severity-trail.ts';
import { IMPORT_LIMITS, parseCsv, parseTestCaseImport } from '../src/modules/qa/test-case-import.ts';

/**
 * The pure halves of bucket G, RUN rather than pinned.
 *
 * Streams G-1 and G-2 put every decision that needs no database into a
 * pure function — the test-case import parser, the reactivation cohort's
 * membership rule, the severity trail read back from a defect's resolution.
 * Their own guard tests pin the doors and the screens (the file is the
 * behaviour for a migration); this file drives the functions with inputs
 * and looks at what came out, so the rules cannot drift behind a regex
 * that still matches.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-30T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

describe('A. the CSV reader is RFC 4180, not split(",")', () => {
  test('a plain grid', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });

  test('a quoted field keeps its comma, its newline and its doubled quote', () => {
    const rows = parseCsv('a,b\n"x, y","line one\nline two"\n"she said ""hi""",z\n');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], ['x, y', 'line one\nline two']);
    assert.deepEqual(rows[2], ['she said "hi"', 'z']);
  });

  test('CRLF and LF both end a record, and a trailing newline adds no record', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
    assert.equal(parseCsv('a,b\n1,2\n\n').length, 2);
  });

  test('an empty field is an empty string, and a record of only empty fields is no record', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3\n'), [['a', 'b', 'c'], ['1', '', '3']]);
    assert.deepEqual(parseCsv('a,b\n,\n'), [['a', 'b']]);
  });

  test('a byte-order mark is not part of the first header', () => {
    assert.deepEqual(parseCsv('﻿a,b\n1,2\n')[0], ['a', 'b']);
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(parseCsv(''), []);
  });
});

describe('B. the import parser names every problem by its data row', () => {
  test('a header alias resolves to the canonical column, whatever its case or spacing', () => {
    const out = parseTestCaseImport('Requirement,Test Type,Test Case,Expected Outcome,Critical\nCheckout,api,Moves money,Paid,yes\n');
    assert.equal(out.format, 'csv');
    assert.deepEqual(out.issues, []);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.requirement, 'Checkout');
    assert.equal(out.rows[0]!.category, 'api');
    assert.equal(out.rows[0]!.reason, 'Moves money');
    assert.equal(out.rows[0]!.expectedResult, 'Paid');
    assert.equal(out.rows[0]!.criticalPath, true);
  });

  test('critical accepts yes/true/1 and refuses nothing else silently', () => {
    const out = parseTestCaseImport('requirement,category,reason,critical\nA,api,r1,true\nA,ui,r2,1\nA,e2e,r3,no\nA,security,r4,\n');
    assert.deepEqual(
      out.rows.map((r) => r.criticalPath),
      [true, true, false, false],
    );
  });

  test('the row number is the data row, header not counted, and the good rows still parse', () => {
    const out = parseTestCaseImport('requirement,category,reason\nCheckout,functional,ok\n,functional,no requirement\nCheckout,fuzz,bad category\nCheckout,api,\n');
    assert.deepEqual(
      out.issues.map((i) => i.row),
      [2, 3, 4],
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.reason, 'ok');
  });

  test('a JSON array and a {cases:[…]} envelope read the same', () => {
    const a = parseTestCaseImport('[{"requirement":"Checkout","category":"api","reason":"r","steps":"1. go"}]');
    const b = parseTestCaseImport('{"cases":[{"requirement":"Checkout","category":"api","reason":"r","steps":"1. go"}]}');
    assert.equal(a.format, 'json');
    assert.equal(b.format, 'json');
    assert.deepEqual(a.rows, b.rows);
    assert.equal(a.rows[0]!.steps, '1. go');
  });

  test('a JSON item that is not an object refuses the whole input, naming the item', () => {
    const out = parseTestCaseImport('[{"requirement":"A","category":"api","reason":"r"},1]');
    assert.deepEqual(out.rows, []);
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.row, 0);
    assert.match(out.issues[0]!.message, /item 2/);
  });

  test('malformed JSON is one whole-input issue, not a crash', () => {
    const out = parseTestCaseImport('[{"requirement": "A",');
    assert.equal(out.format, 'json');
    assert.deepEqual(out.rows, []);
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.row, 0);
  });

  test('empty input says so', () => {
    const out = parseTestCaseImport('   \n  ');
    assert.equal(out.format, 'empty');
    assert.deepEqual(out.rows, []);
    assert.equal(out.issues[0]!.row, 0);
  });

  test('a duplicate requirement+category inside the batch is named on its second appearance, citing the first', () => {
    const out = parseTestCaseImport('requirement,category,reason\nCheckout,api,first\nCheckout,api,second\nCheckout,ui,fine\n');
    // The rows are all returned — the preview shows the batch as written and
    // the issue beside it; the door refuses the batch until it is fixed.
    assert.equal(out.rows.length, 3);
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.row, 2);
    assert.match(out.issues[0]!.message, /duplicates row 1/);
  });

  test('a reason longer than the limit is refused, one shorter is kept whole', () => {
    const long = 'x'.repeat(IMPORT_LIMITS.reason + 1);
    const fine = 'y'.repeat(IMPORT_LIMITS.reason);
    const out = parseTestCaseImport(`requirement,category,reason\nA,api,${long}\nA,ui,${fine}\n`);
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.row, 1);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]!.reason.length, IMPORT_LIMITS.reason);
  });

  test('more rows than the limit is refused as a whole, before any row is judged', () => {
    const lines = Array.from({ length: IMPORT_LIMITS.rows + 1 }, (_, i) => `R${i},api,r${i}`).join('\n');
    const out = parseTestCaseImport(`requirement,category,reason\n${lines}\n`);
    assert.deepEqual(out.rows, []);
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.row, 0);
  });

  test('a task id column travels with the row, whitespace trimmed', () => {
    const out = parseTestCaseImport('requirement,category,reason,linked task\nA,api,r,  11111111-1111-4111-8111-111111111111  \n');
    assert.equal(out.rows[0]!.task, '11111111-1111-4111-8111-111111111111');
  });
});

describe('C. the reactivation cohort is a rule over dates, consent and open sequences', () => {
  const candidate = (lead_id: string, lastActive: string) => ({ lead_id, tier_name: 'warm', last_active_at: lastActive, phone: null });

  test('the cutoff is N whole days before now, and a negative N is treated as zero', () => {
    assert.equal(quietCutoff(NOW, 30).getTime(), NOW.getTime() - 30 * DAY);
    assert.equal(quietCutoff(NOW, 0).getTime(), NOW.getTime());
    assert.equal(quietCutoff(NOW, -5).getTime(), NOW.getTime());
  });

  test('days quiet is a whole number of days, never negative, and zero for a date that cannot be read', () => {
    assert.equal(daysQuiet(daysAgo(31), NOW), 31);
    assert.equal(daysQuiet(new Date(NOW.getTime() - 1.9 * DAY).toISOString(), NOW), 1);
    assert.equal(daysQuiet(new Date(NOW.getTime() + DAY).toISOString(), NOW), 0);
    assert.equal(daysQuiet('not a date', NOW), 0);
  });

  test('quiet for at least N days and no open sequence → in; anything else → out', () => {
    const rows = [
      candidate('quiet-45', daysAgo(45)),
      candidate('quiet-30-exactly', daysAgo(30)),
      candidate('active-29', daysAgo(29)),
      candidate('quiet-but-open', daysAgo(60)),
      candidate('unreadable-date', 'yesterday-ish'),
    ];
    const cohort = selectReactivationCohort(rows, new Set(['quiet-but-open']), NOW);
    assert.deepEqual(
      cohort.map((c) => c.lead_id),
      ['quiet-45', 'quiet-30-exactly'],
    );
  });

  test('the default threshold is the constant the screen states', () => {
    assert.equal(DEFAULT_REACTIVATION_INACTIVE_DAYS, 30);
    const rows = [candidate('a', daysAgo(30)), candidate('b', daysAgo(29))];
    assert.deepEqual(selectReactivationCohort(rows, new Set(), NOW).map((c) => c.lead_id), ['a']);
    assert.deepEqual(selectReactivationCohort(rows, new Set(), NOW, 7).map((c) => c.lead_id), ['a', 'b']);
    assert.deepEqual(selectReactivationCohort(rows, new Set(), NOW, 31).map((c) => c.lead_id), []);
  });

  test('the selector never mutates its input and keeps the candidate order', () => {
    const rows = [candidate('z', daysAgo(90)), candidate('a', daysAgo(40))];
    const before = JSON.stringify(rows);
    const out = selectReactivationCohort(rows, new Set(), NOW);
    assert.equal(JSON.stringify(rows), before);
    assert.deepEqual(out.map((c) => c.lead_id), ['z', 'a']);
  });

  const row = (over: Partial<ReactivationCohortRow>): ReactivationCohortRow => ({
    leadId: 'l',
    title: 't',
    status: 'new',
    tierName: 'warm',
    lastActiveAt: daysAgo(40),
    quietDays: 40,
    inPilot: false,
    assignedTo: null,
    phone: null,
    source: 'manual',
    importBatchId: null,
    importSourceLabel: null,
    ...over,
  });

  test('the chips are predicates: imported, enrolled, not enrolled, all', () => {
    const rows = [
      row({ leadId: 'imported-enrolled', importBatchId: 'b1', inPilot: true }),
      row({ leadId: 'imported-only', importBatchId: 'b2' }),
      row({ leadId: 'enrolled-only', inPilot: true }),
      row({ leadId: 'neither' }),
    ];
    const ids = (f: Parameters<typeof applyReactivationCohortFilter>[1]) => applyReactivationCohortFilter(rows, f).map((r) => r.leadId);
    assert.deepEqual(ids('imported'), ['imported-enrolled', 'imported-only']);
    assert.deepEqual(ids('enrolled'), ['imported-enrolled', 'enrolled-only']);
    assert.deepEqual(ids('not_enrolled'), ['imported-only', 'neither']);
    assert.deepEqual(ids('all'), rows.map((r) => r.leadId));
    assert.notEqual(applyReactivationCohortFilter(rows, 'all'), rows);
  });

  test('a chip name from the URL is admitted only when it is one of the four', () => {
    assert.equal(isReactivationCohortFilter('imported'), true);
    assert.equal(isReactivationCohortFilter('not_enrolled'), true);
    assert.equal(isReactivationCohortFilter('everyone'), false);
    assert.equal(isReactivationCohortFilter(undefined), false);
    assert.equal(isReactivationCohortFilter(''), false);
  });
});

describe('D. the severity trail is read back from the resolution, newest last', () => {
  const trail = 'Fixed the cache key.\nSeverity major → minor: workaround exists\nRetested on build 3.\nSeverity minor → critical: it lost money';

  test('every severity line is a change, in order', () => {
    assert.deepEqual(severityChanges(trail), [
      { from: 'major', to: 'minor', reason: 'workaround exists' },
      { from: 'minor', to: 'critical', reason: 'it lost money' },
    ]);
  });

  test('the last change is the one the page shows beside the severity', () => {
    assert.deepEqual(lastSeverityChange(trail), { from: 'minor', to: 'critical', reason: 'it lost money' });
    assert.equal(lastSeverityChange('no changes here'), null);
    assert.equal(lastSeverityChange(null), null);
    assert.equal(lastSeverityChange(undefined), null);
  });

  test('what was said about the fix survives with the severity lines removed', () => {
    assert.equal(resolutionWithoutSeverityLines(trail), 'Fixed the cache key.\nRetested on build 3.');
    assert.equal(resolutionWithoutSeverityLines('Severity major → minor: only that'), null);
    assert.equal(resolutionWithoutSeverityLines(''), null);
    assert.equal(resolutionWithoutSeverityLines(null), null);
  });

  test('a line that merely mentions severity is not a change', () => {
    assert.deepEqual(severityChanges('Severity is debatable.\nseverity major → minor: lowercase is not the format'), []);
    assert.deepEqual(severityChanges('   Severity minor → major: indented still counts   '), [{ from: 'minor', to: 'major', reason: 'indented still counts' }]);
  });
});
