import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { handleP4qClarificationAnswered, jobKindsOwnedBy } from '../src/modules/p4q/clarification-return.ts';
import { openBlockedRequirementEscalation } from '../src/modules/p4q/escalation.ts';
import { region } from './_region.ts';

/**
 * W-P3 (an answered clarification goes back to the agent that asked) and W-P4 (a refused Task 2 start opens the project's escalation).
 * Behaviour is driven with a fake database; the runner and catalog wiring are pinned as source.
 */

type Row = Record<string, unknown>;
type Call = { fn: string; args: Record<string, unknown> };

/** A fake whose tables answer .select().eq()...(maybeSingle | await) and whose doors are scripted. */
function fake(tables: Record<string, Row[]>, doors: Record<string, (a: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const admin = {
    schema: (schemaName: string) => ({
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        let inFilter: [string, readonly unknown[]] | null = null;
        const rows = (): Row[] =>
          (tables[`${schemaName}.${table}`] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v) && (!inFilter || inFilter[1].includes(r[inFilter[0]])));
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push([c, v]), b),
          in: (c: string, v: readonly unknown[]) => ((inFilter = [c, v]), b),
          order: () => b,
          limit: () => b,
          maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
        };
        return b;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        const door = doors[fn];
        return Promise.resolve(door ? { data: door(args), error: null } : { data: null, error: { message: `no door ${fn}` } });
      },
    }),
  } as never;
  return { admin, calls };
}

const job = (subjectId: string | null) => ({ id: 'job-1', organization_id: 'org', payload: subjectId ? { subjectId, eventType: 'x' } : {}, correlation_id: null }) as never;

describe('W-P4 a refused Task 2 start opens the project escalation', () => {
  test('the helper calls the escalation door with cause blocked_requirement, owner admin, and the missing item', async () => {
    const { admin, calls } = fake({}, { p4q_open_escalation: () => [{ outcome: 'opened', escalation_id: 'e1' }] });
    assert.equal(await openBlockedRequirementEscalation(admin, 'proj', 'Task 2 cannot start: nothing is ready.'), 'opened');
    assert.equal(calls[0]?.fn, 'p4q_open_escalation');
    assert.equal(calls[0]?.args.p_cause, 'blocked_requirement');
    assert.equal(calls[0]?.args.p_owner, 'admin');
    assert.match(String(calls[0]?.args.p_reason), /nothing is ready/);
  });

  test('a door that fails is reported, never thrown', async () => {
    const { admin } = fake({}, {});
    assert.equal(await openBlockedRequirementEscalation(admin, 'proj', 'x is missing here'), 'failed');
  });

  test('start_phase_four answering not_ready opens the escalation, before the same permanent failure is returned', () => {
    const src = readFileSync(new URL('../src/modules/projects/handlers.ts', import.meta.url), 'utf8');
    const body = region(src, 'export async function handlePhaseFourReady', 'export async function handlePossibleScopeChangeDetected');
    const notReady = body.indexOf("case 'not_ready':");
    const ask = body.indexOf('await openBlockedRequirementEscalation(', notReady);
    const refusal = body.indexOf('No ready Phase 3 handoff exists for this project', notReady);
    assert.ok(notReady > 0 && ask > notReady && refusal > ask, 'the escalation is opened inside the not_ready branch, before the refusal is returned');
    assert.match(body, /permanent: true,\n\s+detail: 'No ready Phase 3 handoff exists/);
  });

  test('a hand-off the row says is not ready opens it too, before any start is attempted', () => {
    const src = readFileSync(new URL('../src/modules/projects/handlers.ts', import.meta.url), 'utf8');
    const body = region(src, 'export async function handlePhaseFourReady', 'export async function handlePossibleScopeChangeDetected');
    const rowSays = body.indexOf('if (!handoff.phase_four_ready) {');
    const ask = body.indexOf('await openBlockedRequirementEscalation(', rowSays);
    const door = body.indexOf("rpc('start_phase_four'");
    assert.ok(rowSays > 0 && ask > rowSays && door > ask);
  });
});

describe('W-P3 an answered clarification goes back to the agent that asked', () => {
  const answered = { id: 'c1', organization_id: 'org', project_id: 'proj', ui_version_id: 'v1', raised_by: 'ui_designer', status: 'answered' };
  const deadJob = (id: string, kind: string, subjectId: string | null, projectId: string | null) => ({ id, organization_id: 'org', status: 'dead', kind, payload: { subjectId, event: { projectId } } });
  const designerKind = HANDLER_JOB_KIND['ui_designer:reviseUIVersion'];

  test('the asking agent owns the job kinds its handlers are named for', () => {
    assert.ok(jobKindsOwnedBy('ui_designer').includes(designerKind));
    assert.ok(!jobKindsOwnedBy('ui_designer').includes(HANDLER_JOB_KIND['ui_prototype:reviseBuild']));
  });

  test("only the asking agent's stopped work for this clarification is requeued, with the reason recorded", async () => {
    const { admin, calls } = fake(
      {
        'projects.clarification_requests': [answered],
        'core.jobs': [
          deadJob('j-mine', designerKind, 'v1', 'proj'),
          deadJob('j-other-version', designerKind, 'v9', 'other-project'),
          deadJob('j-other-agent', HANDLER_JOB_KIND['ui_prototype:reviseBuild'], 'v1', 'proj'),
        ],
      },
      { requeue_job_with_reason: () => [{ outcome: 'requeued', job_status: 'queued', attempts: 3 }] },
    );
    const r = await handleP4qClarificationAnswered(admin, job('c1'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'returned');
    assert.deepEqual(calls.map((c) => c.args.p_job_id), ['j-mine']);
    assert.match(String(calls[0]?.args.p_reason), /clarification c1 was answered/);
  });

  test('nothing stopped means the answer stays on the clarification and nothing is requeued', async () => {
    const { admin, calls } = fake({ 'projects.clarification_requests': [answered], 'core.jobs': [] }, {});
    const r = await handleP4qClarificationAnswered(admin, job('c1'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'nothing_waiting');
    assert.equal(calls.length, 0);
  });

  test('the ROW is the authority: an unanswered clarification, a missing one and a non-Phase-4 asker are all left alone', async () => {
    for (const [rows, expected] of [
      [[{ ...answered, status: 'open' }], 'not_mine'],
      [[], 'gone'],
      [[{ ...answered, raised_by: 'sales' }], 'not_mine'],
    ] as const) {
      const { admin, calls } = fake({ 'projects.clarification_requests': [...rows], 'core.jobs': [] }, {});
      const r = await handleP4qClarificationAnswered(admin, job('c1'));
      assert.equal(r.status === 'succeeded' && r.outcome, expected);
      assert.equal(calls.length, 0);
    }
  });

  test('the event is subscribed, its handler has a job kind, and the runner drains it', () => {
    assert.ok(HANDLERS.includes('projects:returnClarificationAnswer'));
    assert.equal(HANDLER_JOB_KIND['projects:returnClarificationAnswer'], 'p4q.clarification_return');
    assert.deepEqual(SUBSCRIPTIONS['project.p4q_clarification_answered'], ['projects:returnClarificationAnswer']);
    const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
    assert.match(route, /runEventJobs\(admin, P4Q_CLARIFICATION_RETURN_JOB_KIND, handleP4qClarificationAnswered, 'runP4qClarificationReturnJobs'\)/);
    assert.match(route, /const P4Q_CLARIFICATION_RETURN_JOB_KIND = HANDLER_JOB_KIND\['projects:returnClarificationAnswer'\];/);
  });

  test('the PM classifier raises its clarification through the p4q door (with the old insert only as the fallback)', () => {
    const wf = readFileSync(new URL('../app/api/jobs/run/workflows.ts', import.meta.url), 'utf8');
    const a = wf.indexOf("if (classification === 'CLARIFICATION') {");
    const b = wf.indexOf("} else if (classification === 'POSSIBLE_SCOPE_CHANGE') {", a);
    assert.ok(a > 0 && b > a);
    const branch = wf.slice(a, b);
    assert.ok(branch.indexOf("'p4q_raise_clarification'") > 0);
    assert.ok(branch.indexOf(".from('clarification_requests')") > branch.indexOf("'p4q_raise_clarification'"));
    assert.match(branch, /falling back to a direct request/);
  });
});

describe('W-P4 the start-Phase-4 handler is wired to the escalation on both refusals', () => {
  test('both refusal paths call openBlockedRequirementEscalation', () => {
    const src = readFileSync(new URL('../src/modules/projects/handlers.ts', import.meta.url), 'utf8');
    assert.equal(src.match(/await openBlockedRequirementEscalation\(/g)?.length, 2);
  });
});
