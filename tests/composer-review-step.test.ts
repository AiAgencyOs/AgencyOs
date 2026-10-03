import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

/**
 * The invoice composer's REVIEW step, rendered (PDF SCR-052; the W1 leftover
 * "a UI-level test for the composer's review step").
 *
 * The step is a presentational component (`ComposerReview`); each case renders
 * it for real with react-dom/server — through tsx, because plain Node does not
 * strip JSX — and reads the markup a person would see: the lines as they will
 * be stored, the tax rows by place of supply, the total, the reason and the
 * notes. The numbers come from the same `composeLines` / `taxBreakdown` the
 * form and the door use, so a figure on this screen that disagreed with them
 * would fail here.
 */

type Scenario = {
  mode: 'gst' | 'non_gst' | null;
  supplierState: string | null;
  placeOfSupply: string | null;
  lines: { description: string; quantity: string; unitPrice: string }[];
  dueOn?: string;
  notes?: string;
};

function render(scenario: Scenario): string {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'tests/_render/composer-review.tsx', JSON.stringify(scenario)], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `render failed: ${run.stderr}`);
  return run.stdout;
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the composer review step', () => {
  it('splits GST into CGST and SGST inside the agency’s own state, and totals what the lines add up to', () => {
    const t = text(render({ mode: 'gst', supplierState: '29', placeOfSupply: '29', lines: [{ description: 'Hosting setup', quantity: '2', unitPrice: '1000' }] }));
    assert.match(t, /Review before generating/);
    assert.match(t, /Atlas Rebuild · Acme Pvt Ltd · GST · due per default terms/);
    assert.match(t, /Hosting setup 2 ₹1,000\.00 ₹2,000\.00/);
    assert.match(t, /Subtotal ₹2,000\.00/);
    assert.match(t, /CGST @ 9% ₹180\.00/);
    assert.match(t, /SGST @ 9% ₹180\.00/);
    assert.doesNotMatch(t, /IGST/);
    assert.match(t, /Total ₹2,360\.00/);
    assert.match(t, /split into CGST and SGST/);
  });

  it('charges IGST, not CGST and SGST, to a client in another state', () => {
    const t = text(render({ mode: 'gst', supplierState: '29', placeOfSupply: '27', lines: [{ description: 'Design sprint', quantity: '1', unitPrice: '5000' }] }));
    assert.match(t, /IGST @ 18% ₹900\.00/);
    assert.doesNotMatch(t, /CGST|SGST/);
    assert.match(t, /Total ₹5,900\.00/);
  });

  it('states no tax on the Non-GST path, with the reason, and shows the due date and notes it was given', () => {
    const t = text(render({ mode: 'non_gst', supplierState: '29', placeOfSupply: '29', lines: [{ description: 'Retainer', quantity: '1', unitPrice: '2500.50' }], dueOn: '2026-11-15', notes: 'Payable within 15 days.' }));
    assert.match(t, /Non-GST · due 2026-11-15/);
    assert.match(t, /Total ₹2,500\.50/);
    assert.doesNotMatch(t, /GST @|IGST|CGST|SGST/);
    assert.match(t, /No GST: this project is billed without GST/);
    assert.match(t, /Payable within 15 days\./);
  });

  it('lists every line in order with its own amount', () => {
    const t = text(render({ mode: 'non_gst', supplierState: null, placeOfSupply: null, lines: [{ description: 'First', quantity: '1', unitPrice: '100' }, { description: 'Second', quantity: '3', unitPrice: '50.25' }] }));
    assert.ok(t.indexOf('First') < t.indexOf('Second'));
    assert.match(t, /Second 3 ₹50\.25 ₹150\.75/);
    assert.match(t, /Total ₹250\.75/);
  });
});
