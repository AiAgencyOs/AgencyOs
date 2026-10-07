// Phase 1 Orchestrator / Coordination: the task envelope is validated at intake, a task type routes to an agent, a service or a person, and an unknown or
// unavailable one has no safe route (P1-ORCH-003/004/006/009, P1-COORD-003). Pure; the database half is scripts/verify-p1o-handoffs.sql.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BOARD_STATES, createHandoffArgs, isBoardState, noRouteEscalation, routeTask, validateTaskEnvelope, type Capability } from '../src/modules/orchestrator/p1o-envelope.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const good = {
  organizationId: ID(1),
  taskType: 'sales.conversation',
  correlationId: ID(2),
  idempotencyKey: 'lead:1:msg:9',
  fromAgent: 'sales',
  toAgent: 'quality_assurance',
  objective: 'check the lead notes',
  acceptanceCriteria: ['notes complete'],
};

describe('the envelope is refused when it is malformed, before anything runs', () => {
  test('a complete envelope passes and defaults its priority', () => {
    const v = validateTaskEnvelope(good);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.envelope.priority, 'normal');
      assert.deepEqual(v.envelope.dependencyIds, []);
    }
  });

  for (const [what, patch] of [
    ['no idempotency key', { idempotencyKey: '' }],
    ['no correlation id', { correlationId: undefined }],
    ['no acceptance criteria', { acceptanceCriteria: [] }],
    ['a blank criterion', { acceptanceCriteria: ['  '] }],
    ['a task type with no area', { taskType: 'conversation' }],
    ['a priority that is not one of four', { priority: 'asap' }],
    ['an organisation that is not an id', { organizationId: 'acme' }],
    ['an unknown field', { secret: 'x' }],
    ['more than twenty prerequisites', { dependencyIds: Array.from({ length: 21 }, (_, i) => ID(100 + i)) }],
  ] as const) {
    test(`refused: ${what}`, () => {
      const v = validateTaskEnvelope({ ...good, ...patch });
      assert.equal(v.ok, false);
      if (!v.ok) assert.ok(v.problems.length >= 1);
    });
  }

  test('a prerequisite listed twice is refused, naming it', () => {
    const v = validateTaskEnvelope({ ...good, dependencyIds: [ID(5), ID(5)] });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.problems.join(' '), /twice/);
  });

  test('every problem is reported, not just the first', () => {
    const v = validateTaskEnvelope({ ...good, idempotencyKey: '', acceptanceCriteria: [], priority: 'asap' });
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.problems.length >= 3, v.problems.join(' | '));
  });

  test('the database door receives exactly the envelope', () => {
    const v = validateTaskEnvelope({ ...good, priority: 'high', boundProposalId: ID(7), dependencyIds: [ID(8)] });
    assert.equal(v.ok, true);
    if (v.ok) {
      const args = createHandoffArgs(v.envelope);
      assert.equal(args.p_priority, 'high');
      assert.equal(args.p_bound_proposal_id, ID(7));
      assert.deepEqual(args.p_dependency_ids, [ID(8)]);
      assert.deepEqual(args.p_acceptance_criteria, ['notes complete']);
      assert.equal(args.p_idempotency_key, 'lead:1:msg:9');
    }
  });
});

const CAPS: Capability[] = [
  { taskType: 'sales.conversation', handlerKind: 'agent', handlerKey: 'sales', agentKey: 'sales', available: true },
  { taskType: 'scheduling.request', handlerKind: 'service', handlerKey: 'crm.subtask_requests', agentKey: null, available: true },
  { taskType: 'approval.decision', handlerKind: 'human', handlerKey: 'admin', agentKey: null, available: true },
  { taskType: 'model.selection', handlerKind: 'agent', handlerKey: 'orchestrator', agentKey: 'orchestrator', available: true },
  { taskType: 'quotation.draft', handlerKind: 'service', handlerKey: 'sales.proposals', agentKey: null, available: false },
];

describe('routing: a known task type routes, an unknown or unavailable one has no safe route', () => {
  const enabled = new Set(['sales']);
  test('an agent route needs the agent switched on', () => {
    assert.deepEqual(routeTask('sales.conversation', CAPS, enabled), { routed: true, handlerKind: 'agent', handlerKey: 'sales' });
    const off = routeTask('model.selection', CAPS, enabled);
    assert.equal(off.routed, false);
  });
  test('scheduling is a service and an approval is a person: never an agent', () => {
    const s = routeTask('scheduling.request', CAPS, enabled);
    const a = routeTask('approval.decision', CAPS, enabled);
    assert.ok(s.routed && s.handlerKind === 'service');
    assert.ok(a.routed && a.handlerKind === 'human');
  });
  test('an unknown task type and an unavailable capability both say why', () => {
    const unknown = routeTask('nothing.known', CAPS, enabled);
    const unavailable = routeTask('quotation.draft', CAPS, enabled);
    assert.ok(!unknown.routed && /no registered capability/.test(unknown.reason));
    assert.ok(!unavailable.routed && /unavailable or disabled/.test(unavailable.reason));
  });
  test('an unroutable task is escalated with the route it tried and a recommendation, never guessed at', () => {
    const r = routeTask('nothing.known', CAPS, enabled);
    assert.ok(!r.routed);
    if (!r.routed) {
      const e = noRouteEscalation('nothing.known', r);
      assert.equal(e.cause, 'no_eligible_agent');
      assert.equal(e.attemptedRoutes[0]?.taskType, 'nothing.known');
      assert.match(e.recommendation, /person/);
    }
  });
});

describe('the board vocabulary is the Admin Panel A16 list', () => {
  test('nine states, in order, and a guard for them', () => {
    assert.deepEqual([...BOARD_STATES], ['created', 'ready', 'in_progress', 'waiting', 'blocked', 'retrying', 'failed', 'escalated', 'closed']);
    assert.equal(isBoardState('blocked'), true);
    assert.equal(isBoardState('done'), false);
    assert.equal(isBoardState(undefined), false);
  });
});
