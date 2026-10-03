import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { evaluateIntegrations, latestVerification, type IntegrationSignals } from '../src/lib/admin/integrations-eval.ts';
import { impactEffects } from '../src/lib/admin/settings-impact-copy.ts';
import { summariseSettingsAreas, type SettingsFacts } from '../src/lib/admin/settings-summary-eval.ts';

const base: IntegrationSignals = {
  database: { ok: true, value: true },
  cronAgeSeconds: 30,
  whatsapp: { tokenConfigured: true, numberConfigured: { ok: true, value: true } },
  aiProviderConfigured: { ok: true, value: true },
  transcriberConfigured: { ok: true, value: false },
  imageGeneratorConfigured: { ok: true, value: false },
  alertWebhookConfigured: false,
  now: '2026-10-06T10:00:00.000Z',
};
const find = (list: ReturnType<typeof evaluateIntegrations>, id: string) => list.find((i) => i.id === id);

describe('Figma and Google Calendar are first-class rows of the registry', () => {
  test('Figma with a token but no checked reference is configured, not verified', () => {
    const row = find(evaluateIntegrations({ ...base, figma: { tokenConfigured: true, references: { ok: true, value: { recorded: 3, verified: 0, lastVerifiedAt: null } } } }), 'figma');
    assert.equal(row?.lifecycle, 'CONFIGURED');
    assert.equal(row?.lastVerifiedAt, null);
    assert.deepEqual(row?.count, { label: 'references', value: 3 });
  });

  test('Figma is verified only once a reference was actually checked, and carries that moment', () => {
    const at = '2026-10-05T08:00:00.000Z';
    const row = find(evaluateIntegrations({ ...base, figma: { tokenConfigured: true, references: { ok: true, value: { recorded: 3, verified: 2, lastVerifiedAt: at } } } }), 'figma');
    assert.equal(row?.lifecycle, 'VERIFIED');
    assert.equal(row?.lastVerifiedAt, at);
  });

  test('no Figma token is not configured, and a count that could not be read is failed, never zero', () => {
    assert.equal(find(evaluateIntegrations({ ...base, figma: { tokenConfigured: false, references: { ok: true, value: { recorded: 0, verified: 0, lastVerifiedAt: null } } } }), 'figma')?.lifecycle, 'NOT_CONFIGURED');
    assert.equal(find(evaluateIntegrations({ ...base, figma: { tokenConfigured: true, references: { ok: false } } }), 'figma')?.lifecycle, 'FAILED');
  });

  test('the calendar is counted in the registry: unconfigured, configured, or verified by a real read', () => {
    assert.equal(find(evaluateIntegrations({ ...base, calendar: { configured: false, verifiedAt: null } }), 'calendar')?.lifecycle, 'NOT_CONFIGURED');
    assert.equal(find(evaluateIntegrations({ ...base, calendar: { configured: true, verifiedAt: null } }), 'calendar')?.lifecycle, 'CONFIGURED');
    const row = find(evaluateIntegrations({ ...base, calendar: { configured: true, verifiedAt: '2026-10-04T09:00:00.000Z' } }), 'calendar');
    assert.equal(row?.lifecycle, 'VERIFIED');
    assert.equal(row?.lastVerifiedAt, '2026-10-04T09:00:00.000Z');
  });

  test('the aggregate last-verified is the most recent recorded check, and null when nothing was checked', () => {
    const list = evaluateIntegrations({
      ...base,
      verifiedAt: { whatsapp: '2026-10-01T00:00:00.000Z', aiProvider: '2026-10-03T00:00:00.000Z' },
      calendar: { configured: true, verifiedAt: '2026-10-02T00:00:00.000Z' },
    });
    assert.equal(latestVerification(list.filter((i) => i.id !== 'database' && i.id !== 'scheduler')), '2026-10-03T00:00:00.000Z');
    assert.equal(latestVerification(evaluateIntegrations({ ...base, now: undefined }).filter((i) => i.id !== 'database' && i.id !== 'scheduler')), null);
  });
});

describe('the settings area summary states what is set from stored facts', () => {
  const empty: SettingsFacts = {
    organizationName: null,
    timezone: null,
    settings: {},
    defaultDesignReviewerId: null,
    members: 0,
    teamDefaults: 0,
    approvalPolicies: 0,
    paymentAccounts: 0,
    gstinSet: false,
    paymentStructures: 0,
    projectTemplates: 0,
    defaultWatchPhases: null,
    standardFolders: null,
  };
  const area = (facts: SettingsFacts, key: string) => summariseSettingsAreas(facts).find((a) => a.key === key)!;

  test('an unconfigured organisation reads as not set up, never as healthy', () => {
    const areas = summariseSettingsAreas(empty);
    assert.equal(areas.length, 7);
    assert.equal(area(empty, 'general').value, '0 of 3 set');
    assert.equal(area(empty, 'general').tone, 'neutral');
    assert.equal(area(empty, 'approvals').tone, 'neutral');
    assert.match(area(empty, 'project-defaults').caption, /folders unread/);
  });

  test('every tile links to its own tab', () => {
    const hrefs = summariseSettingsAreas(empty).map((a) => a.href);
    assert.deepEqual(hrefs, ['/settings', '/settings/commercial', '/settings/team', '/settings/communication', '/settings/approvals', '/settings/finance', '/settings/project-defaults']);
  });

  test('a fully configured area is success, a partly configured one is a warning', () => {
    const full = { ...empty, organizationName: 'Acme', timezone: 'Asia/Kolkata', settings: { quotation_contact_email: 'a@b.co' } };
    assert.equal(area(full, 'general').tone, 'success');
    assert.equal(area({ ...full, settings: {} }, 'general').tone, 'warning');
    const pricing = Object.fromEntries(['pricing_day_rate_rupees', 'pricing_ai_day_rate_rupees', 'pricing_multiplier_min', 'pricing_multiplier_target', 'pricing_multiplier_max'].map((k) => [k, '1']));
    assert.match(area({ ...empty, settings: pricing, paymentStructures: 1 }, 'commercial').caption, /Pricing model set · payment terms set/);
  });
});

describe('the impact preview states the counts it was handed', () => {
  const impact = { timezone: { activeFollowUps: 0, upcomingMeetings: 0 }, name: { openProposals: 0, draftInvoices: 0 }, quotations: { drafts: 4, withClients: 1 }, outreach: { activeFollowUps: 7 } };

  test('a commercial change names the quotations it reaches and the ones it leaves alone', () => {
    const lines = impactEffects('pricing', impact).join(' ');
    assert.match(lines, /4 quotation drafts/);
    assert.match(lines, /1 quotation already approved or sent keep/);
  });

  test('an outreach change names the active sequences, singular and plural', () => {
    assert.match(impactEffects('outreach-window', impact).join(' '), /7 active follow-up sequences/);
    assert.match(impactEffects('outreach-limits', { ...impact, outreach: { activeFollowUps: 1 } }).join(' '), /1 active follow-up sequence /);
  });
});
