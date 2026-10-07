// P2-FLOW-028 / P2-PLAN-027: the cross-project blocker list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { blockerSummary, buildBlockers } from '../src/lib/p13/phase-blockers.ts';

const NOW = new Date('2026-11-28T00:00:00Z');
const projects = [
  { id: 'p1', name: 'Salon app' },
  { id: 'p2', name: 'Clinic site' },
];

test('only waiting states appear, each names who it waits on, and the oldest wait comes first', () => {
  const rows = buildBlockers({
    phaseTwo: [
      { project_id: 'p1', state: 'waiting_client', blocked_reason: null, updated_at: '2026-11-20T00:00:00Z' },
      { project_id: 'p2', state: 'completed', blocked_reason: null, updated_at: '2026-10-01T00:00:00Z' },
      { project_id: 'p2', state: 'waiting_finance', blocked_reason: 'advance not verified', updated_at: '2026-11-26T00:00:00Z' },
    ],
    phaseThree: [{ project_id: 'p1', state: 'blocked_requirement', blocked_reason: 'no brand colours', updated_at: '2026-11-10T00:00:00Z' }],
    dependencies: [{ project_id: 'p2', kind: 'client_access', description: 'domain login', needed_by_phase: 'phase_4', updated_at: '2026-11-27T00:00:00Z' }],
    projects,
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => `${r.projectName}:${r.state}:${r.waitingDays}`), ['Salon app:blocked_requirement:18', 'Salon app:waiting_client:8', 'Clinic site:waiting_finance:2', 'Clinic site:dependency_blocked:1']);
  assert.equal(rows.find((r) => r.state === 'waiting_client')?.needsPerson, false, 'a client wait is the PM chasing, not a person to unblock');
  assert.match(rows.find((r) => r.state === 'dependency_blocked')?.waitingOn ?? '', /client/);
  assert.equal(rows.find((r) => r.state === 'waiting_client')?.reason, 'no reason recorded', 'a missing reason is said, not invented');
});

test('a project the caller cannot read is named as such, never guessed', () => {
  const rows = buildBlockers({ phaseTwo: [{ project_id: 'zz', state: 'blocked', blocked_reason: 'x', updated_at: '2026-11-27T00:00:00Z' }], phaseThree: [], dependencies: [], projects: [], now: NOW });
  assert.equal(rows[0]?.projectName, 'a project you cannot read');
});

test('the summary counts people-needed rows, the longest wait and each party', () => {
  const rows = buildBlockers({
    phaseTwo: [
      { project_id: 'p1', state: 'waiting_client', blocked_reason: null, updated_at: '2026-11-20T00:00:00Z' },
      { project_id: 'p2', state: 'waiting_admin', blocked_reason: null, updated_at: '2026-11-25T00:00:00Z' },
    ],
    phaseThree: [],
    dependencies: [],
    projects,
    now: NOW,
  });
  const s = blockerSummary(rows);
  assert.equal(s.total, 2);
  assert.equal(s.needsPerson, 1);
  assert.equal(s.oldestDays, 8);
  assert.deepEqual(s.byWaitingOn, { 'the client (the PM chases)': 1, 'an Admin': 1 });
  assert.deepEqual(blockerSummary([]), { total: 0, needsPerson: 0, oldestDays: 0, byWaitingOn: {} });
});

test('every state the queries ask for has an owner in the model, and the queries check every read', () => {
  const q = readFileSync(new URL('../src/lib/p13/phase-blockers-queries.ts', import.meta.url), 'utf8');
  assert.equal([...q.matchAll(/\.error\) unreadable\(/g)].length, 5);
  for (const state of ['waiting_client', 'waiting_admin', 'waiting_finance', 'waiting_planning', 'blocked', 'waiting_review', 'waiting_designer', 'blocked_requirement', 'scope_escalation', 'revision_limit_escalation']) {
    assert.ok(q.includes(`'${state}'`), state);
  }
  const rows = buildBlockers({
    phaseTwo: ['waiting_client', 'waiting_admin', 'waiting_finance', 'waiting_planning', 'blocked'].map((state) => ({ project_id: 'p1', state, blocked_reason: null, updated_at: '2026-11-27T00:00:00Z' })),
    phaseThree: ['waiting_client', 'waiting_admin', 'waiting_review', 'waiting_designer', 'blocked_requirement', 'scope_escalation', 'revision_limit_escalation'].map((state) => ({ project_id: 'p1', state, blocked_reason: null, updated_at: '2026-11-27T00:00:00Z' })),
    dependencies: [],
    projects,
    now: NOW,
  });
  assert.equal(rows.length, 12, 'no queried state is dropped by the model');
});
