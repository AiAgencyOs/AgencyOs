import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { renderQuotationPdf, statusBandFor } from '../src/lib/pdf/quotation.ts';
import {
  countSurfaces,
  depthOf,
  laneReferenceFor,
  pricingNoteFor,
} from '../src/modules/sales/pricing-reference.ts';
import { quotationSectionsFor, timelineBandFor } from '../src/modules/sales/quotation-standards.ts';

/**
 * The price checks itself against the lane — G-168.
 *
 * The corpus study proposed blocking any draft implying under ₹2,000 per
 * developer-day. Measured against this engine that control is vacuous, and
 * suite A proves it rather than asserting it: `timelineBandFor` derives the
 * timeline FROM the price, so the implied day-rate is a function of price
 * alone and cannot see scope at all.
 *
 * What replaced it reads the scope the model actually wrote, prices it by
 * the agency's own lane formula, and shows the OWNER the difference. It
 * never blocks and it never reaches a client — both properties are tested,
 * the second one structurally.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const line = (description: string, features: string[] = []) => ({ description, features });

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

describe('A. why the day-rate floor was not built — the arithmetic, not an opinion', () => {
  const perDay = (rupees: number, weeks: number) => rupees / (weeks * 5);

  test('the implied day-rate is a function of PRICE ALONE, so it cannot see scope', () => {
    // OTT (a Netflix-class platform) and NearServe (a three-role marketplace)
    // were both quoted ₹50,000 in the corpus. The band comes from the price,
    // so the two are indistinguishable to any day-rate rule.
    const band = timelineBandFor(50_000_00);
    const ott = perDay(50_000, band.weeksMin);
    const nearserve = perDay(50_000, band.weeksMin);
    assert.equal(ott, nearserve);
    assert.ok(ott < 2000, `₹${Math.round(ott)}/day — a ₹2,000 floor refuses both or neither`);
  });

  test('a ₹2,000 floor would refuse the corpus’s MODAL price', () => {
    // ₹50,000 is 9/45 of the corpus. A guard that rejects the most common
    // quotation an agency writes is not a guard.
    const band = timelineBandFor(50_000_00);
    assert.ok(perDay(50_000, band.weeksMin) < 2000);
  });

  test('and it is not monotonic — one rupee halves the measure at a band edge', () => {
    const low = perDay(49_999, timelineBandFor(49_999_00).weeksMin);
    const high = perDay(50_000, timelineBandFor(50_000_00).weeksMin);
    assert.ok(high < low / 1.9, `₹49,999 → ₹${Math.round(low)}/day, ₹50,000 → ₹${Math.round(high)}/day`);
  });

  test('the reasoning is written where the next person will look for it', () => {
    // A control deliberately NOT built leaves no code behind, so the argument
    // has to live somewhere or it gets proposed again next quarter.
    const source = read('src/modules/sales/pricing-reference.ts');
    assert.match(source, /WHY NOT THE DAY-RATE FLOOR/);
    assert.match(source, /function of price alone/);
  });
});

describe('B. the lane formula, in code at last', () => {
  test('a surface is something a person opens; the work that builds one is not', () => {
    assert.equal(
      countSurfaces({
        items: [
          line('Customer app'),
          line('Admin panel'),
          line('Backend, APIs and database'),
          line('UI/UX design and prototype'),
          line('Testing, deployment and handover'),
        ],
      }),
      2,
      'counting the backend and the design would double every estimate',
    );
  });

  test('two surfaces at standard depth is the base times the multiplier', () => {
    const ref = laneReferenceFor({ items: [line('Customer app'), line('Admin panel')] });
    assert.equal(ref.lane, 2);
    assert.equal(ref.depth, 'standard');
    assert.equal(ref.referenceRupees, 55_000); // 50,000 × 1.1
  });

  test('each surface beyond two adds, and the levers stack in the corpus’s order', () => {
    const ref = laneReferenceFor({
      items: [
        line('Customer app', ['Book a slot and pay with Razorpay']),
        line('Partner app'),
        line('Admin panel'),
      ],
    });
    // (50,000 + 10,000) × 1.1 = 66,000, + 30,000 live gateway = 96,000 → 95,000
    assert.equal(ref.referenceRupees, 95_000);
    assert.ok(ref.basis.some((b) => /live third-party integration/.test(b)));
  });

  test('iOS on the same Flutter build is ₹0; a separate native build is not', () => {
    const shared = laneReferenceFor({
      items: [line('Customer app', ['Android and iOS from one Flutter codebase']), line('Admin panel')],
    });
    const separate = laneReferenceFor({
      items: [line('Customer app'), line('Admin panel'), line('Native iOS app')],
    });
    assert.equal(shared.referenceRupees, 55_000, 'the corpus has always priced this at zero');
    assert.ok(separate.referenceRupees > shared.referenceRupees);
    assert.ok(separate.basis.some((b) => /native iOS/.test(b)));
  });

  test('depth is read from the words, and an unstated depth is not a cheap build', () => {
    assert.equal(depthOf({ items: [line('Customer app')] }), 'standard');
    assert.equal(depthOf({ items: [line('Enterprise admin console')] }), 'full');
    assert.equal(depthOf({ items: [line('MVP customer app')] }), 'basic');
  });

  test('Lane 0 is one surface and no live integration — the owner’s rule, guarded by scope', () => {
    const simple = laneReferenceFor({ items: [line('Brochure website', ['Five pages', 'Contact form'])] });
    assert.equal(simple.lane, 0);
    assert.ok(simple.basis.some((b) => /owner’s ₹20,000–₹35,000 rule/.test(b)));

    // The guard is the scope, not the wish: a live gateway leaves Lane 0.
    const paid = laneReferenceFor({ items: [line('Booking website', ['Pay with Razorpay'])] });
    assert.notEqual(paid.lane, 0);
  });

  test('a game, streaming or AI subject changes the LANE, not a line', () => {
    // The lane rule the fit uncovered — and the reason OTT at ₹50,000 was
    // never a Lane 1 conversation.
    for (const subject of ['Multiplayer game lobby', 'Live streaming feed', 'AI recommendation engine']) {
      const ref = laneReferenceFor({ items: [line(subject), line('Admin panel')] });
      assert.equal(ref.lane, 3, subject);
    }
  });

  test('Lane 3 is priced per surface, and five surfaces reaches it by size alone', () => {
    const ref = laneReferenceFor({
      items: [
        line('Customer app'),
        line('Partner app'),
        line('Driver app'),
        line('Vendor portal'),
        line('Admin panel'),
      ],
    });
    assert.equal(ref.lane, 3);
    assert.equal(ref.surfaces, 5);
    assert.ok(ref.basis.some((b) => /per surface|surface\(s\) ×/.test(b)));
  });

  test('every reference is round, like every headline in the corpus', () => {
    for (const items of [
      [line('Customer app'), line('Admin panel')],
      [line('Customer app', ['Razorpay']), line('Partner app'), line('Admin panel')],
      [line('Wallet app', ['Deposits and payouts']), line('Admin panel')],
    ]) {
      assert.equal(laneReferenceFor({ items }).referenceRupees % 5_000, 0);
    }
  });
});

describe('C. the note the approver reads — advisory, and quiet by default', () => {
  const threeSurfaces = {
    items: [line('Customer app', ['Book a slot and pay with Razorpay']), line('Partner app'), line('Admin panel')],
  };

  test('a price near the formula says nothing at all', () => {
    // Silence is the common case: the fit's own median error is 17.5%, and a
    // note on every quotation is a note nobody reads by the third one.
    assert.equal(pricingNoteFor({ proposedRupees: 95_000, scope: threeSurfaces }), null);
    assert.equal(pricingNoteFor({ proposedRupees: 110_000, scope: threeSurfaces }), null);
  });

  test('a price well below the formula names both figures and the direction', () => {
    const note = pricingNoteFor({ proposedRupees: 50_000, scope: threeSurfaces });
    assert.ok(note);
    assert.match(note, /₹50,000/);
    assert.match(note, /₹95,000/);
    assert.match(note, /47% below/);
  });

  test('and so does a price well above it — this is not a discount detector', () => {
    const note = pricingNoteFor({ proposedRupees: 200_000, scope: threeSurfaces });
    assert.match(note ?? '', /above/);
  });

  test('the note shows its derivation, so the owner can disagree with a step', () => {
    const note = pricingNoteFor({ proposedRupees: 50_000, scope: threeSurfaces }) ?? '';
    assert.match(note, /one complete system/);
    assert.match(note, /surface\(s\) beyond two/);
    assert.match(note, /live third-party integration/);
  });

  test('it says it is a reference and that the price is the owner’s', () => {
    // ADM-96 and ADM-07 put the number with the owner. A note that reads like
    // a verdict has quietly moved the decision into code.
    const note = pricingNoteFor({ proposedRupees: 50_000, scope: threeSurfaces }) ?? '';
    assert.match(note, /not a rule/);
    assert.match(note, /The price is yours to set/);
  });

  test('the corpus’s own worst case would have been caught', () => {
    // OTT: a Netflix-class platform quoted at ₹50,000. The day-rate floor
    // could not see it; the lane can.
    const ott = {
      items: [
        line('Android streaming app', ['Adaptive bitrate playback', 'Watchlist and continue watching']),
        line('Admin panel', ['Content upload', 'Subscription plans']),
      ],
    };
    const note = pricingNoteFor({ proposedRupees: 50_000, scope: ott });
    assert.ok(note, 'the OTT shape must not pass silently at ₹50,000');
    assert.match(note, /below/);
  });

  test('and the honest ₹50,000 quotation beside it is left alone', () => {
    // NearServe: two surfaces plus an admin panel, no live gateway, no
    // real-money mechanics. Same price, different scope, no note.
    const nearserve = {
      items: [
        line('Customer app', ['Find nearby providers', 'Request a visit']),
        line('Provider app', ['Accept or reject a request']),
        line('Admin panel', ['Approve providers']),
      ],
    };
    const ref = laneReferenceFor(nearserve);
    assert.equal(ref.lane, 2);
    assert.equal(ref.referenceRupees, 65_000);
    // ₹50,000 against ₹65,000 is 23% — inside the fit's own error bar.
    assert.equal(pricingNoteFor({ proposedRupees: 50_000, scope: nearserve }), null);
  });
});

describe('D. the gate — the note is the approver’s, structurally', () => {
  const NOTE = 'FOR THE APPROVER ONLY — not shown to the client. This draft is ₹50,000.';

  test('it draws on the copies that already say NOT APPROVED', async () => {
    for (const status of ['draft', 'pending_approval']) {
      assert.notEqual(statusBandFor(status), null, `${status} must carry a band`);
      const rendered = await renderQuotationPdf({ ...DOC, status, internalNote: NOTE });
      assert.ok(
        rendered.drawnText.join('\n').includes('FOR THE APPROVER'),
        `the note must reach the ${status} copy`,
      );
    }
  });

  test('it CANNOT draw on anything a client could receive, whatever the caller passes', async () => {
    // The gate is `statusBandFor` returning null, not a caller's discipline.
    for (const status of ['approved', 'sent', 'accepted']) {
      assert.equal(statusBandFor(status), null, `${status} renders clean`);
      const rendered = await renderQuotationPdf({ ...DOC, status, internalNote: NOTE });
      const text = rendered.drawnText.join('\n');
      assert.ok(!text.includes('FOR THE APPROVER'), `the note leaked onto a ${status} document`);
      assert.ok(!text.includes('₹50,000'), `the reference figure leaked onto a ${status} document`);
    }
  });

  test('no note at all is the normal document, unchanged', async () => {
    const withNull = await renderQuotationPdf({ ...DOC, status: 'draft', internalNote: null });
    const without = await renderQuotationPdf({ ...DOC, status: 'draft' });
    assert.equal(Buffer.from(withNull.bytes).equals(Buffer.from(without.bytes)), true);
  });

  test('the assembler computes it once, so every door shows the owner the same figure', () => {
    const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'A streaming app.' }, [
      line('Android streaming app', ['Adaptive bitrate playback']),
      line('Admin panel', ['Content upload']),
    ]);
    assert.ok(sections?.internalNote, 'the note must ride the assembled sections');
    assert.match(sections.internalNote, /FOR THE APPROVER ONLY/);
  });

  test('a legacy quotation has no note, because it has no document', () => {
    assert.equal(quotationSectionsFor(50_000_00, 0, null, [line('Customer app')]), null);
  });
});
