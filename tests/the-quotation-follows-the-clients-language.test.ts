import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { QUOTATION_LABELS, type QuotationLanguage } from '../src/lib/pdf/quotation-labels.ts';
import { ShapedFont } from '../src/lib/pdf/shaped-font.ts';
import { quotationDevanagariFontBytes } from '../src/lib/pdf/fonts.ts';
import { renderQuotationPdf, statusBandFor } from '../src/lib/pdf/quotation.ts';
import { DEFAULT_CLAUSES, CLAUSE_KEYS } from '../src/modules/sales/quotation-clauses.ts';
import { documentLanguageFrom, translateStandardsOn, writesInDevanagari } from '../src/modules/sales/quotation-language.ts';
import {
  GST_LINE,
  NEXT_STEPS_LINES,
  REGULATED_CLAUSES,
  SCOPE_PROTECTION_LINES,
  SUPPORT_STANDARD,
  TIMELINE_TERMS,
  paymentScheduleFor,
  quotationSectionsFor,
} from '../src/modules/sales/quotation-standards.ts';
import { STANDARD_TRANSLATIONS, localiseSections } from '../src/modules/sales/quotation-standards-i18n.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const DEVANAGARI = /[ऀ-ॿ]/;

// A quotation is read in the client's language, and the language is decided by
// how THEY write — script included, because Roman-script Hinglish and
// Devanagari need different typefaces. These tests hold the whole chain.

describe('A. which language a client\'s quotation is in', () => {
  test('Devanagari-writers get Hindi; Roman-script Hindi gets Hinglish; the rest English', () => {
    assert.equal(documentLanguageFrom('hi', ['मुझे ऐप चाहिए']), 'hindi');
    assert.equal(documentLanguageFrom('en', ['मुझे ऐप चाहिए, app for gym']), 'hindi');
    assert.equal(documentLanguageFrom('hi', ['mujhe app chahiye']), 'hinglish');
    assert.equal(documentLanguageFrom('hi-en', ['mujhe app chahiye']), 'hinglish');
    assert.equal(documentLanguageFrom('en', ['I need an app']), 'en');
    assert.equal(documentLanguageFrom(null, []), 'en');
  });

  test('a few Devanagari words in a Roman message do not flip the document\'s script', () => {
    assert.equal(writesInDevanagari(['Bhai app chahiye, मुझे ऐप, mera business jewellery ka hai please quote bhejo']), false);
    assert.equal(documentLanguageFrom('hi-en', ['Bhai app chahiye, मुझे ऐप, mera business jewellery ka hai please quote bhejo']), 'hinglish');
  });

  test('the owner\'s switch for translated standards is the single word "on"', () => {
    assert.equal(translateStandardsOn({ quotation_translate_standards: 'on' }), true);
    for (const v of [undefined, null, {}, { quotation_translate_standards: '' }, { quotation_translate_standards: 'yes' }, { quotation_translate_standards: true }]) {
      assert.equal(translateStandardsOn(v), false);
    }
  });
});

describe('B. every default the agency prints has a Hinglish and a Hindi version', () => {
  const packs = Object.entries(STANDARD_TRANSLATIONS) as [Exclude<QuotationLanguage, 'en'>, (typeof STANDARD_TRANSLATIONS)['hinglish']][];

  test('same number of lines as the English, none empty, none identical to it', () => {
    for (const [name, pack] of packs) {
      assert.equal(pack.timelineTerms.length, TIMELINE_TERMS.length, name);
      assert.equal(pack.supportLines.length, SUPPORT_STANDARD.lines.length, name);
      assert.equal(pack.scopeProtection.length, SCOPE_PROTECTION_LINES.length, name);
      assert.equal(pack.nextSteps.length, NEXT_STEPS_LINES.length, name);
      for (const [i, line] of pack.timelineTerms.entries()) assert.notEqual(line, TIMELINE_TERMS[i], `${name} timeline ${i}`);
      for (const [i, line] of pack.supportLines.entries()) assert.notEqual(line, SUPPORT_STANDARD.lines[i], `${name} support ${i}`);
      for (const [i, line] of pack.nextSteps.entries()) assert.notEqual(line, NEXT_STEPS_LINES[i], `${name} next ${i}`);
      assert.notEqual(pack.gstLine, GST_LINE);
      for (const line of [...pack.timelineTerms, ...pack.supportLines, ...pack.scopeProtection, ...pack.nextSteps]) {
        assert.ok(line.trim().length > 20, `${name}: a line is empty or stub`);
      }
    }
  });

  test('every regulated category, every default clause and every default payment milestone is covered', () => {
    const defaultLabels = new Set([...paymentScheduleFor(50_000_00).rows, ...paymentScheduleFor(200_000_00).rows].map((r) => r.label));
    for (const [name, pack] of packs) {
      for (const [category, lines] of Object.entries(REGULATED_CLAUSES)) {
        assert.equal(pack.regulated[category]?.length, lines.length, `${name} regulated ${category}`);
      }
      for (const key of CLAUSE_KEYS) assert.ok(pack.clauses[key]?.length > 10, `${name} clause ${key}`);
      for (const label of defaultLabels) assert.ok(pack.payment[label], `${name}: no translation for payment milestone "${label}"`);
    }
  });

  test('Hinglish stays in Roman letters (the typeface cannot draw Devanagari); Hindi is Devanagari', () => {
    const flat = (p: (typeof packs)[number][1]) =>
      JSON.stringify([p.timelineTerms, p.supportLines, p.gstLine, p.scopeProtection, p.nextSteps, p.clauses, p.regulated, p.payment, p.billedToYou, p.included, p.thirdParty]);
    assert.ok(!DEVANAGARI.test(flat(STANDARD_TRANSLATIONS.hinglish)), 'a Devanagari character in the Hinglish pack');
    assert.ok(DEVANAGARI.test(flat(STANDARD_TRANSLATIONS.hindi)));
    assert.ok(!DEVANAGARI.test(JSON.stringify(QUOTATION_LABELS.hinglish.bands)));
  });
});

describe('C. localising replaces the agency\'s DEFAULT wording and nothing else', () => {
  const doc = {
    understanding: 'A clinic app for patients to book.',
    exclusions: ['No payments.'],
    integrations: [{ name: 'UPI', purpose: 'fees', whoPays: 'client' }],
  };
  const base = () => quotationSectionsFor(8_500_000, 0, doc, [{ description: 'Patient app for booking and a clinic admin panel', features: ['patient'] }], { validityDays: 15 })!;

  test('English is returned untouched', () => {
    const b = base();
    assert.equal(localiseSections(b, 'en'), b);
  });

  test('defaults are replaced, with the number in the validity sentence carried over', () => {
    const out = localiseSections(base(), 'hinglish');
    assert.equal(out.nextSteps[0], STANDARD_TRANSLATIONS.hinglish.nextSteps[0]);
    assert.equal(out.commercialTerms[0], STANDARD_TRANSLATIONS.hinglish.validity(15));
    assert.equal(out.commercialTerms[1], STANDARD_TRANSLATIONS.hinglish.clauses.acceptance_window);
    assert.match(out.timelineLabel, /^Anumaanit \d+–\d+ hafte$/);
    assert.equal(out.gstLine, STANDARD_TRANSLATIONS.hinglish.gstLine);
    assert.ok(out.integrationLines?.some((l) => l.includes(STANDARD_TRANSLATIONS.hinglish.billedToYou)));
    assert.ok(out.paymentRows.every((r) => r.label !== paymentScheduleFor(8_500_000).rows[0]!.label));
    const hi = localiseSections(base(), 'hindi');
    assert.match(hi.timelineLabel, /^अनुमानित \d+–\d+ सप्ताह$/);
    assert.ok(DEVANAGARI.test(hi.commercialTerms[0]!));
  });

  test('wording the owner or the model wrote prints exactly as written', () => {
    const b = quotationSectionsFor(8_500_000, 0, doc, [{ description: 'Patient app', features: [] }], {
      validityDays: 15,
      clauses: ['Owner wrote: milestone accepted in 3 days.', DEFAULT_CLAUSES.cancellation, 'Owner liability line here.', DEFAULT_CLAUSES.jurisdiction],
    })!;
    const out = localiseSections(b, 'hindi');
    assert.ok(out.commercialTerms.includes('Owner wrote: milestone accepted in 3 days.'));
    assert.ok(out.commercialTerms.includes('Owner liability line here.'));
    assert.ok(out.commercialTerms.includes(STANDARD_TRANSLATIONS.hindi.clauses.cancellation), 'the unedited default beside them does translate');
    assert.equal(out.understanding, b.understanding);
    assert.deepEqual(out.exclusions, b.exclusions);
    const owner = quotationSectionsFor(8_500_000, 0, { ...doc, commercialTerms: ['Pay on the 1st of each month.'] }, [], { validityDays: 15 })!;
    assert.deepEqual(localiseSections(owner, 'hinglish').commercialTerms, ['Pay on the 1st of each month.']);
    const named = quotationSectionsFor(8_500_000, 0, { ...doc, paymentStructure: { name: 'Mine', milestones: [{ label: 'Kickoff', pct: 50 }, { label: 'Done', pct: 50 }] } }, [], { validityDays: 15 })!;
    assert.deepEqual(localiseSections(named, 'hindi').paymentRows.map((r) => r.label), ['Kickoff', 'Done']);
  });
});

describe('D. the fixed words of the page', () => {
  test('all three languages define every label, and no label is an empty string', () => {
    const keys = Object.keys(QUOTATION_LABELS.en);
    for (const lang of ['hinglish', 'hindi'] as const) {
      assert.deepEqual(Object.keys(QUOTATION_LABELS[lang]), keys, lang);
      for (const [k, v] of Object.entries(QUOTATION_LABELS[lang])) {
        if (typeof v === 'string') assert.ok(v.trim().length > 0, `${lang}.${k}`);
      }
    }
  });

  test('the status band follows the language, and an unknown status still gets one (fail closed)', () => {
    assert.equal(statusBandFor('draft'), QUOTATION_LABELS.en.bands.draft);
    assert.notEqual(statusBandFor('draft', 'hindi'), statusBandFor('draft'));
    assert.ok(DEVANAGARI.test(statusBandFor('pending_approval', 'hindi')!));
    assert.ok(statusBandFor('something_new', 'hinglish')!.includes('SOMETHING NEW'));
    for (const lang of ['en', 'hinglish', 'hindi'] as const) assert.equal(statusBandFor('approved', lang), null);
  });
});

describe('E. the shaper', () => {
  const bold = new ShapedFont(quotationDevanagariFontBytes().bold);

  test('a conjunct is one glyph, and a vowel sign + anusvara is the font\'s single combined glyph', () => {
    assert.ok(bold.glyphNames('क्षत्रिय').length < [...'क्षत्रिय'].length);
    assert.ok(bold.glyphNames('इसमें').includes('uni09470902'));
  });

  test('REGRESSION: after "ऐप" the next word is not shaped with a dotted circle (fontkit leaked glyph state)', () => {
    // A FRESH font each time: the leak needs a cold glyph cache, and a shared
    // instance warmed by the tests above hides it (a first version of this test
    // passed with the fix removed — the red-proof caught it).
    for (const poison of ['ऐप', 'छात्र ऐप — उपस्थिति', 'ऐप — उपस्थिति']) {
      const font = new ShapedFont(quotationDevanagariFontBytes().bold);
      font.glyphNames(poison);
      const names = font.glyphNames('इसमें क्या शामिल है');
      assert.ok(!names.some((n) => /25CC/i.test(n)), `after "${poison}" a dotted circle ◌ was inserted: ${names.slice(0, 6).join('|')}`);
      assert.ok(names.includes('uni09470902'), 'the combined ें glyph is expected');
    }
  });

  test('widths are measured from the shaped run: a conjunct is narrower than its letters side by side', () => {
    assert.ok(bold.widthOfTextAtSize('क्ष', 20) < bold.widthOfTextAtSize('क', 20) + bold.widthOfTextAtSize('ष', 20));
    assert.equal(bold.widthOfTextAtSize('', 20), 0);
  });
});

describe('F. the PDF', () => {
  const input = (language: QuotationLanguage, hindi: boolean) => {
    const doc = {
      understanding: hindi ? 'आपके कोचिंग इंस्टीट्यूट के लिए एंड्रॉइड ऐप।' : 'An Android app for your coaching institute.',
      exclusions: [hindi ? 'iOS ऐप इस चरण में नहीं है।' : 'No iOS app in this phase.'],
    };
    const items = [{ description: hindi ? 'छात्र ऐप' : 'Student app', quantity: 1, amountMinor: 8_500_000, features: [hindi ? 'उपस्थिति इतिहास' : 'Attendance history'] }];
    const sections = localiseSections(quotationSectionsFor(8_500_000, 0, doc, items, { validityDays: 15 })!, language);
    return {
      language,
      organizationName: 'Demo Agency', contactLine: null, preparedFor: hindi ? 'कोचिंग इंस्टीट्यूट' : 'Coaching Institute', title: hindi ? 'कोचिंग ऐप' : 'Coaching App',
      version: 1, status: 'approved', body: null, currency: 'INR', items,
      subtotalMinor: 8_500_000, discountMinor: 0, taxMinor: 0, totalMinor: 8_500_000,
      reference: '87adcdaa-01b8-4ce4-8f88-09afb0b883b5', preparedAt: '2026-10-03T08:00:00Z', validUntil: '2026-10-18', timeZone: 'Asia/Kolkata',
      ...sections,
    } as never;
  };

  test('a Hindi quotation renders in Devanagari with no character lost and the page words in Hindi', async () => {
    const r = await renderQuotationPdf(input('hindi', true));
    assert.deepEqual(r.replacedCharacters, [], 'characters were replaced with ?');
    assert.ok(r.bytes.length > 50_000);
    assert.ok(r.drawnText.includes(QUOTATION_LABELS.hindi.whatItCovers));
    assert.ok(r.drawnText.some((t) => t.includes('कोचिंग')));
    assert.ok(r.drawnText.includes('₹85,000.00'));
    assert.ok(!r.drawnText.includes('WHAT IT COVERS'));
  });

  test('a Hinglish quotation uses the Latin face and Hinglish page words; English is unchanged', async () => {
    const h = await renderQuotationPdf(input('hinglish', false));
    assert.deepEqual(h.replacedCharacters, []);
    assert.ok(h.drawnText.includes(QUOTATION_LABELS.hinglish.whatItCovers));
    const e = await renderQuotationPdf({ ...(input('en', false) as object), language: undefined } as never);
    assert.ok(e.drawnText.includes('WHAT IT COVERS'));
    assert.ok(e.drawnText.includes(QUOTATION_LABELS.en.page(1, 1)) || e.drawnText.some((t) => /^Page 1 of \d+$/.test(t)));
  });

  test('the same input renders to the same bytes (the renderer\'s determinism survives the new path)', async () => {
    const a = await renderQuotationPdf(input('hindi', true));
    const b = await renderQuotationPdf(input('hindi', true));
    assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0);
  });
});

describe('G. the wiring', () => {
  test('all three render sites pass the language and apply the translated standards only behind the owner switch', () => {
    const service = read('src/modules/sales/service.ts');
    const handlers = read('src/modules/crm/handlers.ts');
    const preview = read('src/modules/sales/preview-service.ts');
    assert.equal((service.match(/surroundings\.translateStandards && sections \? localiseSections\(sections, surroundings\.language\)/g) ?? []).length, 2);
    assert.equal((service.match(/language: surroundings\.language,/g) ?? []).length, 2);
    assert.match(handlers, /translateStandardsOn\(org\.settings\) && sections \? localiseSections\(sections, documentLanguage\)/);
    assert.match(handlers, /language: documentLanguage,/);
    assert.match(preview, /surroundings\.translateStandards && sections \? localiseSections/);
  });

  test('the drafters are told the language and script; the reply and extraction match the client\'s script', () => {
    const w = read('app/api/jobs/run/workflows.ts');
    assert.match(w, /Devanagari script, the way they write to us/);
    assert.match(w, /in Hinglish: Hindi in Roman \(English\) letters/);
    assert.match(w, /SCRIPT\. Match the script as well/);
    assert.match(w, /Hindi in Devanagari script if they write/);
    assert.equal((w.match(/await quotationLanguageTurn\(/g) ?? []).length + (w.match(/\(await quotationLanguageTurn\(/g) ?? []).length >= 3, true);
  });

  test('the settings page, action and catalogue carry the switch', () => {
    assert.match(read('app/(internal)/settings/actions.ts'), /key === 'quotation_translate_standards'/);
    assert.match(read('app/(internal)/settings/commercial/page.tsx'), /id="quotation-language"/);
    assert.match(read('src/lib/admin/settings-catalogue.ts'), /setting\('quotation_translate_standards'/);
  });
});
