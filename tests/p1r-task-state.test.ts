// Round 4, Orchestrator and Coordination: the 14-state task machine, the unified result envelope, and the escalation sweep. The database half is proved in
// scripts/verify-p1r-orchestrator.sql; this proves the TypeScript contract matches the migration and that the sweep is connected to the tick.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

import { sweepCoordinationAllOrganizations } from '../src/modules/orchestrator/p1o-coordination-sweep.ts';
import { sweepHandoffEscalations } from '../src/modules/orchestrator/p1r-escalation-sweep.ts';
import { DOOR_STATES, EXCEPTION_STATES, MAIN_LINE, PERSON_ONLY_STATES, TASK_STATES, nextDoorStep, parseResultEnvelope } from '../src/modules/orchestrator/p1r-task-state.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const migrationName = readdirSync(new URL('../supabase/migrations/', import.meta.url)).find((f) => f.startsWith('20261203000000_p1r_a_'));
const migration = migrationName ? read(`supabase/migrations/${migrationName}`) : '';

describe('P1R the task machine vocabulary matches the migration', () => {
  test('the migration exists', () => assert.ok(migration.length > 1000));
  test('the main line is the same fourteen states in the same order', () => {
    const m = /ai\.p1r_main_line\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(migration);
    assert.ok(m);
    const sql = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.deepEqual(sql, [...MAIN_LINE]);
    assert.equal(MAIN_LINE.length, 14);
  });
  test('the check constraint lists every state, main line and exceptions, and nothing else', () => {
    const m = /add constraint p1r_handoffs_task_state check \(task_state in \(([^)]+)\)\)/.exec(migration);
    assert.ok(m);
    const sql = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(sql, [...TASK_STATES].sort());
    assert.deepEqual([...EXCEPTION_STATES].sort(), ['blocked', 'cancelled', 'escalated', 'expired', 'failed', 'retrying']);
  });
  test('the door takes exactly the states the TypeScript offers, and VERIFIED/CLOSED are the person-only pair', () => {
    const m = /if p_to_state not in \(([^)]+)\) then/.exec(migration);
    assert.ok(m);
    const sql = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(sql, [...DOOR_STATES].sort());
    assert.deepEqual([...PERSON_ONLY_STATES], ['verified', 'closed']);
    assert.match(migration, /if p_to_state in \('verified', 'closed'\) then\s{1,}if \(select auth\.uid\(\)\) is null then return query select 'person_required'/);
  });
  test('the next step is the next state on the line, or null where the work itself moves the task', () => {
    assert.equal(nextDoorStep('ready'), 'dispatched');
    assert.equal(nextDoorStep('in_progress'), 'waiting_for_result');
    assert.equal(nextDoorStep('accepted'), 'handoff_ready');
    assert.equal(nextDoorStep('verified'), 'closed');
    assert.equal(nextDoorStep('closed'), null);
    assert.equal(nextDoorStep('dispatched'), null, 'ACKNOWLEDGED is the receiver accepting: not a door');
    assert.equal(nextDoorStep('blocked'), null);
  });
});

describe('P1R the result envelope', () => {
  const good = {
    runId: '00000000-0000-4000-8000-000000000001', handoffId: null, agent: 'sales', status: 'succeeded', validationStatus: 'not_validated', warnings: ['x'],
    errorClass: null, attempt: 1, provider: 'anthropic', model: 'm', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costMinor: 3, nextAction: 'validate', dodEvidence: [], policyVersion: 'routing:3', taskState: null,
  };
  test('an envelope in the agreed shape parses', () => assert.equal(parseResultEnvelope(good).ok, true));
  test('a missing field, an unknown status or an extra field is refused with the problem named', () => {
    const { usage: _usage, ...noUsage } = good;
    const a = parseResultEnvelope(noUsage);
    assert.ok(!a.ok && a.problems.some((p) => p.startsWith('usage')));
    assert.equal(parseResultEnvelope({ ...good, status: 'weird' }).ok, false);
    assert.equal(parseResultEnvelope({ ...good, secret: 'x' }).ok, false);
    assert.equal(parseResultEnvelope(null).ok, false);
  });
  test('the migration builds exactly the keys the schema reads', () => {
    const m = /return jsonb_build_object\(([\s\S]*?)\n\s{2}\);\nend \$\$;/.exec(migration);
    assert.ok(m);
    const keys = [...m[1]!.matchAll(/^\s+'([A-Za-z]+)',/gm)].map((x) => x[1]).filter((k) => !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(k!));
    assert.deepEqual([...keys].sort(), Object.keys(good).sort());
  });
});

describe('P1R the escalation sweep', () => {
  test('it calls the runner door for its own organisation, passing no deadline', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const admin = { schema: () => ({ rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data: [{ timed_out: 2, permission_conflicts: 1, expired: 0 }], error: null }); } }) } as never;
    const r = await sweepHandoffEscalations(admin, 'org-1');
    assert.deepEqual(calls, [{ fn: 'p1r_sweep_handoff_escalations', args: { p_organization_id: 'org-1' } }]);
    assert.ok(r.status === 'succeeded' && r.outcome === 'escalated' && /2 task\(s\) escalated for timeout, 1 for a permission conflict/.test(r.detail));
  });
  test('a failed read is a retryable failure, not "nothing to escalate"', async () => {
    const admin = { schema: () => ({ rpc: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) } as never;
    const r = await sweepHandoffEscalations(admin, 'o');
    assert.ok(r.status === 'failed' && r.permanent === false);
  });
  test('the tick sweeps every organisation for escalations too, and counts a failure of it', async () => {
    const seen: string[] = [];
    const admin = {
      schema: () => ({
        from: () => ({ select: () => Promise.resolve({ data: [{ id: 'o1' }, { id: 'o2' }], error: null }) }),
        rpc: (fn: string, args: { p_organization_id: string }) => {
          seen.push(`${fn}:${args.p_organization_id}`);
          if (fn === 'p1r_sweep_handoff_escalations' && args.p_organization_id === 'o2') return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: fn === 'p1o_invalidate_stale_handoffs' ? [{ withdrawn: 0, blocked: 0 }] : [{ expired: 0 }], error: null });
        },
      }),
    } as never;
    const r = await sweepCoordinationAllOrganizations(admin);
    assert.ok(seen.includes('p1r_sweep_handoff_escalations:o1') && seen.includes('p1r_sweep_handoff_escalations:o2'));
    assert.equal(r.failed, 1);
  });
  test('the idle tick of the job runner still runs the coordination sweep (the connection)', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /const coordination = idleTick \? await sweepCoordinationAllOrganizations\(admin\) : null;/);
    assert.match(read('src/modules/orchestrator/p1o-coordination-sweep.ts'), /await sweepHandoffEscalations\(admin, org\.id\)/);
  });
  test('the sweep never passes a deadline: the maximum wait is the owner\'s decision', () => {
    assert.doesNotMatch(read('src/modules/orchestrator/p1r-escalation-sweep.ts'), /p_expire_after:/);
  });
});

describe('P1R the task page reads the history and the envelopes', () => {
  const page = read('app/(internal)/operations/task-board/[handoffId]/page.tsx');
  test('it reads the history and the run envelopes, and offers the next step only to an administrator', () => {
    assert.match(page, /await readTaskHistory\(handoffId\)/);
    assert.match(page, /await readTaskRunEnvelopes\(/);
    assert.match(page, /admin && nextStep \? /);
  });
  test('the history read treats an error as unreadable, never as empty', () => {
    const src = read('src/modules/orchestrator/p1o-coordination.ts');
    assert.equal((src.match(/if \(error\) unreadable\(/g) ?? []).length >= 5, true);
  });
});
