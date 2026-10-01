import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { PostgrestClient } from '@supabase/postgrest-js';

/**
 * The Usage page's latency figures read the model-call steps of the latest runs.
 * The run ids travel in the URL of a GET, so five hundred of them made a ~18 KB
 * address that PostgREST and the proxies in front of it refuse: the read broke
 * the day there were enough runs. It now asks in chunks, and the figure is the
 * same as one big ask would give. The reader runs for real over a fake wire that
 * refuses an over-long address the way the real one does.
 */

const MAX_URL = 8_000;
const runs = Array.from({ length: 500 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, latency_ms: 1000 }));
const seen: number[] = [];

const wire = (async (input: RequestInfo | URL) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(href);
  seen.push(href.length);
  if (href.length > MAX_URL) return new Response('', { status: 414 });
  if (url.pathname.endsWith('/agent_runs')) return new Response(JSON.stringify(runs), { status: 200, headers: { 'content-type': 'application/json' } });
  // Every run has one model-call step of 400 ms.
  const ids = (url.searchParams.get('run_id') ?? '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
  return new Response(JSON.stringify(ids.map(() => ({ latency_ms: 400 }))), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

mock.module('@/lib/db/server', { exports: { createClient: async () => new PostgrestClient('http://wire/rest/v1', { fetch: wire }) } });

const { readLatencyKpis } = await import('../src/lib/admin/usage-latency.ts');

describe('the latency read over a full sample of runs', () => {
  test('never builds an address the server would refuse, and still counts every run', async () => {
    const kpis = await readLatencyKpis();
    assert.ok(Math.max(...seen) <= MAX_URL, `longest address was ${Math.max(...seen)} characters`);
    assert.ok(seen.length > 2, 'the step read was asked for in more than one request');
    assert.equal(kpis.averageModelCallMs, 400);
  });
});
