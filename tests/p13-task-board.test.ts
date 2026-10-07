// P1-BLUEPRINT-022 (A16): the board names backend state; it never invents progress.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { BOARD_STATES, buildBoard, handoffState, jobState, queueSummary, type BoardHandoff, type BoardJob } from '../src/lib/p13/task-board.ts';

const NOW = new Date('2026-11-28T12:00:00Z');
const job = (over: Partial<BoardJob>): BoardJob => ({ id: 'j', kind: 'k', status: 'queued', priority: 100, run_at: '2026-11-28T11:00:00Z', attempts: 0, max_attempts: 5, created_at: '2026-11-28T10:00:00Z', last_error: null, ...over });
const handoff = (status: string): BoardHandoff => ({ id: 'h', from_agent: 'sales', to_agent: 'scheduler', status, objective: 'book a call', created_at: '2026-11-28T10:00:00Z', sla_at: null });

test('there are nine states and every job status lands in one of them', () => {
  assert.equal(BOARD_STATES.length, 9);
  const seen = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead'].map((status) => jobState(job({ status }), NOW, new Set()).state);
  assert.deepEqual(seen, ['ready', 'in_progress', 'closed', 'retrying', 'closed', 'failed']);
});

test('a queued job with attempts behind it is retrying, one scheduled later is waiting, and a failed job with no attempts left is failed', () => {
  assert.equal(jobState(job({ attempts: 2 }), NOW, new Set()).state, 'retrying');
  assert.equal(jobState(job({ run_at: '2026-11-29T00:00:00Z' }), NOW, new Set()).state, 'waiting');
  assert.equal(jobState(job({ status: 'failed', attempts: 5, max_attempts: 5 }), NOW, new Set()).state, 'failed');
  assert.equal(jobState(job({ status: 'failed', attempts: 2 }), NOW, new Set()).state, 'retrying');
});

test('an open escalation makes an open job escalated, but never re-opens a closed one', () => {
  assert.equal(jobState(job({ id: 'x', status: 'failed', attempts: 5 }), NOW, new Set(['x'])).state, 'escalated');
  assert.equal(jobState(job({ id: 'x', status: 'succeeded' }), NOW, new Set(['x'])).state, 'closed');
});

test('a handoff is closed only when it is completed or cancelled: a result received is not acceptance', () => {
  const map = Object.fromEntries(['queued', 'accepted', 'running', 'needs_input', 'awaiting_approval', 'rejected', 'failed_retryable', 'failed_permanent', 'completed', 'cancelled'].map((s) => [s, handoffState(handoff(s)).state]));
  assert.deepEqual(map, {
    queued: 'ready', accepted: 'created', running: 'in_progress', needs_input: 'waiting', awaiting_approval: 'waiting', rejected: 'blocked',
    failed_retryable: 'retrying', failed_permanent: 'failed', completed: 'closed', cancelled: 'closed',
  });
  assert.equal(handoffState(handoff('something_new')).state, 'blocked', 'an unknown status is blocked, never silently closed');
});

test('stale means open for a day or more; closed and failed work is never stale; the summary counts every state', () => {
  const items = buildBoard({
    jobs: [job({ id: 'a', created_at: '2026-11-26T00:00:00Z' }), job({ id: 'b', status: 'succeeded', created_at: '2026-11-20T00:00:00Z' }), job({ id: 'c', status: 'dead', created_at: '2026-11-20T00:00:00Z' })],
    handoffs: [handoff('running')],
    escalatedJobIds: new Set(),
    now: NOW,
  });
  assert.deepEqual(items.map((i) => `${i.id}:${i.stale}`).sort(), ['a:true', 'b:false', 'c:false', 'h:false']);
  const s = queueSummary(items);
  assert.equal(s.ready, 1);
  assert.equal(s.closed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.in_progress, 1);
  assert.equal(s.stale, 1);
  assert.equal(BOARD_STATES.reduce((n, k) => n + s[k], 0), items.length);
});

test('the queries check every read and the page is read-only', () => {
  const q = readFileSync(new URL('../src/lib/p13/task-board-queries.ts', import.meta.url), 'utf8');
  assert.equal([...q.matchAll(/\.error\) unreadable\(/g)].length, 3);
  const page = readFileSync(new URL('../app/(internal)/operations/work-board/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /requireInternal\('\/operations\/work-board'\)/);
  assert.doesNotMatch(page, /use server|<form/);
});
