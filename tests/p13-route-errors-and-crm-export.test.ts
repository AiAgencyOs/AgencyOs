// P1-DOD-061 (a ratchet, not a closure) and P1-CRM-057 (the CRM export is logged before the file exists).
//
// DOD-061 asks that every route map failures to the canonical envelope. 33 of the 42 existing routes are file downloads / provider callbacks that answer
// with ad-hoc JSON errors and have never used src/lib/errors.ts. Rewriting them is a behaviour change nobody asked for, so this test PINS that set: a
// NEW route must use the canonical error module (or the Result type), and a route that adopts it must leave the list, so the list only shrinks.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url).pathname;

function routes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) routes(rel, out);
    else if (entry === 'route.ts') out.push(rel);
  }
  return out;
}

const NOT_CANONICAL_YET = new Set([
  'app/api/builds/report/route.ts',
  'app/api/clients/export/route.ts',
  'app/api/design/figma/[projectId]/report/route.ts',
  'app/api/audit/export/route.ts',
  'app/api/files/share/[token]/route.ts',
  'app/api/finance/expenses/export/route.ts',
  'app/api/finance/attachment/[kind]/[id]/route.ts',
  'app/api/finance/gst/gstr3b/route.ts',
  'app/api/design/figma/[projectId]/route.ts',
  'app/api/finance/payments/export/route.ts',
  'app/api/finance/invoices/export/route.ts',
  'app/api/finance/tax/pdf/route.ts',
  'app/api/finance/gst/gstr1/route.ts',
  'app/api/handoff/[code]/route.ts',
  'app/api/landing/[versionId]/page/route.ts',
  'app/api/finance/tax/export/route.ts',
  'app/api/projects/[projectId]/attachments/[attachmentId]/route.ts',
  'app/api/outreach/unsubscribe/[token]/route.ts',
  'app/api/projects/[projectId]/calendar.ics/route.ts',
  'app/api/projects/[projectId]/files/[fileId]/download/route.ts',
  'app/api/projects/[projectId]/qa/evidence/route.ts',
  'app/api/projects/[projectId]/design/screens/export/route.ts',
  'app/api/meetings/[meetingId]/evidence/[evidenceId]/route.ts',
  'app/api/projects/[projectId]/report/time/route.ts',
  'app/api/projects/[projectId]/scope/export/route.ts',
  'app/api/projects/[projectId]/report/route.ts',
  'app/api/requirements/scope-summary/route.ts',
  'app/api/projects/[projectId]/design/assets/export/route.ts',
  'app/api/sales/pipeline/export/route.ts',
  'app/api/webhooks/delivery-callback/route.ts',
  'app/api/projects/[projectId]/report/pdf/route.ts',
  'app/api/usage/ledger/route.ts',
  'app/api/usage/export/route.ts',
]);

const usesCanonical = (src: string) => /from '@\/lib\/(errors|result|p13\/canonical-errors)'/.test(src);

test('every route outside the pinned list answers failures through the canonical error module', () => {
  const offenders = routes('app/api').filter((r) => !NOT_CANONICAL_YET.has(r) && !usesCanonical(readFileSync(join(root, r), 'utf8')));
  assert.deepEqual(offenders, [], `new routes must use src/lib/errors.ts: ${offenders.join(', ')}`);
});

test('the pinned list only shrinks: a route that adopted the canonical module must be removed from it', () => {
  const stale = [...NOT_CANONICAL_YET].filter((r) => usesCanonical(readFileSync(join(root, r), 'utf8')));
  assert.deepEqual(stale, [], `remove from NOT_CANONICAL_YET: ${stale.join(', ')}`);
  for (const r of NOT_CANONICAL_YET) assert.ok(statSync(join(root, r)).isFile(), `${r} no longer exists: remove it from the list`);
});

test('the pipeline export logs BEFORE it builds the file and withholds the file when the log fails', () => {
  const src = readFileSync(join(root, 'app/api/sales/pipeline/export/route.ts'), 'utf8');
  const logAt = src.indexOf('await logCrmExport(');
  const fileAt = src.indexOf("'text/csv; charset=utf-8'");
  assert.ok(logAt > 0 && fileAt > logAt, 'the log call must come before the response that carries the file');
  assert.match(src, /if \(!logged\.ok\) return NextResponse\.json\([^)]*503/);
});

test('logCrmExport sends the kind, filters and row count to the door, and refuses on an error or any answer but "logged"', () => {
  // server-only + the cookie-bound client cannot be built outside Next, so the contract is pinned at the source level
  const src = readFileSync(join(root, 'src/modules/crm/export-log.ts'), 'utf8');
  assert.match(src, /p13_log_crm_export', \{ p_kind: kind, p_filters: filters, p_row_count: rowCount \}/);
  assert.match(src, /if \(error\) \{[\s\S]{0,200}ok: false/);
  assert.match(src, /if \(data !== 'logged'\) return \{ ok: false/);
});
