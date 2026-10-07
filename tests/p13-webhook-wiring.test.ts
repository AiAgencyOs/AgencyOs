import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { admitDelivery, bodyEventKey, rejectDelivery, settleDelivery } from '../src/lib/p13/webhook-guard.ts';

/**
 * W5 wiring: the three inbound webhook routes record every delivery in the ledger. The behaviour is driven here with a fake ledger; the routes are
 * pinned as source (each must call the guard in the right order), so removing a wiring line turns a test red.
 */

type Call = { fn: string; args: Record<string, unknown> };
function fakeAdmin(opts: { outcome?: string; originalStatus?: string | null; ledgerThrows?: boolean }) {
  const calls: Call[] = [];
  const core = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (opts.ledgerThrows) return Promise.resolve({ data: null, error: { message: 'down' } });
      if (fn === 'p13_record_webhook_event') {
        return Promise.resolve({ data: [{ outcome: opts.outcome ?? 'accepted', event_id: 'ev-1', duplicate_of: opts.outcome === 'duplicate' ? 'orig-1' : null }], error: null });
      }
      return Promise.resolve({ data: args.p_ok ? 'processed' : 'failed', error: null });
    },
    from() {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: opts.originalStatus ? { status: opts.originalStatus } : null, error: null }),
      };
      return b;
    },
  };
  const admin = { schema: () => core } as never;
  return { admin, calls };
}

describe('W5 webhook guard', () => {
  test('a first delivery is accepted and carries the ledger event id', async () => {
    const { admin, calls } = fakeAdmin({});
    const r = await admitDelivery(admin, { provider: 'whatsapp', eventKey: bodyEventKey('{}'), rawBody: '{}' });
    assert.deepEqual(r, { proceed: true, eventId: 'ev-1' });
    assert.equal(calls[0]!.args.p_signature_status, 'valid');
    assert.equal(calls[0]!.args.p_provider, 'whatsapp');
  });

  test('a replay of a processed delivery is answered from the ledger and not acted on', async () => {
    const { admin } = fakeAdmin({ outcome: 'duplicate', originalStatus: 'processed' });
    const r = await admitDelivery(admin, { provider: 'email', eventKey: 'm1', rawBody: 'x' });
    assert.deepEqual(r, { proceed: false, status: 200, outcome: 'duplicate' });
  });

  test('a replay of a delivery whose first attempt failed is processed again (the retry of a 500 must not be lost)', async () => {
    const { admin } = fakeAdmin({ outcome: 'duplicate', originalStatus: 'failed' });
    const r = await admitDelivery(admin, { provider: 'email', eventKey: 'm1', rawBody: 'x' });
    assert.deepEqual(r, { proceed: true, eventId: null });
  });

  test('an unreachable ledger fails open: the message is still ingested, the failure is logged', async () => {
    const { admin } = fakeAdmin({ ledgerThrows: true });
    const r = await admitDelivery(admin, { provider: 'whatsapp', eventKey: 'k', rawBody: 'x' });
    assert.deepEqual(r, { proceed: true, eventId: null });
  });

  test('a bad signature is recorded as invalid, a missing one as missing, with no organization and no event key', async () => {
    const a = fakeAdmin({ outcome: 'rejected_signature' });
    await rejectDelivery(a.admin, { provider: 'whatsapp', signatureHeader: 'sha256=bad', body: 'b' });
    assert.equal(a.calls[0]!.args.p_signature_status, 'invalid');
    assert.equal(a.calls[0]!.args.p_organization_id, null);
    assert.equal(a.calls[0]!.args.p_event_key, null);
    const b = fakeAdmin({ outcome: 'rejected_signature' });
    await rejectDelivery(b.admin, { provider: 'whatsapp', signatureHeader: null });
    assert.equal(b.calls[0]!.args.p_signature_status, 'missing');
  });

  test('a rejection never throws even when the ledger is down', async () => {
    const { admin } = fakeAdmin({ ledgerThrows: true });
    await rejectDelivery(admin, { provider: 'whatsapp', signatureHeader: 'x' });
  });

  test('the outcome is written back: 2xx processed, 5xx failed; no event id means nothing to write', async () => {
    const ok = fakeAdmin({});
    await settleDelivery(ok.admin, 'ev-1', 200, 'whatsapp');
    assert.equal(ok.calls[0]!.args.p_ok, true);
    const bad = fakeAdmin({});
    await settleDelivery(bad.admin, 'ev-1', 500, 'whatsapp');
    assert.equal(bad.calls[0]!.args.p_ok, false);
    const none = fakeAdmin({});
    await settleDelivery(none.admin, null, 200, 'whatsapp');
    assert.equal(none.calls.length, 0);
  });
});

describe('W5 the routes call the guard, in order', () => {
  for (const [route, provider] of [['whatsapp', 'whatsapp'], ['email', 'email'], ['facebook-leads', 'facebook_leads']] as const) {
    test(`/api/webhooks/${route}: reject on a bad signature, admit after the signature check and before ingest, settle afterwards`, () => {
      const src = readFileSync(new URL(`../app/api/webhooks/${route}/route.ts`, import.meta.url), 'utf8');
      const sig = src.indexOf(route === 'email' ? 'authorizeEmailSignature(' : 'authorizeSignature(rawBody');
      const reject = src.indexOf('await rejectDelivery(');
      const admit = src.indexOf('await admitDelivery(');
      const settle = src.indexOf('await settleDelivery(');
      assert.ok(sig > 0 && reject > sig, 'rejectDelivery follows the signature check');
      assert.ok(admit > reject, 'admitDelivery comes after the rejection branch');
      assert.ok(settle > admit, 'settleDelivery comes after admitDelivery');
      assert.match(src, new RegExp(`provider: '${provider}'`));
      const ingestName = route === 'email' ? 'ingestEmailLead(' : route === 'facebook-leads' ? 'ingestFacebookLead(' : 'ingestInboundMessage(';
      assert.ok(src.lastIndexOf(ingestName) > admit, 'ingest is called only after the ledger admitted the delivery');
    });
  }
});
