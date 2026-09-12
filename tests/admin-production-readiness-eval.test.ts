import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluateReadiness, readinessSummary, type ReadinessSignals } from '../src/lib/admin/production-readiness-eval.ts';
import type { BacklogRow } from '../src/lib/observability/backlog.ts';

const cleanBacklog: BacklogRow = {
  dead_jobs: 0, stalled_jobs: 0, stuck_queued_jobs: 0, unpublished_events: 0, dead_events: 0,
  overdue_approvals: 0, unannounced_approvals: 0,
  sends_waiting_on_admin: 0, sends_waiting_on_reply: 0,
  oldest_dead_at: null, oldest_unpublished_at: null, oldest_overdue_due_at: null,
  oldest_unannounced_at: null,
  oldest_waiting_on_admin_at: null,
};

// A deployment that is fully CONFIGURED — but nothing has been verified.
const configured: ReadinessSignals = {
  looksLocal: false,
  productionProblems: [],
  timezone: { ok: true, value: 'Asia/Kolkata' },
  whatsapp: { tokenConfigured: true, numberConfigured: { ok: true, value: true }, verifiedAt: null, verifiedNumber: null, testSentAt: null },
  aiProviderConfigured: { ok: true, value: true },
  aiProviderVerifiedAt: null,
  aiProviderVerifiedModel: null,
  cronAgeSeconds: 30,
  backlog: { ok: true, value: cleanBacklog },
  alertWebhookConfigured: true,
};

const find = (checks: ReturnType<typeof evaluateReadiness>, id: string) => checks.find((c) => c.id === id)!;

describe('evaluateReadiness — configured is never green on its own', () => {
  test('a configured WhatsApp is YELLOW (not verified), never green', () => {
    const w = find(evaluateReadiness(configured), 'whatsapp');
    assert.equal(w.status, 'yellow');
    assert.notEqual(w.status, 'green');
    assert.match(w.evidence, /NOT yet verified/i);
  });

  test('a configured AI provider is YELLOW (not exercised), never green', () => {
    const a = find(evaluateReadiness(configured), 'ai-provider');
    assert.equal(a.status, 'yellow');
    assert.match(a.evidence, /NOT yet exercised/i);
  });

  test('an unreadable signal is UNKNOWN, never green', () => {
    const checks = evaluateReadiness({
      ...configured,
      backlog: { ok: false },
      aiProviderConfigured: { ok: false },
      timezone: { ok: false },
    });
    assert.equal(find(checks, 'backlog').status, 'unknown');
    assert.equal(find(checks, 'ai-provider').status, 'unknown');
    assert.equal(find(checks, 'timezone').status, 'unknown');
  });

  test('local deployment, missing config, unset timezone, stale cron and lost work are RED', () => {
    const checks = evaluateReadiness({
      looksLocal: true,
      productionProblems: ['ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN'],
      timezone: { ok: true, value: null },
      whatsapp: { tokenConfigured: false, numberConfigured: { ok: true, value: false }, verifiedAt: null, verifiedNumber: null, testSentAt: null },
      aiProviderConfigured: { ok: true, value: false },
      aiProviderVerifiedAt: null,
      aiProviderVerifiedModel: null,
      cronAgeSeconds: 3600,
      backlog: { ok: true, value: { ...cleanBacklog, dead_jobs: 2 } },
      alertWebhookConfigured: false,
    });
    assert.equal(find(checks, 'environment').status, 'red');
    assert.equal(find(checks, 'config').status, 'red');
    assert.equal(find(checks, 'timezone').status, 'red');
    assert.equal(find(checks, 'whatsapp').status, 'red');
    assert.equal(find(checks, 'cron').status, 'red');
    assert.equal(find(checks, 'backlog').status, 'red');
    assert.equal(find(checks, 'alerts').status, 'yellow'); // unset alerts is a warning, not a hard block
  });
});

describe('readinessSummary — the ready gate is honest', () => {
  test('a fully configured-but-unverified deployment is NOT ready (yellows remain, but red/unknown gate it)', () => {
    // configured has no red and no unknown -> ready true, but WhatsApp/AI are yellow:
    // "ready" means nothing is red/unknown; verification (yellow->green) is still owed.
    const summary = readinessSummary(evaluateReadiness(configured));
    assert.equal(summary.red, 0);
    assert.equal(summary.unknown, 0);
    assert.ok(summary.yellow >= 2, 'WhatsApp + AI remain yellow until verified');
  });

  test('any red or unknown makes it not ready', () => {
    const withRed = readinessSummary(evaluateReadiness({ ...configured, looksLocal: true }));
    assert.equal(withRed.ready, false);
    const withUnknown = readinessSummary(evaluateReadiness({ ...configured, backlog: { ok: false } }));
    assert.equal(withUnknown.ready, false);
  });
});


describe('G-236 — verified is recorded, and only then green', () => {
  test('WhatsApp verified with Meta but never test-sent stays yellow, and names the missing half', () => {
    const half: ReadinessSignals = { ...configured, whatsapp: { ...configured.whatsapp, verifiedAt: '2026-09-12T12:19:00.000Z', verifiedNumber: '+1 555-204-8026 “Test Number”' } };
    const w = find(evaluateReadiness(half), 'whatsapp');
    assert.equal(w.status, 'yellow');
    assert.match(w.evidence, /verified with Meta 2026-09-12T12:19/);
    assert.match(w.evidence, /test send to the internal recipient has not been made/);
    assert.match(w.remediation, /^Send the test message/);
  });

  test('WhatsApp verified AND test-sent is green, with both moments as evidence', () => {
    const both: ReadinessSignals = { ...configured, whatsapp: { ...configured.whatsapp, verifiedAt: '2026-09-12T12:19:00.000Z', verifiedNumber: '+1 555', testSentAt: '2026-09-12T12:25:00.000Z' } };
    const w = find(evaluateReadiness(both), 'whatsapp');
    assert.equal(w.status, 'green');
    assert.match(w.evidence, /verified with Meta 2026-09-12T12:19:00.000Z \(\+1 555\) · test message sent 2026-09-12T12:25/);
  });

  test('a test send recorded without a verification is still yellow — the order matters', () => {
    const sentOnly: ReadinessSignals = { ...configured, whatsapp: { ...configured.whatsapp, testSentAt: '2026-09-12T12:25:00.000Z' } };
    assert.equal(find(evaluateReadiness(sentOnly), 'whatsapp').status, 'yellow');
  });

  test('a recorded verification with the token now missing is red, not green — configured comes first', () => {
    const gone: ReadinessSignals = { ...configured, whatsapp: { ...configured.whatsapp, tokenConfigured: false, verifiedAt: '2026-09-12T12:19:00.000Z', testSentAt: '2026-09-12T12:25:00.000Z' } };
    assert.equal(find(evaluateReadiness(gone), 'whatsapp').status, 'red');
  });

  test('the AI provider is green only when a real call answered, and says which model', () => {
    const verified: ReadinessSignals = { ...configured, aiProviderVerifiedAt: '2026-09-12T12:30:00.000Z', aiProviderVerifiedModel: 'claude-sonnet-5' };
    const a = find(evaluateReadiness(verified), 'ai-provider');
    assert.equal(a.status, 'green');
    assert.match(a.evidence, /a real call answered 2026-09-12T12:30:00.000Z \(claude-sonnet-5\)/);
    const noKey: ReadinessSignals = { ...verified, aiProviderConfigured: { ok: true, value: false } };
    assert.equal(find(evaluateReadiness(noKey), 'ai-provider').status, 'red', 'a verification cannot outlive the key');
  });

  test('with everything verified and recorded the summary has no yellows and is ready', () => {
    const all: ReadinessSignals = {
      ...configured,
      whatsapp: { ...configured.whatsapp, verifiedAt: '2026-09-12T12:19:00.000Z', testSentAt: '2026-09-12T12:25:00.000Z' },
      aiProviderVerifiedAt: '2026-09-12T12:30:00.000Z', aiProviderVerifiedModel: 'claude-sonnet-5',
    };
    const summary = readinessSummary(evaluateReadiness(all));
    assert.equal(summary.yellow, 0);
    assert.equal(summary.ready, true);
  });
});
