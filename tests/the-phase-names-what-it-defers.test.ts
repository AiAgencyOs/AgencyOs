import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { renderQuotationPdf } from '../src/lib/pdf/quotation.ts';
import { countSurfaces, depthOf, laneReferenceFor } from '../src/modules/sales/pricing-reference.ts';
import { quotationSectionsFor } from '../src/modules/sales/quotation-standards.ts';
import { quotationScopeSchema } from '../src/modules/sales/schema.ts';

/**
 * The phase names what it defers — G-169.
 *
 * Two things, both taken from the same eight documents in the corpus: the
 * DharmikIndia phases, the only quotations in 45 that said what a phase does
 * NOT include and which later phase owns it. That device turns "why isn't X
 * there?" into "X is phase 5", and it existed nowhere else in the folder.
 *
 * The second half is the one that makes the G-168 reference honest. It has
 * been counting surfaces and reading depth out of PROSE with regexes —
 * "Customer app" counts, "Backend, APIs and database" must not, and every
 * judgement between those was a guess. The model wrote the line and knows
 * which it is, so it now says so, and the regexes are the fallback for
 * drafts written before the field existed.
 */

const DOC = {
  organizationName: 'BussEnhancer',
  preparedFor: 'A Sample Client',
  title: 'Faith platform',
  version: 1,
  status: 'approved',
  body: null,
  currency: 'INR',
  items: [{ description: 'Customer app', quantity: 1, amountMinor: 285_000_00 }],
  subtotalMinor: 285_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 285_000_00,
  validUntil: null,
  preparedAt: '2026-08-25T10:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  reference: 'test-ref',
};

const BASE_SCOPE = {
  title: 'Faith platform — foundation',
  understanding:
    'The client wants a personalised home for six religions, with authentication and profiles before any commerce module is built.',
  items: [
    {
      description: 'Customer app',
      priceRupees: 200_000,
      features: ['Mobile OTP login', 'Religion selection and theming'],
      kind: 'surface' as const,
    },
    {
      description: 'Backend, APIs and database',
      priceRupees: 85_000,
      features: ['Session and device management', 'Religion engine tables'],
      kind: 'foundation' as const,
    },
  ],
  summary: 'Covers the foundation layer only.',
  exclusions: [],
  assumptions: [],
  clientResponsibilities: [],
};

describe('A. a phase says what it hands to a later one', () => {
  test('the schema takes a phase block with its deferrals', () => {
    const parsed = quotationScopeSchema.safeParse({
      ...BASE_SCOPE,
      phase: {
        number: 1,
        of: 7,
        deferredTo: [
          { item: 'Product catalog, cart and checkout', phase: 2 },
          { item: 'Book My Pandit and the pandit dashboard', phase: 3 },
        ],
      },
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('a deferral must name a LATER phase — otherwise it is an exclusion wearing a plan’s clothes', () => {
    const backwards = quotationScopeSchema.safeParse({
      ...BASE_SCOPE,
      phase: { number: 3, of: 7, deferredTo: [{ item: 'Wallet', phase: 2 }] },
    });
    assert.equal(backwards.success, false);
    assert.match(JSON.stringify(backwards.error?.issues), /must name a LATER phase/);
  });

  test('and a phase cannot be numbered beyond its own programme', () => {
    const impossible = quotationScopeSchema.safeParse({
      ...BASE_SCOPE,
      phase: { number: 9, of: 7, deferredTo: [] },
    });
    assert.equal(impossible.success, false);
    assert.match(JSON.stringify(impossible.error?.issues), /beyond the programme/);
  });

  test('the assembler turns it into a label and a list', () => {
    const sections = quotationSectionsFor(
      285_000_00,
      0,
      {
        understanding: 'Foundation layer.',
        phase: { number: 1, of: 7, deferredTo: [{ item: 'Prasad delivery', phase: 4 }] },
      },
      [{ description: 'Customer app', kind: 'surface' }],
    );
    assert.equal(sections?.phaseLabel, 'Phase 1 of 7');
    assert.deepEqual(sections?.deferredLines, ['Prasad delivery — phase 4']);
  });

  test('a single-shot quotation gets neither, and looks exactly as it did', async () => {
    const sections = quotationSectionsFor(285_000_00, 0, { understanding: 'One build.' }, [
      { description: 'Customer app', kind: 'surface' },
    ]);
    assert.equal(sections?.phaseLabel, null);
    assert.equal(sections?.deferredLines, null);
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    assert.ok(!rendered.drawnText.join('\n').includes('NOT IN THIS PHASE'));
  });

  test('on the page: the phase rides beside the version, the deferrals below the exclusions', async () => {
    const sections = quotationSectionsFor(
      285_000_00,
      0,
      {
        understanding: 'Foundation layer.',
        exclusions: ['Native mobile applications'],
        phase: {
          number: 1,
          of: 7,
          deferredTo: [
            { item: 'Product catalog, cart and checkout', phase: 2 },
            { item: 'Book My Pandit', phase: 3 },
          ],
        },
      },
      [{ description: 'Customer app', kind: 'surface' }],
    );
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    const text = rendered.drawnText.join('\n');
    assert.match(text, /Phase 1 of 7/);
    assert.ok(text.includes('NOT IN THIS PHASE — AND WHICH PHASE OWNS IT'));
    assert.match(text, /Product catalog, cart and checkout — phase 2/);
    assert.match(text, /Book My Pandit — phase 3/);
    // Exclusions and deferrals are DIFFERENT sections: one says never, the
    // other says not yet, and a client must not have to guess which.
    assert.ok(text.includes('EXPLICITLY NOT INCLUDED'));
    assert.ok(text.indexOf('EXPLICITLY NOT INCLUDED') < text.indexOf('NOT IN THIS PHASE'));
    assert.equal(rendered.replacedCharacters.length, 0);
  });
});

describe('B. stated beats inferred — the reference stops guessing', () => {
  test('when the model says which lines are surfaces, the regexes stay out of it', () => {
    const scope = {
      items: [
        // Prose that the regex would read WRONG in both directions.
        { description: 'Rider experience', kind: 'surface' as const },
        { description: 'Ops console', kind: 'surface' as const },
        { description: 'Payment app integration layer', kind: 'foundation' as const },
      ],
    };
    assert.equal(countSurfaces(scope), 2);
    // Without the kinds, the same three lines read differently.
    assert.notEqual(countSurfaces({ items: scope.items.map(({ description }) => ({ description })) }), 2);
  });

  test('a scope with NO kinds anywhere still falls back to reading prose', () => {
    // Every draft written before this field existed depends on this.
    assert.equal(
      countSurfaces({ items: [{ description: 'Customer app' }, { description: 'Backend and database' }] }),
      1,
    );
  });

  test('stated depth wins, and an unstated one is standard rather than cheap', () => {
    assert.equal(depthOf({ items: [{ description: 'MVP app' }], depth: 'full' }), 'full');
    assert.equal(depthOf({ items: [{ description: 'MVP app' }] }), 'basic');
    assert.equal(depthOf({ items: [{ description: 'Customer app' }] }), 'standard');
  });

  test('the reference says which facts it had to guess', () => {
    const guessed = laneReferenceFor({ items: [{ description: 'Customer app' }, { description: 'Admin panel' }] });
    assert.ok(guessed.basis.some((b) => /read from the wording/.test(b)));

    const stated = laneReferenceFor({
      items: [
        { description: 'Customer app', kind: 'surface' },
        { description: 'Admin panel', kind: 'surface' },
      ],
      depth: 'standard',
    });
    assert.ok(!stated.basis.some((b) => /read from the wording/.test(b)), 'nothing was guessed, so say nothing');
  });

  test('stated facts change the figure, which is the whole point', () => {
    const items = [
      { description: 'Rider experience' },
      { description: 'Ops console' },
      { description: 'Driver experience' },
    ];
    // Read as prose: none of these match the surface regex → Lane 0 or a
    // two-surface base. Stated: three surfaces, which is a different price.
    const inferred = laneReferenceFor({ items });
    const stated = laneReferenceFor({
      items: items.map((i) => ({ ...i, kind: 'surface' as const })),
      depth: 'standard',
    });
    assert.notEqual(inferred.referenceRupees, stated.referenceRupees);
    assert.equal(stated.surfaces, 3);
    assert.equal(stated.referenceRupees, 65_000); // (50,000 + 10,000) × 1.1
  });

  test('the phase and the kinds ride the stored document, so every door agrees', () => {
    const sections = quotationSectionsFor(
      65_000_00,
      0,
      { understanding: 'Three surfaces.', depth: 'standard', phase: { number: 2, of: 4, deferredTo: [] } },
      [
        { description: 'Rider experience', kind: 'surface' },
        { description: 'Ops console', kind: 'surface' },
        { description: 'Driver experience', kind: 'surface' },
      ],
    );
    assert.equal(sections?.phaseLabel, 'Phase 2 of 4');
    // ₹65,000 against a ₹65,000 reference — silence, and it took the stated
    // depth to get there.
    assert.equal(sections?.internalNote, null);
  });
});

describe('C. a name a person can say — G-170', () => {
  test('the code is derived, stable, and identical on every re-render', async () => {
    const { quotationReferenceCode } = await import('../src/lib/pdf/quotation.ts');
    const id = '4b0f6d1a-9c3e-4a2b-8f7d-2e5a1c9b3d84';
    const once = quotationReferenceCode(id, '2026-08-25T10:00:00.000Z');
    const twice = quotationReferenceCode(id, '2026-08-25T10:00:00.000Z');
    assert.equal(once, twice);
    assert.equal(once, 'Q-2026-4B0F6D');
    assert.match(once, /^Q-\d{4}-[0-9A-F]{6}$/);
  });

  test('it is NOT a counter, and two quotations minutes apart prove it', async () => {
    const { quotationReferenceCode } = await import('../src/lib/pdf/quotation.ts');
    const a = quotationReferenceCode('aaaaaaaa-0000-4000-8000-000000000001', '2026-08-25T10:00:00.000Z');
    const b = quotationReferenceCode('bbbbbbbb-0000-4000-8000-000000000002', '2026-08-25T10:05:00.000Z');
    assert.notEqual(a, b);
    // Nothing about them implies an order, which is the honest reading: a
    // sequence would need a table, and would then owe an answer about
    // discarded drafts.
    assert.ok(!/0*1$/.test(a) || !/0*2$/.test(b));
  });

  test('a malformed date degrades to a code rather than a crash', async () => {
    const { quotationReferenceCode } = await import('../src/lib/pdf/quotation.ts');
    assert.match(quotationReferenceCode('abc', 'not-a-date'), /^Q-0000-ABC000$/);
  });

  test('the client reads the code at the top; the UUID stays in the footer', async () => {
    const rendered = await renderQuotationPdf(DOC);
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('Q-2026-TESTRE') || /Q-2026-[0-9A-F]{6}/.test(text), 'the sayable code must be drawn');
    // The address is still there for support to look up.
    assert.ok(text.includes('test-ref'), 'the traceable reference must survive in the footer');
  });
});
