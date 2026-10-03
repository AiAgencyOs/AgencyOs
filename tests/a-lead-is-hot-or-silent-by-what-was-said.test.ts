import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasNoResponse, isHotLead, isQuickFilterKey, matchesQuickFilter, silentSince } from '../src/modules/crm/lead-quick-filters.ts';

const NOW = new Date('2026-10-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const lead = (over: Partial<Parameters<typeof isHotLead>[0]> = {}) => ({ status: 'qualified', dealStage: null, createdAt: hoursAgo(24 * 30), lastInboundAt: hoursAgo(5), ...over });

describe('Hot Leads: qualified or beyond, and the lead replied in the last 7 days', () => {
  it('a qualified lead who wrote yesterday is hot', () => {
    assert.equal(isHotLead(lead({ lastInboundAt: hoursAgo(24) }), NOW), true);
  });

  it('the seven days are exact: 7 days is in, 7 days and an hour is out', () => {
    assert.equal(isHotLead(lead({ lastInboundAt: hoursAgo(24 * 7) }), NOW), true);
    assert.equal(isHotLead(lead({ lastInboundAt: hoursAgo(24 * 7 + 1) }), NOW), false);
  });

  it('a lead who has never written is not hot, however far along', () => {
    assert.equal(isHotLead(lead({ lastInboundAt: null }), NOW), false);
  });

  it('an early or parked lead is not hot even if it just wrote', () => {
    for (const status of ['new', 'qualifying', 'nurture', 'disqualified']) {
      assert.equal(isHotLead(lead({ status }), NOW), false, status);
    }
  });

  it('converted counts as beyond qualified, and so does a deal that reached proposal', () => {
    assert.equal(isHotLead(lead({ status: 'converted' }), NOW), true);
    assert.equal(isHotLead(lead({ status: 'qualifying', dealStage: 'proposal' }), NOW), true);
    assert.equal(isHotLead(lead({ status: 'qualifying', dealStage: 'discovery' }), NOW), false);
  });

  it('a message stamped slightly in the future still counts as a reply', () => {
    assert.equal(isHotLead(lead({ lastInboundAt: hoursAgo(-2) }), NOW), true);
  });
});

describe('No Response: 3 or more days of silence, from the last inbound message or, if none, from creation', () => {
  it('silence is measured from the last inbound message', () => {
    assert.equal(hasNoResponse(lead({ status: 'new', lastInboundAt: hoursAgo(71) }), NOW), false);
    assert.equal(hasNoResponse(lead({ status: 'new', lastInboundAt: hoursAgo(72) }), NOW), true);
    assert.equal(hasNoResponse(lead({ status: 'new', lastInboundAt: hoursAgo(24 * 20) }), NOW), true);
  });

  it('a lead that never wrote is silent from the day it was created', () => {
    assert.equal(silentSince({ createdAt: hoursAgo(100), lastInboundAt: null }), hoursAgo(100));
    assert.equal(hasNoResponse(lead({ status: 'new', createdAt: hoursAgo(80), lastInboundAt: null }), NOW), true);
    assert.equal(hasNoResponse(lead({ status: 'new', createdAt: hoursAgo(10), lastInboundAt: null }), NOW), false);
  });

  it('an old message counts, not the creation date: a lead created long ago who wrote an hour ago is not silent', () => {
    assert.equal(hasNoResponse(lead({ status: 'qualifying', createdAt: hoursAgo(24 * 90), lastInboundAt: hoursAgo(1) }), NOW), false);
  });

  it('finished and parked leads are not "no response"', () => {
    for (const status of ['converted', 'disqualified', 'nurture']) {
      assert.equal(hasNoResponse(lead({ status, lastInboundAt: hoursAgo(24 * 30) }), NOW), false, status);
    }
  });
});

describe('the filter key', () => {
  it('only the two named keys are filters', () => {
    assert.equal(isQuickFilterKey('hot_leads'), true);
    assert.equal(isQuickFilterKey('no_response'), true);
    assert.equal(isQuickFilterKey('everything'), false);
    assert.equal(isQuickFilterKey(undefined), false);
  });

  it('dispatches to the right rule', () => {
    const quietQualified = lead({ lastInboundAt: hoursAgo(24 * 10) });
    assert.equal(matchesQuickFilter('hot_leads', quietQualified, NOW), false);
    assert.equal(matchesQuickFilter('no_response', quietQualified, NOW), true);
  });
});
