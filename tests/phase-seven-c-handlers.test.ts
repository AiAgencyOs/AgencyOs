import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sweepSupportAndHealth } from '../src/modules/orchestrator/sweeps.ts';
import { handleCreateDraftHandoverPackage, handleOpenSupportTicketFromMessage } from '../src/modules/projects/phase-seven-handlers.ts';

/**
 * Phase 7c / 8A runner jobs against a scripted database: a client's support message opens a ticket, a validated production gets a DRAFT handover package, and the
 * Phase 8A sweeps run on the cron tick. The decisions are the DATABASE doors' (scripts/verify-phase-seven-c.sql proves them live); these jobs call a door under
 * the JOB's organization and report. They reply to no one, send nothing, and deliver nothing.
 */

type Call = { fn: string; args: Record<string, unknown> };
function stubAdmin(script: { rpc: Record<string, unknown>; rpcError?: string[]; rpcThrows?: string[] }) {
  const calls: Call[] = [];
  const schemas: string[] = [];
  const admin = {
    schema: (schema: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        schemas.push(schema);
        calls.push({ fn, args });
        if (script.rpcThrows?.includes(fn)) throw new Error('socket hang up');
        if (script.rpcError?.includes(fn)) return { data: null, error: { message: 'boom' } };
        if (!(fn in script.rpc)) return { data: null, error: { message: `unexpected rpc ${fn}` } };
        return { data: script.rpc[fn], error: null };
      },
    }),
  };
  return { admin: admin as never, calls, schemas };
}
const job = (subjectId: string | null, eventType: string) => ({ id: 'j1', organization_id: 'org-1', correlation_id: null, payload: { eventType, subjectId } }) as never;

describe('message.received: a client support message opens a ticket through the service-role door', () => {
  test('the door is called with the JOB organization and the message id, and an opened ticket is reported', async () => {
    const { admin, calls, schemas } = stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: 'opened', ticket_id: 't1' }] } });
    const r = await handleOpenSupportTicketFromMessage(admin, job('msg-1', 'message.received'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'opened');
    assert.deepEqual(calls, [{ fn: 'open_support_ticket_from_message', args: { p_organization_id: 'org-1', p_message_id: 'msg-1' } }]);
    assert.deepEqual(schemas, ['projects']);
  });
  test('it opens a ticket and nothing else: no reply, no send, no classification, no assignment', async () => {
    const { admin, calls } = stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: 'opened' }] } });
    await handleOpenSupportTicketFromMessage(admin, job('msg-1', 'message.received'));
    assert.ok(!calls.some((c) => /send|reply|classify|assign|respond|message_client/i.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
  test('the organization is the job\'s, never the event payload\'s', async () => {
    const { admin, calls } = stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: 'duplicate' }] } });
    await handleOpenSupportTicketFromMessage(admin, { id: 'j', organization_id: 'org-1', correlation_id: null, payload: { eventType: 'message.received', subjectId: 'msg-1', organizationId: 'FORGED', projectId: 'FORGED' } } as never);
    assert.equal(calls[0]?.args.p_organization_id, 'org-1');
    assert.ok(!JSON.stringify(calls).includes('FORGED'));
  });
  test('every refusal of the door is a success that opens nothing, in its own words', async () => {
    for (const o of ['not_a_support_request', 'no_intent_label', 'intent_pending', 'not_a_client_message', 'not_a_project_conversation', 'no_phase_eight', 'workspace_not_active', 'not_found']) {
      const { admin } = stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: o }] } });
      const r = await handleOpenSupportTicketFromMessage(admin, job('m', 'message.received'));
      assert.equal(r.status, 'succeeded', o);
      assert.equal(r.status === 'succeeded' && r.outcome, o);
      assert.match(r.detail, /no ticket was opened|nothing was opened/, o);
    }
  });
  test('a duplicate delivery is a success: the same ticket is not opened twice', async () => {
    const { admin } = stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: 'duplicate', ticket_id: 't1' }] } });
    const r = await handleOpenSupportTicketFromMessage(admin, job('m', 'message.received'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'duplicate');
  });
  test('an event with no subject is a permanent failure; a door that does not answer, a throw-free error and an unknown answer are retryable failures', async () => {
    const none = await handleOpenSupportTicketFromMessage(stubAdmin({ rpc: {} }).admin, job(null, 'message.received'));
    assert.equal(none.status === 'failed' && none.permanent, true);
    const down = await handleOpenSupportTicketFromMessage(stubAdmin({ rpc: {}, rpcError: ['open_support_ticket_from_message'] }).admin, job('m', 'message.received'));
    assert.equal(down.status === 'failed' && down.permanent, false);
    for (const o of ['refused:bad_title', 'what']) {
      const odd = await handleOpenSupportTicketFromMessage(stubAdmin({ rpc: { open_support_ticket_from_message: [{ outcome: o }] } }).admin, job('m', 'message.received'));
      assert.equal(odd.status === 'failed' && odd.permanent, false, o);
    }
  });
});

describe('project.production_validated: a DRAFT handover package is created from the contract checklist, never delivered', () => {
  test('the door is called with the JOB organization and the workspace id', async () => {
    const { admin, calls } = stubAdmin({ rpc: { create_draft_handover_package_for_validated: [{ outcome: 'created', package_id: 'pk' }] } });
    const r = await handleCreateDraftHandoverPackage(admin, job('ph-1', 'project.production_validated'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'created');
    assert.match(r.detail, /DRAFT/);
    assert.deepEqual(calls, [{ fn: 'create_draft_handover_package_for_validated', args: { p_organization_id: 'org-1', p_phase_seven_id: 'ph-1' } }]);
  });
  test('it never submits, approves, delivers or records an acceptance', async () => {
    const { admin, calls } = stubAdmin({ rpc: { create_draft_handover_package_for_validated: [{ outcome: 'created' }] } });
    await handleCreateDraftHandoverPackage(admin, job('ph-1', 'project.production_validated'));
    assert.ok(!calls.some((c) => /submit|approve|deliver|decide|accept|complete/i.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
  test('no checklist, not validated, money not verified and an existing package are successes that create nothing', async () => {
    for (const [o, re] of [['contract_deliverables_missing', /no contract checklist/], ['production_not_validated', /no draft was created/], ['m4_not_verified', /no draft was created/], ['already_exists', /already exists/]] as const) {
      const r = await handleCreateDraftHandoverPackage(stubAdmin({ rpc: { create_draft_handover_package_for_validated: [{ outcome: o }] } }).admin, job('ph', 'project.production_validated'));
      assert.equal(r.status, 'succeeded', o);
      assert.match(r.detail, re, o);
    }
  });
  test('a workspace of another organization is "gone"', async () => {
    const r = await handleCreateDraftHandoverPackage(stubAdmin({ rpc: { create_draft_handover_package_for_validated: [{ outcome: 'not_found' }] } }).admin, job('ph', 'project.production_validated'));
    assert.equal(r.status === 'succeeded' && r.outcome, 'gone');
  });
  test('failures: no subject is permanent; an unreachable door and an unknown answer are retryable', async () => {
    const none = await handleCreateDraftHandoverPackage(stubAdmin({ rpc: {} }).admin, job(null, 'project.production_validated'));
    assert.equal(none.status === 'failed' && none.permanent, true);
    const down = await handleCreateDraftHandoverPackage(stubAdmin({ rpc: {}, rpcError: ['create_draft_handover_package_for_validated'] }).admin, job('ph', 'project.production_validated'));
    assert.equal(down.status === 'failed' && down.permanent, false);
    const odd = await handleCreateDraftHandoverPackage(stubAdmin({ rpc: { create_draft_handover_package_for_validated: [{ outcome: 'what' }] } }).admin, job('ph', 'project.production_validated'));
    assert.equal(odd.status === 'failed' && odd.permanent, false);
  });
});

describe('sweepSupportAndHealth: the Phase 8A sweeps run on the cron tick', () => {
  const ALL = {
    sweep_support_sla: [{ response_breaches: 1, resolution_breaches: 2, escalated: 3 }],
    sweep_phase_eight_health: [{ checked: 4, recorded: 1, unchanged: 3 }],
    sweep_checkins_due: [{ checked: 2, noticed: 2 }],
    sweep_message_support_tickets: [{ checked: 5, opened: 1 }],
    sweep_draft_handover_packages: [{ checked: 1, created: 1 }],
  };
  test('it calls the five service-role doors in order, in the projects schema, and reports each count', async () => {
    const { admin, calls, schemas } = stubAdmin({ rpc: ALL });
    const out = await sweepSupportAndHealth(admin);
    assert.deepEqual(calls.map((c) => c.fn), ['sweep_support_sla', 'sweep_phase_eight_health', 'sweep_checkins_due', 'sweep_message_support_tickets', 'sweep_draft_handover_packages']);
    assert.ok(schemas.every((s) => s === 'projects'));
    assert.deepEqual(out.sweep_support_sla, { response_breaches: 1, resolution_breaches: 2, escalated: 3 });
    assert.deepEqual(out.sweep_phase_eight_health, { checked: 4, recorded: 1, unchanged: 3 });
    assert.deepEqual(out.sweep_checkins_due, { checked: 2, noticed: 2 });
    assert.deepEqual(out.sweep_message_support_tickets, { checked: 5, opened: 1 });
    assert.deepEqual(out.sweep_draft_handover_packages, { checked: 1, created: 1 });
  });
  test('it contacts nobody: no door that sends, replies, renews, closes or delivers is among them', async () => {
    const { admin, calls } = stubAdmin({ rpc: ALL });
    await sweepSupportAndHealth(admin);
    assert.ok(!calls.some((c) => /send|reply|renew|close|deliver|bill|invoice|complete_check_in|skip_check_in/i.test(c.fn)), calls.map((c) => c.fn).join(','));
  });
  test('it passes no organization and no clock: the doors read their own', async () => {
    const { admin, calls } = stubAdmin({ rpc: ALL });
    await sweepSupportAndHealth(admin);
    for (const c of calls) assert.ok(!('p_organization_id' in c.args) && !('p_now' in c.args), c.fn);
  });
  test('a failing or throwing sweep is logged and the rest still run', async () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void logs.push(String(m));
    try {
      const { admin, calls } = stubAdmin({ rpc: ALL, rpcError: ['sweep_phase_eight_health'], rpcThrows: ['sweep_checkins_due'] });
      const out = await sweepSupportAndHealth(admin);
      assert.equal(calls.length, 5);
      assert.equal(out.sweep_phase_eight_health, null);
      assert.equal(out.sweep_checkins_due, null);
      assert.ok(out.sweep_support_sla && out.sweep_message_support_tickets && out.sweep_draft_handover_packages);
      assert.equal(logs.length, 2);
      assert.match(logs[0] ?? '', /sweep_phase_eight_health: boom/);
      assert.match(logs[1] ?? '', /sweep_checkins_due: socket hang up/);
    } finally {
      console.error = orig;
    }
  });
  test('a door that answers nothing is reported as null, never as zero', async () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void logs.push(String(m));
    try {
      const { admin } = stubAdmin({ rpc: { ...ALL, sweep_support_sla: [] } });
      const out = await sweepSupportAndHealth(admin);
      assert.equal(out.sweep_support_sla, null);
      assert.equal(logs.length, 1);
    } finally {
      console.error = orig;
    }
  });
});
