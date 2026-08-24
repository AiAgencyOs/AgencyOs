import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * The quotation grows its document — G-165, the Master Quotation System
 * landing in the engine at the owner's "proceed".
 *
 * The load-bearing split: the MODEL writes only what requires reading the
 * requirements (understanding, per-line features, exclusions, assumptions,
 * client responsibilities); CODE writes what is policy (payment families,
 * timeline bands, the support standard, GST, the change-request rule). A
 * legacy quotation with no document renders exactly as it always did.
 */

import {
  GST_LINE,
  NEXT_STEPS_LINES,
  SCOPE_PROTECTION_LINES,
  SUPPORT_STANDARD,
  paymentScheduleFor,
  quotationSectionsFor,
  timelineBandFor,
} from '../src/modules/sales/quotation-standards.ts';
import { quotationScopeSchema, parseQuotationDocument } from '../src/modules/sales/schema.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATION = sqlCode(read('supabase/migrations/20260824190000_the_quotation_grows_its_document.sql'));
const RENDERER = read('src/lib/pdf/quotation.ts');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const HANDLERS = read('src/modules/crm/handlers.ts');
const SERVICE = read('src/modules/sales/service.ts');

describe('A. the money is exact, whatever the total', () => {
  test('the families split at ₹1,00,000 and every schedule sums to the total', () => {
    // Family A below one lakh, B from it — the exclusive boundary Part G fixed.
    assert.equal(paymentScheduleFor(80_000_00).family, 'A');
    assert.equal(paymentScheduleFor(100_000_00).family, 'B');
    // Exactness across awkward totals: the last row absorbs the remainder.
    for (const total of [80_000_00, 100_000_00, 115_000_00, 99_999_99, 123_456_78, 1_00_001]) {
      const schedule = paymentScheduleFor(total);
      const sum = schedule.rows.reduce((s, r) => s + r.amountMinor, 0);
      assert.equal(sum, total, `Σ milestones ≠ total for ${total}`);
      assert.equal(schedule.rows.reduce((s, r) => s + r.pct, 0), 100);
    }
  });

  test('the design-approval milestone carries the revision cap (corpus DO-NOT #12)', () => {
    const b = paymentScheduleFor(150_000_00);
    assert.match(b.rows[1]!.label, /max 2 revision rounds; further rounds are change requests/);
  });

  test('timeline bands are the corpus’s own', () => {
    assert.deepEqual(timelineBandFor(40_000_00), { weeksMin: 3, weeksMax: 6 });
    assert.deepEqual(timelineBandFor(80_000_00), { weeksMin: 6, weeksMax: 9 });
    assert.deepEqual(timelineBandFor(115_000_00), { weeksMin: 7, weeksMax: 14 });
    assert.deepEqual(timelineBandFor(225_000_00), { weeksMin: 8, weeksMax: 12 });
    assert.deepEqual(timelineBandFor(500_000_00), { weeksMin: 10, weeksMax: 22 });
  });

  test('GST is named plainly, never hedged', () => {
    assert.equal(GST_LINE, 'All amounts are exclusive of GST; 18% GST extra.');
    assert.doesNotMatch(GST_LINE, /if applicable/i);
  });
});

describe('B. assembly — judgment from the row, policy from code, legacy untouched', () => {
  const doc = {
    understanding: 'A customer orders food and tracks the delivery.',
    exclusions: ['Marketing'],
    assumptions: [],
    clientResponsibilities: ['Hosting'],
  };

  test('a stored document assembles every section', () => {
    const sections = quotationSectionsFor(115_000_00, 0, doc);
    assert.ok(sections);
    assert.equal(sections.understanding, doc.understanding);
    assert.equal(sections.paymentRows.length, 4);
    assert.match(sections.timelineLabel, /7–14 weeks/);
    assert.equal(sections.gstLine, GST_LINE);
    assert.equal(sections.supportLines, SUPPORT_STANDARD.lines);
    assert.equal(sections.scopeProtection, SCOPE_PROTECTION_LINES);
    assert.equal(sections.nextSteps, NEXT_STEPS_LINES);
  });

  test('a stored Tax row silences the GST-extra line — one statement, never both (review finding)', () => {
    const taxed = quotationSectionsFor(118_000_00, 18_000_00, doc);
    assert.ok(taxed);
    assert.equal(taxed.gstLine, null);
    const untaxed = quotationSectionsFor(100_000_00, 0, doc);
    assert.equal(untaxed?.gstLine, GST_LINE);
  });

  test('a legacy proposal (no document) assembles NOTHING — it renders as it always did', () => {
    assert.equal(quotationSectionsFor(115_000_00, 0, null), null);
    assert.equal(quotationSectionsFor(115_000_00, 0, undefined), null);
    // Malformed jsonb renders as none rather than crashing a send.
    assert.equal(quotationSectionsFor(115_000_00, 0, 'garbage'), null);
    assert.equal(parseQuotationDocument({ exclusions: 'not-an-array' }), null);
  });
});

describe('C. the schema asks the model for judgment only', () => {
  test('understanding, per-line features and the three lists are required; policy fields are refused', () => {
    const good = {
      title: 'A delivery app',
      understanding: 'A customer orders food from nearby restaurants and tracks the delivery to their door.',
      items: [{ description: 'Customer app', priceRupees: 50_000, features: ['Browse restaurants', 'Order and pay'] }],
      summary: 'x',
      exclusions: [],
      assumptions: [],
      clientResponsibilities: [],
    };
    assert.equal(quotationScopeSchema.safeParse(good).success, true);
    // The judgment fields are load-bearing…
    assert.equal(quotationScopeSchema.safeParse({ ...good, understanding: undefined }).success, false);
    assert.equal(
      quotationScopeSchema.safeParse({ ...good, items: [{ description: 'Customer app', priceRupees: 50_000 }] })
        .success,
      false,
      'a line without features must be refused',
    );
    // …and one vague feature bullet is not two real ones.
    assert.equal(
      quotationScopeSchema.safeParse({
        ...good,
        items: [{ description: 'Customer app', priceRupees: 50_000, features: ['Everything'] }],
      }).success,
      false,
    );
    // Policy never arrives from the model: no field exists for it.
    for (const field of ['payment', 'paymentSchedule', 'timeline', 'support', 'gst']) {
      assert.equal(quotationScopeSchema.safeParse({ ...good, [field]: 'x' }).success, false, field);
    }
  });
});

describe('D. the renderer, EXECUTED — transcripts, not source regexes', () => {
  // The review mutation-proved that source pins alone were vacuous: the
  // renderer is now actually run, and the drawn transcript is the assertion.
  const base = {
    organizationName: 'BussEnhancer',
    preparedFor: 'A Sample Client',
    title: 'Delivery platform',
    version: 2,
    status: 'approved',
    body: 'Covers the apps. Does not cover marketing.',
    currency: 'INR',
    items: [
      { description: 'Customer app', quantity: 1, amountMinor: 80_000_00, features: ['Browse restaurants', 'Order and pay'] },
      { description: 'Admin panel', quantity: 1, amountMinor: 35_000_00 },
    ],
    subtotalMinor: 115_000_00,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 115_000_00,
    validUntil: '2026-09-08',
    preparedAt: '2026-08-24T10:00:00.000Z',
    timeZone: 'Asia/Kolkata',
    reference: 'test-ref',
  };

  test('a documented input draws every section; bullets ride their own line', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const { quotationSectionsFor } = await import('../src/modules/sales/quotation-standards.ts');
    const sections = quotationSectionsFor(115_000_00, 0, {
      understanding: 'A customer orders food and tracks it to the door.',
      exclusions: ['Marketing work'],
      assumptions: ['Single city at launch'],
      clientResponsibilities: ['Hosting charges'],
    });
    assert.ok(sections);
    const rendered = await renderQuotationPdf({ ...base, ...sections });
    const text = rendered.drawnText.join('\n');
    for (const label of [
      'THE PROJECT, AS UNDERSTOOD',
      'TIMELINE',
      'PAYMENT SCHEDULE',
      'EXPLICITLY NOT INCLUDED',
      'CLIENT RESPONSIBILITIES',
      'ASSUMPTIONS',
      'SCOPE & CHANGES',
      'SUPPORT',
      'NEXT STEPS',
    ]) {
      assert.ok(text.includes(label), `the ${label} section did not draw`);
    }
    // The bullets drew, attached to their OWN line's flow.
    assert.match(text, /\u2022 Browse restaurants/);
    // The GST line drew (taxMinor is 0), and the schedule sums on the page.
    assert.ok(text.includes('All amounts are exclusive of GST; 18% GST extra.'));
    assert.match(text, /₹34,500\.00 \(30%\)/);
    assert.equal(rendered.replacedCharacters.length, 0, 'every glyph must exist in the subset fonts');
  });

  test('a stored Tax row silences the GST line on the page itself', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const { quotationSectionsFor } = await import('../src/modules/sales/quotation-standards.ts');
    // ₹1,15,000 of lines plus ₹18,000 of tax is ₹1,33,000 — the identity the
    // database asserts (`proposals_total_is_arithmetic`) and, since G-167,
    // the renderer refuses to draw without.
    const sections = quotationSectionsFor(133_000_00, 18_000_00, { understanding: 'Taxed build.' });
    assert.ok(sections);
    const rendered = await renderQuotationPdf({
      ...base,
      taxMinor: 18_000_00,
      totalMinor: 133_000_00,
      ...sections,
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('Tax'), 'the Tax row must draw');
    assert.ok(!text.includes('GST extra'), 'the GST-extra line must NOT draw beside a Tax row');
  });

  test('a LEGACY input draws none of the new sections — byte-for-byte the old document', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const legacyItems = base.items.map(({ features: _features, ...rest }) => rest);
    const rendered = await renderQuotationPdf({ ...base, items: legacyItems });
    const text = rendered.drawnText.join('\n');
    for (const label of ['THE PROJECT, AS UNDERSTOOD', 'PAYMENT SCHEDULE', 'SCOPE & CHANGES', 'NEXT STEPS', 'GST']) {
      assert.ok(!text.includes(label), `${label} leaked into a legacy render`);
    }
    assert.ok(!text.includes('\u2022'), 'no bullets on a legacy render');
    assert.ok(text.includes('Total'), 'the legacy document still renders whole');
  });

  test('the renderer holds no policy', () => {
    const code = RENDERER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /quotation-standards/);
  });
});

describe('E. the plumbing — one document, every door, pinned in CODE', () => {
  const codeOf = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the columns exist and are frozen with the rest of the commercial content', () => {
    assert.match(MIGRATION, /add column if not exists document jsonb/);
    assert.match(MIGRATION, /alter table sales\.proposal_items\s+add column if not exists features jsonb/);
    const guard = MIGRATION.slice(MIGRATION.indexOf('create or replace function sales.proposals_guard'));
    assert.match(guard, /new\.document\s+is distinct from old\.document/);
    assert.match(guard, /a proposal is created as a draft/);
    // add_proposal_item carried its edits and kept its outcomes (D16).
    assert.match(MIGRATION, /p_features\s+jsonb default null/);
    assert.match(MIGRATION, /unit_price_minor, features/);
    assert.match(MIGRATION, /'not_draft'/);
  });

  test('all three drafting workflows write the line features AND the document, before submitting', () => {
    const code = codeOf(WORKFLOWS);
    assert.equal((code.match(/p_features: item\.features/g) ?? []).length, 3);
    const writes = [...code.matchAll(/document: \{\s*\n\s*understanding: validated\.data\.understanding/g)];
    assert.equal(writes.length, 3, 'scope, revise and rework must all write the document');
    // Each write precedes ITS OWN submission — all three orderings, not one.
    const submits = [...code.matchAll(/submitDraftedQuotation\(admin, draft\.proposal_id\)/g)];
    assert.equal(submits.length, 3);
    writes.forEach((w, i) => {
      assert.ok(w.index! < submits[i]!.index!, `write ${i + 1} must precede submission ${i + 1}`);
    });
  });

  test('every render door selects the document and assembles with the tax rule', () => {
    const handlers = codeOf(HANDLERS);
    const service = codeOf(SERVICE);
    // G-167 added the fourth argument and G-168 widened it to the priced
    // lines themselves — read by the regulated-category backstop (which
    // looks for "payout", "betting", "loan") and by the pricing reference
    // (which counts surfaces). Pinned WITH it, so a door that silently stops
    // passing it fails here rather than in front of a client.
    const call =
      /quotationSectionsFor\(proposal\.total_minor, proposal\.tax_minor, proposal\.document \?\? null, renderItems\)/g;
    assert.equal((handlers.match(call) ?? []).length, 1, 'the announce/dispatch renderer must assemble once');
    assert.equal((service.match(call) ?? []).length, 2, 'the owner download and the manual send must both assemble');
    // The selects behind them — the review mutation-proved these were unpinned:
    // dropping `document` from the dispatch select reverted client PDFs to
    // legacy with every test green.
    assert.match(handlers, /opportunity_id, document',/);
    assert.match(handlers, /requirement_version_id, document',/);
    assert.equal((service.match(/opportunity_id, document',/g) ?? []).length, 2);
    // And the items selects carry the row-features every door renders from.
    assert.equal((handlers.match(/description, quantity, amount_minor, features/g) ?? []).length, 2);
    assert.equal((service.match(/description, quantity, amount_minor, features/g) ?? []).length, 2);
  });

  test('the revision jobs read the STORED document and the ROW features back', () => {
    const code = codeOf(WORKFLOWS);
    assert.match(code, /const storedDocument = parseQuotationDocument\(proposal\.document \?\? null\)/);
    assert.match(code, /features: Array\.isArray\(i\.features\) \? i\.features : undefined/);
    assert.match(code, /clientResponsibilities: storedDocument\?\.clientResponsibilities \?\? undefined/);
  });
});
