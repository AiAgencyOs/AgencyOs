import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { PostgrestClient } from '@supabase/postgrest-js';

/**
 * SCR-002 "Recent searches": a search that was run is remembered, and running
 * it again bumps the same row instead of adding a second one.
 *
 * It was never remembered. The lookup compared the jsonb `filters` column with
 * `.eq('filters', {})`, which the client writes into the URL as
 * `filters=eq.[object Object]`; PostgREST refuses that, the function took the
 * refusal for "could not read recent searches", and every recorded search ended
 * there. This test drives the real `recordSearch` through the real PostgREST
 * client over a fake wire that, like PostgREST, rejects a filter value that is
 * not JSON — so the request itself is what is checked, not a stubbed answer.
 */

type Row = { id: string; organization_id: string; user_id: string; query: string; filters: unknown; name: string | null; last_used_at: string; use_count: number };
const table: Row[] = [];
const requests: string[] = [];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const wire = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push(`${method} ${url.pathname}${url.search}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const filt = url.searchParams.get('filters');
  let wanted: unknown = undefined;
  if (filt !== null) {
    try {
      wanted = JSON.parse(filt.replace(/^eq\./, ''));
    } catch {
      return json({ code: '22P02', message: `invalid input syntax for type json: "${filt}"` }, 400);
    }
  }
  const single = String((init?.headers as Record<string, string> | Headers | undefined) instanceof Headers ? (init?.headers as Headers).get('accept') : (init?.headers as Record<string, string> | undefined)?.Accept ?? '').includes('vnd.pgrst.object');
  if (method === 'GET' || method === 'HEAD') {
    const q = url.searchParams.get('query')?.replace(/^eq\./, '');
    const user = url.searchParams.get('user_id')?.replace(/^eq\./, '');
    let rows = table.filter((r) => (q === undefined || r.query === q) && (user === undefined || r.user_id === user) && (filt === null || same(r.filters, wanted)));
    if (url.searchParams.get('name') === 'is.null') rows = rows.filter((r) => r.name === null);
    return single ? (rows[0] ? json(rows[0]) : json({ code: 'PGRST116', message: 'no rows' }, 406)) : json(rows);
  }
  if (method === 'POST') {
    const body = JSON.parse(String(init?.body)) as Partial<Row>;
    const row: Row = { id: `s${table.length + 1}`, organization_id: String(body.organization_id), user_id: String(body.user_id), query: String(body.query), filters: body.filters ?? {}, name: body.name ?? null, last_used_at: new Date().toISOString(), use_count: 1 };
    table.push(row);
    return single ? json(row, 201) : json([row], 201);
  }
  if (method === 'PATCH') {
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const row = table.find((r) => r.id === id);
    if (row) Object.assign(row, JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }
  return json([], 200);
}) as typeof fetch;

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role: 'owner', userId: 'u1', organizationId: 'o1' }) } });
mock.module('@/lib/db/server', { exports: { createClient: async () => new PostgrestClient('http://wire/rest/v1', { fetch: wire }) } });

const { recordSearch, normalizeFilters } = await import('../src/lib/admin/saved-searches.ts');

describe('recording a search', () => {
  test('a search with no filters is recorded as one recent row', async () => {
    const r = await recordSearch('northwind', normalizeFilters({}));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(table.length, 1);
    assert.equal(table[0]!.query, 'northwind');
    assert.equal(table[0]!.name, null);
  });

  test('the lookup sends the filters as JSON, never as "[object Object]"', () => {
    assert.ok(requests.some((q) => q.includes('filters=eq.%7B%7D')), requests.join('\n'));
    assert.ok(!requests.some((q) => q.includes('object+Object') || q.includes('object%20Object')));
  });

  test('running the same search again bumps the row it already has', async () => {
    const again = await recordSearch('northwind', normalizeFilters({}));
    assert.equal(again.ok, true);
    assert.equal(table.length, 1);
    assert.equal(table[0]!.use_count, 2);
  });

  test('the same words with a filter are a different search', async () => {
    const r = await recordSearch('northwind', normalizeFilters({ type: 'Lead', since: '30d' }));
    assert.equal(r.ok, true);
    assert.equal(table.length, 2);
    assert.deepEqual(table[1]!.filters, { since: '30d', type: 'Lead' });
    const again = await recordSearch('northwind', normalizeFilters({ since: '30d', type: 'Lead' }));
    assert.equal(again.ok, true);
    assert.equal(table.length, 2, 'filter order must not make a second row');
    assert.equal(table[1]!.use_count, 2);
  });

  test('a search too short to mean anything is not recorded', async () => {
    const r = await recordSearch('a', normalizeFilters({}));
    assert.equal(r.ok, false);
    assert.equal(table.length, 2);
  });
});
