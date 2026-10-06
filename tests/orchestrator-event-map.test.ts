import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { routeQaFailed, routeQaPassed, routingDecisionRow, QA_EVENTS } from '../src/modules/orchestrator/event-map.ts';

/**
 * The Orchestrator's QA event map - spec 11: DevelopmentTaskQAFailed routes the fix; DevelopmentTaskQAPassed marks a task eligible for integration.
 * Pure decisions in the shape of `projects.routing_decisions`; nothing is subscribed (see event-map.ts for why that is stated, not hidden).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const enabled = (...keys: string[]) => new Map(keys.map((k) => [k, true]));

describe('A. QA failed', () => {
  test('a defect goes to the Bug Fix specialist, and the fix returns to independent QA', () => {
    const d = routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: enabled('bug_fix', 'frontend_developer') });
    assert.equal(d.outcome, 'routed');
    assert.equal(d.toAgent, 'bug_fix');
    assert.equal(d.code, 'qa_failed_to_bug_fix');
    assert.equal(d.requiresIndependentQa, true);
    assert.match(d.reason, /does not close its own defect/);
    assert.deepEqual(d.candidates.map((c) => c.agent), ['bug_fix', 'frontend_developer']);
  });

  test('incomplete work goes back to the specialist that owns the task', () => {
    const d = routeQaFailed({ originalSpecialist: 'backend_developer', failureKind: 'incomplete', attempt: 1, enabled: enabled('bug_fix', 'backend_developer') });
    assert.equal(d.toAgent, 'backend_developer');
    assert.equal(d.code, 'qa_failed_to_original_specialist');
  });

  test('when the preferred agent is not enabled the other takes it, and the reason says why', () => {
    const d = routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: enabled('frontend_developer') });
    assert.equal(d.toAgent, 'frontend_developer');
    assert.equal(d.code, 'qa_failed_to_original_specialist');
    assert.match(d.reason, /because bug_fix is not available/);
    assert.equal(d.candidates[0]?.eligible, false);
    assert.equal(d.candidates[0]?.rejected, 'agent is not enabled');
  });

  test('when neither is enabled the task is HELD with the reason, never handed to an agent that cannot run', () => {
    const d = routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: new Map() });
    assert.equal(d.outcome, 'held');
    assert.equal(d.code, 'agent_disabled');
    assert.equal(d.toAgent, 'bug_fix');
  });

  test('once the retry budget is spent the task is refused for a person, not routed round again', () => {
    const d = routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 3, enabled: enabled('bug_fix', 'frontend_developer') });
    assert.equal(d.outcome, 'refused');
    assert.equal(d.code, 'attempts_exhausted');
    assert.equal(d.toAgent, null);
  });

  test('incomplete work with no registered specialist is refused; a defect with no original still goes to Bug Fix', () => {
    assert.equal(routeQaFailed({ originalSpecialist: null, failureKind: 'incomplete', attempt: 1, enabled: enabled('bug_fix') }).code, 'no_original_specialist');
    assert.equal(routeQaFailed({ originalSpecialist: 'not_an_agent', failureKind: 'defect', attempt: 1, enabled: enabled('bug_fix') }).toAgent, 'bug_fix');
  });

  test('QA is never a fix target', () => {
    for (const kind of ['defect', 'incomplete'] as const) {
      const d = routeQaFailed({ originalSpecialist: 'backend_developer', failureKind: kind, attempt: 1, enabled: enabled('bug_fix', 'backend_developer', 'quality_assurance') });
      assert.notEqual(d.toAgent, 'quality_assurance');
    }
  });
});

describe('B. QA passed', () => {
  const base = { producedBy: 'backend_developer', verifiedBy: 'quality_assurance', qaCommit: 'abc123abc123abc1', currentCommit: 'abc123abc123abc1', securityReviewRequired: false, securityReviewDone: false, openDependencies: 0 };

  test('an independent pass for the exact commit makes the task eligible for integration, and routes to nobody', () => {
    const d = routeQaPassed(base);
    assert.equal(d.outcome, 'routed');
    assert.equal(d.code, 'qa_passed_eligible_for_integration');
    assert.equal(d.toAgent, null);
    assert.match(d.reason, /Eligible is not accepted/);
  });

  test('a pass by the producer, or by an agent that may not verify, is refused as not independent', () => {
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'backend_developer' }).code, 'qa_not_independent');
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'orchestrator' }).code, 'qa_not_independent', 'the Orchestrator may not impersonate QA');
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'bug_fix', producedBy: 'bug_fix' }).outcome, 'refused');
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'nobody_registered' }).outcome, 'refused');
  });

  test('a person may pass work, unless they are the producer', () => {
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'user:1234' }).outcome, 'routed');
    assert.equal(routeQaPassed({ ...base, verifiedBy: 'user:1234', producedBy: 'user:1234' }).code, 'qa_not_independent');
  });

  test('a pass for another commit is stale: the changed build is verified again', () => {
    const d = routeQaPassed({ ...base, currentCommit: 'def456def456def4' });
    assert.equal(d.outcome, 'held');
    assert.equal(d.code, 'stale_qa_pass');
    assert.equal(d.requiresIndependentQa, true);
  });

  test('a pass that names no commit, or a build with no commit, cannot be tied to the build and is held', () => {
    assert.equal(routeQaPassed({ ...base, qaCommit: null }).code, 'qa_commit_unknown');
    assert.equal(routeQaPassed({ ...base, currentCommit: null }).code, 'qa_commit_unknown');
  });

  test('a security-sensitive task waits for its security review even after QA passed', () => {
    const d = routeQaPassed({ ...base, securityReviewRequired: true, securityReviewDone: false });
    assert.equal(d.outcome, 'held');
    assert.equal(d.code, 'security_review_pending');
    assert.equal(d.toAgent, 'security_review');
    assert.equal(routeQaPassed({ ...base, securityReviewRequired: true, securityReviewDone: true }).outcome, 'routed');
  });

  test('open dependencies hold it', () => {
    assert.equal(routeQaPassed({ ...base, openDependencies: 2 }).code, 'dependencies_open');
  });

  test('independence is checked before anything else: a non-independent pass is never merely "held"', () => {
    const d = routeQaPassed({ ...base, verifiedBy: 'backend_developer', currentCommit: 'other', securityReviewRequired: true, openDependencies: 1 });
    assert.equal(d.code, 'qa_not_independent');
  });
});

describe('C. each decision is recorded through projects.routing_decisions', () => {
  const ctx = { organizationId: 'o', projectId: 'p', planId: 'plan', taskId: 't', policyVersion: 'v1' };

  test('the row has the columns routing_decisions takes, and an outcome its CHECK allows', () => {
    const migration = read('supabase/migrations/20261031290000_evidence_is_traceable_decisions_are_recorded_documents_are_derived.sql');
    const row = routingDecisionRow(routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: enabled('bug_fix') }), ctx);
    for (const column of ['organization_id', 'project_id', 'plan_id', 'task_id', 'to_agent', 'outcome', 'code', 'reason']) {
      assert.ok(column in row, column);
      assert.match(migration, new RegExp(`\\b${column}\\b`));
    }
    assert.match(migration, /outcome\s+text not null check \(outcome in \('routed', 'held', 'refused'\)\)/);
    for (const decision of [
      routeQaPassed({ producedBy: 'a', verifiedBy: 'quality_assurance', qaCommit: 'x', currentCommit: 'x', securityReviewRequired: false, securityReviewDone: false, openDependencies: 0 }),
      routeQaPassed({ producedBy: 'a', verifiedBy: 'a', qaCommit: 'x', currentCommit: 'x', securityReviewRequired: false, securityReviewDone: false, openDependencies: 0 }),
      routeQaFailed({ originalSpecialist: null, failureKind: 'defect', attempt: 9, enabled: new Map() }),
    ]) {
      assert.ok(['routed', 'held', 'refused'].includes(routingDecisionRow(decision, ctx).outcome));
    }
  });

  test('(task, outcome, code) is the dedupe key: the same facts produce the same key, so a replay records nothing twice', () => {
    const a = routingDecisionRow(routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: enabled('bug_fix') }), ctx);
    const b = routingDecisionRow(routeQaFailed({ originalSpecialist: 'frontend_developer', failureKind: 'defect', attempt: 1, enabled: enabled('bug_fix') }), ctx);
    assert.deepEqual([a.task_id, a.outcome, a.code], [b.task_id, b.outcome, b.code]);
    const service = read('src/modules/orchestrator/orchestrator-service.ts');
    assert.match(service, /onConflict: 'task_id,outcome,code', ignoreDuplicates: true/);
  });

  test('a refusal is escalated to a person with the reason', () => {
    const service = read('src/modules/orchestrator/orchestrator-service.ts');
    assert.match(service, /if \(decision\.outcome === 'refused'\)/);
    assert.match(service, /from\('orchestrator_escalations'\)/);
  });

  test('the event names are the specification\'s', () => {
    assert.deepEqual(QA_EVENTS, { failed: 'DevelopmentTaskQAFailed', passed: 'DevelopmentTaskQAPassed' });
  });
});
