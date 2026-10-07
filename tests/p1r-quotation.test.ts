// Round 4, Quotation Master: the timeline recalculation, the GST sentence from the tax configuration, and the wiring that connects them.
// The database half (line pricing, delivery events, the invoice column, the recalculation door) is proved in scripts/verify-p1r-quotation.sql.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

import { readQuoteTax, QuoteTaxUnreadable } from '../src/modules/sales/p1r-quote-tax.ts';
import { estimateFor, recalculateTimeline } from '../src/modules/sales/p1r-timeline-recalc.ts';
import { GST_LINE, GST_NEUTRAL_LINE, GST_NONE_LINE, gstLineFor, quotationSectionsFor, ratePercentText, timelineBandFor } from '../src/modules/sales/quotation-standards.ts';
import { STANDARD_TRANSLATIONS, localiseSections } from '../src/modules/sales/quotation-standards-i18n.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('P1R the timeline objection is recalculated', () => {
  const est = { min: 6, max: 9 };
  test('at or past the long end it fits', () => {
    for (const asked of [9, 10, 20]) assert.equal(recalculateTimeline({ askedWeeks: asked, estimate: est }).verdict, 'fits');
  });
  test('inside the estimate but short of its long end it is tight', () => {
    for (const asked of [6, 7, 8]) assert.equal(recalculateTimeline({ askedWeeks: asked, estimate: est }).verdict, 'tight');
  });
  test('shorter than the shortest estimate it does not fit, and the options name the owners decision', () => {
    const r = recalculateTimeline({ askedWeeks: 3, estimate: est });
    assert.equal(r.verdict, 'does_not_fit');
    assert.ok(r.options.some((o) => /owner/.test(o) && /nothing is priced or promised/.test(o)));
    assert.ok(r.options.some((o) => /Phase the scope/.test(o)));
  });
  test('it never invents a price, a discount or a percentage', () => {
    for (const asked of [1, 3, 6, 8, 12]) {
      for (const o of recalculateTimeline({ askedWeeks: asked, estimate: est }).options) {
        assert.doesNotMatch(o, /₹|rupee|\bINR\b|%|discount/i, o);
      }
    }
  });
  test('every verdict says when the clock starts', () => {
    for (const asked of [3, 7, 12]) assert.ok(recalculateTimeline({ askedWeeks: asked, estimate: est }).options.some((o) => /advance payment/.test(o)));
  });
  test('a nonsense ask or estimate is refused rather than answered', () => {
    assert.throws(() => recalculateTimeline({ askedWeeks: 0, estimate: est }));
    assert.throws(() => recalculateTimeline({ askedWeeks: 2.5, estimate: est }));
    assert.throws(() => recalculateTimeline({ askedWeeks: 200, estimate: est }));
    assert.throws(() => recalculateTimeline({ askedWeeks: 5, estimate: { min: 9, max: 6 } }));
  });
  test('the estimate is the quotation\'s stated timeline, else the corpus band for its price', () => {
    assert.deepEqual(estimateFor({ min: 4, max: 5 }, 90_000_00), { min: 4, max: 5 });
    const band = timelineBandFor(90_000_00);
    assert.deepEqual(estimateFor(null, 90_000_00), { min: band.weeksMin, max: band.weeksMax });
    assert.deepEqual(estimateFor({ min: 9, max: 4 }, 90_000_00), { min: band.weeksMin, max: band.weeksMax }, 'an inverted stated timeline is not trusted');
  });
  test('the verdict regimes are the ones the table\'s own check enforces', () => {
    const migration = read(readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => f.startsWith('20261203200000_p1r_c_')).map((f) => `supabase/migrations/${f}`)[0]!);
    assert.match(migration, /verdict = 'fits' and asked_weeks >= estimate_max_weeks/);
    assert.match(migration, /verdict = 'tight' and asked_weeks >= estimate_min_weeks and asked_weeks < estimate_max_weeks/);
    assert.match(migration, /verdict = 'does_not_fit' and asked_weeks < estimate_min_weeks/);
  });
});

describe('P1R the GST sentence comes from the tax configuration', () => {
  test('a caller that does not ask keeps the legacy sentence; a configured GST organisation prints its own rate', () => {
    assert.equal(gstLineFor(undefined), GST_LINE);
    assert.equal(gstLineFor({ mode: 'gst', rateBp: 1800 }), 'All amounts are exclusive of GST; 18% GST extra.');
    assert.equal(gstLineFor({ mode: 'gst', rateBp: 1250 }), 'All amounts are exclusive of GST; 12.5% GST extra.');
    assert.equal(ratePercentText(500), '5');
  });
  test('nothing configured names NO rate (it is never guessed) and a non-GST organisation says no GST is charged', () => {
    assert.equal(gstLineFor(null), GST_NEUTRAL_LINE);
    assert.doesNotMatch(GST_NEUTRAL_LINE, /\d/);
    assert.equal(gstLineFor({ mode: 'non_gst', rateBp: 0 }), GST_NONE_LINE);
  });
  test('the sections carry the configured sentence, and none when a tax row is already inside the total', () => {
    const doc = { understanding: 'A build.' };
    assert.equal(quotationSectionsFor(100_000_00, 0, doc, [], { tax: { mode: 'gst', rateBp: 1200 } })?.gstLine, 'All amounts are exclusive of GST; 12% GST extra.');
    assert.equal(quotationSectionsFor(100_000_00, 0, doc, [], { tax: null })?.gstLine, GST_NEUTRAL_LINE);
    assert.equal(quotationSectionsFor(118_000_00, 18_000_00, doc, [], { tax: { mode: 'gst', rateBp: 1800 } })?.gstLine, null);
    assert.equal(quotationSectionsFor(100_000_00, 0, doc, [])?.gstLine, GST_LINE, 'no option: unchanged');
  });
  test('in Hinglish and Hindi the configured rate survives translation and the neutral and no-GST lines have their own words', () => {
    const doc = { understanding: 'A build.' };
    for (const language of ['hinglish', 'hindi'] as const) {
      const pack = STANDARD_TRANSLATIONS[language];
      const rated = localiseSections(quotationSectionsFor(100_000_00, 0, doc, [], { tax: { mode: 'gst', rateBp: 1200 } })!, language);
      assert.match(String(rated.gstLine), /12%/);
      assert.doesNotMatch(String(rated.gstLine), /18/);
      assert.equal(localiseSections(quotationSectionsFor(100_000_00, 0, doc, [], { tax: { mode: 'gst', rateBp: 1800 } })!, language).gstLine, pack.gstLine);
      assert.equal(localiseSections(quotationSectionsFor(100_000_00, 0, doc, [], { tax: null })!, language).gstLine, pack.gstNeutral);
      assert.equal(localiseSections(quotationSectionsFor(100_000_00, 0, doc, [], { tax: { mode: 'non_gst', rateBp: 0 } })!, language).gstLine, pack.gstNone);
      assert.notEqual(pack.gstNeutral, pack.gstLine);
      assert.doesNotMatch(pack.gstNeutral, /\d/);
    }
  });
  test('reading the configuration: none is null, a failed read throws (never "no configuration"), a strange row throws', async () => {
    const db = (answer: { data: unknown; error: { message: string } | null }) => ({
      schema: () => ({ from: () => { const q: Record<string, unknown> = {}; q.select = () => q; q.eq = () => q; q.maybeSingle = () => Promise.resolve(answer); return q; } }),
    });
    assert.equal(await readQuoteTax(db({ data: null, error: null }), 'o'), null);
    assert.deepEqual(await readQuoteTax(db({ data: { mode: 'gst', rate_bp: 1800 }, error: null }), 'o'), { mode: 'gst', rateBp: 1800 });
    await assert.rejects(readQuoteTax(db({ data: null, error: { message: 'down' } }), 'o'), QuoteTaxUnreadable);
    await assert.rejects(readQuoteTax(db({ data: { mode: 'weird', rate_bp: 5 }, error: null }), 'o'), QuoteTaxUnreadable);
  });
  test('every place a quotation is rendered reads the configuration and passes it (the connection)', () => {
    const service = read('src/modules/sales/service.ts');
    assert.equal((service.match(/await readQuoteTax\(supabase\)/g) ?? []).length, 2, 'the PDF and the send path');
    assert.equal((service.match(/clauses: clauses\.data,\s*tax,/g) ?? []).length, 2);
    assert.match(read('src/modules/crm/handlers.ts'), /readQuoteTax\(admin, organizationId\)/);
    assert.match(read('src/modules/crm/handlers.ts'), /clauses: clauses\.data,\s*tax,/);
    assert.match(read('src/modules/sales/preview-service.ts'), /tax: await readQuoteTax\(supabase\)/);
  });
});

describe('P1R the negotiation page shows what was built', () => {
  const page = read('app/(internal)/quotations/negotiation/[opportunityId]/page.tsx');
  test('lines and pricing, the delivery record, the invoices that bill a version, and the timeline objections', () => {
    assert.match(page, /readQuoteLines\(v\.id\)/);
    assert.match(page, /readQuoteDelivery\(v\.id\)/);
    assert.match(page, /readInvoicesForProposal\(v\.id\)/);
    assert.match(page, /readTimelineObjections\(opportunityId\)/);
    assert.match(page, /<LinePricingForm /);
    assert.match(page, /<TimelineRecalcForm /);
  });
  test('the line pricing form is offered only on a draft, and only to those who can change settings', () => {
    assert.match(page, /can\(context, 'organization\.settings'\) && v\.status === 'draft'/);
  });
  test('the service treats a failed read as unreadable and records a recalculation only through the door', () => {
    const src = read('src/modules/sales/p1r-quotation-service.ts');
    assert.ok((src.match(/if \(error\) unreadable\(/g) ?? []).length >= 4);
    assert.match(src, /rpc\('p1r_record_timeline_recalc'/);
    assert.doesNotMatch(src, /\.from\('p1r_timeline_recalcs'\)\.(insert|update)/);
  });
  test("'use server' actions export only async functions", () => {
    const src = read('app/(internal)/quotations/negotiation/[opportunityId]/actions.ts');
    const exports = [...src.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
    assert.ok(exports.length >= 6 && exports.every((e) => e === 'async'));
  });
});
