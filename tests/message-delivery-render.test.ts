import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deliveryOf } from '../src/modules/crm/types.ts';

/**
 * The transcript makes a failed send distinguishable — queue item 14.
 *
 * A message's send state lives in its metadata jsonb, set by the send path:
 * pending when written, sent when the provider accepted it, failed when it did
 * not. `deliveryOf` is the one place that reads that shape, so it is tested
 * directly; the lead page renders whatever it returns. An unrecognised value
 * becomes null rather than a state that does not exist.
 */

describe('deliveryOf', () => {
  test('an outbound message carries its send state', () => {
    assert.deepEqual(deliveryOf({ direction: 'outbound', delivery: 'sent' }), {
      direction: 'outbound',
      delivery: 'sent',
    });
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'failed' }).delivery, 'failed');
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'pending' }).delivery, 'pending');
  });

  test('an inbound message has no send state of its own', () => {
    // Even if a delivery value were somehow present, inbound has no send state.
    assert.deepEqual(deliveryOf({ direction: 'inbound', delivery: 'sent' }), {
      direction: 'inbound',
      delivery: null,
    });
  });

  test('an unrecognised or absent delivery value becomes null, never invented', () => {
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'delivered' }).delivery, null);
    assert.equal(deliveryOf({ direction: 'outbound' }).delivery, null);
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 42 }).delivery, null);
  });

  test('missing or malformed metadata is safe', () => {
    assert.deepEqual(deliveryOf(null), { direction: null, delivery: null });
    assert.deepEqual(deliveryOf(undefined), { direction: null, delivery: null });
    assert.deepEqual(deliveryOf('nonsense'), { direction: null, delivery: null });
    assert.deepEqual(deliveryOf({}), { direction: null, delivery: null });
  });
});
