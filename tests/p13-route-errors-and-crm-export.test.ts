// P1-DOD-061 (canonical errors) and P1-CRM-057 (the CRM export is logged before the file exists).
//
// DOD-061 asks that every route map failures to the canonical envelope. Round 1 (2026-11-28) could only pin the 33 routes that did not; round 4 (2026-12-04)
// converted them. Every route in `app/api` now answers a failure through `src/lib/route-errors.ts` (`routeError`, body `{ error, code, correlationId }`, the
// status each route always used), directly or through a helper that does, and this file fails when a route writes a raw `{ error: ... }` body by hand.
//
// Two things stay outside, each with its reason and each CHECKED rather than assumed: `app/api/jobs/run/route.ts` is the runner entry point other builders
// are editing at the same time (three raw bodies; the caller is the scheduler and reads only the status), and `app/api/handoff/[code]/route.ts` answers
// nothing but redirects by design (it must not tell which references exist). The ratchet works in both directions: a route that is listed must still have
// what excuses it, so the list can only shrink.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NextResponse } from 'next/server';

import { ERROR_CODES, httpStatusFor } from '../src/lib/errors.ts';
import { codeForStatus, routeError } from '../src/lib/route-errors.ts';

const root = new URL('..', import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

function routes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) routes(rel, out);
    else if (entry === 'route.ts') out.push(rel);
  }
  return out;
}

/** Routes that still write a raw error body, with the reason. Each must STILL do so (the list only shrinks). */
const RAW_ERROR_BODY_ALLOWED: Record<string, string> = {
  'app/api/jobs/run/route.ts': 'the scheduler entry point is edited by concurrent builders; its caller reads only the status',
};

/** Routes that answer only redirects, with the reason. Each must STILL emit no error status and no JSON. */
const REDIRECT_ONLY: Record<string, string> = {
  'app/api/handoff/[code]/route.ts': 'a public link that must not tell which references exist: every non-match is the same redirect',
};

/** Routes whose failures go through a helper module that builds them with `routeError`. Both ends are checked. */
const DELEGATES: Record<string, { helper: string; call: RegExp }> = {
  'app/api/design/figma/[projectId]/route.ts': { helper: 'src/modules/projects/figma-route.ts', call: /replyError\(/ },
  'app/api/design/figma/[projectId]/report/route.ts': { helper: 'src/modules/projects/figma-route.ts', call: /replyError\(/ },
  'app/api/finance/gst/gstr1/route.ts': { helper: 'app/api/finance/gst/gstr-export.ts', call: /exportGstr\(/ },
  'app/api/finance/gst/gstr3b/route.ts': { helper: 'app/api/finance/gst/gstr-export.ts', call: /exportGstr\(/ },
};

const RAW_BODY = /(?:NextResponse|Response)\.json\(\s*\{[^}]*\berror\b/;
const canonicalImport = (src: string) => /from '@\/lib\/(route-errors|errors|result|p13\/canonical-errors)'/.test(src);
const usesRouteError = (src: string) => /from '@\/lib\/route-errors'/.test(src) && /routeError\(/.test(src);

const ALL = routes('app/api');

test('there are routes to check (the scan is not vacuous)', () => {
  assert.ok(ALL.length >= 44, `found ${ALL.length} routes`);
  for (const r of [...Object.keys(RAW_ERROR_BODY_ALLOWED), ...Object.keys(REDIRECT_ONLY), ...Object.keys(DELEGATES)]) assert.ok(ALL.includes(r), `${r} is listed but is not a route`);
});

test('no route writes a raw { error } body by hand, except the listed one', () => {
  const offenders = ALL.filter((r) => !(r in RAW_ERROR_BODY_ALLOWED) && RAW_BODY.test(read(r)));
  assert.deepEqual(offenders, [], `use routeError from src/lib/route-errors.ts: ${offenders.join(', ')}`);
  for (const h of ['src/modules/projects/figma-route.ts', 'app/api/finance/gst/gstr-export.ts']) assert.doesNotMatch(read(h), RAW_BODY, `${h} builds a raw error body`);
});

test('every route answers failures through the canonical module, or is excused with a checked reason', () => {
  const offenders = ALL.filter((r) => {
    if (r in RAW_ERROR_BODY_ALLOWED || r in REDIRECT_ONLY || r in DELEGATES) return false;
    return !canonicalImport(read(r));
  });
  assert.deepEqual(offenders, [], `new routes must use src/lib/route-errors.ts: ${offenders.join(', ')}`);
});

test('a route that converted uses routeError itself (importing the module is not enough)', () => {
  const importersWithoutCall = ALL.filter((r) => /from '@\/lib\/route-errors'/.test(read(r)) && !/routeError\(/.test(read(r)));
  assert.deepEqual(importersWithoutCall, []);
  const converted = ALL.filter((r) => usesRouteError(read(r)));
  assert.ok(converted.length >= 30, `only ${converted.length} routes call routeError`);
});

test('the ratchet: the raw-body exception still has a raw body, and a redirect-only route still emits no error and no JSON', () => {
  for (const r of Object.keys(RAW_ERROR_BODY_ALLOWED)) assert.match(read(r), RAW_BODY, `${r} no longer has a raw error body: remove it from RAW_ERROR_BODY_ALLOWED`);
  for (const r of Object.keys(REDIRECT_ONLY)) {
    const src = read(r);
    assert.doesNotMatch(src, /status: ?[45]\d\d/, `${r} answers an error status`);
    assert.doesNotMatch(src, /\.json\(/, `${r} answers JSON`);
    assert.match(src, /NextResponse\.redirect\(/, `${r} no longer redirects: it is not redirect-only any more`);
  }
});

test('a delegating route calls its helper, and the helper builds its failures with routeError', () => {
  for (const [route, { helper, call }] of Object.entries(DELEGATES)) {
    assert.match(read(route), call, `${route} does not call ${helper}`);
    assert.ok(usesRouteError(read(helper)), `${helper} does not use routeError`);
  }
});

test('routeError answers { error, code, correlationId } with the status the code names, or the one a route always used', async () => {
  const res = routeError('NOT_FOUND', 'Project not found.');
  assert.equal(res.status, 404);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, 'Project not found.');
  assert.equal(body.code, 'NOT_FOUND');
  assert.match(String(body.correlationId), /^[0-9a-f-]{36}$/);

  const overridden = routeError('INTERNAL', 'The cost ledger could not be read.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  assert.equal(overridden.status, 503);
  assert.equal(overridden.headers.get('cache-control'), 'no-store');

  const withId = routeError('VALIDATION', 'malformed payload', { status: 400, correlationId: 'fixed-id' });
  assert.equal(((await withId.json()) as Record<string, unknown>).correlationId, 'fixed-id');
});

test('extra keys travel with the error but can never replace error, code or correlationId', async () => {
  const res = routeError('VALIDATION', 'refused', { extra: { reason: 'stale', error: 'forged', code: 'FORGED', correlationId: 'forged', ok: false } });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.reason, 'stale');
  assert.equal(body.ok, false);
  assert.equal(body.error, 'refused');
  assert.equal(body.code, 'VALIDATION');
  assert.notEqual(body.correlationId, 'forged');
});

test('every status a route answers with maps to one of the eight application codes, and a code\'s own status maps back to it', () => {
  for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503]) assert.ok((ERROR_CODES as readonly string[]).includes(codeForStatus(status)), String(status));
  for (const code of ERROR_CODES) assert.equal(codeForStatus(httpStatusFor(code)), code, code);
  assert.ok(NextResponse, 'next/server loads in the test runner');
});

test('the pipeline export logs BEFORE it builds the file and withholds the file when the log fails', () => {
  const src = readFileSync(join(root, 'app/api/sales/pipeline/export/route.ts'), 'utf8');
  const logAt = src.indexOf('await logCrmExport(');
  const fileAt = src.indexOf("'text/csv; charset=utf-8'");
  assert.ok(logAt > 0 && fileAt > logAt, 'the log call must come before the response that carries the file');
  assert.match(src, /if \(!logged\.ok\) return routeError\('INTERNAL', logged\.reason, \{ status: 503 \}\);/);
});

test('logCrmExport sends the kind, filters and row count to the door, and refuses on an error or any answer but "logged"', () => {
  // server-only + the cookie-bound client cannot be built outside Next, so the contract is pinned at the source level
  const src = readFileSync(join(root, 'src/modules/crm/export-log.ts'), 'utf8');
  assert.match(src, /p13_log_crm_export', \{ p_kind: kind, p_filters: filters, p_row_count: rowCount \}/);
  assert.match(src, /if \(error\) \{[\s\S]{0,200}ok: false/);
  assert.match(src, /if \(data !== 'logged'\) return \{ ok: false/);
});
