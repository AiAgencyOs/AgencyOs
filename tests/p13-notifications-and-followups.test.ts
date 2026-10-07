// A26 notification gate, P3-PM-030 design-share sweep, and the shape of the new server files. SQL is proved in
// scripts/verify-p13-notifications-planning-and-design-clarification.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { notificationVerdict } from '../src/lib/p13/notification-gate.ts';
import { sweepDesignShareReminders, type DueShare } from '../src/modules/projects/design-share-followups.ts';

type Reply = { data: unknown; error: { message: string } | null };
function admin(answers: Record<string, Reply | ((args: Record<string, unknown>) => Reply)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const a = {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const r = answers[fn];
        return Promise.resolve(typeof r === 'function' ? r(args) : (r ?? { data: null, error: null }));
      },
    }),
  };
  return { admin: a as never, calls };
}
const due = (id: string): DueShare => ({ share_id: id, project_id: 'p', phase_three_id: 'f', share_number: 1, shared_at: '2026-11-20T00:00:00Z', reminders_sent: 0, next_reminder_number: 1 });

test('the gate returns the database verdict and sends the severity and last-sent time along', async () => {
  const { admin: a, calls } = admin({ p13_notification_decision: { data: [{ allowed: false, reason: 'quiet_hours' }], error: null } });
  const v = await notificationVerdict(a, { organizationId: 'o', eventClass: 'client_followup', channel: 'whatsapp', severity: 'critical', lastSentAt: new Date('2026-11-28T00:00:00Z') });
  assert.deepEqual(v, { allowed: false, reason: 'quiet_hours', degraded: false });
  assert.equal(calls[0]?.args.p_severity, 'critical');
  assert.equal(calls[0]?.args.p_last_sent_at, '2026-11-28T00:00:00.000Z');
});

test('an unreadable rule set allows the send and says it is degraded (an outage must not silence an incident)', async () => {
  const { admin: a } = admin({ p13_notification_decision: { data: null, error: { message: 'down' } } });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await notificationVerdict(a, { organizationId: 'o', eventClass: 'incident', channel: 'in_app' }), { allowed: true, reason: 'unreadable', degraded: true });
    const junk = admin({ p13_notification_decision: { data: [{ allowed: 'yes', reason: 'ok' }], error: null } });
    assert.equal((await notificationVerdict(junk.admin, { organizationId: 'o', eventClass: 'incident', channel: 'in_app' })).degraded, true);
  } finally {
    console.error = quiet;
  }
});

test('the sweep reminds a due share only after the rules allow it and the sender confirms, then records the reference', async () => {
  const { admin: a, calls } = admin({
    p13_design_shares_awaiting_decision: { data: [due('s1')], error: null },
    p13_notification_decision: { data: [{ allowed: true, reason: 'ok' }], error: null },
    p13_record_design_share_reminder: { data: [{ outcome: 'recorded', reminder_number: 1 }], error: null },
  });
  const res = await sweepDesignShareReminders(a, { organizationId: 'o' }, async () => ({ sent: true, channel: 'whatsapp', evidenceRef: 'wa:1' }));
  assert.ok(res.ok);
  assert.deepEqual(res.ok && res.outcomes, [{ shareId: 's1', result: 'reminded', detail: 'reminder 1' }]);
  const rec = calls.find((c) => c.fn === 'p13_record_design_share_reminder');
  assert.deepEqual(rec?.args, { p_share_id: 's1', p_channel: 'whatsapp', p_evidence: 'wa:1' });
});

test('quiet hours hold a reminder: the sender is never called and nothing is recorded', async () => {
  let called = 0;
  const { admin: a, calls } = admin({
    p13_design_shares_awaiting_decision: { data: [due('s1')], error: null },
    p13_notification_decision: { data: [{ allowed: false, reason: 'quiet_hours' }], error: null },
  });
  const res = await sweepDesignShareReminders(a, { organizationId: 'o' }, async () => {
    called += 1;
    return { sent: true, channel: 'whatsapp', evidenceRef: 'x' };
  });
  assert.equal(called, 0);
  assert.deepEqual(res.ok && res.outcomes.map((o) => o.result), ['held_by_rules']);
  assert.equal(calls.filter((c) => c.fn === 'p13_record_design_share_reminder').length, 0);
});

test('a sender that cannot send (no number, no consent, a throw) records NOTHING, so the share is due again', async () => {
  const { admin: a, calls } = admin({
    p13_design_shares_awaiting_decision: { data: [due('s1'), due('s2')], error: null },
    p13_notification_decision: { data: [{ allowed: true, reason: 'ok' }], error: null },
  });
  let n = 0;
  const res = await sweepDesignShareReminders(a, { organizationId: 'o' }, async () => {
    n += 1;
    if (n === 1) return { sent: false, reason: 'WHATSAPP_NOT_CONFIGURED' };
    throw new Error('socket hang up');
  });
  assert.deepEqual(res.ok && res.outcomes.map((o) => `${o.result}:${o.detail}`), ['not_sent:WHATSAPP_NOT_CONFIGURED', 'not_sent:socket hang up']);
  assert.equal(calls.filter((c) => c.fn === 'p13_record_design_share_reminder').length, 0);
});

test('a refusal by the recording door (a third reminder, an answered share) is reported, not hidden; an unreadable list fails the sweep', async () => {
  const { admin: a } = admin({
    p13_design_shares_awaiting_decision: { data: [due('s1')], error: null },
    p13_notification_decision: { data: [{ allowed: true, reason: 'ok' }], error: null },
    p13_record_design_share_reminder: { data: [{ outcome: 'already_answered' }], error: null },
  });
  const res = await sweepDesignShareReminders(a, { organizationId: 'o' }, async () => ({ sent: true, channel: 'email', evidenceRef: 'em:1' }));
  assert.deepEqual(res.ok && res.outcomes, [{ shareId: 's1', result: 'refused', detail: 'already_answered' }]);
  const down = admin({ p13_design_shares_awaiting_decision: { data: null, error: { message: 'db down' } } });
  const bad = await sweepDesignShareReminders(down.admin, { organizationId: 'o' }, async () => ({ sent: false, reason: 'x' }));
  assert.ok(!bad.ok && /db down/.test(bad.detail));
});

test('the new server files keep their discipline', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const f of ['src/lib/p13/notification-rules-actions.ts', 'src/modules/projects/p13-design-clarification-actions.ts']) {
    const src = read(f);
    assert.match(src, /^'use server';/);
    assert.equal([...src.matchAll(/^export (?!async function)/gm)].length, 0, f);
  }
  for (const f of ['src/lib/p13/notification-rules.ts', 'src/modules/projects/p13-design-clarifications.ts']) {
    const src = read(f);
    assert.equal([...src.matchAll(/if \(error\)/g)].length >= 1, true);
    assert.equal([...src.matchAll(/unreadable\(/g)].length, 1, `${f}: its one read checks its error`);
  }
});
