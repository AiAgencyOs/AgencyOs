import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { viewFailedDelivery } from '../src/lib/observability/delivery.ts';

/**
 * The operations screen turns a failed outbound message into a line an operator
 * can act on. Two things must hold: a failure with no recorded reason is SAID
 * to have none (not shown as blank, which reads as "no problem"), and the
 * preview is bounded and single-line so a long or multi-line message cannot run
 * the page. The provider's error and message id are its own public strings —
 * there is no secret here to leak.
 */
describe('viewFailedDelivery', () => {
  test('carries the provider error and message id as written', () => {
    const v = viewFailedDelivery({
      authorType: 'agent',
      body: 'Hi, following up on your quote.',
      metadata: { delivery: 'failed', error: '(#131047) Re-engagement message', provider_ref: 'wamid.ABC' },
      occurredAt: '2026-08-17T10:00:00Z',
    });
    assert.equal(v.reason, '(#131047) Re-engagement message');
    assert.equal(v.providerRef, 'wamid.ABC');
    assert.equal(v.preview, 'Hi, following up on your quote.');
    assert.equal(v.authorType, 'agent');
  });

  test('a failure with no recorded error says so rather than showing blank', () => {
    const v = viewFailedDelivery({
      authorType: 'user',
      body: 'Anything?',
      metadata: { delivery: 'failed' },
      occurredAt: '2026-08-17T10:00:00Z',
    });
    assert.match(v.reason, /no provider error/i);
    assert.equal(v.providerRef, null);
  });

  test('null/empty metadata does not throw and yields the stated fallback', () => {
    for (const metadata of [null, {}, { error: '   ' }]) {
      const v = viewFailedDelivery({ authorType: 'system', body: 'x', metadata, occurredAt: '2026-08-17T10:00:00Z' });
      assert.match(v.reason, /no provider error/i);
      assert.equal(v.providerRef, null);
    }
  });

  test('the preview is single-line and bounded', () => {
    const body = 'line one\nline two\t' + 'x'.repeat(400);
    const v = viewFailedDelivery({
      authorType: 'agent',
      body,
      metadata: { delivery: 'failed', error: 'boom' },
      occurredAt: '2026-08-17T10:00:00Z',
    });
    assert.ok(!v.preview.includes('\n'), 'preview collapses newlines');
    assert.ok(!v.preview.includes('\t'), 'preview collapses tabs');
    assert.ok(v.preview.length <= 140, `preview bounded, got ${v.preview.length}`);
    assert.ok(v.preview.endsWith('…'), 'a clipped preview is marked');
  });
});
