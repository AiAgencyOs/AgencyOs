import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { maintenanceSentence, summariseCommercials } from '../src/modules/sales/client-commercial-summary.ts';

const TODAY = '2026-10-01';

describe('SCR-016 header: accepted quote value', () => {
  test('adds only the projects that cite an accepted quotation, in the client currency', () => {
    const s = summariseCommercials(
      [
        { currency: 'INR', acceptedQuoteMinor: 1_500_000, maintenance: null },
        { currency: 'INR', acceptedQuoteMinor: null, maintenance: null },
        { currency: 'USD', acceptedQuoteMinor: 90_000, maintenance: null },
        { currency: 'INR', acceptedQuoteMinor: 250_000, maintenance: null },
      ],
      'INR',
      TODAY,
    );
    assert.equal(s.acceptedQuoteMinor, 1_750_000);
    assert.equal(s.cited, 2);
    assert.equal(s.otherCurrency, 1);
    assert.equal(s.projects, 4);
  });
  test('no project, no figure', () => {
    assert.equal(summariseCommercials([], 'INR', TODAY).acceptedQuoteMinor, 0);
  });
});

describe('SCR-016 header: maintenance and renewal status', () => {
  test('says there is no plan when none exists', () => {
    assert.deepEqual(maintenanceSentence(summariseCommercials([{ currency: 'INR', acceptedQuoteMinor: null, maintenance: null }], 'INR', TODAY).maintenance), { value: 'No plan', caption: 'No project carries a maintenance plan' });
  });
  test('an accepted plan that has ended is a renewal due; a plan nobody accepted is named', () => {
    const s = summariseCommercials(
      [
        { currency: 'INR', acceptedQuoteMinor: null, maintenance: { name: 'Care', accepted: true, endsOn: '2026-09-01' } },
        { currency: 'INR', acceptedQuoteMinor: null, maintenance: { name: 'Care 2', accepted: false, endsOn: '2027-01-01' } },
      ],
      'INR',
      TODAY,
    );
    assert.equal(s.maintenance.lapsed, 1);
    assert.equal(s.maintenance.notAccepted, 1);
    assert.equal(s.maintenance.nextEndsOn, '2027-01-01');
    assert.deepEqual(maintenanceSentence(s.maintenance), { value: '2 plans', caption: '1 ended: renewal due · 1 not accepted yet' });
  });
  test('a healthy plan says when it ends', () => {
    const s = summariseCommercials([{ currency: 'INR', acceptedQuoteMinor: null, maintenance: { name: 'Care', accepted: true, endsOn: '2027-03-31' } }], 'INR', TODAY);
    assert.deepEqual(maintenanceSentence(s.maintenance), { value: '1 plan', caption: 'next ends 2027-03-31' });
  });
});
