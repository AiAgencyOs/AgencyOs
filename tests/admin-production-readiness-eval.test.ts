import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluateReadiness, readinessSummary, type ReadinessSignals } from '../src/lib/admin/production-readiness-eval.ts';
import type { BacklogRow } from '../src/lib/observability/backlog.ts';

const cleanBacklog: BacklogRow = {
  dead_jobs: 0, stalled_jobs: 0, stuck_queued_jobs: 0, unpublished_events: 0, dead_events: 0,
  overdue_approvals: 0, unannounced_approvals: 0,
  oldest_dead_at: null, oldest_unpublished_at: null, oldest_overdue_due_at: null,
  oldest_unannounced_at: null,
};

// A deployment that is fully CONFIGURED — but nothing has been verified.
const configured: ReadinessSignals = {
  looksLocal: false,
  productionProblems: [],
  timezone: { ok: true, value: 'Asia/Kolkata' },
  whatsapp: { tokenConfigured: true, numberConfigured: { ok: true, value: true } },
  aiProviderConfigured: { ok: true, value: true },
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
      whatsapp: { tokenConfigured: false, numberConfigured: { ok: true, value: false } },
      aiProviderConfigured: { ok: true, value: false },
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
