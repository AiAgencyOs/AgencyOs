import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { activateDesignerForRevision, gatePrototypeRevision, interpretDesignJobOutcome } from '../src/modules/p4q/revision-activation.ts';

/**
 * W-P1 / W-O1 / p4ui item 7: a Designer or Prototype revision passes the PM's classification and the p4ui activation record BEFORE a model is asked.
 * Behaviour is driven with a fake database (rows by table, doors by name); the workflow wiring is pinned as source between two named anchors.
 */

type Row = Record<string, unknown>;
type Fake = { tables: Record<string, Row[]>; doors: Record<string, (args: Record<string, unknown>) => unknown>; calls: string[] };

function fake(f: Partial<Fake>): { admin: never; calls: string[] } {
  const state: Fake = { tables: f.tables ?? {}, doors: f.doors ?? {}, calls: [] };
  const admin = {
    schema: () => ({
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push([c, v]), b),
          order: () => b,
          limit: () => b,
          maybeSingle: () => {
            const rows = (state.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
            return Promise.resolve({ data: rows[0] ?? null, error: null });
          },
        };
        return b;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        state.calls.push(fn);
        const door = state.doors[fn];
        if (!door) return Promise.resolve({ data: null, error: { message: `no door ${fn}` } });
        return Promise.resolve({ data: door(args), error: null });
      },
    }),
  } as never;
  return { admin, calls: state.calls };
}

const base = { organizationId: 'org', phaseFourId: 'p4', priorVersionId: 'v1', priorStatus: 'client_change', feedback: 'make the button bigger' };

describe('W-O1 / p4ui: the Designer is activated only by a classified design revision', () => {
  test('an unclassified client change WAITS (retryable) and nothing is requested', async () => {
    const { admin, calls } = fake({
      tables: { ui_version_client_decisions: [{ id: 'd1', ui_version_id: 'v1', organization_id: 'org', decision: 'change_requested' }] },
      doors: { p4q_decide_designer_revision: () => [{ outcome: 'awaiting_classification', allowed: false, reason: 'The PM has not classified this feedback yet' }] },
    });
    const r = await activateDesignerForRevision(admin, { ...base, source: 'client' });
    assert.equal(r.go, false);
    assert.equal(r.go === false && r.wait, true);
    assert.ok(!calls.includes('p4ui_request_design_job'));
  });

  test('a clarification / scope change is settled, not redrafted, and no design job is requested', async () => {
    const { admin, calls } = fake({
      tables: { ui_version_client_decisions: [{ id: 'd1', ui_version_id: 'v1', organization_id: 'org', decision: 'change_requested' }] },
      doors: { p4q_decide_designer_revision: () => [{ outcome: 'decided', allowed: false, reason: 'Possible new scope goes to a change request first' }] },
    });
    const r = await activateDesignerForRevision(admin, { ...base, source: 'client' });
    assert.equal(r.go, false);
    assert.equal(r.go === false && r.wait, false);
    assert.ok(!calls.includes('p4ui_request_design_job'));
  });

  test('a correction: gate, then the p4ui route, then the design job (in that order) -> go', async () => {
    const { admin, calls } = fake({
      tables: {
        ui_version_client_decisions: [{ id: 'd1', ui_version_id: 'v1', organization_id: 'org', decision: 'change_requested' }],
        client_feedback_classifications: [{ decision_id: 'd1', classification: 'CORRECTION', reasoning: 'a visual fix' }],
      },
      doors: {
        p4q_decide_designer_revision: () => [{ outcome: 'decided', allowed: true, reason: 'A correction' }],
        p4ui_route_ui_feedback: () => [{ outcome: 'routed', route: 'design_revision' }],
        p4ui_request_design_job: () => [{ outcome: 'requested', ref_id: 'job-1', route_to: null }],
      },
    });
    const r = await activateDesignerForRevision(admin, { ...base, source: 'client' });
    assert.deepEqual(r, { go: true, designJobId: 'job-1' });
    assert.deepEqual(calls, ['p4q_decide_designer_revision', 'p4ui_route_ui_feedback', 'p4ui_request_design_job']);
  });

  test('an Admin edit and a QA defect skip the client gate and ask for their own activation reason', async () => {
    for (const [source, status, trigger] of [['admin', 'admin_edit', 'admin_edit'], ['qa', 'qa_changes_required', 'design_qa_defect']] as const) {
      let asked: unknown;
      const { admin, calls } = fake({
        doors: {
          p4ui_request_design_job: (a) => ((asked = a.p_trigger), [{ outcome: 'requested', ref_id: 'j', route_to: null }]),
        },
      });
      const r = await activateDesignerForRevision(admin, { ...base, source, priorStatus: status });
      assert.equal(r.go, true);
      assert.equal(asked, trigger);
      assert.deepEqual(calls, ['p4ui_request_design_job']);
    }
  });

  test('door outcomes: the four named refusals skip the model; an unknown outcome is retried, never assumed', () => {
    for (const o of ['classification_required', 'not_a_design_revision', 'phase_blocked', 'locked']) {
      const r = interpretDesignJobOutcome(o, null, 'PM');
      assert.equal(r.go, false);
      assert.equal(r.go === false && r.wait, false, o);
    }
    for (const o of ['requested', 'exists']) assert.equal(interpretDesignJobOutcome(o, 'j', null).go, true);
    const unknown = interpretDesignJobOutcome('forbidden', null, null);
    assert.equal(unknown.go === false && unknown.wait, true);
  });
});

describe('W-P1: a prototype is rebuilt only for a classified correction or included revision', () => {
  const decided = { id: 'del1', organization_id: 'org', approval_request_id: 'req1' };

  test('an Admin edit or a QA defect needs no client classification', async () => {
    const { admin, calls } = fake({});
    assert.deepEqual(await gatePrototypeRevision(admin, { organizationId: 'org', deliverableId: 'del1', source: 'admin' }), { go: true, origin: 'admin' });
    assert.deepEqual(await gatePrototypeRevision(admin, { organizationId: 'org', deliverableId: 'del1', source: 'qa' }), { go: true, origin: 'qa' });
    assert.deepEqual(calls, []);
  });

  test('unclassified client feedback waits', async () => {
    const { admin } = fake({ tables: { deliverables: [decided] } });
    const r = await gatePrototypeRevision(admin, { organizationId: 'org', deliverableId: 'del1', source: 'client' });
    assert.equal(r.go, false);
    assert.equal(r.go === false && r.wait, true);
  });

  test('a clarification is settled with its routing and the prototype is not rebuilt', async () => {
    const { admin, calls } = fake({
      tables: {
        deliverables: [decided],
        p4q_prototype_feedback_classifications: [{ deliverable_id: 'del1', decision_key: 'req1', classification: 'CLARIFICATION', reasoning: 'unclear', routed_to: 'clarification', revision_allowed: false }],
      },
      doors: { p4q_prototype_revision_allowed: () => false },
    });
    const r = await gatePrototypeRevision(admin, { organizationId: 'org', deliverableId: 'del1', source: 'client' });
    assert.equal(r.go, false);
    assert.equal(r.go === false && r.wait, false);
    assert.equal(r.go === false && r.outcome, 'clarification');
    assert.ok(!calls.includes('p4ui_route_prototype_feedback'));
  });

  test('a correction is allowed and the p4ui prototype route is recorded', async () => {
    const { admin, calls } = fake({
      tables: {
        deliverables: [decided],
        p4q_prototype_feedback_classifications: [{ deliverable_id: 'del1', decision_key: 'req1', classification: 'CORRECTION', reasoning: 'typo', routed_to: 'prototype_revision', revision_allowed: true }],
      },
      doors: {
        p4q_prototype_revision_allowed: () => true,
        p4ui_route_prototype_feedback: () => [{ outcome: 'routed', route: 'prototype_revision' }],
      },
    });
    const r = await gatePrototypeRevision(admin, { organizationId: 'org', deliverableId: 'del1', source: 'client' });
    assert.deepEqual(r, { go: true, origin: 'client' });
    assert.deepEqual(calls, ['p4q_prototype_revision_allowed', 'p4ui_route_prototype_feedback']);
  });
});

const workflows = readFileSync(new URL('../app/api/jobs/run/workflows.ts', import.meta.url), 'utf8');
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `${from} .. ${to}`);
  return src.slice(a, b);
}

describe('the workflows ask before the model, and the classifier is a registered workflow', () => {
  test('ui_designer:reviseUIVersion activates the Designer before its model call', () => {
    const wf = between(workflows, 'const UI_VERSION_REVISE: AgentWorkflow', 'const CLASSIFY_CLIENT_FEEDBACK_PROMPT');
    const act = wf.indexOf('await activateDesignerForRevision(');
    const model = wf.indexOf('await callModel(');
    assert.ok(act > 0 && model > act);
    assert.match(wf, /if \(activation\.wait\) \{\s*await failJob\(admin, job, activation\.reason\);/);
  });

  test('ui_prototype:reviseBuild gates the rebuild before its model call', () => {
    const wf = between(workflows, 'const PROTOTYPE_BUILD_REVISE: AgentWorkflow', 'const PROTOTYPE_FEEDBACK_CLASSIFY_PROMPT');
    const gate = wf.indexOf('await gatePrototypeRevision(');
    const model = wf.indexOf('await callModel(');
    assert.ok(gate > 0 && model > gate);
  });

  test('the model-backed prototype classifier runs the p4q handler and is in the runnable list', () => {
    const wf = between(workflows, 'const PROTOTYPE_FEEDBACK_CLASSIFY: AgentWorkflow', 'The designer proposes two or three directions');
    assert.match(wf, /jobKind: 'prototype\.feedback_classify'/);
    assert.match(wf, /handleP4qClassifyPrototypeFeedback\(/);
    assert.match(workflows, /\n {2}PROTOTYPE_BUILD_REVISE,\n {2}PROTOTYPE_FEEDBACK_CLASSIFY,\n/);
  });

  test('the catalog subscribes the classifier to project.deliverable_decided', () => {
    assert.ok(HANDLERS.includes('project_manager:classifyPrototypeFeedback'));
    assert.equal(HANDLER_JOB_KIND['project_manager:classifyPrototypeFeedback'], 'prototype.feedback_classify');
    assert.ok(SUBSCRIPTIONS['project.deliverable_decided']?.includes('project_manager:classifyPrototypeFeedback'));
  });
});
