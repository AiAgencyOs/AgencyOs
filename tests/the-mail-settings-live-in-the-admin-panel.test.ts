import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { slotFor, storableSlots, validateSecretValue } from '../src/lib/secrets/registry.ts';

// Owner, 2026-10-04: "everything manageable from the admin panel". The mail server and both
// mailboxes are Keys & secrets slots, so nothing needs a redeploy.

const MAIL = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'EMAIL_FROM', 'SMTP_OUTREACH_USER', 'EMAIL_OUTREACH_FROM'];

describe('the mail settings are slots on the Keys & secrets screen', () => {
  test('every mail setting and both passwords are storable from the panel', () => {
    const keys = storableSlots().map((s) => s.key);
    for (const k of [...MAIL, 'SMTP_PASS', 'SMTP_OUTREACH_PASS']) assert.ok(keys.includes(k), k);
  });

  test('the seven settings are shown as values, never rotated; the two passwords stay secrets', () => {
    for (const k of MAIL) {
      assert.equal(slotFor(k)?.plain, true, k);
      assert.equal(slotFor(k)?.maxAgeDays, 0, k);
    }
    for (const k of ['SMTP_PASS', 'SMTP_OUTREACH_PASS']) assert.notEqual(slotFor(k)?.plain, true, k);
  });
});

describe('each setting is shape-checked before it is stored', () => {
  test('accepts the real Hostinger values', () => {
    assert.equal(validateSecretValue('SMTP_HOST', 'smtp.hostinger.com'), null);
    assert.equal(validateSecretValue('SMTP_PORT', '465'), null);
    assert.equal(validateSecretValue('SMTP_SECURE', 'true'), null);
    for (const k of ['SMTP_USER', 'EMAIL_FROM', 'SMTP_OUTREACH_USER', 'EMAIL_OUTREACH_FROM']) {
      assert.equal(validateSecretValue(k, k.includes('OUTREACH') ? 'info@sonushah.com' : 'care@sonushah.com'), null, k);
    }
  });

  test('refuses what would silently break sending', () => {
    assert.match(validateSecretValue('SMTP_HOST', 'https://smtp.hostinger.com') ?? '', /server name/);
    assert.match(validateSecretValue('SMTP_HOST', 'smtp.hostinger.com:465') ?? '', /server name/);
    assert.match(validateSecretValue('SMTP_PORT', '99999') ?? '', /port/i);
    assert.match(validateSecretValue('SMTP_PORT', 'abc') ?? '', /port/i);
    assert.match(validateSecretValue('SMTP_SECURE', 'yes') ?? '', /true or false/);
    assert.match(validateSecretValue('EMAIL_FROM', 'care sonushah.com') ?? '', /./);
    assert.match(validateSecretValue('EMAIL_FROM', 'care@sonushah') ?? '', /email address/);
  });
});
