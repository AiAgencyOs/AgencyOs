import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluateIntegrations, integrationsSummary, type IntegrationSignals } from '../src/lib/admin/integrations-eval.ts';

const healthy: IntegrationSignals = {
  database: { ok: true, value: true },
  cronAgeSeconds: 30,
  whatsapp: { tokenConfigured: true, numberConfigured: { ok: true, value: true } },
  aiProviderConfigured: { ok: true, value: true },
  alertWebhookConfigured: true,
};

const find = (list: ReturnType<typeof evaluateIntegrations>, id: string) => list.find((i) => i.id === id)!;

describe('evaluateIntegrations — CONFIGURED is never VERIFIED', () => {
  test('a fully configured WhatsApp is CONFIGURED, never VERIFIED (verification is an action)', () => {
    assert.equal(find(evaluateIntegrations(healthy), 'whatsapp').lifecycle, 'CONFIGURED');
  });

  test('a configured AI provider is CONFIGURED, never VERIFIED from this page', () => {
    assert.equal(find(evaluateIntegrations(healthy), 'ai-provider').lifecycle, 'CONFIGURED');
  });

  test('the database is VERIFIED only because a live read succeeded', () => {
    assert.equal(find(evaluateIntegrations(healthy), 'database').lifecycle, 'VERIFIED');
    assert.equal(find(evaluateIntegrations({ ...healthy, database: { ok: false } }), 'database').lifecycle, 'FAILED');
  });

  test('the scheduler is VERIFIED when ticking, DEGRADED when stale, FAILED when unknown', () => {
    assert.equal(find(evaluateIntegrations(healthy), 'scheduler').lifecycle, 'VERIFIED');
    assert.equal(find(evaluateIntegrations({ ...healthy, cronAgeSeconds: 3600 }), 'scheduler').lifecycle, 'DEGRADED');
    assert.equal(find(evaluateIntegrations({ ...healthy, cronAgeSeconds: null }), 'scheduler').lifecycle, 'FAILED');
  });

  test('an unreadable signal FAILS the integration, never marks it verified', () => {
    const list = evaluateIntegrations({
      ...healthy,
      whatsapp: { tokenConfigured: true, numberConfigured: { ok: false } },
      aiProviderConfigured: { ok: false },
    });
    assert.equal(find(list, 'whatsapp').lifecycle, 'FAILED');
    assert.equal(find(list, 'ai-provider').lifecycle, 'FAILED');
    for (const i of list) assert.notEqual(i.lifecycle === 'VERIFIED' && (i.id === 'whatsapp' || i.id === 'ai-provider'), true);
  });

  test('missing WhatsApp config is NOT_CONFIGURED; unset alerts are DEGRADED', () => {
    const list = evaluateIntegrations({
      ...healthy,
      whatsapp: { tokenConfigured: false, numberConfigured: { ok: true, value: false } },
      alertWebhookConfigured: false,
    });
    assert.equal(find(list, 'whatsapp').lifecycle, 'NOT_CONFIGURED');
    assert.equal(find(list, 'alerts').lifecycle, 'DEGRADED');
  });
});

describe('integrationsSummary', () => {
  test('counts every lifecycle bucket', () => {
    const s = integrationsSummary(evaluateIntegrations(healthy));
    assert.equal(s.VERIFIED, 2); // database + scheduler
    assert.equal(s.CONFIGURED, 3); // whatsapp + ai + alerts
    assert.equal(s.FAILED, 0);
  });
});
