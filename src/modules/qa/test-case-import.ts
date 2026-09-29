import { TEST_CATEGORIES } from './schema';
import type { TestCaseImportIssue, TestCaseImportParse, TestCaseImportRow } from './test-case-import-types';

/**
 * SCR-045 — "Create/import test case": the parser behind the import.
 *
 * Pure. Takes the text somebody pasted or uploaded (CSV or JSON), answers
 * with the rows it understood and every row it did not, and writes nothing.
 * The door is `qa.import_test_cases` (20261001160000), which re-checks each
 * row against the plan's own baseline inside one transaction; this parser
 * is the preview step, so a person sees exactly what would be written and
 * exactly what is wrong before anything is.
 *
 * A row is what a planned case IS in this schema — a requirement (a scope
 * item of the plan's baseline, by id or exact title), a category, a reason
 * — plus the optional preconditions, steps, expected result, critical-path
 * flag and task. There is no free-text case title: a case that names no
 * agreed requirement cannot be planned for (Doc 14 §3), so `title` is read
 * as the reason, and `suite` as the category (the two share a vocabulary).
 */

/** Column aliases, matched after lower-casing and dropping non-alphanumerics. */
export const IMPORT_COLUMN_ALIASES: Record<keyof TestCaseImportRow, readonly string[]> = {
  requirement: ['requirement', 'requirementref', 'ref', 'scopeitem', 'scopeitemid', 'scopeitemtitle', 'item', 'feature', 'linkedrequirement'],
  category: ['category', 'suite', 'type', 'testtype'],
  reason: ['reason', 'title', 'name', 'case', 'testcase', 'why'],
  criticalPath: ['criticalpath', 'critical', 'priority'],
  preconditions: ['preconditions', 'precondition', 'given', 'setup'],
  steps: ['steps', 'step', 'when', 'procedure', 'howto'],
  expectedResult: ['expectedresult', 'expected', 'then', 'result', 'expectedoutcome'],
  task: ['task', 'taskid', 'linkedtask'],
};

export const IMPORT_LIMITS = {
  /** An upload or a paste larger than this is refused before parsing. */
  bytes: 200 * 1024,
  rows: 500,
  reason: 600,
  preconditions: 2000,
  steps: 4000,
  expectedResult: 2000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fieldFor(key: string): keyof TestCaseImportRow | null {
  const k = normaliseKey(key);
  for (const [field, aliases] of Object.entries(IMPORT_COLUMN_ALIASES) as [keyof TestCaseImportRow, readonly string[]][]) {
    if (aliases.includes(k)) return field;
  }
  return null;
}

function truthy(value: string): boolean {
  return ['true', 'yes', 'y', '1', 'critical', 'high', 'x'].includes(value.trim().toLowerCase());
}

/**
 * RFC 4180: fields separated by commas, a quoted field may hold commas,
 * newlines and doubled quotes. CRLF and LF both end a record. A trailing
 * empty line is not a record.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.startsWith('﻿') ? text.slice(1) : text;

  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/** One raw record (from either format) to a typed row, with its own issues. */
function toRow(raw: Record<string, unknown>, rowNumber: number, issues: TestCaseImportIssue[]): TestCaseImportRow | null {
  const picked: Partial<Record<keyof TestCaseImportRow, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fieldFor(key);
    if (!field || value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value : typeof value === 'boolean' || typeof value === 'number' ? String(value) : '';
    if (str.trim().length === 0) continue;
    picked[field] = str;
  }

  const before = issues.length;
  const requirement = (picked.requirement ?? '').trim();
  if (!requirement) issues.push({ row: rowNumber, message: 'requirement is missing (a scope item of the baseline, by id or exact title)' });

  const category = (picked.category ?? '').trim().toLowerCase();
  if (!category) issues.push({ row: rowNumber, message: 'category is missing' });
  else if (!(TEST_CATEGORIES as readonly string[]).includes(category)) {
    issues.push({ row: rowNumber, message: `category "${category}" is not one of ${TEST_CATEGORIES.join(', ')}` });
  }

  const reason = (picked.reason ?? '').trim();
  if (!reason) issues.push({ row: rowNumber, message: 'reason is missing (why this category applies; a title is read as the reason)' });
  else if (reason.length > IMPORT_LIMITS.reason) issues.push({ row: rowNumber, message: `reason is longer than ${IMPORT_LIMITS.reason} characters` });

  const optional = (field: 'preconditions' | 'steps' | 'expectedResult'): string | undefined => {
    const v = (picked[field] ?? '').trim();
    if (!v) return undefined;
    if (v.length > IMPORT_LIMITS[field]) issues.push({ row: rowNumber, message: `${field} is longer than ${IMPORT_LIMITS[field]} characters` });
    return v;
  };
  const preconditions = optional('preconditions');
  const steps = optional('steps');
  const expectedResult = optional('expectedResult');

  const task = (picked.task ?? '').trim();
  if (task && !UUID.test(task)) issues.push({ row: rowNumber, message: `task "${task}" is not a task id` });

  if (issues.length > before) return null;
  return {
    requirement,
    category,
    reason,
    criticalPath: picked.criticalPath ? truthy(picked.criticalPath) : false,
    ...(preconditions ? { preconditions } : {}),
    ...(steps ? { steps } : {}),
    ...(expectedResult ? { expectedResult } : {}),
    ...(task ? { task } : {}),
  };
}

function parseJsonRecords(text: string): Record<string, unknown>[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not valid JSON: ${e instanceof Error ? e.message : 'unknown error'}`;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : null;
  if (!list) return 'JSON must be an array of cases, or an object with a "cases" array';
  const records: Record<string, unknown>[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return `every case must be an object (item ${records.length + 1} is not)`;
    records.push(item as Record<string, unknown>);
  }
  return records;
}

/**
 * The whole parse: format detection (a leading `[` or `{` is JSON, anything
 * else is CSV with a header row), records to rows, every problem numbered
 * by its data row (1-based, the header not counted).
 */
export function parseTestCaseImport(text: string): TestCaseImportParse {
  const issues: TestCaseImportIssue[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return { format: 'empty', rows: [], issues: [{ row: 0, message: 'nothing to import' }] };

  let records: Record<string, unknown>[];
  let format: 'json' | 'csv';

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    format = 'json';
    const out = parseJsonRecords(trimmed);
    if (typeof out === 'string') return { format, rows: [], issues: [{ row: 0, message: out }] };
    records = out;
  } else {
    format = 'csv';
    const table = parseCsv(trimmed);
    const header = table[0];
    if (!header) return { format, rows: [], issues: [{ row: 0, message: 'nothing to import' }] };
    const fields = header.map((h) => fieldFor(h));
    const known = fields.filter((f): f is keyof TestCaseImportRow => f !== null);
    for (const required of ['requirement', 'category', 'reason'] as const) {
      if (!known.includes(required)) {
        issues.push({ row: 0, message: `the header has no "${required}" column (accepted: ${IMPORT_COLUMN_ALIASES[required].join(', ')})` });
      }
    }
    if (issues.length > 0) return { format, rows: [], issues };
    records = table.slice(1).map((cells) => {
      const record: Record<string, unknown> = {};
      fields.forEach((field, i) => {
        if (field && cells[i] !== undefined) record[field] = cells[i];
      });
      return record;
    });
  }

  if (records.length === 0) return { format, rows: [], issues: [{ row: 0, message: 'nothing to import' }] };
  if (records.length > IMPORT_LIMITS.rows) {
    return { format, rows: [], issues: [{ row: 0, message: `${records.length} rows is more than the ${IMPORT_LIMITS.rows} one import takes` }] };
  }

  const rows: TestCaseImportRow[] = [];
  records.forEach((record, i) => {
    const row = toRow(record, i + 1, issues);
    if (row) rows.push(row);
  });

  // A duplicate inside the batch would be refused by the door on its row;
  // saying so here keeps the preview honest about what would land.
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const key = `${row.requirement.toLowerCase()}|${row.category}`;
    const first = seen.get(key);
    if (first !== undefined) issues.push({ row: i + 1, message: `duplicates row ${first + 1}: one case per requirement and category` });
    else seen.set(key, i);
  });

  issues.sort((a, b) => a.row - b.row);
  return { format, rows, issues };
}
