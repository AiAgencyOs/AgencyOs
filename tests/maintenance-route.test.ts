import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyMaintenancePriority,
  decideMaintenanceRoute,
  rankMaintenanceQueue,
  slaStateFor,
  type MaintenanceItemFacts,
  type MaintenancePriority,
  type SlaPolicy,
} from '../src/modules/orchestrator/maintenance-route.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const item = (over: Partial<MaintenanceItemFacts> = {}): MaintenanceItemFacts => ({
  id: 'w-1', kind: 'patch', area: 'backend', status: 'open', emergency: false, sensitive: false, commitRef: null, hasDefect: false, defectSLevel: null, raisedAt: '2026-11-10T00:00:00.000Z', ...over,
});
const none = new Map<MaintenancePriority, SlaPolicy>();
const enabledAll = new Map([['backend_developer', true], ['bug_fix', true], ['frontend_developer', true]]);
const enabledNone = new Map<string, boolean>();

describe('priority is a class derived from facts', () => {
  test('emergency > severe or sensitive hotfix > patch / other hotfix > enhancement', () => {
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: true, sensitive: false, defectSLevel: 3 }), 'p0');
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: false, sensitive: false, defectSLevel: 1 }), 'p1');
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: false, sensitive: true, defectSLevel: null }), 'p1');
    assert.equal(classifyMaintenancePriority({ kind: 'hotfix', emergency: false, sensitive: false, defectSLevel: 3 }), 'p2');
    assert.equal(classifyMaintenancePriority({ kind: 'patch', emergency: false, sensitive: true, defectSLevel: null }), 'p2');
    assert.equal(classifyMaintenancePriority({ kind: 'enhancement', emergency: false, sensitive: false, defectSLevel: null }), 'p3');
  });
});

describe('the SLA is never invented', () => {
  test('with no policy the SLA is unknown and nothing is called breached', () => {
    const s = slaStateFor({ priority: 'p1', raisedAt: '2020-01-01T00:00:00.000Z', now: NOW, policy: undefined });
    assert.equal(s.state, 'unknown');
  });
  test('with a policy: ok, at risk (only if the Admin set a threshold) and breached', () => {
    const p: SlaPolicy = { version: 2, responseHours: 2, resolutionHours: 10, atRiskPercent: 80 };
    const at = (hoursAgo: number, policy: SlaPolicy = p) => slaStateFor({ priority: 'p1', raisedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), now: NOW, policy });
    assert.equal(at(1).state, 'ok');
    assert.equal(at(8).state, 'at_risk');
    assert.equal(at(11).state, 'breached');
    assert.equal(at(8, { ...p, atRiskPercent: null }).state, 'ok', 'no at-risk threshold set: there is no at-risk state');
    const s = at(4);
    assert.ok(s.state === 'ok' && s.policyVersion === 2 && s.hoursRemaining === 6);
  });
});

describe('routing explains itself and never skips a gate', () => {
  test('every development specialist is installed disabled, so a routable item is HELD with the reason, and a candidate list explains each', () => {
    const r = decideMaintenanceRoute({ item: item(), enabled: enabledNone, failingGates: [], policies: none, now: NOW });
    assert.equal(r.outcome, 'held');
    assert.equal(r.code, 'agent_disabled');
    assert.equal(r.toAgent, 'backend_developer');
    assert.ok(r.candidates.length >= 9 && r.candidates.every((c) => c.eligible === false && typeof c.rejected === 'string'));
    assert.equal(r.sla.state, 'unknown');
  });
  test('an enabled specialist is chosen; a defect-backed fix goes to the Bug Fix agent; an enhancement goes by area', () => {
    const a = decideMaintenanceRoute({ item: item({ hasDefect: true }), enabled: enabledAll, failingGates: [], policies: none, now: NOW });
    assert.deepEqual([a.outcome, a.toAgent], ['routed', 'bug_fix']);
    const b = decideMaintenanceRoute({ item: item({ kind: 'enhancement', area: 'frontend' }), enabled: enabledAll, failingGates: [], policies: none, now: NOW });
    assert.deepEqual([b.outcome, b.toAgent], ['routed', 'frontend_developer']);
  });
  test('work whose authorization is not valid is held, not started (a paid change that is not paid)', () => {
    const r = decideMaintenanceRoute({ item: item(), enabled: enabledAll, failingGates: ['scope_authorized', 'targeted_qa'], policies: none, now: NOW });
    assert.deepEqual([r.outcome, r.code], ['held', 'authorization_open']);
    assert.match(r.reason, /scope_authorized/);
  });
  test('a held emergency, or a held item past its SLA, is escalated to a person', () => {
    const e = decideMaintenanceRoute({ item: item({ kind: 'hotfix', emergency: true }), enabled: enabledNone, failingGates: [], policies: none, now: NOW });
    assert.equal(e.outcome, 'escalated');
    const policies = new Map<MaintenancePriority, SlaPolicy>([['p2', { version: 1, responseHours: 1, resolutionHours: 2, atRiskPercent: null }]]);
    const late = decideMaintenanceRoute({ item: item(), enabled: enabledNone, failingGates: [], policies, now: NOW });
    assert.deepEqual([late.outcome, late.sla.state], ['escalated', 'breached']);
    const fine = decideMaintenanceRoute({ item: item({ raisedAt: NOW.toISOString() }), enabled: enabledNone, failingGates: [], policies, now: NOW });
    assert.equal(fine.outcome, 'held');
  });
  test('a closed item is refused', () => {
    assert.equal(decideMaintenanceRoute({ item: item({ status: 'released' }), enabled: enabledAll, failingGates: [], policies: none, now: NOW }).outcome, 'refused');
  });
  test('the builder is never its own QA, and a sensitive change adds a security reviewer', () => {
    const r = decideMaintenanceRoute({ item: item({ hasDefect: true, sensitive: true }), enabled: enabledAll, failingGates: [], policies: none, now: NOW });
    assert.ok(!r.independentQa.includes(r.toAgent ?? ''));
    assert.ok(r.independentQa.includes('quality_assurance') && r.independentQa.includes('security_review'));
    assert.equal(r.requiresSecurityReview, true);
  });
  test('the decision key is stable per state and commit (a retry records once) and changes with the commit', () => {
    const a = decideMaintenanceRoute({ item: item(), enabled: enabledNone, failingGates: [], policies: none, now: NOW });
    const b = decideMaintenanceRoute({ item: item(), enabled: enabledNone, failingGates: [], policies: none, now: new Date(NOW.getTime() + 1000) });
    const c = decideMaintenanceRoute({ item: item({ commitRef: 'a'.repeat(40), status: 'fix_submitted' }), enabled: enabledNone, failingGates: [], policies: none, now: NOW });
    assert.equal(a.decisionKey, b.decisionKey);
    assert.notEqual(a.decisionKey, c.decisionKey);
  });
});

describe('the queue is ordered by priority, then SLA state, then due time', () => {
  test('deterministic ranking', () => {
    const sla = (state: 'ok' | 'breached', due: string) => ({ state, policyVersion: 1, resolutionDueAt: due, hoursRemaining: 0 }) as const;
    const rows = [
      { id: 'c', priority: 'p2' as const, sla: sla('ok', '2026-11-12T00:00:00Z'), raisedAt: '2026-11-01T00:00:00Z' },
      { id: 'a', priority: 'p2' as const, sla: sla('breached', '2026-11-09T00:00:00Z'), raisedAt: '2026-11-02T00:00:00Z' },
      { id: 'z', priority: 'p0' as const, sla: { state: 'unknown' as const, reason: 'x' }, raisedAt: '2026-11-05T00:00:00Z' },
      { id: 'b', priority: 'p2' as const, sla: sla('ok', '2026-11-11T00:00:00Z'), raisedAt: '2026-11-03T00:00:00Z' },
    ];
    assert.deepEqual(rankMaintenanceQueue(rows).map((r) => r.id), ['z', 'a', 'b', 'c']);
    assert.deepEqual(rankMaintenanceQueue([...rows].reverse()).map((r) => r.id), ['z', 'a', 'b', 'c']);
  });
});
