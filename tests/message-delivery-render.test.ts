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
      wire: null,
      mediaKind: null,
    });
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'failed' }).delivery, 'failed');
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'pending' }).delivery, 'pending');
  });

  test('an inbound message has no send state of its own', () => {
    // Even if a delivery value were somehow present, inbound has no send state.
    assert.deepEqual(deliveryOf({ direction: 'inbound', delivery: 'sent' }), {
      direction: 'inbound',
      delivery: null,
      wire: null,
      mediaKind: null,
    });
  });

  test('an unrecognised or absent delivery value becomes null, never invented', () => {
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'delivered' }).delivery, null);
    assert.equal(deliveryOf({ direction: 'outbound' }).delivery, null);
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 42 }).delivery, null);
  });

  test('missing or malformed metadata is safe', () => {
    assert.deepEqual(deliveryOf(null), { direction: null, delivery: null, wire: null, mediaKind: null });
    assert.deepEqual(deliveryOf(undefined), { direction: null, delivery: null, wire: null, mediaKind: null });
    assert.deepEqual(deliveryOf('nonsense'), { direction: null, delivery: null, wire: null, mediaKind: null });
    assert.deepEqual(deliveryOf({}), { direction: null, delivery: null, wire: null, mediaKind: null });
  });
});

/**
 * The second axis — what Meta reported after we handed the message off.
 *
 * Kept separate from `delivery` on purpose, per the receipts migration: a
 * message can be delivery=sent and wire=failed, and it is precisely that pair
 * the transcript must not collapse into a reassuring double tick.
 */
describe('deliveryOf — the media kind', () => {
  test('a known kind is carried, in either direction', () => {
    assert.equal(deliveryOf({ direction: 'inbound', media_type: 'audio' }).mediaKind, 'audio');
    assert.equal(deliveryOf({ direction: 'outbound', media_type: 'image' }).mediaKind, 'image');
  });

  test('a text message has none', () => {
    assert.equal(deliveryOf({ direction: 'inbound' }).mediaKind, null);
  });

  test('an unrecognised kind becomes null rather than reaching a screen', () => {
    assert.equal(deliveryOf({ direction: 'inbound', media_type: 'order_update' }).mediaKind, null);
    assert.equal(deliveryOf({ direction: 'inbound', media_type: 7 }).mediaKind, null);
  });
});

describe('deliveryOf — the wire axis', () => {
  const out = (wire_status: unknown) =>
    deliveryOf({ direction: 'outbound', delivery: 'sent', wire_status });

  test('each Meta-reported state is carried through', () => {
    assert.equal(out('sent').wire, 'sent');
    assert.equal(out('delivered').wire, 'delivered');
    assert.equal(out('read').wire, 'read');
    assert.equal(out('failed').wire, 'failed');
  });

  test('no receipt yet is null — which is not the same as "not delivered"', () => {
    assert.equal(deliveryOf({ direction: 'outbound', delivery: 'sent' }).wire, null);
  });

  test('an unrecognised wire value becomes null rather than a state that does not exist', () => {
    assert.equal(out('pending').wire, null);
    assert.equal(out(7).wire, null);
    assert.equal(out(null).wire, null);
  });

  test('the two axes are independent — sent on ours, failed on Meta\'s', () => {
    // The case the receipts exist to surface: we handed it off successfully
    // and it still never arrived.
    const bounced = deliveryOf({ direction: 'outbound', delivery: 'sent', wire_status: 'failed' });
    assert.equal(bounced.delivery, 'sent');
    assert.equal(bounced.wire, 'failed');
  });

  test('an inbound message carries no wire state — a receipt cannot stamp a client\'s own words', () => {
    assert.equal(deliveryOf({ direction: 'inbound', wire_status: 'read' }).wire, null);
  });
});
