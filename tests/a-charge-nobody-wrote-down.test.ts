import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { quotationDocumentSchema, quotationScopeSchema } from '../src/modules/sales/schema.ts';

/**
 * A charge nobody wrote down — G-207 (audit QM-20).
 *
 * ── the finding ───────────────────────────────────────────────────────────
 *
 * G-178 got the important half right: `whoPays` is an enum because whose bill
 * it is causes the argument, and there is no numeric price field because *"a
 * figure printed inside a fixed-price quotation becomes a commitment the
 * agency cannot keep and did not make."*
 *
 * What it left was `charge` — free text, written by the model, printed
 * verbatim to a client:
 *
 *     Razorpay — payment collection. Billed to you directly by the provider,
 *     and not part of this price. 2% per transaction
 *
 * That two per cent came from a language model. **It was the one number in
 * the whole quotation with no row behind it**, in a system whose central rule
 * is that every price belongs to somebody who wrote it down —
 * `crm.refuse_unread_price` refuses exactly this at the row for a WhatsApp
 * message, and the quotation had no equivalent.
 *
 * ── and the control is the resolver, not the prompt ───────────────────────
 *
 * The model cites a ref from the Admin's list. The words are read back out of
 * `crm.third_party_charges` and anything it wrote for itself is deleted. A
 * prompt rule a model can decline is not a control.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const MIGRATION = read('supabase/migrations/20260904200000_a_charge_nobody_wrote_down.sql');

describe('A. the model cannot express a figure', () => {
  /**
   * Asked of `quotationScopeSchema`, which is the AGENT'S OUTPUT, and not of
   * `quotationDocumentSchema`, which is the stored jsonb.
   *
   * The distinction cost me a false pass. The stored schema is deliberately
   * `.loose()` with `.catch(null)` — one malformed entry must not take the
   * understanding and the exclusions down with it — so every bad ref below
   * sails straight through it. Asserting the guard there would have been
   * asserting it of the one schema whose job is NOT to refuse.
   *
   * The refusal belongs where the model's words arrive, once.
   */
  const scope = (chargeRef: string) =>
    quotationScopeSchema.safeParse({
      title: 'Food delivery platform',
      summary: 'A delivery app for a restaurant, with customer ordering and a kitchen view.',
      items: [
        {
          description: 'Customer app',
          priceRupees: 50_000,
          effortDays: 10,
          features: ['Browse the menu', 'Place an order', 'Track it'],
        },
      ],
      exclusions: ['Anything not listed above'],
      assumptions: ['The menu is supplied as a spreadsheet'],
      clientResponsibilities: ['Provide the menu and the brand assets'],
      understanding: 'A delivery app for a restaurant, with customer ordering.',
      integrations: [{ name: 'Razorpay', purpose: 'Collecting payments from customers', whoPays: 'client', chargeRef }],
    });

  test('a ref of exactly eight hex characters is accepted', () => {
    /**
     * This is the twin that makes the refusal below mean anything.
     *
     * It failed first, on a fixture missing five unrelated required fields —
     * which meant every "bad ref is refused" case was passing for the wrong
     * reason. A negative assertion over an invalid fixture refuses everything,
     * including the thing it is supposed to permit.
     */
    const parsed = scope('a1b2c3d4');
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.map((i) => i.path.join('.'))));
    assert.equal(parsed.data?.integrations?.[0]?.chargeRef, 'a1b2c3d4');
  });

  test('and anything shaped like money REFUSES THE DRAFT', () => {
    // Not "the field is dropped" — the whole parse fails, the draft is
    // refused, and the client sees nothing. That is the same posture the
    // client-reply schema takes about a price: a model that names an amount
    // fails here rather than being quietly tidied up.
    for (const notARef of ['2% per txn', '2', '₹8300', 'A1B2C3D4', 'a1b2c3d', '2 percent']) {
      assert.equal(scope(notARef).success, false, `${notARef} was accepted as a ref`);
    }
  });

  test('the stored document holds resolved WORDS and never a ref', () => {
    // What survives into jsonb is the Admin's sentence, because the resolver
    // deletes the ref on its way past. Nothing downstream should be able to
    // look the charge up a second time and get a different answer.
    const doc = quotationDocumentSchema.safeParse({
      understanding: 'A delivery app.',
      integrations: [{ name: 'Razorpay', purpose: 'Collecting payments', whoPays: 'client', charge: '2% per transaction' }],
    });
    assert.equal(doc.success, true);
    assert.equal(doc.data?.integrations?.[0]?.charge, '2% per transaction');
  });
});

describe('B. the resolver is the control', () => {
  test('the words come from the row, keyed on the ref', () => {
    assert.match(WORKFLOWS, /const found = ref \? byRef\.get\(ref\) : undefined;/);
    assert.match(WORKFLOWS, /item\.charge = found\.charge;/);
  });

  test('and a charge the model wrote for itself is DELETED, not passed through', () => {
    // The whole finding in one line. Leaving it would be indistinguishable
    // downstream from a figure an Admin recorded.
    assert.match(WORKFLOWS, /delete item\.charge;/);
    assert.match(WORKFLOWS, /delete item\.chargeRef;/);
  });

  test('the ref never survives into the document either', () => {
    // An eight-character id is not something a client should read, and a ref
    // left on the row would be a second place the charge could be looked up
    // from — one of which could go stale.
    assert.match(WORKFLOWS, /item\.charge = found\.charge;\s*\n\s*delete item\.chargeRef;/);
  });

  test('org-scoped and active-only, so a retired charge cannot be cited', () => {
    assert.match(WORKFLOWS, /thirdPartyChargesFor[\s\S]{0,700}?\.eq\('organization_id', organizationId\)[\s\S]{0,120}?\.eq\('active', true\)/);
  });

  test('a failed read logs and yields an empty list rather than failing the draft', () => {
    // What is lost is a line the document is allowed to omit anyway; what a
    // refusal would cost is the quotation.
    assert.match(WORKFLOWS, /scope: 'thirdPartyChargesFor'/);
  });

  test('and it runs at all three drafting doors', () => {
    assert.equal(
      (WORKFLOWS.match(/integrations: resolveIntegrationCharges\(validated\.data\.integrations \?\? null, \w+\)/g) ?? []).length,
      3,
    );
    assert.equal((WORKFLOWS.match(/await thirdPartyChargesFor\(admin, job\.organization_id\)/g) ?? []).length, 3);
  });
});

describe('C. what the drafter is shown', () => {
  test('service, words and ref — never told to invent one', () => {
    assert.match(WORKFLOWS, /THIRD-PARTY CHARGES THIS AGENCY HAS RECORDED/);
    assert.match(WORKFLOWS, /A service that is not here gets no figure at all/);
  });

  test('an empty list shows nothing at all', () => {
    // A heading with nothing under it is an invitation to fill the gap.
    assert.match(WORKFLOWS, /if \(charges\.length === 0\) return '';/);
  });

  test('all three prompts carry the absolute rule', () => {
    assert.equal((WORKFLOWS.match(/You may NEVER write a charge yourself, in any field, in any form/g) ?? []).length, 3);
  });

  test('and name the no-figure case as the ordinary one, not a failure', () => {
    // G-178 already called it "the honest answer and the common one". A model
    // told an omission is a defect will fill it.
    assert.equal((WORKFLOWS.match(/That is the ordinary case, and the document is complete without it/g) ?? []).length, 3);
  });
});

describe('D. the list is the Admin’s, and it says when it was last true', () => {
  const sql = sqlCode(MIGRATION);

  test('one row per service per organization, case-insensitively', () => {
    // "Razorpay" and "razorpay" are one service; two rows would make the
    // resolver choose, which is the judgement this design keeps away from it.
    assert.match(sql, /create unique index if not exists third_party_charges_service_key[\s\S]{0,160}?lower\(btrim\(service\)\)/);
  });

  test('the charge is text, because real charges are not numbers', () => {
    assert.match(sql, /charge\s+text not null/);
  });

  test('it carries provenance and a confirmation date', () => {
    assert.match(sql, /source\s+text/);
    assert.match(sql, /checked_on\s+date not null/);
  });

  test('a confirmation date in the future is refused', () => {
    // The one input that would make a staleness warning lie.
    assert.match(sql, /if v_when > current_date then[\s\S]{0,120}?'not_yet'/);
  });

  test('writes go through the function, and the row refuses anything else', () => {
    assert.match(sql, /crm\.charge_write_is_sanctioned/);
    assert.match(sql, /third_party_charges are set through crm\.set_third_party_charge|third-party charges are set through crm\.set_third_party_charge/);
  });

  test('and retiring keeps the row, so a sent quotation still points at something', () => {
    assert.match(sql, /update crm\.third_party_charges set active = false/);
  });
});
