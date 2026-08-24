import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import { QUOTATION_THEMES, quotationArithmeticFault, renderQuotationPdf } from '../src/lib/pdf/quotation.ts';
import {
  QUOTATION_INDUSTRIES,
  quotationLanguageFault,
  quotationScopeSchema,
} from '../src/modules/sales/schema.ts';
import {
  COMMERCIAL_TERMS,
  REGULATED_CLAUSES,
  VALIDITY_DAYS,
  quotationSectionsFor,
  regulatedCategoriesFor,
} from '../src/modules/sales/quotation-standards.ts';

/**
 * The quotation refuses its own defects — G-167.
 *
 * The owner's corpus study read all 45 quotations this agency sent between
 * 29 July and 22 August 2026 and counted what actually went wrong. Two
 * defect classes were not merely present but SHIPPED, to real clients:
 *
 *   1. Five documents carried a cost table that did not sum to its own
 *      total — DharmikIndia's ₹19,75,000 quotation by ₹5,40,000, Tango's two
 *      by ₹5,000 and ₹10,000, Kaka Plastic's by ₹15,000, and Smart PG's
 *      grand total held only because a subtotal was overstated by ₹1,000.
 *
 *   2. Priced lines promised "structure ready", "API-ready", "hooks" and
 *      "much more" without once saying what does not work at handover —
 *      the sentence that decides the argument later.
 *
 * `PRICING_KNOWLEDGE` has ASKED the model to avoid class 2 since ADM-96.
 * Asking is not refusing, and the corpus is the evidence: every one of those
 * documents was written by someone who knew better.
 *
 * The two gates sit at different layers on purpose, and the difference is the
 * point (the guard-ownership discipline — asserting a refusal another layer
 * owns is a false test):
 *
 *   ARITHMETIC is owned by the DATABASE. `sales.proposal_totals()` re-sums
 *   the subtotal from the items and `proposals_total_is_arithmetic` asserts
 *   subtotal − discount + tax = total. The renderer's check is the LAST gate,
 *   not the only one, and it covers what the database cannot see: the items
 *   reach the renderer through a SEPARATE query from the totals.
 *
 *   LANGUAGE is owned by the WRITE. It is refused in `quotationScopeSchema`,
 *   where new content is authored — never at render, because an approved
 *   quotation is a record of what the owner decided and refusing to draw it
 *   later would break history to punish it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUOTE_MIGRATION = sqlCode(read('supabase/migrations/20260813120019_the_quote_the_owner_signs.sql'));

const DOC = {
  organizationName: 'BussEnhancer',
  preparedFor: 'A Sample Client',
  title: 'Delivery platform',
  version: 1,
  status: 'approved',
  body: null,
  currency: 'INR',
  items: [
    { description: 'Customer app', quantity: 1, amountMinor: 80_000_00 },
    { description: 'Admin panel', quantity: 1, amountMinor: 35_000_00 },
  ],
  subtotalMinor: 115_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 115_000_00,
  validUntil: null,
  preparedAt: '2026-08-24T10:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  reference: 'test-ref',
};

describe('A. the arithmetic gate — the corpus’s five broken tables', () => {
  test('a document whose lines add up draws, and reports no fault', async () => {
    // The positive twin: the gate must pass the honest document, or the
    // refusals below prove nothing.
    assert.equal(quotationArithmeticFault(DOC), null);
    const rendered = await renderQuotationPdf(DOC);
    assert.ok(rendered.bytes.length > 0);
    assert.ok(rendered.drawnText.includes('Total'));
  });

  test('lines that do not sum to the subtotal are refused, naming both figures', () => {
    // Kaka Plastic's exact shape: twelve modules summing to ₹85,000 under a
    // subtotal that says ₹70,000.
    const fault = quotationArithmeticFault({ ...DOC, items: [{ amountMinor: 85_000_00 }] });
    assert.match(fault ?? '', /sum to 8500000/);
    assert.match(fault ?? '', /subtotal drawn says 11500000/);
  });

  test('a total that is not subtotal − discount + tax is refused', () => {
    // Smart PG's shape: the total only held because a subtotal was inflated.
    const fault = quotationArithmeticFault({ ...DOC, taxMinor: 18_000_00 });
    assert.match(fault ?? '', /subtotal − discount \+ tax is 13300000/);
    assert.match(fault ?? '', /total drawn says 11500000/);
  });

  test('the renderer refuses to draw a single glyph of a broken document', async () => {
    // DharmikIndia's shape: a ₹19,75,000 total over lines summing to
    // ₹25,15,000. It must fail BEFORE any output exists, not produce a
    // document with a wrong page 2.
    await assert.rejects(
      () =>
        renderQuotationPdf({
          ...DOC,
          items: [{ description: 'Every work stream', quantity: 1, amountMinor: 25_15_000_00 }],
          subtotalMinor: 19_75_000_00,
          totalMinor: 19_75_000_00,
        }),
      /Quotation arithmetic does not hold/,
    );
  });

  test('an empty item list is not a fault — the totals still have to hold', () => {
    // A legacy proposal with no line rows renders its total alone; that is a
    // thin document, not a lying one. But the identity is still checked.
    assert.equal(quotationArithmeticFault({ ...DOC, items: [] }), null);
    assert.match(
      quotationArithmeticFault({ ...DOC, items: [], totalMinor: 99_00_000 }) ?? '',
      /total drawn says 9900000/,
    );
  });

  test('the DATABASE owns this invariant; the renderer is the last gate, not the only one', () => {
    // Named here so nobody later reads the renderer's check as the whole
    // control and deletes the real one, or vice versa.
    assert.match(QUOTE_MIGRATION, /total_minor = subtotal_minor - discount_minor \+ tax_minor/);
    assert.match(QUOTE_MIGRATION, /create trigger proposal_totals/);
    assert.match(QUOTE_MIGRATION, /sum\(i\.amount_minor\)/);
  });
});

describe('B. the language gate — what the corpus promised without bounding', () => {
  const scope = {
    title: 'SkyWash pickup platform',
    understanding:
      'SkyWash wants customers to book a laundry pickup from a phone, and partners to accept and track those jobs from theirs.',
    items: [
      {
        description: 'Customer app',
        priceRupees: 38_000,
        features: ['Mobile and OTP login', 'Book a pickup slot and pay online'],
      },
    ],
    summary: 'Covers the customer app and the admin panel. Multi-city zones are not covered.',
    exclusions: [],
    assumptions: [],
    clientResponsibilities: [],
  };

  test('an honest scope passes — both gates, the schema included', () => {
    assert.equal(quotationLanguageFault(scope), null);
    assert.equal(quotationScopeSchema.safeParse(scope).success, true);
  });

  test('an unbounded promise inside a fixed price is refused', () => {
    // The wagering quotation's exact sentence: twelve screens listed, then
    // "Much more Screens", for one fixed number.
    const fault = quotationLanguageFault({
      ...scope,
      items: [{ ...scope.items[0]!, features: ['Twelve screens', 'Much more screens'] }],
    });
    assert.match(fault ?? '', /leaves the scope open/);
    assert.match(fault ?? '', /Much more/i);
  });

  test('"etc" and "and more" are the same promise in fewer words', () => {
    for (const phrase of ['Wallet, KYC, etc.', 'Reports and more', 'Dashboards and many more']) {
      assert.match(
        quotationLanguageFault({ ...scope, summary: phrase }) ?? '',
        /leaves the scope open/,
        phrase,
      );
    }
  });

  test('a readiness promise without its limit is refused', () => {
    for (const line of ['Razorpay hooks', 'Wallet structure ready', 'Admin-ready backend', 'Scoring foundation']) {
      const fault = quotationLanguageFault({
        ...scope,
        items: [{ ...scope.items[0]!, description: line }],
      });
      assert.match(fault ?? '', /does not work at handover/, line);
    }
  });

  test('the SAME promise passes once the line says what does not work', () => {
    // The rule is not "never ship a foundation" — it is "name what the
    // foundation does not do". The limit may live in a sibling bullet, which
    // is how a person would actually write it.
    assert.equal(
      quotationLanguageFault({
        ...scope,
        items: [
          {
            ...scope.items[0]!,
            description: 'Razorpay hooks',
            features: [
              'Order creation and signature verification',
              'Does not take a live payment until SkyWash adds its own merchant keys',
            ],
          },
        ],
      }),
      null,
    );
  });

  test('an amount written into prose is refused — the price fields are the checked ones', () => {
    for (const text of ['Total is Rs. 50,000', 'Includes ₹12,000 of design', 'INR 95000 all in']) {
      assert.match(quotationLanguageFault({ ...scope, summary: text }) ?? '', /price fields/, text);
    }
  });

  test('the gate does not fire on the words that merely look like the defects', () => {
    // A false refusal fails the whole drafting job, so the guards matter as
    // much as the rules: "already" is not "-ready", a percentage is a product
    // feature the client asked for, and a plain number is not an amount.
    assert.equal(
      quotationLanguageFault({
        ...scope,
        summary: 'Serves 3 cities and about 500 partners at launch.',
        items: [
          {
            ...scope.items[0]!,
            description: 'Coupons and returning customers',
            features: ['Up to 20% off discount codes', 'Already-registered users skip onboarding'],
          },
        ],
      }),
      null,
    );
  });

  test('the gate is wired into the schema the drafting workflows validate against', () => {
    // The rule is worth nothing if it only exists as a function nobody calls.
    const bad = {
      ...scope,
      items: [{ ...scope.items[0]!, features: ['Login', 'Payments and much more'] }],
    };
    const parsed = quotationScopeSchema.safeParse(bad);
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.error?.issues ?? []), /leaves the scope open/);
  });

  test('one fault at a time, most-structural first', () => {
    // A model handed three complaints at once tends to fix the last one.
    const fault = quotationLanguageFault({
      ...scope,
      summary: 'Costs Rs. 50,000 and much more',
      items: [{ ...scope.items[0]!, description: 'Razorpay hooks' }],
    });
    assert.match(fault ?? '', /leaves the scope open/);
    assert.doesNotMatch(fault ?? '', /price fields/);
  });
});

describe('C. one brand, twelve accents — a theme may change a colour and nothing else', () => {
  test('the renderer’s accent roster and the schema’s industry list are the same list', () => {
    // The list exists twice because the renderer lives in src/lib and may not
    // import the sales module. Twice is fine; drifting is not.
    assert.deepEqual([...QUOTATION_THEMES], [...QUOTATION_INDUSTRIES]);
  });

  test('an untheme’d document and a "general" one are the SAME BYTES', async () => {
    // The promise G-165 made to legacy documents, kept again: a quotation
    // drafted before themes existed must not shift by a pixel.
    const plain = await renderQuotationPdf(DOC);
    const general = await renderQuotationPdf({ ...DOC, theme: 'general' });
    assert.equal(Buffer.from(plain.bytes).equals(Buffer.from(general.bytes)), true);
  });

  test('an unknown theme is the neutral document, not a crash and not a guess', async () => {
    const nonsense = await renderQuotationPdf({ ...DOC, theme: 'not-an-industry' });
    const plain = await renderQuotationPdf(DOC);
    assert.equal(Buffer.from(nonsense.bytes).equals(Buffer.from(plain.bytes)), true);
  });

  test('a themed document differs in ink and NOT in a single word', async () => {
    const plain = await renderQuotationPdf(DOC);
    const themed = await renderQuotationPdf({ ...DOC, theme: 'fintech' });
    assert.equal(
      Buffer.from(plain.bytes).equals(Buffer.from(themed.bytes)),
      false,
      'a theme that changes nothing is not a theme',
    );
    // The whole point: same document, different colour.
    assert.deepEqual(themed.drawnText, plain.drawnText);
  });

  test('every accent in the roster renders, and none of them changes the text', async () => {
    const plain = await renderQuotationPdf(DOC);
    for (const theme of QUOTATION_THEMES) {
      const rendered = await renderQuotationPdf({ ...DOC, theme });
      assert.deepEqual(rendered.drawnText, plain.drawnText, theme);
      assert.equal(rendered.replacedCharacters.length, 0, theme);
    }
  });

  test('a theme does not soften the status band — a warning is not decoration', async () => {
    const draft = await renderQuotationPdf({ ...DOC, status: 'draft', theme: 'gaming' });
    assert.ok(draft.drawnText.includes('DRAFT — NOT YET APPROVED'));
  });
});

describe('D. the sections the corpus was missing', () => {
  const documented = {
    understanding: 'A customer books a laundry pickup and a partner collects it.',
    exclusions: ['Multi-city zones'],
    assumptions: ['One city at launch'],
    clientResponsibilities: ['Razorpay merchant account'],
    dependencies: ['Brand assets before design starts'],
    acceptanceCriteria: ['A booking reaches a partner and is paid for, on staging'],
    optionalAddons: [{ label: 'Customer web portal', priceRupees: 35_000 }],
    industryTheme: 'marketplace',
  };

  test('validity has one home, and it is the corpus modal', () => {
    assert.equal(VALIDITY_DAYS, 15);
    assert.ok(COMMERCIAL_TERMS.some((l) => l.includes('15 days')));
  });

  test('the four clauses the corpus effectively did not have are all stated', () => {
    const text = COMMERCIAL_TERMS.join(' ');
    assert.match(text, /accepted when/i, 'acceptance was undefined in 42 of 45');
    assert.match(text, /cancellation/i, 'a cancellation position existed in 1 of 45');
    assert.match(text, /liability is limited/i, 'a liability cap existed in 1 of 45');
    assert.match(text, /jurisdiction/i, 'jurisdiction was named in 3 of 45');
  });

  test('a documented quotation draws the new sections, and the add-on says it is not in the total', async () => {
    const sections = quotationSectionsFor(95_000_00, 0, documented, [
      { description: 'Customer app' },
      { description: 'Partner app' },
    ]);
    assert.ok(sections);
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    const text = rendered.drawnText.join('\n');
    for (const label of ['DEPENDENCIES', 'ACCEPTED WHEN', 'OPTIONAL — NOT IN THE TOTAL ABOVE', 'COMMERCIAL TERMS']) {
      assert.ok(text.includes(label), `${label} did not draw`);
    }
    assert.match(text, /Customer web portal — ₹35,000\.00/);
    assert.equal(rendered.replacedCharacters.length, 0);
  });

  test('the theme rides the document, so the door does not have to know about it', () => {
    const sections = quotationSectionsFor(95_000_00, 0, documented, []);
    assert.equal(sections?.theme, 'marketplace');
  });

  test('a legacy proposal still gets none of it', async () => {
    assert.equal(quotationSectionsFor(95_000_00, 0, null, [{ description: 'Customer app' }]), null);
    const rendered = await renderQuotationPdf(DOC);
    for (const label of ['DEPENDENCIES', 'ACCEPTED WHEN', 'COMMERCIAL TERMS', 'REGULATORY']) {
      assert.ok(!rendered.drawnText.join('\n').includes(label), `${label} must not appear unasked`);
    }
  });
});

describe('E. the regulatory clause a model may not opt out of', () => {
  test('a declared category carries its clauses', () => {
    assert.deepEqual(regulatedCategoriesFor({ declared: 'lending', text: 'nothing telling here' }), ['lending']);
  });

  test('the scope’s own words add a category the model did not declare', () => {
    // The corpus's wagering quotation: an admin panel with payout-ratio and
    // result control, and no regulatory sentence anywhere in the document.
    assert.deepEqual(
      regulatedCategoriesFor({
        declared: null,
        text: 'UP/DOWN prediction game with payout ratio control and withdrawal approval',
      }),
      ['gaming', 'payouts'],
    );
  });

  test('the backstop can only ADD — a declaration is never overridden away', () => {
    const found = regulatedCategoriesFor({ declared: 'health', text: 'A loan application with EMI tracking' });
    assert.ok(found.includes('health'), 'the declared category survives');
    assert.ok(found.includes('lending'), 'and the text’s own category joins it');
  });

  test('an ordinary build gets no regulatory section at all', () => {
    assert.deepEqual(regulatedCategoriesFor({ declared: null, text: 'A turf booking app with slot selection' }), []);
    const sections = quotationSectionsFor(75_000_00, 0, { understanding: 'Turf slots.' }, [
      { description: 'Turf booking app', features: ['Slot selection'] },
    ]);
    assert.equal(sections?.regulatedClauses, null);
  });

  test('the clauses reach the page, and put the licence on the client', async () => {
    const sections = quotationSectionsFor(
      165_000_00,
      0,
      { understanding: 'A prediction game.' },
      [{ description: 'Wallet', features: ['Deposits and payout ratio control'] }],
    );
    assert.ok(sections?.regulatedClauses);
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('REGULATORY'));
    assert.match(text, /Real-money gaming is regulated/);
    assert.match(text, /client’s responsibility/);
  });

  test('every category in the clause table is reachable from words alone', () => {
    // A clause set nothing can select is a clause set that will never fire.
    const probes: Record<string, string> = {
      gaming: 'a betting round',
      lending: 'a loan disbursal',
      health: 'a patient record',
      payouts: 'a withdrawal request',
    };
    for (const category of Object.keys(REGULATED_CLAUSES)) {
      assert.ok(
        regulatedCategoriesFor({ declared: null, text: probes[category]! }).includes(category),
        category,
      );
    }
  });
});
