import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Phase 7 / 8 round-two staff action and the pure helpers around it, against a stand-in database that records every call. What is proved: what is refused
 * BEFORE the database is asked, what is forwarded (as which schema and door, with which arguments), that a door answer other than a success word is an ERROR
 * and never reported as done, that no agent-only door is reachable, and how a stored document is served. The doors themselves are proved in Postgres by
 * scripts/verify-p789-phase-seven-round2.sql, verify-p789-phase-eight-round2.sql and verify-p789-feedback-signal.sql.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

type Call = { schema: string; rpc: string; args: Record<string, unknown> };
let calls: Call[] = [];
let revalidated: string[] = [];
let role = 'owner';
let answers: Record<string, { data: unknown; error: { message: string } | null }> = {};

mock.module('next/cache', { exports: { revalidatePath: (p: string) => void revalidated.push(p) } });
mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: 'u1', organizationId: 'o1', roles: [] }) } });
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: (schema: string) => ({
        rpc: async (rpc: string, args: Record<string, unknown>) => {
          calls.push({ schema, rpc, args });
          return answers[rpc] ?? { data: [{ outcome: 'no answer' }], error: null };
        },
      }),
    }),
  },
});

const { p789RoundTwoAction } = await import('../src/modules/projects/p789-round2-actions.ts');
const { documentFileName, documentHeaders } = await import('../src/modules/projects/p789-document-http.ts');

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
};
const run = (entries: Record<string, string>) => p789RoundTwoAction({ status: 'idle' }, form(entries));
const ok = (outcome: string, rpc: string) => { answers[rpc] = { data: [{ outcome }], error: null }; };

beforeEach(() => {
  calls = [];
  revalidated = [];
  role = 'owner';
  answers = {};
});

describe('what is refused before the database is asked', () => {
  test('an unknown door, a prototype name, and a role without write permission', async () => {
    assert.equal((await run({ door: 'drop_everything' })).status, 'error');
    assert.equal((await run({ door: 'constructor' })).status, 'error');
    assert.equal((await run({ door: '__proto__' })).status, 'error');
    role = 'member';
    const r = await run({ door: 'certificate_render', projectId: ID });
    assert.equal(r.status, 'error');
    assert.equal(calls.length, 0);
  });
  test('a malformed id is refused with a word and never sent', async () => {
    const r = await run({ door: 'certificate_render', projectId: 'not-a-uuid' });
    assert.equal(r.status, 'error');
    assert.equal(calls.length, 0);
  });
  test('a retention decision states a period or indefinite, never both and never neither', async () => {
    assert.equal((await run({ door: 'retention_set', dataSet: 'client_feedback', mode: 'period', basis: 'ninety days then review' })).status, 'error');
    assert.equal((await run({ door: 'retention_set', dataSet: 'client_feedback', mode: 'indefinite', days: '90', basis: 'ninety days then review' })).status, 'error');
    assert.equal((await run({ door: 'retention_set', dataSet: 'client_feedback', mode: 'period', days: '10', basis: 'ninety days then review' })).status, 'error');
    assert.equal((await run({ door: 'retention_set', dataSet: 'diary', mode: 'indefinite', basis: 'ninety days then review' })).status, 'error');
    assert.equal(calls.length, 0);
  });
  test('a fail-over decision without its target, an alert threshold of zero and a short note are refused', async () => {
    const base = { door: 'provider_decision', incidentId: ID, providerKind: 'hosting', providerName: 'HostCo', decision: 'failover', evidenceRef: 'status page' };
    // the target is the database's rule too; the form forwards what it has and the door refuses
    ok('failover_target_required', 'p789_record_provider_decision');
    assert.equal((await run(base)).status, 'error');
    assert.equal((await run({ door: 'alert_rule_set', metric: 'check_ins_overdue', threshold: '0', reason: 'too many' })).status, 'error');
    assert.equal((await run({ door: 'alert_ack', alertId: ID, note: 'ok' })).status, 'error');
    assert.equal(calls.filter((c) => c.rpc !== 'p789_record_provider_decision').length, 0);
  });
});

describe('what is forwarded', () => {
  test('the certificate is rendered through the projects schema door', async () => {
    ok('rendered', 'render_completion_certificate');
    const r = await run({ door: 'certificate_render', projectId: ID });
    assert.equal(r.status, 'success');
    assert.deepEqual(calls, [{ schema: 'projects', rpc: 'render_completion_certificate', args: { p_project_id: ID } }]);
    assert.ok(revalidated.includes(`/projects/${ID}`));
  });
  test('a receipt is rendered through the FINANCE schema door', async () => {
    ok('rendered', 'p789_render_receipt_documents');
    await run({ door: 'receipt_render', receiptId: ID });
    assert.equal(calls[0]!.schema, 'finance');
    assert.deepEqual(calls[0]!.args, { p_receipt_id: ID });
  });
  test('a provider decision turns the next-check day into a morning in the future and passes the target', async () => {
    ok('recorded', 'p789_record_provider_decision');
    await run({ door: 'provider_decision', incidentId: ID, providerKind: 'hosting', providerName: 'HostCo', decision: 'failover', evidenceRef: 'status page', failoverTarget: 'StandbyHost' });
    assert.deepEqual(calls[0]!.args, { p_incident_id: ID, p_provider_kind: 'hosting', p_provider_name: 'HostCo', p_decision: 'failover', p_evidence_ref: 'status page', p_next_check_at: null, p_failover_target: 'StandbyHost' });
    calls = [];
    await run({ door: 'provider_decision', incidentId: ID, providerKind: 'dns', providerName: 'DnsCo', decision: 'wait', evidenceRef: 'status page', nextCheckOn: '2030-01-05' });
    assert.equal(calls[0]!.args.p_next_check_at, '2030-01-05T09:00:00.000Z');
  });
  test('an outage case sends the audit gap as a boolean and the day as the start of that day', async () => {
    ok('recorded', 'p789_record_outage_case');
    await run({ door: 'outage_record', kind: 'audit_store_failure', handling: 'work_held', observedOn: '2030-01-05', summary: 'the audit store was unreachable', auditGap: 'on' });
    assert.equal(calls[0]!.args.p_audit_gap, true);
    assert.equal(calls[0]!.args.p_observed_from, '2030-01-05T00:00:00.000Z');
  });
  test('a retention period and an indefinite decision map to the door arguments', async () => {
    ok('set', 'p789_set_retention_class');
    await run({ door: 'retention_set', dataSet: 'client_feedback', mode: 'period', days: '90', basis: 'ninety days then review' });
    assert.deepEqual(calls[0]!.args, { p_data_set: 'client_feedback', p_indefinite: false, p_retention_days: 90, p_basis: 'ninety days then review' });
    calls = [];
    await run({ door: 'retention_set', dataSet: 'client_feedback', mode: 'indefinite', basis: 'keep for the contract life' });
    assert.deepEqual(calls[0]!.args, { p_data_set: 'client_feedback', p_indefinite: true, p_retention_days: null, p_basis: 'keep for the contract life' });
  });
  test('a task is made from an acknowledged request through the person door, with optional assignee and day', async () => {
    ok('created', 'p789_create_task_from_followup');
    await run({ door: 'followup_task', requestId: ID, assigneeId: ID2, dueOn: '2030-02-01' });
    assert.deepEqual(calls[0]!.args, { p_request_id: ID, p_assignee_id: ID2, p_due_on: '2030-02-01' });
  });
});

describe('a door answer that is not a success word is an error', () => {
  for (const [door, rpc, entries, refusal] of [
    ['policy_set', 'p789_set_admin_notification_policy', { severity: 'sev1', channel: 'email', minutes: '30', reason: 'tell the owner fast' }, 'not_authorized'],
    ['notification_ack', 'p789_acknowledge_admin_notification', { notificationId: ID, note: 'seen and on it' }, 'not_authorized'],
    ['failover_approve', 'p789_approve_provider_failover', { recordId: ID, note: 'independent approval' }, 'self_approval'],
    ['failover_executed', 'p789_record_provider_failover_executed', { recordId: ID, evidence: 'ran the runbook' }, 'not_approved'],
    ['major_release', 'p789_record_major_release', { projectId: ID, versionLabel: 'v2', summary: 'a big new checkout flow', releaseRef: 'https://notes.example.test', releasedOn: '2030-01-01' }, 'no_phase_eight'],
    ['followup_task', 'p789_create_task_from_followup', { requestId: ID }, 'not_acknowledged_yet'],
    ['signal_review', 'p789_review_feedback_signal_draft', { draftId: ID, decision: 'reviewed', note: 'reads right' }, 'already_settled'],
    ['alert_ack', 'p789_acknowledge_alert', { alertId: ID, note: 'looking now' }, 'not_authorized'],
  ] as [string, string, Record<string, string>, string][]) {
    test(`${door}: ${refusal} is reported as written, never as done`, async () => {
      ok(refusal, rpc);
      const r = await run({ door, ...entries });
      assert.equal(r.status, 'error');
      assert.ok(r.message && !/^Done|Saved|Recorded/.test(r.message));
      assert.equal(revalidated.length, 0, 'a refusal revalidates nothing');
    });
  }
  test('a database failure is an error and says nothing was recorded', async () => {
    answers.render_completion_certificate = { data: null, error: { message: 'boom' } };
    const r = await run({ door: 'certificate_render', projectId: ID });
    assert.equal(r.status, 'error');
    assert.match(r.message ?? '', /nothing was recorded/);
  });
});

describe('structure', () => {
  test('the action file exports only async functions and reaches no agent-only door', () => {
    const src = read('src/modules/projects/p789-round2-actions.ts');
    assert.match(src, /^'use server';/);
    const exports = [...src.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(exports, ['async']);
    const rpcs = [...code('src/modules/projects/p789-round2-actions.ts').matchAll(/rpc: '([a-z_0-9]+)'/g)].map((m) => m[1]!);
    assert.ok(rpcs.length >= 18);
    assert.ok(!rpcs.includes('p789_record_feedback_signal_draft'), 'the agent door is not reachable from a form');
    assert.equal(new Set(rpcs).size, rpcs.length, 'no door is listed twice');
  });
  test('no object in the door table repeats a key', () => {
    const keys = [...code('src/modules/projects/p789-round2-actions.ts').matchAll(/^ {2}([a-z_]+): \{/gm)].map((m) => m[1]!);
    assert.equal(new Set(keys).size, keys.length);
  });
  test('every database door the form reaches is a person door in the migrations (no service-role grant)', () => {
    const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
    const sql = readdirSync(dir).filter((f) => /^202611291|^202611290|^202611292/.test(f)).map((f) => read(`supabase/migrations/${f}`)).join('\n');
    const personDoors = [...code('src/modules/projects/p789-round2-actions.ts').matchAll(/rpc: '([a-z_0-9]+)'/g)].map((m) => m[1]!).filter((n) => !['p789_sweep_client_action_reminders', 'p789_sweep_alerts', 'render_completion_certificate', 'p789_render_receipt_documents'].includes(n));
    for (const door of personDoors) {
      const re = new RegExp(`revoke all on function (projects|finance)\\.${door}\\([^)]*\\) from public, anon, service_role;`);
      assert.match(sql, re, `${door} must be uncallable by the service role`);
    }
  });
  test('the query files count every read failure', () => {
    const src = read('src/modules/projects/p789-round2-queries.ts');
    const errors = [...src.matchAll(/if \([a-z.]*error\)/g)].length;
    const unreadables = [...src.matchAll(/unreadable\(/g)].length;
    assert.equal(errors, unreadables);
    assert.ok(errors >= 10);
  });
});

describe('how a stored document is served', () => {
  test('as a download with a locked-down content policy, never inline', () => {
    const h = documentHeaders('certificate-CERT-ZP-1', 'a'.repeat(64));
    assert.match(h['Content-Disposition']!, /^attachment; filename="certificate-CERT-ZP-1\.html"$/);
    assert.match(h['Content-Security-Policy']!, /default-src 'none'/);
    assert.match(h['Content-Security-Policy']!, /sandbox/);
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Cache-Control'], 'private, no-store');
    assert.equal(h.ETag, `"${'a'.repeat(64)}"`);
  });
  test('a file name cannot carry a path, a quote or a header break', () => {
    assert.equal(documentFileName('../../etc/passwd'), 'etc-passwd.html');
    assert.equal(documentFileName('a"b\r\nSet-Cookie: x'), 'a-b-Set-Cookie-x.html');
    assert.equal(documentFileName('   '), 'document.html');
  });
  test('the routes are behind the session and answer a stranger 404, not 403', () => {
    for (const rel of ['app/api/p789/certificate/[projectId]/route.ts', 'app/api/p789/receipt/[paymentId]/route.ts']) {
      const src = read(rel);
      assert.match(src, /getAuthContext\(\)/);
      assert.match(src, /httpStatusFor\('UNAUTHORIZED'\)/);
      assert.match(src, /httpStatusFor\('NOT_FOUND'\)/);
      assert.ok(!/FORBIDDEN/.test(src));
      assert.match(src, /documentHeaders\(/);
    }
  });
});
