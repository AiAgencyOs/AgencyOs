/**
 * Renders the invoice composer's review step to static HTML for
 * tests/composer-review-step.test.ts. Run through tsx (JSX is not something
 * plain Node strips); the scenario arrives as JSON in argv[2]:
 *   { mode, supplierState, placeOfSupply, lines: [{description, quantity, unitPrice}], dueOn, notes }
 * Prints the markup and nothing else.
 */
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerReview } from '../../app/(internal)/invoices/new/composer-review';
import { composeLines } from '../../src/modules/finance/invoice-composer';
import { taxBreakdown } from '../../src/modules/finance/invoice-presentation';

const scenario = JSON.parse(process.argv[2] ?? '{}') as {
  mode: 'gst' | 'non_gst' | null;
  supplierState: string | null;
  placeOfSupply: string | null;
  lines: { description: string; quantity: string; unitPrice: string }[];
  dueOn?: string;
  notes?: string;
};

const composition = composeLines(scenario.lines, scenario.mode === 'gst' ? 1800 : 0);
if (!composition.ok) {
  console.error(composition.errors.join('; '));
  process.exit(2);
}
const breakdown = taxBreakdown({
  mode: scenario.mode,
  subtotalMinor: composition.totals.subtotalMinor,
  taxMinor: composition.totals.taxMinor,
  supplierStateCode: scenario.supplierState,
  placeOfSupplyCode: scenario.placeOfSupply,
});

process.stdout.write(
  renderToStaticMarkup(
    <ComposerReview
      project={{ projectId: 'p1', projectName: 'Atlas Rebuild', currency: 'INR', mode: scenario.mode, version: 1, legalName: 'Acme Pvt Ltd', gstin: null, billingState: 'Karnataka', billingStateCode: scenario.placeOfSupply, complete: true, missing: [] }}
      composition={composition}
      breakdown={breakdown}
      dueOn={scenario.dueOn ?? ''}
      notes={scenario.notes ?? ''}
      currency="INR"
    />,
  ),
);
