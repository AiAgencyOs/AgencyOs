import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { heldByNotificationRules } from '../src/lib/p13/notification-hold.ts';

/**
 * W7 (approval detail page) and W8 (notification gate in every outbound sender) wiring.
 * Behaviour of the hold is driven with a fake rules function; the call sites are pinned as source, function by function, so removing a line is red.
 */

function adminWith(row: { allowed: boolean; reason: string } | 'throws') {
  const calls: Record<string, unknown>[] = [];
  const admin = {
    schema: () => ({
      rpc(_fn: string, args: Record<string, unknown>) {
        calls.push(args);
        if (row === 'throws') return Promise.resolve({ data: null, error: { message: 'rules table unreadable' } });
        return Promise.resolve({ data: [row], error: null });
      },
    }),
  } as never;
  return { admin, calls };
}

describe('W8 heldByNotificationRules', () => {
  test('allowed: the sender goes ahead (null), and the question names the class and channel', async () => {
    const { admin, calls } = adminWith({ allowed: true, reason: 'ok' });
    assert.equal(await heldByNotificationRules(admin, { organizationId: 'o', eventClass: 'approval' }), null);
    assert.equal(calls[0]?.p_event_class, 'approval');
    assert.equal(calls[0]?.p_channel, 'whatsapp');
  });

  test('quiet hours: a RETRYABLE failure (delayed, never dropped)', async () => {
    const { admin } = adminWith({ allowed: false, reason: 'quiet_hours' });
    const held = await heldByNotificationRules(admin, { organizationId: 'o', eventClass: 'meeting_reminder' });
    assert.deepEqual(held && held.status, 'failed');
    assert.equal(held?.status === 'failed' && held.permanent, false);
  });

  test('disabled and too soon: settled, nothing sent', async () => {
    for (const reason of ['disabled', 'too_soon']) {
      const { admin } = adminWith({ allowed: false, reason });
      const held = await heldByNotificationRules(admin, { organizationId: 'o', eventClass: 'sales' });
      assert.equal(held?.status, 'succeeded');
      assert.equal(held?.status === 'succeeded' && held.outcome, `held_${reason}`);
    }
  });

  test('unreadable rules: an internal notice still goes (an outage never silences an incident); a client-facing send is held', async () => {
    const internal = adminWith('throws');
    assert.equal(await heldByNotificationRules(internal.admin, { organizationId: 'o', eventClass: 'escalation' }), null);
    const client = adminWith('throws');
    const held = await heldByNotificationRules(client.admin, { organizationId: 'o', eventClass: 'client_followup', clientFacing: true });
    assert.equal(held?.status, 'failed');
  });
});

const handlers = readFileSync(new URL('../src/modules/crm/handlers.ts', import.meta.url), 'utf8');
function bodyOf(src: string, name: string): string {
  const parts = src.split(/\nexport async function /);
  const part = parts.find((p) => p.startsWith(`${name}(`));
  assert.ok(part, `${name} exists`);
  return part;
}

describe('W8 every internal announcer asks the rules before it records or sends', () => {
  const expected: [string, string][] = [
    ['handleApprovalRequested', 'approval'],
    ['handleConversationEscalated', 'escalation'],
    ['handleRevisionLimitEscalated', 'escalation'],
    ['handlePhaseThreeCompleted', 'admin_alert'],
    ['announceOfferApplied', 'sales'],
  ];
  for (const [name, cls] of expected) {
    test(`${name} asks for class ${cls} before send_outbound_message`, () => {
      const body = bodyOf(handlers, name);
      const ask = body.indexOf('heldByNotificationRules(');
      const send = body.indexOf("rpc('send_outbound_message'");
      assert.ok(ask > 0, 'asks the rules');
      assert.ok(send > ask, 'asks before it records the message');
      assert.ok(body.includes(`eventClass: '${cls}'`));
      assert.ok(body.includes('if (held) return held;'));
    });
  }

  test('announceToInternalChannel asks with the caller-supplied class (default admin_alert) before it records', () => {
    const body = bodyOf(handlers, 'announceToInternalChannel');
    assert.ok(body.indexOf('heldByNotificationRules(') > 0);
    assert.ok(body.indexOf("rpc('send_outbound_message'") > body.indexOf('heldByNotificationRules('));
    assert.ok(body.includes("input.notificationClass ?? 'admin_alert'"));
  });

  test('the meeting announcements name their class: reminder is meeting_reminder', () => {
    const src = readFileSync(new URL('../src/modules/crm/meeting-announcements.ts', import.meta.url), 'utf8');
    assert.match(src, /meeting-reminder:[^\n]*\n\s*notificationClass: 'meeting_reminder'/);
    assert.equal(src.match(/notificationClass: 'sales'/g)?.length, 2);
  });
});

describe('W8 the follow-up worker (client-facing) asks before it claims, and holds when degraded', () => {
  const src = readFileSync(new URL('../src/modules/crm/follow-up-worker.ts', import.meta.url), 'utf8');
  test('asked before the claim insert, with clientFacing', () => {
    const ask = src.indexOf("eventClass: 'client_followup'");
    const claim = src.indexOf(".from('follow_up_sends').insert({");
    assert.ok(ask > 0 && claim > ask);
    assert.ok(src.includes('clientFacing: true'));
  });
});

describe('W8 the automatic invoice reminder (client-facing) asks before it claims', () => {
  const src = readFileSync(new URL('../src/modules/finance/reminder-worker.ts', import.meta.url), 'utf8');
  test('asked with clientFacing before the claim RPC', () => {
    const ask = src.indexOf("eventClass: 'client_followup'");
    const claim = src.indexOf("rpc('claim_invoice_reminder'");
    assert.ok(ask > 0 && claim > ask);
    assert.match(src, /clientFacing: true \}\);\n\s+if \(held\) \{\n\s+outcome\.skipped \+= 1;\n\s+continue;/);
  });
});

describe('W7 the approval detail page shows the annotation and offers the two forms', () => {
  const page = readFileSync(new URL('../app/(internal)/approvals/[requestId]/page.tsx', import.meta.url), 'utf8');
  const forms = readFileSync(new URL('../app/(internal)/approvals/[requestId]/approval-execution-forms.tsx', import.meta.url), 'utf8');
  test('reads the annotation and renders risk, policy version, executed and verified', () => {
    assert.match(page, /readApprovalAnnotation\(requestId\)/);
    for (const label of ['"Risk"', '"Policy version"', '"Executed"', '"Verified"']) assert.ok(page.includes(`label=${label}`), label);
  });
  test('mark executed only on an approved, not-yet-executed request; mark verified only after execution; admin only', () => {
    assert.match(page, /request\.state === 'approved' && canRecordExecution && !annotation\?\.executed_at[\s\S]{0,200}step="execute"/);
    assert.match(page, /annotation\?\.executed_at && !annotation\.verified_at[\s\S]{0,200}step="verify"/);
    assert.match(page, /can\(context, 'organization\.settings'\)/);
  });
  test('the forms post to the two server actions', () => {
    assert.match(forms, /markApprovalExecutedAction/);
    assert.match(forms, /markApprovalVerifiedAction/);
    assert.match(forms, /name="requestId"/);
    assert.match(forms, /name="note"/);
  });
});
