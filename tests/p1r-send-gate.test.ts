import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { invoiceSendHold } from '../src/modules/finance/p1r-send-hold.ts';

/**
 * Round 4: the last client-facing senders ask the notification gate. Behaviour of the invoice hold is driven with a fake rules function; the four call
 * sites are pinned as source so removing the question is red.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function client(row: { allowed: boolean; reason: string } | 'throws') {
  return {
    schema: () => ({
      rpc: () => Promise.resolve(row === 'throws' ? { data: null, error: { message: 'down' } } : { data: [row], error: null }),
    }),
  };
}

describe('P1R invoice send hold', () => {
  test('allowed: goes ahead', async () => {
    assert.equal(await invoiceSendHold(client({ allowed: true, reason: 'ok' }), 'o', 'email'), null);
  });
  for (const reason of ['quiet_hours', 'disabled', 'too_soon']) {
    test(`${reason}: the send is refused with the reason in words`, async () => {
      const held = await invoiceSendHold(client({ allowed: false, reason }), 'o', 'whatsapp');
      assert.ok(held && !held.ok);
      assert.equal(held.error.code, 'CONFLICT');
      assert.match(held.error.message, /^Not sent\./);
    });
  }
  test('unreadable rules hold a bill (a client is never billed on a rulebook that could not be read)', async () => {
    const held = await invoiceSendHold(client('throws'), 'o', 'email');
    assert.ok(held && !held.ok);
    assert.match(held.error.message, /could not be read/);
  });
  test('a session with no organisation is refused, not defaulted', async () => {
    const held = await invoiceSendHold(client({ allowed: true, reason: 'ok' }), undefined, 'email');
    assert.ok(held && !held.ok);
  });
});

describe('P1R the senders ask before they send', () => {
  test('manual invoice email: asks the hold before the transport is used', () => {
    const src = read('src/modules/finance/email-send-service.ts');
    const ask = src.indexOf("invoiceSendHold(supabase, context.organizationId, 'email')");
    assert.ok(ask > 0);
    assert.ok(src.indexOf('await sendEmail({') > ask);
    assert.ok(src.indexOf('if (held) return held;') > ask);
  });
  test('manual invoice WhatsApp: asks before the first leg', () => {
    const src = read('src/modules/finance/whatsapp-send-service.ts');
    const ask = src.indexOf("invoiceSendHold(supabase, context.organizationId, 'whatsapp')");
    assert.ok(ask > 0);
    assert.ok(src.indexOf('await sendClientMessage({') > ask);
  });
  test('campaign worker: asks (client-facing) before the allowance and the send', () => {
    const src = read('src/modules/crm/campaign-worker.ts');
    const ask = src.indexOf("heldByNotificationRules(admin, { organizationId: row.organization_id, eventClass: 'sales', channel: 'whatsapp', clientFacing: true })");
    assert.ok(ask > 0);
    assert.ok(src.indexOf('await outreachAllowance(') > ask);
    assert.ok(src.indexOf('await sendTemplateToConversation(') > ask);
  });
  test('outreach worker: asks (client-facing) before the claim reserves anything', () => {
    const src = read('src/modules/crm/outreach/worker.ts');
    const ask = src.indexOf("heldByNotificationRules(admin, { organizationId, eventClass: 'sales', channel: 'email', clientFacing: true })");
    assert.ok(ask > 0);
    assert.ok(src.indexOf("rpc('claim_outreach_sends'") > ask);
  });
});
