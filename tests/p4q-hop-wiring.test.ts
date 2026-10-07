import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLERS, HANDLER_JOB_KIND } from '../src/lib/events/catalog.ts';
import { PHASE_FOUR_TASK_TYPES, envelopeInputFor, runPhaseFourHop, runPhaseFourWorkflowHop, taskTypeForJobKind } from '../src/modules/p4q/hop.ts';

/**
 * W-O2: a Phase 4 hop is dispatched inside its ExecutionEnvelope. Behaviour is driven with scripted doors; the two dispatch paths in the runner are pinned as
 * source, so deleting the wrapper turns a test red.
 */
const P = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444';

type Call = { fn: string; args: Record<string, unknown> };
function doors(script: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const admin = {
    schema: () => ({
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        const d = script[fn];
        return Promise.resolve(d ? { data: d(args), error: null } : { data: null, error: { message: `no door ${fn}` } });
      },
    }),
  } as never;
  return { admin, calls };
}

const uiJob = { id: 'job-1', payload: { eventType: 'project.ui_version_drafted', subjectType: 'ui_version', subjectId: V, event: { projectId: P, phaseFourId: F } } };
const reviewKind = HANDLER_JOB_KIND['quality_assurance:reviewUIVersion'];

describe('the hop table agrees with the task-type rows and the catalog', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261126300000_a_phase_four_hop_has_a_persisted_envelope_a_classed_failure_and_one_trace.sql', import.meta.url), 'utf8');
  const rows = [...migration.matchAll(/\('([a-z0-9_.]+)', '[a-z_.]+', '([a-z_]+:[A-Za-z0-9]+)', '[a-z_]+', \d+,/g)].map((m) => [String(m[2]), String(m[1])] as const);

  test('every task_type row has the same handler -> task type here, and every handler is a catalog handler', () => {
    assert.equal(rows.length, 11);
    for (const [handler, taskType] of rows) {
      assert.equal(PHASE_FOUR_TASK_TYPES[handler], taskType, handler);
      assert.ok((HANDLERS as readonly string[]).includes(handler), handler);
    }
    assert.equal(Object.keys(PHASE_FOUR_TASK_TYPES).length, rows.length);
  });

  test('a job kind finds its task type, and an unrelated kind finds none', () => {
    assert.equal(taskTypeForJobKind(reviewKind), 'ui.qa_review');
    assert.equal(taskTypeForJobKind(HANDLER_JOB_KIND['crm:routeLead']), null);
  });
});

describe('the envelope input comes only from ids the event carries', () => {
  test('project, phase four and the subject become exact references; the job id is the idempotency key', () => {
    assert.deepEqual(envelopeInputFor(uiJob, 'ui.qa_review'), { projectId: P, taskType: 'ui.qa_review', exactRefs: { phaseFourId: F, uiVersionId: V }, idempotencyKey: 'job-1' });
  });
  test('no project in the event, or no reference at all, means no envelope (the hop runs as before)', () => {
    assert.equal(envelopeInputFor({ id: 'j', payload: { subjectType: 'ui_version', subjectId: V, event: {} } }, 'ui.qa_review'), null);
    assert.equal(envelopeInputFor({ id: 'j', payload: { event: { projectId: P } } }, 'ui.qa_review'), null);
    assert.equal(envelopeInputFor({ id: 'j', payload: { subjectType: 'ui_version', subjectId: 'latest', event: { projectId: P } } }, 'ui.qa_review'), null);
  });
});

describe('an event job runs inside its envelope', () => {
  test('opened -> the work runs once -> the envelope completes', async () => {
    const { admin, calls } = doors({ p4q_open_envelope: () => [{ outcome: 'opened', envelope_id: E }], p4q_complete_envelope: () => [{ outcome: 'completed' }] });
    let ran = 0;
    const r = await runPhaseFourHop(admin, reviewKind, uiJob, async () => (ran += 1, { status: 'succeeded', outcome: 'ok', detail: 'done' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(ran, 1);
    assert.deepEqual(calls.map((c) => c.fn), ['p4q_open_envelope', 'p4q_complete_envelope']);
    assert.equal(calls[0]?.args.p_task_type, 'ui.qa_review');
    assert.equal(calls[0]?.args.p_idempotency_key, 'job-1');
  });

  test('a failed hop is recorded as a classed failure and a spent budget parks it with the escalation', async () => {
    const { admin, calls } = doors({
      p4q_open_envelope: () => [{ outcome: 'opened', envelope_id: E }],
      p4q_record_failure: () => [{ outcome: 'escalated', attempts: 3 }],
    });
    const r = await runPhaseFourHop(admin, reviewKind, uiJob, async () => ({ status: 'failed', permanent: false, detail: 'the model was unavailable' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.status === 'failed' && r.permanent, true);
    assert.match(r.status === 'failed' ? r.detail : '', /escalated to a person after 3 attempt/);
    assert.deepEqual(calls.map((c) => c.fn), ['p4q_open_envelope', 'p4q_record_failure']);
  });

  test('a disabled specialist is never bypassed: the work does not run and the job is held', async () => {
    const { admin } = doors({ p4q_open_envelope: () => [{ outcome: 'agent_disabled', envelope_id: null }] });
    let ran = 0;
    const r = await runPhaseFourHop(admin, reviewKind, uiJob, async () => (ran += 1, { status: 'succeeded', outcome: 'ok', detail: '' }));
    assert.equal(ran, 0);
    // held, not dead: a disabled specialist is the installed default and no job dies for it; the escalation is on the record
    assert.equal(r.status, 'succeeded');
    assert.equal(r.status === 'succeeded' && r.outcome, 'held_specialist_disabled');
  });

  test('an envelope the door cannot take (stale reference, door missing) lets the hop run exactly as before', async () => {
    for (const script of [{ p4q_open_envelope: () => [{ outcome: 'ref_not_in_project', envelope_id: null }] }, {} as Record<string, (a: Record<string, unknown>) => unknown>]) {
      const { admin } = doors(script);
      let ran = 0;
      const r = await runPhaseFourHop(admin, reviewKind, uiJob, async () => (ran += 1, { status: 'succeeded', outcome: 'ok', detail: '' }));
      assert.equal(ran, 1);
      assert.equal(r.status, 'succeeded');
    }
  });

  test('a job that is not a Phase 4 hop never touches the envelope doors', async () => {
    const { admin, calls } = doors({});
    const r = await runPhaseFourHop(admin, HANDLER_JOB_KIND['crm:routeLead'], uiJob, async () => ({ status: 'succeeded', outcome: 'ok', detail: '' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(calls.length, 0);
  });
});

describe('a workflow job runs inside its envelope', () => {
  const reviseKind = HANDLER_JOB_KIND['ui_designer:reviseUIVersion'];
  const job = { ...uiJob, kind: reviseKind };

  test('its own outcome comes back unchanged on success and on a retryable failure', async () => {
    const ok = doors({ p4q_open_envelope: () => [{ outcome: 'opened', envelope_id: E }], p4q_complete_envelope: () => [{ outcome: 'completed' }] });
    const out = await runPhaseFourWorkflowHop(ok.admin, job, async () => ({ status: 'succeeded', reason: 'revised', runId: 'r1' }), async () => assert.fail('not parked'));
    assert.deepEqual(out, { status: 'succeeded', reason: 'revised', runId: 'r1' });

    const retry = doors({ p4q_open_envelope: () => [{ outcome: 'opened', envelope_id: E }], p4q_record_failure: () => [{ outcome: 'retry', attempts: 1 }] });
    const failed = await runPhaseFourWorkflowHop(retry.admin, job, async () => ({ status: 'failed', reason: 'provider error', detail: 'timeout' }), async () => assert.fail('not parked'));
    assert.equal(failed.status, 'failed');
    assert.equal((failed as { reason: string }).reason, 'provider error');
  });

  test('a spent budget parks the job and says why', async () => {
    const { admin } = doors({ p4q_open_envelope: () => [{ outcome: 'opened', envelope_id: E }], p4q_record_failure: () => [{ outcome: 'escalated', attempts: 3 }] });
    let parked = '';
    const out = await runPhaseFourWorkflowHop(admin, job, async () => ({ status: 'failed', reason: 'provider error', detail: 'timeout' }), async (d) => void (parked = d));
    assert.equal(out.status, 'failed');
    assert.match(parked, /escalated to a person/);
  });

  test('a disabled specialist: the workflow does not run and the job is held, not parked', async () => {
    const { admin } = doors({ p4q_open_envelope: () => [{ outcome: 'agent_disabled', envelope_id: null }] });
    let ran = 0;
    let parked = '';
    let settled = '';
    const out = await runPhaseFourWorkflowHop(admin, job, async () => (ran += 1, { status: 'succeeded', reason: 'x' }), async (d) => void (parked = d), async (d) => void (settled = d));
    assert.equal(ran, 0);
    assert.equal(parked, '');
    assert.match(settled, /disabled/);
    assert.equal(out.status, 'succeeded');
  });
});

describe('a model answer that fails its schema is retried, not escalated', () => {
  test('failureClassFor treats it as transient, and still calls a bad input a validation failure', async () => {
    const { failureClassFor } = await import('../src/modules/p4q/envelope.ts');
    assert.equal(failureClassFor({ status: 'failed', permanent: false, detail: 'model output failed schema validation - screens: Invalid input' }), 'transient');
    assert.equal(failureClassFor({ status: 'failed', permanent: false, detail: 'the payload is malformed' }), 'validation');
  });
});

describe('the runner calls the wrappers on both dispatch paths', () => {
  const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
  test('runEventJobs wraps the handler call', () => {
    assert.match(route, /result = await runPhaseFourHop\(admin, kind, job, \(\) => handler\(admin, job\)\);/);
    assert.doesNotMatch(route, /result = await handler\(admin, job\);/);
  });
  test('runOneAgentJob wraps the workflow call and parks a job whose budget is spent', () => {
    assert.match(route, /await runPhaseFourWorkflowHop\(\s+admin,\s+job,\s+\(\) => workflow\.run\(\{ admin, job, agent, correlationId, workClass: workflow\.workClass \}\),/);
    assert.match(route, /status: 'dead', last_error: detail\.slice\(0, 1000\)/);
  });
});
