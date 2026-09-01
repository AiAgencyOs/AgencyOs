import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import {
  costSettingsFrom,
  productionCostFor,
  productionCostNoteFor,
  storedProductionCostFor,
} from '../src/modules/sales/production-cost.ts';
import { quotationSectionsFor } from '../src/modules/sales/quotation-standards.ts';
import { quotationScopeSchema, parseQuotationDocument } from '../src/modules/sales/schema.ts';

/**
 * What it costs to make — G-179.
 *
 * The owner's stated pricing principle, which the repository did not have:
 *
 *     production cost × 2    minimum
 *     production cost × 2.5  recommended
 *     production cost × 3    premium
 *
 * A zero-trust audit searched the whole repository for a production cost, an
 * AI cost, a margin, a markup or a multiplier and found nothing outside UI
 * markup and per-run token accounting. So a quotation could sit **below what
 * the work costs to build** and nothing in the system would know — which is
 * the one thing the corpus formula cannot see, because the corpus records
 * what this agency CHARGED and not what it cost.
 *
 * The audit's other pricing finding was that the corpus formula lives in a
 * TypeScript literal, so the owner cannot change their own pricing without an
 * engineer. Every input here is an organization SETTING instead, written
 * through the audited setter and shape-checked in the database.
 *
 * ── the three refusals that keep it honest ────────────────────────────────
 *
 * **Unconfigured is silent.** An agency that has not set its rates gets
 * exactly the behaviour it had before this existed.
 *
 * **Incoherent is silent.** A configuration where the minimum band exceeds
 * the premium one produces three numbers in an order nobody can act on, and
 * the honest answer to a contradiction is to say nothing rather than pick a
 * reading of it.
 *
 * **Half-estimated is silent.** A cost built from three of five lines is an
 * underestimate wearing a cost's clothes, and printing it beside a price
 * would be worse than printing nothing.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260901140000_what_it_costs_to_make.sql');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

/** The owner's own principle, as five settings. */
const SETTINGS = {
  pricing_day_rate_rupees: '8000',
  pricing_ai_day_rate_rupees: '2000',
  pricing_multiplier_min: '2',
  pricing_multiplier_target: '2.5',
  pricing_multiplier_max: '3',
};

const SCOPE = {
  items: [
    { description: 'Customer app', effortDays: 3 },
    { description: 'Admin panel', effortDays: 2 },
  ],
};

describe('A. the rates are the owner’s, and read as they wrote them', () => {
  test('five settings make a model', () => {
    const cfg = costSettingsFrom(SETTINGS);
    assert.deepEqual(cfg, {
      dayRateRupees: 8000,
      aiDayRateRupees: 2000,
      multiplierMin: 2,
      multiplierTarget: 2.5,
      multiplierMax: 3,
    });
  });

  test('four of five make none — a half-configured model produces no figure', () => {
    for (const missing of Object.keys(SETTINGS)) {
      const partial = { ...SETTINGS } as Record<string, string>;
      delete partial[missing];
      assert.equal(costSettingsFrom(partial), null, `${missing} missing must yield no model`);
    }
  });

  test('and bands out of order make none either — a contradiction is not a reading', () => {
    assert.equal(
      costSettingsFrom({ ...SETTINGS, pricing_multiplier_min: '4' }),
      null,
      'a minimum above the premium band must produce silence, not a guess',
    );
  });

  test('a multiplier at or below cost is not a band anybody configured', () => {
    assert.equal(costSettingsFrom({ ...SETTINGS, pricing_multiplier_min: '1' }), null);
    assert.equal(costSettingsFrom({ ...SETTINGS, pricing_multiplier_min: '0.9' }), null);
  });

  test('a day that costs nothing is an empty field that parsed', () => {
    assert.equal(costSettingsFrom({ ...SETTINGS, pricing_day_rate_rupees: '0' }), null);
  });

  test('but AI costing nothing is a real answer — an agency may not use any', () => {
    assert.ok(costSettingsFrom({ ...SETTINGS, pricing_ai_day_rate_rupees: '0' }));
  });

  test('nothing at all is nothing, and does not throw', () => {
    assert.equal(costSettingsFrom(null), null);
    assert.equal(costSettingsFrom({}), null);
    assert.equal(costSettingsFrom('not settings'), null);
  });
});

describe('B. what it costs, and the bands above it', () => {
  const cfg = costSettingsFrom(SETTINGS)!;

  test('days × (build + AI) is the cost, and the bands are the owner’s multipliers', () => {
    const cost = productionCostFor(SCOPE, cfg)!;
    assert.equal(cost.days, 5);
    assert.equal(cost.costRupees, 50_000); // 5 × (8000 + 2000)
    assert.equal(cost.minimumRupees, 100_000);
    assert.equal(cost.recommendedRupees, 125_000);
    assert.equal(cost.premiumRupees, 150_000);
  });

  test('the derivation travels with the figure, in the order it was applied', () => {
    const cost = productionCostFor(SCOPE, cfg)!;
    assert.match(cost.basis[0]!, /5 developer-day\(s\) estimated across 2 line\(s\)/);
    assert.match(cost.basis[1]!, /₹10,000 per day \(₹8,000 build \+ ₹2,000 AI and tooling\)/);
    assert.match(cost.basis[2]!, /= ₹50,000 to produce/);
  });

  test('half-estimated is refused, not extrapolated', () => {
    // The important one. A cost built from three of five lines is an
    // underestimate wearing a cost's clothes, and it would make the owner's
    // floor look lower than it is — the exact direction that loses money.
    const half = { items: [{ description: 'Customer app', effortDays: 3 }, { description: 'Admin panel' }] };
    assert.equal(productionCostFor(half, cfg), null);
  });

  test('and so is a zero or a nonsense day count', () => {
    for (const effortDays of [0, -2, Number.NaN]) {
      assert.equal(productionCostFor({ items: [{ description: 'App', effortDays }] }, cfg), null);
    }
  });

  test('no settings means no cost, whatever the scope says', () => {
    assert.equal(productionCostFor(SCOPE, null), null);
  });

  test('an empty scope produces nothing rather than a free build', () => {
    assert.equal(productionCostFor({ items: [] }, cfg), null);
  });
});

describe('C. the note speaks only below the owner’s own floor', () => {
  const cfg = costSettingsFrom(SETTINGS)!;
  const cost = storedProductionCostFor(SCOPE, cfg)!;

  test('silence at or above the minimum band — the common case', () => {
    assert.equal(productionCostNoteFor({ proposedRupees: 100_000, cost }), null);
    assert.equal(productionCostNoteFor({ proposedRupees: 250_000, cost }), null);
  });

  test('below the floor it says what the work costs and what the bands are', () => {
    const note = productionCostNoteFor({ proposedRupees: 80_000, cost })!;
    assert.match(note, /FOR THE APPROVER ONLY — not shown to the client/);
    assert.match(note, /This draft is ₹80,000/);
    assert.match(note, /= ₹50,000 to produce/);
    assert.match(note, /minimum ₹1,00,000, recommended ₹1,25,000, premium ₹1,50,000/);
    assert.match(note, /above cost but below your minimum band/);
  });

  test('and below COST it says the harder thing plainly', () => {
    // Not the same sentence softened. "The agency pays to do it" is a
    // different fact from "under your target margin", and an approver needs
    // to know which one they are looking at.
    const note = productionCostNoteFor({ proposedRupees: 40_000, cost })!;
    assert.match(note, /BELOW what the work costs to produce — the agency pays to do it/);
    assert.doesNotMatch(note, /above cost but below/);
  });

  test('it names the decision as the owner’s, and says where the numbers live', () => {
    const note = productionCostNoteFor({ proposedRupees: 40_000, cost })!;
    assert.match(note, /The price is yours to set/);
    assert.match(note, /on the Settings page/);
  });

  test('no stored cost, no note — an unconfigured agency is unchanged', () => {
    assert.equal(productionCostNoteFor({ proposedRupees: 40_000, cost: null }), null);
    assert.equal(productionCostNoteFor({ proposedRupees: 40_000, cost: undefined }), null);
  });

  test('and a corrupt stored block says nothing rather than something wrong', () => {
    const corrupt = { ...cost, costRupees: 0, minimumRupees: 0 };
    assert.equal(productionCostNoteFor({ proposedRupees: 40_000, cost: corrupt }), null);
  });
});

describe('D. frozen with the quotation, and read back from there', () => {
  const cfg = costSettingsFrom(SETTINGS)!;

  test('the document round-trips the frozen block', () => {
    const stored = storedProductionCostFor(SCOPE, cfg)!;
    const parsed = parseQuotationDocument({ understanding: 'x', productionCost: stored });
    assert.equal(parsed?.productionCost?.costRupees, 50_000);
    assert.equal(parsed?.productionCost?.minimumRupees, 100_000);
  });

  test('a malformed block does not take the document with it', () => {
    const doc = parseQuotationDocument({ understanding: 'A booking platform.', productionCost: 'nonsense' });
    assert.equal(doc?.understanding, 'A booking platform.');
    assert.equal(doc?.productionCost, null);
  });

  test('the assembler reads the FROZEN figure and never recomputes one', () => {
    // The G-172 discipline, and the reason is sharper here: these rates are
    // editable from a settings page, so a recomputed note would judge an
    // August quotation by today's costs.
    const stored = storedProductionCostFor(SCOPE, cfg)!;
    const sections = quotationSectionsFor(80_000_00, 0, { understanding: 'x', productionCost: stored }, []);
    assert.match(sections!.internalNote!, /= ₹50,000 to produce/);

    const standards = read('src/modules/sales/quotation-standards.ts');
    assert.ok(
      !/costSettingsFrom|productionCostFor\(/.test(codeOnly(standards)),
      'the assembler must not recompute the cost — that judges an old quotation by new rates',
    );
  });

  test('and a quotation with no cost block shows exactly what it always did', () => {
    const sections = quotationSectionsFor(80_000_00, 0, { understanding: 'x' }, []);
    assert.equal(sections?.internalNote, null);
  });
});

describe('E. the model is told, and the answer is kept', () => {
  test('the schema takes a per-line day estimate', () => {
    const scope = {
      title: 'Turf booking platform',
      understanding:
        'A player finds a nearby turf, sees which slots are free and pays for one; the owner sets prices.',
      items: [
        {
          description: 'Player app',
          priceRupees: 30_000,
          effortDays: 6,
          features: ['Mobile number and OTP login', 'Find turfs nearby and book a slot'],
        },
      ],
      summary: 'Covers the player app.',
      exclusions: [],
      assumptions: [],
      clientResponsibilities: [],
    };
    assert.equal(quotationScopeSchema.safeParse(scope).success, true);
    // And a fraction of a day is not an estimate anybody acts on.
    assert.equal(
      quotationScopeSchema.safeParse({ ...scope, items: [{ ...scope.items[0]!, effortDays: 0.5 }] }).success,
      false,
    );
  });

  test('all three prompts ask for it, and say why it is all-or-nothing', () => {
    assert.equal((WORKFLOWS.match(/EFFORT — developer-days for EACH line/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/Estimate every line or none/g) ?? []).length, 3);
  });

  test('and tell the model it never reaches the client', () => {
    assert.equal((WORKFLOWS.match(/It never reaches the client/g) ?? []).length, 3);
  });

  test('all three doors freeze the cost at draft time', () => {
    assert.equal((WORKFLOWS.match(/productionCost: storedProductionCostFor\(/g) ?? []).length, 3);
    assert.equal(
      (WORKFLOWS.match(/await costSettingsForOrganization\(admin, job\.organization_id\)/g) ?? []).length,
      3,
    );
  });

  test('a failed settings read is "not configured", never a failed draft', () => {
    // An advisory note nobody is owed must not cost work somebody is.
    const helper = WORKFLOWS.slice(
      WORKFLOWS.indexOf('async function costSettingsForOrganization'),
      WORKFLOWS.indexOf('async function submitDraftedQuotation'),
    );
    assert.ok(helper.length > 100, 'the helper was not found');
    assert.ok(!/failJob|throw /.test(helper), 'a settings read must not be able to fail a draft');
    assert.match(helper, /costSettingsFrom\(data\?\.settings \?\? null\)/);
  });
});

describe('F. the owner can change their own pricing, and the door is guarded', () => {
  const sql = sqlCode(MIGRATION);

  test('all five keys are whitelisted in the setter', () => {
    for (const key of [
      'pricing_day_rate_rupees',
      'pricing_ai_day_rate_rupees',
      'pricing_multiplier_min',
      'pricing_multiplier_target',
      'pricing_multiplier_max',
    ]) {
      assert.ok(sql.includes(`'${key}'`), `${key} must be settable`);
    }
  });

  test('and in the GUARD too — the two lists are the same list, twice', () => {
    // A key in the setter and not the guard is a key anybody with
    // conversations_write can set over PostgREST, unaudited. That is the whole
    // reason the guard exists.
    const guard = sql.slice(sql.indexOf('create or replace function core.org_setting_write_is_sanctioned'));
    for (const key of [
      'pricing_day_rate_rupees',
      'pricing_ai_day_rate_rupees',
      'pricing_multiplier_min',
      'pricing_multiplier_target',
      'pricing_multiplier_max',
    ]) {
      assert.ok(guard.includes(`'${key}'`), `${key} must be guarded against a direct write`);
    }
  });

  test('a rate with a comma in it is refused', () => {
    // "8,000" would parse to 8 on the way out and divide the agency's costs by
    // a thousand. Digits only.
    assert.match(sql, /v_value !~ '\^\[0-9\]\{1,7\}\$'/);
  });

  test('and a multiplier typed as a percentage is refused', () => {
    // 250 is the realistic mistake, and it would price at 250× cost.
    assert.match(sql, /v_value::numeric <= 1 or v_value::numeric > 10/);
  });

  test('the ORDER is deliberately not checked in the database', () => {
    // The setter writes one key at a time and cannot see the other four; an
    // owner raising all three passes through an incoherent moment on the way.
    // The reader refuses an out-of-order set instead, and the form refuses it
    // at the point a person can fix it.
    const setter = sql.slice(0, sql.indexOf('create or replace function core.org_setting_write_is_sanctioned'));
    assert.ok(
      !/multiplier_min.*<=.*multiplier_max/s.test(setter),
      'the database must not half-check an order it cannot see',
    );
  });

  test('the form refuses a partly-filled model, and one out of order', () => {
    const actions = read('app/(internal)/settings/actions.ts');
    assert.match(actions, /Fill in all five, or clear all five/);
    assert.match(actions, /The bands must rise: minimum ≤ recommended ≤ premium/);
  });

  test('and the settings page says plainly when nothing is set', () => {
    const page = read('app/(internal)/settings/page.tsx');
    assert.match(page, /nothing warns you about one priced below cost/);
  });
});
