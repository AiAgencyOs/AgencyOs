import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyHeatOverride, deriveLeadHeat, heatTitle, type HeatOverride } from '../src/modules/crm/lead-heat.ts';
import { overrideLeadHeatSchema } from '../src/modules/crm/lead-heat-override-schema.ts';

/** Q-OVERRIDE (owner, round 3): a person's label with a reason; the computed label is kept. */

const NOW = new Date('2026-10-01T12:00:00Z');
const computed = deriveLeadHeat({ status: 'new', dealStage: null, createdAt: NOW.toISOString(), lastInboundAt: null, budgetRecorded: false }, NOW);
const override: HeatOverride = { label: 'Hot', reason: 'The founder confirmed budget on a call', at: NOW.toISOString(), byUserId: 'u1', computed: 'Cold' };

describe('an override sits beside the computed label', () => {
  test('without an override the computed label stands', () => {
    const reading = applyHeatOverride(computed, null);
    assert.equal(reading.label, 'Cold');
    assert.equal(reading.override, null);
  });

  test('with one, the person’s label shows and the computed one is kept', () => {
    const reading = applyHeatOverride(computed, override);
    assert.equal(reading.label, 'Hot');
    assert.equal(reading.computed, 'Cold');
    assert.deepEqual(reading.reasons, computed.reasons);
  });

  test('the hover text names both and the reason', () => {
    const title = heatTitle(applyHeatOverride(computed, override));
    assert.match(title, /Hot lead \(set by a person; computed Cold\)/);
    assert.match(title, /Reason: The founder confirmed budget/);
  });

  test('an unchanged reading keeps its plain title', () => {
    assert.match(heatTitle(applyHeatOverride(computed, null)), /^Cold lead\n/);
  });
});

describe('the request is checked before the door', () => {
  const leadId = '11111111-1111-4111-8111-111111111111';
  test('a reason is required, for setting and for clearing', () => {
    assert.equal(overrideLeadHeatSchema.safeParse({ leadId, label: 'Hot', reason: '   ' }).success, false);
    assert.equal(overrideLeadHeatSchema.safeParse({ leadId, label: null, reason: '' }).success, false);
  });

  test('the label is Hot, Warm or Cold, or null to clear', () => {
    assert.equal(overrideLeadHeatSchema.safeParse({ leadId, label: 'Lukewarm', reason: 'x' }).success, false);
    assert.equal(overrideLeadHeatSchema.safeParse({ leadId, label: null, reason: 'agreed it is stale' }).success, true);
    assert.equal(overrideLeadHeatSchema.safeParse({ leadId, label: 'Warm', reason: 'x'.repeat(501) }).success, false);
  });
});
