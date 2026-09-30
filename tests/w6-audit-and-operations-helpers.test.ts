import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { auditReason, auditRecordLink, isPrivilegedAction } from '../src/lib/audit/links.ts';
import { describeWorkflowCancel, planWorkflowCancel } from '../src/lib/observability/cancel-workflow-plan.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const PROJECT = '99999999-2222-4333-8444-555555555555';

describe('an audit entry links to the record it is about', () => {
  test('a subject the panel has a page for links to it', () => {
    assert.equal(auditRecordLink('lead', ID)?.href, `/leads/${ID}`);
    assert.equal(auditRecordLink('approval_request', ID)?.href, `/approvals/${ID}`);
    assert.equal(auditRecordLink('client_account', ID)?.href, `/clients/${ID}`);
    assert.equal(auditRecordLink('invoice', ID)?.href, `/invoices/${ID}`);
  });

  test('a row inside a project links through the project id the entry recorded', () => {
    assert.equal(auditRecordLink('project_file', ID, null, { projectId: PROJECT })?.href, `/projects/${PROJECT}/files`);
    assert.equal(auditRecordLink('scope_version', ID, { project_id: PROJECT }, null)?.href, `/projects/${PROJECT}`);
  });

  test('no page, no id, or a malformed id gives no link rather than a dead one', () => {
    assert.equal(auditRecordLink('secret', ID), null);
    assert.equal(auditRecordLink('lead', null), null);
    assert.equal(auditRecordLink('lead', 'not-an-id'), null);
    assert.equal(auditRecordLink('project_file', ID, null, null), null);
  });

  test('a reason is read from whichever key the writer used, and only when it says something', () => {
    assert.equal(auditReason({ reason: ' left the company ' }), 'left the company');
    assert.equal(auditReason(null, { note: 'by request' }), 'by request');
    assert.equal(auditReason({ reason: '   ' }), null);
    assert.equal(auditReason({ status: 'active' }), null);
  });

  test('only real privilege changes are privileged; a department edit is not', () => {
    assert.equal(isPrivilegedAction('membership.status_changed'), true);
    assert.equal(isPrivilegedAction('membership.secondary_role_granted'), true);
    assert.equal(isPrivilegedAction('membership.department_set'), false);
  });
});

describe('cancelling a workflow stops what can be stopped and leaves the rest', () => {
  const jobs = [
    { id: 'a', status: 'queued' },
    { id: 'b', status: 'failed' },
    { id: 'c', status: 'running' },
    { id: 'd', status: 'succeeded' },
    { id: 'e', status: 'dead' },
    { id: 'f', status: 'cancelled' },
  ];

  test('queued and failed jobs are cancelled, running jobs are asked to stop, settled jobs need nothing', () => {
    const plan = planWorkflowCancel(jobs);
    assert.deepEqual(plan.cancel, ['a', 'b']);
    assert.deepEqual(plan.stop, ['c']);
    assert.equal(plan.settled, 3);
  });

  test('the sentence says exactly what will happen, and says so when nothing will', () => {
    assert.equal(describeWorkflowCancel(planWorkflowCancel(jobs)), 'cancel 2 jobs and ask 1 running job to stop at the next step');
    assert.equal(describeWorkflowCancel(planWorkflowCancel([{ id: 'd', status: 'succeeded' }])), 'nothing to cancel');
  });
});

import { attachReasons } from '../src/lib/audit/privileged.ts';

describe('a privileged change is paired with the reason its author gave', () => {
  const M = 'm1';
  const change = (id: number, at: string, actor = 'owner', action = 'membership.status_changed') => ({ id, action, subjectId: M, actorId: actor, createdAt: at, after: null });
  const reason = (id: number, at: string, text: string, kind = 'status_changed', actor = 'owner') => ({ id, action: 'membership.change_reason', subjectId: M, actorId: actor, createdAt: at, after: { kind, reason: text } });

  test('each change takes the reason recorded right after it, not a later change’s', () => {
    const changes = [change(1, '2026-10-01T10:00:00Z'), change(3, '2026-10-02T10:00:00Z')];
    const reasons = [reason(2, '2026-10-01T10:00:01Z', 'left the company'), reason(4, '2026-10-02T10:00:01Z', 'returned')];
    const paired = attachReasons(changes, reasons);
    assert.equal(paired.get(1), 'left the company');
    assert.equal(paired.get(3), 'returned');
  });

  test('a change with no reason stays without one; a reason never crosses to another author, kind or member', () => {
    const changes = [change(1, '2026-10-01T10:00:00Z'), change(5, '2026-10-03T10:00:00Z', 'owner', 'membership.secondary_role_granted')];
    const reasons = [
      reason(2, '2026-10-01T10:00:01Z', 'someone else said this', 'status_changed', 'other-owner'),
      reason(6, '2026-10-03T10:00:01Z', 'wrong kind', 'secondary_role_revoked'),
      { ...reason(7, '2026-10-03T10:00:02Z', 'other member', 'secondary_role_granted'), subjectId: 'm2' },
    ];
    const paired = attachReasons(changes, reasons);
    assert.equal(paired.has(1), false);
    assert.equal(paired.has(5), false);
  });

  test('a blank reason is not a reason', () => {
    assert.equal(attachReasons([change(1, '2026-10-01T10:00:00Z')], [reason(2, '2026-10-01T10:00:01Z', '   ')]).size, 0);
  });
});
