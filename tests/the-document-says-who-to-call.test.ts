import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import { quotationContactLine, renderQuotationPdf } from '../src/lib/pdf/quotation.ts';

/**
 * The document says who to call — G-171.
 *
 * Every one of the 45 quotations the corpus study read carried a contact
 * block: an email, a phone number and a place. The generated PDF carried the
 * agency's NAME and nothing else — so a client who forwards it to a partner,
 * which is the whole reason a PDF exists rather than a WhatsApp message, had
 * no way to reach the agency from the document in their hand.
 *
 * The rule the module already lived by decides the shape of this one: nothing
 * is invented. A letterhead that prints a phone number nobody set is worse
 * than a letterhead without one, so an unset contact block draws nothing at
 * all and the document is byte-identical to before.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260825120000_the_document_says_who_to_call.sql'));
const SERVICE = read('src/modules/sales/service.ts');
const HANDLERS = read('src/modules/crm/handlers.ts');

const DOC = {
  organizationName: 'BussEnhancer',
  preparedFor: 'A Sample Client',
  title: 'Delivery platform',
  version: 1,
  status: 'approved',
  body: null,
  currency: 'INR',
  items: [{ description: 'Customer app', quantity: 1, amountMinor: 115_000_00 }],
  subtotalMinor: 115_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 115_000_00,
  validUntil: null,
  preparedAt: '2026-08-25T10:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  reference: 'test-ref',
};

describe('A. the block is assembled from what is set, and never from what is not', () => {
  test('all three read in the order a person reads them', () => {
    assert.equal(
      quotationContactLine({
        quotation_contact_email: 'care@sonushah.com',
        quotation_contact_phone: '+91 90562 24993',
        quotation_contact_location: 'Mohali, Punjab',
      }),
      'care@sonushah.com  ·  +91 90562 24993  ·  Mohali, Punjab',
    );
  });

  test('a subset is a subset — no placeholder stands in for the missing one', () => {
    assert.equal(quotationContactLine({ quotation_contact_email: 'care@sonushah.com' }), 'care@sonushah.com');
    assert.equal(
      quotationContactLine({ quotation_contact_phone: '+91 90562 24993', quotation_contact_location: 'Mohali' }),
      '+91 90562 24993  ·  Mohali',
    );
  });

  test('nothing set is NULL, not an empty letterhead line', () => {
    assert.equal(quotationContactLine({}), null);
    assert.equal(quotationContactLine({ quotation_contact_email: '   ' }), null);
    assert.equal(quotationContactLine(null), null);
    assert.equal(quotationContactLine('not an object'), null);
    assert.equal(quotationContactLine(undefined), null);
  });

  test('an unrelated setting cannot leak onto the letterhead', () => {
    // The whitelist is in the database; this is the second wall.
    assert.equal(quotationContactLine({ whatsapp_phone_number_id: '123456789012345' }), null);
  });
});

describe('B. on the page — under the name, and absent when unset', () => {
  test('the block draws beneath the agency name', async () => {
    const rendered = await renderQuotationPdf({
      ...DOC,
      contactLine: 'care@sonushah.com  ·  +91 90562 24993  ·  Mohali, Punjab',
    });
    const text = rendered.drawnText.join('\n');
    assert.match(text, /care@sonushah\.com/);
    assert.match(text, /\+91 90562 24993/);
    // Directly after the name, which is where a letterhead puts it.
    const nameAt = rendered.drawnText.indexOf('BussEnhancer');
    const contactAt = rendered.drawnText.findIndex((l) => l.includes('care@sonushah.com'));
    assert.ok(nameAt >= 0 && contactAt > nameAt, 'the contact block must follow the name');
    assert.equal(rendered.replacedCharacters.length, 0);
  });

  test('no contact set draws NO contact — nothing is invented', async () => {
    // The first version of this test only compared the null render to the
    // absent render and asserted they matched. A red-proof that forced a
    // default contact line passed it clean: both renders were equally wrong,
    // and identical. An absence needs its own positive assertion.
    for (const input of [{ ...DOC, contactLine: null }, DOC]) {
      const rendered = await renderQuotationPdf(input);
      const text = rendered.drawnText.join('\n');
      assert.ok(!/@/.test(text), `an email appeared on a document with no contact set: ${text.slice(0, 200)}`);
      assert.ok(!/\+\d/.test(text), 'a phone number appeared on a document with no contact set');
    }
    // And having proved neither invents one, they must also agree.
    const withNull = await renderQuotationPdf({ ...DOC, contactLine: null });
    const without = await renderQuotationPdf(DOC);
    assert.equal(Buffer.from(withNull.bytes).equals(Buffer.from(without.bytes)), true);
  });

  test('it reaches the client copy, which is the copy that gets forwarded', async () => {
    // The approver note is deliberately absent from an approved document
    // (G-168); the contact block is deliberately present, and the difference
    // is the whole point of each.
    const rendered = await renderQuotationPdf({
      ...DOC,
      status: 'approved',
      contactLine: 'care@sonushah.com',
      internalNote: 'FOR THE APPROVER ONLY — this must not appear.',
    });
    const text = rendered.drawnText.join('\n');
    assert.match(text, /care@sonushah\.com/, 'the client must be able to reach the agency');
    assert.ok(!text.includes('FOR THE APPROVER'), 'and must not read the approver’s note');
  });
});

describe('C. the whitelist is the database’s, and the guard travels with it', () => {
  test('the three keys are whitelisted in the setter', () => {
    for (const key of ['quotation_contact_email', 'quotation_contact_phone', 'quotation_contact_location']) {
      assert.ok(MIGRATION.includes(`'${key}'`), `${key} must be whitelisted`);
    }
  });

  test('each carries a shape check — a typo on a client document is caught here', () => {
    assert.match(MIGRATION, /quotation_contact_email[\s\S]{0,200}invalid_value/);
    assert.match(MIGRATION, /quotation_contact_phone[\s\S]{0,200}invalid_value/);
    assert.match(MIGRATION, /quotation_contact_location[\s\S]{0,200}invalid_value/);
  });

  test('the guard names the same keys, from ONE array so the halves cannot drift', () => {
    // The old guard repeated each key in its own condition, which is how a
    // whitelist and its guard come to disagree. One list now.
    assert.match(MIGRATION, /v_keys text\[\] := array\[/);
    assert.match(MIGRATION, /foreach v_key in array v_keys loop/);
    for (const key of ['quotation_contact_email', 'quotation_contact_phone', 'quotation_contact_location']) {
      assert.ok(MIGRATION.includes(`'${key}'`), key);
    }
  });

  test('and no secret was let through the widening', () => {
    // The refusal that matters most is the one that did NOT change.
    assert.match(MIGRATION, /invalid_key/);
    for (const secret of ['api_key', 'token', 'secret', 'password']) {
      assert.ok(!new RegExp(`'[a-z_]*${secret}[a-z_]*'`).test(MIGRATION), `${secret} must not be whitelisted`);
    }
  });
});

describe('D. both render doors say the same thing', () => {
  test('the owner’s download and the client’s copy read the same settings', () => {
    // Two doors that assemble the letterhead differently are two agencies.
    assert.match(SERVICE, /contactLine: quotationContactLine\(org\.settings\)/);
    assert.match(HANDLERS, /contactLine: quotationContactLine\(org\.settings\)/);
  });

  test('both select the settings column they read it from', () => {
    assert.match(SERVICE, /\.select\('name, timezone, settings'\)/);
    assert.match(HANDLERS, /\.select\('name, timezone, settings'\)/);
  });
});
