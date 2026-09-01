import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { renderQuotationPdf } from '../src/lib/pdf/quotation.ts';
import { quotationSectionsFor, timelineBandFor, timelineNoteFor } from '../src/modules/sales/quotation-standards.ts';
import { quotationScopeSchema, parseQuotationDocument } from '../src/modules/sales/schema.ts';

/**
 * The timeline is a promise, not a formula — G-177.
 *
 * A zero-trust audit traced one sentence an owner might realistically write on
 * a revision:
 *
 *     "Price ₹50,000 se ₹45,000 kar do aur timeline 25 days se 20 days."
 *
 * The price half worked exactly as designed. The timeline half had **nowhere
 * to go**. `timelineBandFor(totalMinor)` derived the weeks from the price
 * across five bands, so the timeline was the one field of a quotation that
 * nobody — not the model, not the owner, not the client — could change. The
 * reviser applied every other instruction in the note and dropped that one
 * without saying so, and the document came back with the same band unless the
 * new price happened to cross a band edge.
 *
 * Worse, the drafting prompts said so out loud: *"Payment schedules,
 * timelines, support terms and GST are written by the system from standing
 * policy — never by you."* The model was told not to have an opinion about the
 * one thing a client asks about first.
 *
 * ── the shape of the fix ──────────────────────────────────────────────────
 *
 * `timelineWeeks` is a BAND and never a date, because the corpus quotes a band
 * and never a date (45/45), and because the three sentences in
 * `TIMELINE_TERMS` about when the clock starts only make sense beside one.
 *
 * Stated beats derived — the same order of authority G-169 gave surfaces and
 * depth. Absent, `timelineBandFor` answers exactly as before, so every
 * quotation drafted before this field existed renders byte-for-byte as it did,
 * and an approved one keeps the timeline it was approved with rather than
 * acquiring a new one when the price band moves underneath it.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const RENDERER = read('src/lib/pdf/quotation.ts');

const SCOPE = {
  title: 'Bakery ordering app',
  understanding:
    'The client wants their bakery customers to browse the day’s menu, order ahead and pay, so the counter stops taking orders by phone.',
  items: [
    {
      description: 'Customer app',
      priceRupees: 50_000,
      kind: 'surface' as const,
      features: ['Mobile number and OTP login', 'Browse the day’s menu and order ahead'],
    },
  ],
  summary: 'Covers the customer app and its ordering flow.',
  exclusions: [],
  assumptions: [],
  clientResponsibilities: [],
};

const DOC = {
  organizationName: 'BussEnhancer',
  preparedFor: 'A Sample Client',
  title: 'Bakery ordering app',
  version: 1,
  status: 'approved',
  body: null,
  currency: 'INR',
  items: [{ description: 'Customer app', quantity: 1, amountMinor: 50_000_00 }],
  subtotalMinor: 50_000_00,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 50_000_00,
  validUntil: null,
  preparedAt: '2026-09-01T10:00:00.000Z',
  timeZone: 'Asia/Kolkata',
  reference: 'test-ref',
};

describe('A. the model may say how long it takes', () => {
  test('the schema takes a band of whole weeks', () => {
    const parsed = quotationScopeSchema.safeParse({ ...SCOPE, timelineWeeks: { min: 6, max: 9 } });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  test('and refuses one that ends before it starts', () => {
    const backwards = quotationScopeSchema.safeParse({ ...SCOPE, timelineWeeks: { min: 9, max: 6 } });
    assert.equal(backwards.success, false);
    assert.match(JSON.stringify(backwards.error?.issues), /cannot end before it starts/);
  });

  test('a date is not expressible — the corpus quotes a band, 45 times out of 45', () => {
    const dated = quotationScopeSchema.safeParse({
      ...SCOPE,
      timelineWeeks: { min: 6, max: 9, deliverBy: '2026-11-01' },
    });
    assert.equal(dated.success, false, 'a delivery date must not survive the parse');
  });

  test('and saying nothing is still valid — this is an addition, not a demand', () => {
    assert.equal(quotationScopeSchema.safeParse(SCOPE).success, true);
  });

  test('it survives the document round-trip that freezes it', () => {
    const parsed = parseQuotationDocument({ understanding: 'x', timelineWeeks: { min: 4, max: 6 } });
    assert.deepEqual(parsed?.timelineWeeks, { min: 4, max: 6 });
  });
});

describe('B. stated beats derived, and absent changes nothing', () => {
  test('a stated band is what the document says', () => {
    const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'x', timelineWeeks: { min: 3, max: 4 } }, []);
    assert.equal(sections?.timelineLabel, 'Estimated 3–4 weeks');
  });

  test('with none stated, the corpus band answers exactly as it always did', () => {
    const band = timelineBandFor(50_000_00);
    const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'x' }, []);
    assert.equal(sections?.timelineLabel, `Estimated ${band.weeksMin}–${band.weeksMax} weeks`);
  });

  test('a legacy quotation renders the identical label it did before this field existed', () => {
    // The compatibility claim, asserted rather than assumed. Every document in
    // the database predates `timelineWeeks`.
    for (const totalMinor of [20_000_00, 50_000_00, 99_999_00, 150_000_00, 250_000_00, 475_000_00]) {
      const band = timelineBandFor(totalMinor);
      const sections = quotationSectionsFor(totalMinor, 0, { understanding: 'x' }, []);
      assert.equal(sections?.timelineLabel, `Estimated ${band.weeksMin}–${band.weeksMax} weeks`);
    }
  });

  test('a stored band that is backwards falls back rather than printing it', () => {
    // The schema refuses this at the write, but the value has since been
    // through a jsonb column. A backwards range on a client's quotation is
    // cheap to refuse, and the fallback is a band that is never wrong.
    const band = timelineBandFor(50_000_00);
    const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'x', timelineWeeks: { min: 9, max: 3 } }, []);
    assert.equal(sections?.timelineLabel, `Estimated ${band.weeksMin}–${band.weeksMax} weeks`);
  });

  test('and so does a nonsensical one', () => {
    const band = timelineBandFor(50_000_00);
    for (const timelineWeeks of [{ min: 0, max: 4 }, { min: Number.NaN, max: 4 }, { min: -3, max: -1 }]) {
      const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'x', timelineWeeks }, []);
      assert.equal(sections?.timelineLabel, `Estimated ${band.weeksMin}–${band.weeksMax} weeks`);
    }
  });

  test('the page draws the stated weeks, and the terms still travel with them', async () => {
    const sections = quotationSectionsFor(50_000_00, 0, { understanding: 'x', timelineWeeks: { min: 3, max: 4 } }, []);
    const rendered = await renderQuotationPdf({ ...DOC, ...sections });
    const text = rendered.drawnText.join('\n');
    assert.match(text, /Estimated 3–4 weeks/);
    // The band is meaningless without them: a client reading "3–4 weeks" with
    // no statement of when the clock starts has been told a delivery date.
    assert.match(text, /The clock starts at advance payment plus the required inputs/);
    assert.equal(rendered.replacedCharacters.length, 0);
  });
});

describe('C. the approver is told when a promise leaves the usual band', () => {
  test('silence while the two overlap at all', () => {
    // A note on every quotation is a note nobody reads by the third one. The
    // corpus band for ₹50,000 is 6–9 weeks; 6–8 sits inside it, 8–11 touches.
    assert.equal(timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: { min: 6, max: 8 } }), null);
    assert.equal(timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: { min: 8, max: 11 } }), null);
  });

  test('and nothing at all when no timeline was stated', () => {
    assert.equal(timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: null }), null);
  });

  test('faster than the band is a promise somebody has to keep', () => {
    const note = timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: { min: 2, max: 3 } });
    assert.ok(note, 'a band well below the corpus must be reported');
    assert.match(note, /FOR THE APPROVER ONLY — not shown to the client/);
    assert.match(note, /promises 2–3 weeks/);
    assert.match(note, /faster commitment than anything in that history/);
  });

  test('slower is a different problem, and says so', () => {
    // Not the same sentence with a word flipped: slow-for-the-price loses a
    // deal, fast-for-the-price loses a delivery. An approver needs to know
    // which one they are looking at.
    const note = timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: { min: 20, max: 24 } });
    assert.ok(note);
    assert.match(note, /slower than the price would suggest/);
    assert.doesNotMatch(note, /faster commitment/);
  });

  test('it names the decision as the owner’s, not as an error', () => {
    const note = timelineNoteFor({ totalMinor: 50_000_00, statedWeeks: { min: 2, max: 3 } })!;
    assert.match(note, /The timeline is yours to set/);
  });

  test('the assembler carries it into the approver block beside the pricing note', () => {
    const sections = quotationSectionsFor(
      50_000_00,
      0,
      { understanding: 'x', timelineWeeks: { min: 2, max: 3 } },
      [{ description: 'Customer app', kind: 'surface' }],
    );
    assert.ok(sections?.internalNote, 'the approver block must exist');
    assert.match(sections.internalNote, /promises 2–3 weeks/);
  });

  test('and the renderer draws two notes as two items, not one run-on paragraph', async () => {
    const sections = quotationSectionsFor(
      50_000_00,
      0,
      { understanding: 'x', timelineWeeks: { min: 2, max: 3 }, depth: 'full' },
      // Priced far enough from the formula that BOTH notes fire at once:
      // three surfaces at full depth reads ₹85,000 against a ₹50,000 total.
      [
        { description: 'Customer app', kind: 'surface' },
        { description: 'Admin panel', kind: 'surface' },
        { description: 'Delivery app', kind: 'surface' },
      ],
    );
    assert.ok(sections?.internalNote?.includes('\n\n'), 'both notes must be present for this to test anything');

    const rendered = await renderQuotationPdf({ ...DOC, status: 'draft', ...sections });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('FOR THE APPROVER — NOT PART OF THE QUOTATION'));
    assert.match(text, /promises 2–3 weeks/);
    assert.match(text, /agency's own formula reads/);
    // Never a raw newline through the drawer — the wrapper draws lines, and a
    // \n reaching a font is a missing glyph rather than a line break.
    assert.ok(!rendered.drawnText.some((line) => line.includes('\n')));
  });

  test('the approver block still never reaches a client', () => {
    // G-167's gate, unchanged and worth re-proving now that a second note can
    // put it on more documents than before.
    assert.match(RENDERER, /if \(input\.internalNote && band\)/);
  });
});

describe('D. the model is told the field exists — the G-173 lesson', () => {
  test('all three drafting prompts name the timeline', () => {
    // A field a model is never told about is a field it leaves empty. Seven of
    // them were dead in production for exactly this reason (G-173).
    assert.equal((WORKFLOWS.match(/TIMELINE — how many weeks this takes/g) ?? []).length, 3);
  });

  test('and none of them still claims the system writes it', () => {
    // The sentence that was the defect. It is gone from all three, and its
    // neighbours — payment schedules, support terms, GST — are still the
    // system's, because those genuinely are.
    assert.ok(
      !WORKFLOWS.includes('Payment schedules, timelines, support terms and GST'),
      'a prompt still tells the model the timeline is not its business',
    );
    assert.equal((WORKFLOWS.match(/Payment schedules, support terms and GST are written by the/g) ?? []).length, 3);
  });

  test('the reviser is told the owner’s note may change it', () => {
    assert.match(WORKFLOWS, /THE NOTE MAY CHANGE THE TIMELINE/);
    // And what to do when it does not — a revision about price must not
    // silently move the delivery promise.
    assert.match(WORKFLOWS, /timeline the current quotation already carries/);
  });

  test('and it is SHOWN the timeline it is being asked to keep', () => {
    // The instruction above is unfollowable otherwise. Both the owner's
    // revision and the client's rework read the stored document, so both get
    // it — two, not one.
    assert.equal(
      (WORKFLOWS.match(/timelineWeeks: storedDocument\?\.timelineWeeks \?\? undefined/g) ?? []).length,
      2,
    );
  });

  test('all three drafting doors persist it, or two thirds of the field is dead', () => {
    assert.equal(
      (WORKFLOWS.match(/timelineWeeks: validated\.data\.timelineWeeks \?\? null/g) ?? []).length,
      3,
    );
  });

  test('the wire schema carries it, without the bounds the decoder refuses', async () => {
    // G-164: constrained decoding rejects `minimum`/`maximum`, and a schema
    // carrying them fails at the provider rather than here.
    const { quotationScopeJsonSchema } = await import('../src/modules/sales/schema.ts');
    const wire = quotationScopeJsonSchema() as {
      properties?: { timelineWeeks?: { properties?: Record<string, Record<string, unknown>> } };
    };
    const field = wire.properties?.timelineWeeks;
    assert.ok(field, 'the model cannot answer with a field the wire schema does not declare');
    assert.equal(field.properties?.min?.type, 'integer');
    assert.ok(!Object.hasOwn(field.properties?.min ?? {}, 'minimum'));
    assert.ok(!Object.hasOwn(field.properties?.max ?? {}, 'maximum'));
  });
});
