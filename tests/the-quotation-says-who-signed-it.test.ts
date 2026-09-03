import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { preparedBySignature } from '../src/lib/pdf/quotation.ts';

/**
 * The quotation says who signed it — G-194 (Doc 08, QM-16).
 *
 * ── the finding ───────────────────────────────────────────────────────────
 *
 * A zero-trust audit read the twenty sections the renderer draws and found
 * the one a client looks for first missing. The document says which agency it
 * came from and who it is for, and **nothing at all about who**. Every one of
 * the 45 quotations in the corpus came from a person; the generated one came
 * from an institution, which is how a stranger's PDF reads.
 *
 * ── whose name, honestly ──────────────────────────────────────────────────
 *
 * Not the drafter. An agent wrote the words, and a person's name over a
 * model's paragraph would be the first invented sentence in a document whose
 * whole value is that nothing in it is invented.
 *
 * The APPROVER — the only human who read the number and said yes to it
 * (ADM-07, ADM-96). Which is why an unapproved copy carries no signature:
 * nobody has signed one.
 *
 * ── and why it is copied onto the row rather than joined ──────────────────
 *
 * `decided_by` is `on delete set null`, so a person leaving the agency would
 * erase their name from every quotation they ever signed; and `full_name` is
 * editable, so a joined name would make a document a client keeps change
 * after it was sent. The name and the role are frozen at the moment of
 * approval, the way G-165 froze the document, and the guard refuses every
 * later change.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260903120000_the_quotation_says_who_signed_it.sql'));

describe('A. the signature, and what it refuses to print', () => {
  test('a name and a role a person can read', () => {
    assert.deepEqual(preparedBySignature('Sonu Shah', 'owner'), { name: 'Sonu Shah', role: 'Owner' });
    assert.deepEqual(preparedBySignature('A Delivery Lead', 'delivery_lead'), {
      name: 'A Delivery Lead', role: 'Delivery lead',
    });
  });

  test('an unrecognised role draws NOTHING rather than its raw key', () => {
    // `ops_admin` under a name is worse than a name on its own, and a role
    // added to the enum later must not leak its identifier onto a client's
    // document before anybody has decided how to say it.
    assert.deepEqual(preparedBySignature('Sonu Shah', 'chief_of_vibes'), { name: 'Sonu Shah', role: null });
    assert.deepEqual(preparedBySignature('Sonu Shah', null), { name: 'Sonu Shah', role: null });
  });

  test('no name, no block — an agency that recorded none renders as it always did', () => {
    assert.equal(preparedBySignature(null, 'owner'), null);
    assert.equal(preparedBySignature('', 'owner'), null);
    assert.equal(preparedBySignature('   ', 'owner'), null);
    assert.equal(preparedBySignature(undefined, undefined), null);
  });

  test('and it is the name that is trimmed, not truncated', () => {
    assert.equal(preparedBySignature('  Sonu Shah  ', 'owner')?.name, 'Sonu Shah');
  });
});

describe('B. the page, RENDERED', () => {
  const base = {
    organizationName: 'BussEnhancer',
    preparedFor: 'A Sample Client — Sample Pvt Ltd',
    title: 'Delivery platform',
    version: 1,
    status: 'sent',
    body: 'Covers the apps.',
    currency: 'INR',
    items: [{ description: 'Customer app', quantity: 1, amountMinor: 90_000_00 }],
    subtotalMinor: 90_000_00,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 90_000_00,
    validUntil: '2026-09-18',
    preparedAt: '2026-09-03T10:00:00.000Z',
    timeZone: 'Asia/Kolkata',
    reference: 'test-ref',
  };

  test('the two parties sit side by side, and the role reads as words', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const rendered = await renderQuotationPdf({
      ...base, preparedByName: 'Sonu Shah', preparedByRole: 'owner',
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('PREPARED FOR'), 'the client half must still draw');
    assert.ok(text.includes('PREPARED BY'), 'the agency half did not draw');
    assert.ok(text.includes('Sonu Shah'), 'the approver was not named');
    assert.ok(text.includes('Owner'), 'the role did not draw as words');
    assert.ok(!text.includes('owner\n') && !text.includes('ops_admin'), 'no raw role key on the page');
    assert.equal(rendered.replacedCharacters.length, 0, 'every glyph must exist in the subset fonts');
  });

  test('an unsigned copy draws no label at all — not an empty one', async () => {
    // The failure this guards against is a heading with nothing under it,
    // which reads as a missing signature rather than as a document that never
    // needed one.
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const rendered = await renderQuotationPdf({ ...base, status: 'draft' });
    const text = rendered.drawnText.join('\n');
    assert.ok(!text.includes('PREPARED BY'), 'an unapproved copy must carry no signature');
    assert.ok(text.includes('PREPARED FOR'), 'and the client half is untouched by its absence');
  });

  test('a name with no readable role draws the name alone', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const rendered = await renderQuotationPdf({
      ...base, preparedByName: 'Sonu Shah', preparedByRole: 'chief_of_vibes',
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('PREPARED BY') && text.includes('Sonu Shah'));
    assert.ok(!text.includes('chief_of_vibes'), 'an unknown role key must never reach the page');
  });

  test('and a signature alone still draws, with no client block above it', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const rendered = await renderQuotationPdf({
      ...base, preparedFor: null, preparedByName: 'Sonu Shah', preparedByRole: 'owner',
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(!text.includes('PREPARED FOR'));
    assert.ok(text.includes('PREPARED BY') && text.includes('Sonu Shah'));
    assert.ok(text.includes('Total'), 'the rest of the document is unaffected');
  });
});

describe('C. the database owns the signature, not the caller', () => {
  test('it is written in exactly one place — the decision sync', () => {
    assert.match(MIGRATION, /approved_by_name = case when v_status = 'approved' then v_name else sales\.proposals\.approved_by_name end/);
    assert.match(MIGRATION, /approved_by_role = case when v_status = 'approved' then v_role else sales\.proposals\.approved_by_role end/);
  });

  test('read from the approval’s own decider, scoped to this organization', () => {
    assert.match(MIGRATION, /select r\.state, r\.decided_by into v_state, v_decider/);
    assert.match(MIGRATION, /join core\.memberships m[\s\S]{0,200}?m\.organization_id = v_row\.organization_id/);
  });

  test('a missing name stays NULL rather than becoming an id or an email', () => {
    // A quotation signed `a1f2c3d4-…` is worse than one signed by nobody.
    assert.match(MIGRATION, /nullif\(btrim\(u\.full_name\), ''\)/);
    assert.match(MIGRATION, /if v_status = 'approved' and v_decider is not null then/);
  });

  test('the guard refuses a proposal born already signed', () => {
    assert.match(MIGRATION, /a proposal is not created already approved by somebody/);
  });

  test('and refuses to change one once it is written — in any state', () => {
    assert.match(
      MIGRATION,
      /old\.approved_by_name is not null and new\.approved_by_name is distinct from old\.approved_by_name/,
    );
    assert.match(MIGRATION, /is a record of what happened, and does not change/);
  });

  test('and refuses to sign anything that is not approved', () => {
    assert.match(MIGRATION, /a quotation is signed when it is approved, not while it is %/);
  });

  test('the function stays SECURITY INVOKER — the guard is what makes the two new reads safe', () => {
    assert.match(MIGRATION, /create or replace function sales\.sync_proposal_decision\([\s\S]{0,200}?security invoker/);
  });
});

describe('D. every door that renders a quotation carries it', () => {
  test('both selects in the sales service read the two columns', () => {
    const service = codeOnly(read('src/modules/sales/service.ts'));
    assert.equal((service.match(/approved_by_name, approved_by_role'/g) ?? []).length, 2);
    assert.equal((service.match(/preparedByName: proposal\.approved_by_name \?\? null/g) ?? []).length, 2);
  });

  test('and so does the dispatch handler, which is the copy the client receives', () => {
    const handlers = codeOnly(read('src/modules/crm/handlers.ts'));
    assert.equal((handlers.match(/approved_by_name, approved_by_role'/g) ?? []).length, 2);
    assert.match(handlers, /preparedByName: proposal\.approved_by_name \?\? null/);
    assert.match(handlers, /preparedByRole: proposal\.approved_by_role \?\? null/);
  });
});
