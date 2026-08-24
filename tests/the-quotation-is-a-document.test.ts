import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import {
  quotationPdfFilename,
  renderQuotationPdf,
  statusBandFor,
  type QuotationPdfInput,
} from '../src/lib/pdf/quotation.ts';

/**
 * The quotation as a document — brief §12, gap G-156.
 *
 * §12's bar is "professional, readable, structured, branded, versioned,
 * traceable", with one hard rule underneath: **do not add undocumented
 * commercial commitments.** These tests hold the second part and the two
 * properties the renderer promises — deterministic bytes and fail-closed
 * status honesty — plus the transcript discipline that makes any of it
 * assertable at all: the PDF's content streams are compressed CID glyph
 * runs, so what the document SAYS is asserted against `drawnText`, written
 * by the one wrapper every draw goes through.
 *
 * The renders here are real: real fonts off disk, real pdf-lib, real bytes
 * reloaded through the same library to prove they parse.
 */

const INPUT: QuotationPdfInput = {
  organizationName: 'Bussen Hancer Agency',
  preparedFor: 'Rahul Verma — Story TV',
  title: 'Delivery app',
  version: 2,
  status: 'approved',
  body: 'Covers the three apps and payments as discussed.\nDoes not cover marketing or the restaurant-side app.',
  currency: 'INR',
  items: [
    { description: 'Customer app — ordering, tracking, payments', quantity: 1, amountMinor: 4_000_000 },
    { description: 'Driver app', quantity: 1, amountMinor: 3_000_000 },
  ],
  subtotalMinor: 7_000_000,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 7_000_000,
  validUntil: null,
  preparedAt: '2026-08-23T10:15:00Z',
  timeZone: 'Asia/Kolkata',
  reference: '4b0f6d1a-9c3e-4a2b-8f7d-2e5a1c9b3d84',
};

/**
 * A fixture whose money holds — G-167.
 *
 * The renderer now refuses to draw a document whose lines do not add up to
 * its own total, and three fixtures in this file were overriding `items`
 * while leaving the base subtotal behind: documents describing a scope that
 * could not exist, used to assert pagination and wrapping. The helper derives
 * the money from whatever items it is given, so a test says what it is about
 * and the arithmetic follows. An explicit override still wins — that is how
 * the Tax and discount cases state their own facts.
 */
const withInput = (over: Partial<QuotationPdfInput>): QuotationPdfInput => {
  const merged = { ...INPUT, ...over };
  const subtotalMinor =
    over.subtotalMinor ?? merged.items.reduce((sum, item) => sum + item.amountMinor, 0);
  const totalMinor =
    over.totalMinor ?? subtotalMinor - merged.discountMinor + merged.taxMinor;
  return { ...merged, subtotalMinor, totalMinor };
};

describe('A. it is a real document', () => {
  test('the bytes are a PDF that parses, on A4, titled like the record', async () => {
    const { bytes } = await renderQuotationPdf(INPUT);
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');

    const loaded = await PDFDocument.load(bytes);
    assert.equal(loaded.getPageCount(), 1);
    const { width, height } = loaded.getPage(0).getSize();
    assert.ok(Math.abs(width - 595.28) < 0.01 && Math.abs(height - 841.89) < 0.01, 'A4');
    assert.equal(loaded.getTitle(), 'Quotation v2 — Delivery app');
  });

  test('₹ survives the trip — the one glyph the built-in PDF fonts do not carry', async () => {
    const { drawnText, replacedCharacters } = await renderQuotationPdf(INPUT);
    assert.ok(drawnText.some((l) => l.includes('₹')), 'no rupee sign was drawn');
    assert.deepEqual(replacedCharacters, [], 'the font is missing glyphs the app writes');
  });

  test('the same record renders to the same bytes — a quotation is a record, not an event', async () => {
    const a = await renderQuotationPdf(INPUT);
    const b = await renderQuotationPdf(INPUT);
    assert.equal(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), true);
  });

  test('a long quotation flows onto more pages instead of falling off the first', async () => {
    const { bytes, drawnText } = await renderQuotationPdf(
      withInput({
        items: Array.from({ length: 60 }, (_, i) => ({
          description: `Line item ${i + 1} with a description long enough to wrap onto a second line when the column narrows`,
          quantity: 1,
          amountMinor: 100_000,
        })),
      }),
    );
    const loaded = await PDFDocument.load(bytes);
    assert.ok(loaded.getPageCount() > 1, `${loaded.getPageCount()} page(s)`);
    // Every line survives — a document may not silently truncate the scope
    // the way the 12-line WhatsApp announcement (which SAYS it truncates) may.
    assert.ok(drawnText.some((l) => l.includes('Line item 60')), 'the last line was dropped');
    // And every page says which page it is of how many.
    assert.ok(drawnText.includes(`Page ${loaded.getPageCount()} of ${loaded.getPageCount()}`));
  });

  test('a word wider than its column is broken, not drawn through the money', async () => {
    const url = 'https://example.invalid/projects/delivery-app/quotation/v2/attachments/full-scope-document';
    const { drawnText } = await renderQuotationPdf(
      withInput({ items: [{ description: url, quantity: 1, amountMinor: 100_000 }] }),
    );
    const pieces = drawnText.filter((l) => url.startsWith(l.trim()) || url.includes(l.trim()));
    assert.ok(
      !drawnText.includes(url) && pieces.length > 1,
      'the unbroken token was drawn as one line across the amount column',
    );
  });

  test('a tab separates words rather than deleting itself between them', async () => {
    const { drawnText } = await renderQuotationPdf(withInput({ body: 'Covers\tthe site.' }));
    assert.ok(drawnText.some((l) => l.includes('Covers the site.')), 'the tab fused its neighbours');
  });

  test('a character with no glyph is replaced and reported, never crashed on', async () => {
    const { drawnText, replacedCharacters } = await renderQuotationPdf(
      withInput({ body: 'Covers the site. देवनागरी is outside the subset.' }),
    );
    assert.ok(replacedCharacters.length > 0, 'nothing was reported');
    assert.ok(drawnText.some((l) => l.includes('?')), 'nothing was replaced');
  });
});

describe('B. nothing undocumented appears — §12’s hard rule', () => {
  test('a zero discount is not a Discount row', async () => {
    const { drawnText } = await renderQuotationPdf(INPUT);
    assert.ok(!drawnText.some((l) => l.startsWith('Discount')), 'a zero was rendered as a fact');
    assert.ok(!drawnText.some((l) => l.startsWith('Subtotal')), 'a subtotal equal to the total said twice');
    assert.ok(!drawnText.some((l) => l.startsWith('Tax')));
  });

  test('a real discount is spelled out with the subtotal it came off', async () => {
    const { drawnText } = await renderQuotationPdf(
      withInput({ discountMinor: 500_000, totalMinor: 6_500_000 }),
    );
    assert.ok(drawnText.includes('Subtotal'));
    assert.ok(drawnText.includes('Discount'));
    assert.ok(drawnText.some((l) => l.includes('−₹5,000')));
  });

  test('validity appears only when the quotation has one', async () => {
    const without = await renderQuotationPdf(INPUT);
    assert.ok(!without.drawnText.some((l) => l.includes('Valid until')));
    const withDate = await renderQuotationPdf(withInput({ validUntil: '2026-09-15' }));
    assert.ok(withDate.drawnText.some((l) => l.includes('Valid until 15 Sept 2026')));
  });

  test('a validity date does not shrink by a day west of Greenwich', async () => {
    // valid_until is a Postgres date — a calendar day, not an instant. Parsed
    // as UTC midnight and formatted in a negative-offset zone it reads the
    // 14th, and a client told the 14th has a day less than the row grants.
    const { drawnText } = await renderQuotationPdf(
      withInput({ validUntil: '2026-09-15', timeZone: 'America/New_York' }),
    );
    assert.ok(
      drawnText.some((l) => l.includes('Valid until 15 Sept 2026')),
      drawnText.find((l) => l.includes('Valid until')) ?? '(none)',
    );
  });

  test('the client IS named when the rows name one — the absence test alone would pass on a renderer that never draws the block', async () => {
    const { drawnText } = await renderQuotationPdf(INPUT);
    assert.ok(drawnText.includes('PREPARED FOR'));
    assert.ok(drawnText.includes('Rahul Verma — Story TV'));
  });

  test('the letterhead and the title are actually drawn — §12’s "branded" is ink, not metadata', async () => {
    const { drawnText } = await renderQuotationPdf(INPUT);
    assert.ok(drawnText.includes('Bussen Hancer Agency'));
    assert.ok(drawnText.includes('QUOTATION'));
    assert.ok(drawnText.includes('Delivery app'));
  });

  test('no client is named when the rows name none', async () => {
    const { drawnText } = await renderQuotationPdf(withInput({ preparedFor: null }));
    assert.ok(!drawnText.includes('PREPARED FOR'), 'a label with nobody under it');
    assert.ok(!drawnText.includes('Rahul Verma — Story TV'));
  });

  test('an empty body is not boilerplate', async () => {
    const { drawnText } = await renderQuotationPdf(withInput({ body: null }));
    const joined = drawnText.join('\n');
    assert.ok(!/as discussed/.test(joined));
    // The structure that IS documented still stands.
    assert.ok(drawnText.includes('WHAT IT COVERS'));
    assert.ok(drawnText.includes('Total'));
  });

  test('×1 is noise and ×12 is information — and the QTY column exists only when it informs', async () => {
    const allOnes = await renderQuotationPdf(INPUT);
    assert.ok(!allOnes.drawnText.includes('QTY'), 'a column of ones');
    const withTwelve = await renderQuotationPdf(
      withInput({ items: [...INPUT.items, { description: 'Screens', quantity: 12, amountMinor: 1_200_000 }] }),
    );
    assert.ok(withTwelve.drawnText.includes('QTY'));
    assert.ok(withTwelve.drawnText.includes('×12'));
    assert.ok(!withTwelve.drawnText.includes('×1'));
  });

  test('the date drawn is the record’s, in the agency’s zone — not the render’s wall clock', async () => {
    const { drawnText } = await renderQuotationPdf(INPUT);
    assert.ok(drawnText.some((l) => l.includes('Prepared 23 Aug 2026')));
  });

  test('the footer carries the proposal id — §12’s "traceable"', async () => {
    const { drawnText } = await renderQuotationPdf(INPUT);
    assert.ok(drawnText.some((l) => l.includes(INPUT.reference)));
    assert.ok(drawnText.some((l) => l === 'Page 1 of 1'));
  });
});

describe('C. status honesty is fail-closed — ADM-76', () => {
  test('only approved, sent and accepted render clean', () => {
    for (const clean of ['approved', 'sent', 'accepted']) {
      assert.equal(statusBandFor(clean), null, clean);
    }
  });

  test('every other state carries a labelled band', () => {
    for (const [status, words] of [
      ['draft', /DRAFT/],
      ['pending_approval', /INTERNAL REVIEW/],
      ['superseded', /SUPERSEDED/],
      ['lapsed', /EXPIRED/],
      // 'rejected' is the status sales.proposals actually has — the first
      // draft keyed this to 'declined', a word the schema never uses, and the
      // real status fell to the generic band.
      ['rejected', /DECLINED BY THE CLIENT/],
    ] as const) {
      assert.match(statusBandFor(status) ?? '', words, status);
    }
  });

  test('a status this module has never heard of gets a band too — the clean list is closed', () => {
    assert.match(
      statusBandFor('half_signed') ?? '',
      /NOT APPROVED — STATUS: HALF SIGNED/,
      'an unknown state rendered as a finished quotation',
    );
  });

  test('and the band is actually drawn', async () => {
    const { drawnText } = await renderQuotationPdf(withInput({ status: 'pending_approval' }));
    assert.ok(drawnText.includes('FOR INTERNAL REVIEW — NOT YET APPROVED'));
    const clean = await renderQuotationPdf(INPUT);
    assert.ok(!clean.drawnText.some((l) => l.includes('NOT YET APPROVED')));
  });
});

describe('D. the filename a phone shows', () => {
  test('is versioned and ASCII-safe', () => {
    assert.equal(quotationPdfFilename('Delivery app', 2), 'Quotation-v2-Delivery-app.pdf');
    assert.equal(quotationPdfFilename('वेबसाइट — Störe/API v2!', 3), 'Quotation-v3-Store-API-v2.pdf');
  });

  test('a title with nothing ASCII in it still yields a name', () => {
    assert.equal(quotationPdfFilename('वेबसाइट', 1), 'Quotation-v1.pdf');
  });
});

describe('E. the wiring around the renderer', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  test('the fonts ship with every serverless route — a font missing from a bundle is a 500 on the first send', () => {
    const config = read('../next.config.ts');
    assert.match(config, /outputFileTracingIncludes/);
    // The KEY is the guarantee: '/**' reaches every route. A narrower glob
    // would trace the fonts into some bundles and 500 in the rest.
    assert.match(config, /'\/\*\*': \['src\/lib\/pdf\/fonts\/\*\*'\]/);
  });

  test('the vendored fonts are the pre-subset files, embedded whole — pdf-lib’s own subsetting breaks CoreGraphics', () => {
    const fonts = read('../src/lib/pdf/fonts.ts');
    assert.match(fonts, /NotoSans_400Regular\.subset\.ttf/);
    assert.match(fonts, /NotoSans_700Bold\.subset\.ttf/);
    const renderer = read('../src/lib/pdf/quotation.ts');
    assert.match(renderer, /subset: false/);
    assert.ok(!/subset: true/.test(renderer), 'at-embed-time subsetting came back');
  });

  test('the fonts and their license are actually vendored', () => {
    for (const file of [
      '../src/lib/pdf/fonts/NotoSans_400Regular.subset.ttf',
      '../src/lib/pdf/fonts/NotoSans_700Bold.subset.ttf',
      '../src/lib/pdf/fonts/LICENSE',
      '../src/lib/pdf/fonts/README.md',
    ]) {
      assert.ok(
        readFileSync(fileURLToPath(new URL(file, import.meta.url))).length > 0,
        `${file} is missing or empty`,
      );
    }
  });

  test('every draw goes through the transcript wrapper — an unrecorded draw makes the honesty tests above blind', () => {
    const renderer = read('../src/lib/pdf/quotation.ts');
    const bare = renderer.match(/\.drawText\(/g) ?? [];
    assert.equal(bare.length, 1, 'a drawText call outside the draw() wrapper appeared');
  });

  test('the owner leg attaches for every quotation; attribution still asks for a PERSON', () => {
    const handlers = read('../src/modules/crm/handlers.ts');
    // ADM-96 removed the authored gate from the PDF leg — a system-submitted
    // quotation is exactly when the owner has only the announcement to decide
    // from — so the gate is subject-and-id alone…
    assert.match(
      handlers,
      /subjectType !== 'proposal' \|\| !event\.subjectId\) \{/,
      'the PDF leg must run for a system submission too (ADM-96)',
    );
    // …while attribution kept its whole rule: a person's id or nobody's,
    // because an agent-raised request carries a non-null id too and
    // p_author_id references core.users.
    assert.match(
      handlers,
      /requested_by_type === 'user'/,
      'the gate must ask for a PERSON — an agent-raised request carries a non-null id too',
    );
    assert.match(handlers, /\.\.\.\(requestedById \? \{ p_author_id: requestedById \} : \{\}\)/);
    assert.match(handlers, /approval:\$\{requestId\}:pdf/);

    const sales = read('../src/modules/sales/service.ts');
    assert.match(sales, /proposal:\$\{proposal\.id\}:v\$\{proposal\.version\}:pdf/);
  });

  test('both Graph stubs answer an upload with the upload’s shape, not the send envelope', () => {
    for (const script of ['../scripts/verify-flow-01.mjs', '../scripts/verify-media-reading.mjs', '../scripts/verify-approval-announcements.mjs']) {
      const stub = read(script);
      assert.match(stub, /endsWith\('\/media'\)/, `${script} does not route uploads`);
      assert.match(stub, /MEDIA\.STUB\./, `${script} does not answer an upload id`);
    }
  });
});
