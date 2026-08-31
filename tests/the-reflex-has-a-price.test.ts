import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { storedReferenceFor } from '../src/modules/sales/pricing-reference.ts';
import { parseQuotationDocument } from '../src/modules/sales/schema.ts';

/**
 * The reflex has a price — G-172, the corpus study's §24 #13 and the last of
 * its list.
 *
 * The study's sharpest commercial finding was that this agency prices onto
 * round anchors and bends the scope to meet them: ₹50,000 bought an app plus
 * an admin panel, a dual-app ERP, a three-role marketplace AND a
 * Netflix-class OTT platform. That is a reflex, and a reflex cannot be
 * argued with until somebody can see what it costs.
 *
 * THE DESIGN DECISION, and it is the whole gap: the delta is RECORDED at
 * draft time rather than recomputed on demand. The measurement is of a
 * DECISION, so the figure has to be the one that was in front of the decider.
 * Recomputing later answers a different question — what today's formula says
 * about an August quotation — which is a re-judgement with hindsight rather
 * than a record. The formula has already moved once (G-169 gave it stated
 * surfaces and depth), which is exactly the drift that would have silently
 * rewritten history.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const FUNNEL = read('src/lib/admin/sales-funnel.ts');
const PAGE = read('app/(internal)/sales-funnel/page.tsx');

describe('A. the figure is frozen beside the price it was compared to', () => {
  test('the record carries both numbers, not just the gap', () => {
    // A stored gap alone would silently re-baseline if the total were later
    // revised. The pair is the fact; the gap is arithmetic over it.
    const stored = storedReferenceFor(
      {
        items: [
          { description: 'Customer app', kind: 'surface' },
          { description: 'Admin panel', kind: 'surface' },
        ],
        depth: 'standard',
      },
      50_000,
    );
    assert.equal(stored.proposedRupees, 50_000);
    assert.equal(stored.referenceRupees, 55_000);
    assert.equal(stored.surfaces, 2);
    assert.equal(stored.depth, 'standard');
    assert.equal(stored.lane, 2);
  });

  test('it survives the document round-trip that freezes it', () => {
    const stored = storedReferenceFor({ items: [{ description: 'Customer app', kind: 'surface' }] }, 30_000);
    const parsed = parseQuotationDocument({ understanding: 'x', pricingReference: stored });
    assert.ok(parsed, 'the document must still parse with the reference on it');
    // Asserted WITHOUT a fallback, and the first version of this test had one.
    // Zod strips undeclared keys, so `?? stored` made the assertion pass while
    // the value was in fact being dropped on every parse. The field is
    // declared on quotationDocumentSchema now, and this proves it round-trips.
    assert.deepEqual((parsed as unknown as { pricingReference?: unknown }).pricingReference, stored);
  });

  test('all three drafting doors record it, or two thirds of the measurement is missing', () => {
    const writes = [...WORKFLOWS.matchAll(/pricingReference: storedReferenceFor\(/g)];
    assert.equal(writes.length, 3, 'every drafting workflow must record the reference');
    // Against the LINES the model wrote and the total those lines sum to —
    // not against a number fetched back, which could already have moved.
    assert.match(WORKFLOWS, /items: validated\.data\.items, depth: validated\.data\.depth \?\? null/);
    assert.match(WORKFLOWS, /reduce\(\(sum, item\) => sum \+ item\.priceRupees, 0\)/);
  });
});

describe('B. the reader reports what was recorded, and never recomputes it', () => {
  test('it reads the stored figure rather than re-deriving one', () => {
    // Re-deriving here would quietly undo the entire reason for storing it.
    assert.match(FUNNEL, /document\?\.pricingReference/);
    assert.ok(
      !/laneReferenceFor|storedReferenceFor/.test(FUNNEL),
      'the funnel must not recompute the reference — that answers a different question',
    );
  });

  test('a quotation drafted before this existed is ABSENT, not a zero', () => {
    // The difference matters: counting old quotations as "no gap" would
    // dilute the measurement with rows that were never measured.
    assert.match(FUNNEL, /if \(referenceRupees === null \|\| proposedRupees === null \|\| referenceRupees <= 0\) continue;/);
  });

  test('only quotations priced BELOW the reference are summed', () => {
    // Pricing above the formula is not a cost; netting the two would hide
    // the thing being measured.
    assert.match(FUNNEL, /const gap = referenceRupees - proposedRupees;/);
    assert.match(FUNNEL, /if \(gap <= 0\) continue;/);
  });

  test('it refuses on a failed read rather than reporting a healthy zero (G-054)', () => {
    assert.match(FUNNEL, /if \(error\) unreadable\('getPricingReflex', error\);/);
  });
});

describe('C. what the page says, and what it refuses to say', () => {
  test('the section only appears once something has been measured', () => {
    assert.match(PAGE, /reflex\.quoted > 0 \?/);
  });

  test('it names the gap as a decision, not an error', () => {
    // The owner may have had every reason to price below the reference. A
    // page that calls that a mistake would be wrong and would be ignored.
    assert.match(PAGE, /A gap is not a mistake/);
    assert.match(PAGE, /the cost of a\s*\n?\s*decision/);
  });

  test('and it says which reference it is quoting', () => {
    assert.match(PAGE, /recorded when each quotation was drafted, not what/);
  });

  test('zero below is stated plainly rather than hidden', () => {
    // An absent section and "none were below" are different facts.
    assert.match(PAGE, /reflex\.below === 0 \?/);
    assert.match(PAGE, /None of the \{reflex\.quoted\}/);
  });
});
