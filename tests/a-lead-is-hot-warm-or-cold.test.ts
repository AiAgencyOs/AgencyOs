import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deriveLeadHeat, heatRank, heatTitle } from '../src/modules/crm/lead-heat.ts';
import { isHotLead } from '../src/modules/crm/lead-quick-filters.ts';

/**
 * Owner decision 1, round 2 (2026-10-01): no number, a Hot / Warm / Cold label
 * derived from stage, a reply in the last 7 days and a recorded budget, with
 * the reasons on the hover title. Hot is exactly the Hot Leads quick filter.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const base = { status: 'qualifying', dealStage: null, createdAt: daysAgo(30), lastInboundAt: null as string | null, budgetRecorded: false };

describe('a lead is Hot, Warm or Cold from recorded reasons', () => {
  test('qualified and replied within 7 days is Hot, and agrees with the Hot Leads filter', () => {
    const lead = { ...base, status: 'qualified', lastInboundAt: daysAgo(2) };
    assert.equal(deriveLeadHeat(lead, NOW).label, 'Hot');
    assert.equal(isHotLead(lead, NOW), true);
  });

  test('a deal at proposal counts as Qualified-or-beyond whatever the status says', () => {
    assert.equal(deriveLeadHeat({ ...base, dealStage: 'proposal', lastInboundAt: daysAgo(1) }, NOW).label, 'Hot');
  });

  test('qualified but silent for 8 days is Warm, not Hot', () => {
    const lead = { ...base, status: 'qualified', lastInboundAt: daysAgo(8) };
    assert.equal(deriveLeadHeat(lead, NOW).label, 'Warm');
    assert.equal(isHotLead(lead, NOW), false);
  });

  test('a recent reply alone, or a budget alone, is Warm', () => {
    assert.equal(deriveLeadHeat({ ...base, lastInboundAt: daysAgo(3) }, NOW).label, 'Warm');
    assert.equal(deriveLeadHeat({ ...base, budgetRecorded: true }, NOW).label, 'Warm');
  });

  test('nothing recorded is Cold', () => {
    assert.equal(deriveLeadHeat({ ...base, status: 'new' }, NOW).label, 'Cold');
  });

  test('a disqualified lead is Cold even with a reply and a budget', () => {
    const reading = deriveLeadHeat({ ...base, status: 'disqualified', lastInboundAt: daysAgo(1), budgetRecorded: true }, NOW);
    assert.equal(reading.label, 'Cold');
    assert.ok(reading.reasons.some((r) => /Disqualified/.test(r)));
  });

  test('every reading names its three reasons and the title carries them, with no figure out of 100', () => {
    const reading = deriveLeadHeat({ ...base, status: 'qualified', lastInboundAt: daysAgo(2), budgetRecorded: true }, NOW);
    assert.equal(reading.reasons.length, 3);
    const title = heatTitle(reading);
    assert.match(title, /^Hot lead\n/);
    assert.match(title, /Replied 2 days ago/);
    assert.match(title, /Budget recorded/);
    assert.doesNotMatch(title, /\/100|score/i);
  });

  test('the sort rank puts Hot above Warm above Cold', () => {
    assert.ok(heatRank('Hot') > heatRank('Warm') && heatRank('Warm') > heatRank('Cold'));
  });
});
