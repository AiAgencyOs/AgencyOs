import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { PostgrestClient } from '@supabase/postgrest-js';

/**
 * SCR-003 names "blockers" among what the inbox gathers. A blocked task already
 * records what it waits on, who must act and the next action; the inbox row
 * must carry those words, and must not nag about a project that has finished.
 * The reader runs for real over the real PostgREST client and a fake wire.
 */

const tasks = [
  { id: 't1', title: 'Get the Razorpay keys', project_id: 'p1', blocker_type: 'client_answer', blocker_owner: 'Priya at Northwind', blocker_next_action: 'Chase on WhatsApp Monday', updated_at: '2026-09-30T10:00:00Z' },
  { id: 't2', title: 'Old block on a shipped project', project_id: 'p2', blocker_type: 'payment', blocker_owner: 'Finance', blocker_next_action: 'n/a', updated_at: '2026-09-01T10:00:00Z' },
  { id: 't3', title: 'Written before the kinds existed', project_id: 'p1', blocker_type: null, blocker_owner: null, blocker_next_action: null, updated_at: '2026-09-29T10:00:00Z' },
];
const projects = [
  { id: 'p1', name: 'Northwind loyalty app', status: 'active' },
  { id: 'p2', name: 'Shipped site', status: 'completed' },
];
const seen: string[] = [];

const wire = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  seen.push(url.pathname + url.search);
  const body = url.pathname.endsWith('/tasks') ? tasks : projects;
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

mock.module('@/lib/db/server', { exports: { createClient: async () => new PostgrestClient('http://wire/rest/v1', { fetch: wire }) } });

const { listBlockedTasks } = await import('../src/modules/projects/blocked-tasks-queries.ts');

describe('the blocked-work reader behind the inbox', () => {
  const run = listBlockedTasks();

  test('asks only for tasks whose status is blocked', async () => {
    await run;
    assert.ok(seen.some((s) => s.includes('/tasks') && s.includes('status=eq.blocked')), seen.join('\n'));
  });

  test('says what each is waiting on, who must act and what happens next', async () => {
    const rows = await run;
    const first = rows.find((r) => r.id === 't1')!;
    assert.equal(first.blockerTypeLabel, 'Waiting on the client');
    assert.equal(first.blockerOwner, 'Priya at Northwind');
    assert.equal(first.nextAction, 'Chase on WhatsApp Monday');
    assert.equal(first.projectName, 'Northwind loyalty app');
  });

  test('a block on a finished project is not an open question', async () => {
    const rows = await run;
    assert.equal(rows.some((r) => r.id === 't2'), false);
  });

  test('a block recorded before the kinds existed says so instead of inventing one', async () => {
    const rows = await run;
    assert.equal(rows.find((r) => r.id === 't3')!.blockerTypeLabel, 'Reason not recorded');
  });
});
