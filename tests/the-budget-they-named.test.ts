import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { clientBudgetNoteFor } from '../src/modules/sales/production-cost.ts';
import { quotationDocumentSchema } from '../src/modules/sales/schema.ts';

/**
 * The budget they named — G-193.
 *
 * ── the finding, in one line ──────────────────────────────────────────────
 *
 * A zero-trust audit traced the flow's **BUDGET DISCOVERY** step and found it
 * ended nowhere. `crm.qualification_coverage` records the client's own
 * sentence for sixteen areas, two of them commercial. All three readers of
 * that table select `area` alone — to decide what not to ask again — so **the
 * number the client named was invisible to the number the agency proposed.**
 *
 * Asking a client their budget and then pricing without it is worse than not
 * asking: it sets an expectation the quotation may contradict.
 *
 * ── and the design is mostly about what it must NOT do ────────────────────
 *
 * A model shown *"my budget is ₹50,000"* and asked to quote will quote
 * ₹50,000 — abandoning the cost model and the corpus formula for the client's
 * anchor, which is the exact failure the pricing work exists to prevent.
 *
 * So the words shape the **scope**, and they reach the **approver**. The
 * prompt is told to price honestly and phase the build rather than discount
 * it; the sentence is frozen onto the document so the owner reads what the
 * client said beside what was drafted, at the moment they are deciding.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const WORKFLOWS_RAW = read('app/api/jobs/run/workflows.ts');
const STANDARDS = codeOnly(read('src/modules/sales/quotation-standards.ts'));

describe('A. the words reach the drafter, verbatim', () => {
  test('both commercial areas are read, and only those', () => {
    assert.match(WORKFLOWS, /\.in\('area', \['budget', 'payment_expectations'\]\)/);
  });

  test('scoped to the organization and the lead', () => {
    assert.match(WORKFLOWS, /budgetSignalFor[\s\S]{0,900}?\.eq\('organization_id', organizationId\)[\s\S]{0,120}?\.eq\('lead_id', leadId\)/);
  });

  test('a failed read yields nothing rather than failing the draft', () => {
    // The budget is context the owner would like, not a fact the quotation
    // cannot be written without — but a persistent failure is logged.
    assert.match(WORKFLOWS, /scope: 'budgetSignalFor'/);
  });

  test('no lead means no read at all', () => {
    assert.match(WORKFLOWS, /if \(!leadId\) return \[\];/);
  });

  test('the turn says what it is for before it says what was said', () => {
    assert.match(WORKFLOWS, /This is CONTEXT FOR SCOPE and/);
    assert.match(WORKFLOWS, /it is NOT a price to hit/);
  });
});

describe('B. the prompt is told what not to do with it', () => {
  test('the drafting and rework prompts carry the rule', () => {
    // Two, not three: the reviser works from the owner's explicit note, and an
    // old client budget could contradict a current instruction from the person
    // who decides. The owner's words win there.
    assert.equal((WORKFLOWS.match(/WHAT THEY SAID ABOUT MONEY/g) ?? []).length, 2);
  });

  test('and the rule is "never price to them"', () => {
    assert.match(WORKFLOWS, /They are CONTEXT, not a target\. Never price to them/);
    assert.match(WORKFLOWS, /never discount the same scope to reach them/);
  });

  test('with the answer when the honest price is higher', () => {
    // Phase it, do not shave it — the same instruction G-183 gave the rework,
    // arrived at from the other direction.
    assert.match(WORKFLOWS, /SMALLER FIRST PHASE at an honest price/);
    assert.match(WORKFLOWS, /put the rest in `phase\.deferredTo`/);
  });

  test('and the answer when it cannot be phased', () => {
    assert.match(WORKFLOWS, /quote it honestly at full scope/);
    assert.match(WORKFLOWS, /that decision is theirs, not yours/);
  });

  test('the model is told never to repeat it back to the client', () => {
    assert.match(WORKFLOWS, /never repeat them in the document/);
  });
});

describe('C. the words reach the approver, and only the approver', () => {
  test('the document carries them, frozen with everything else', () => {
    const parsed = quotationDocumentSchema.safeParse({
      understanding: 'A delivery platform.',
      clientBudget: [{ area: 'budget', said: 'Around ₹50–60k is what I had in mind' }],
    });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.clientBudget?.[0]?.said, 'Around ₹50–60k is what I had in mind');
  });

  test('a malformed entry loses only itself', () => {
    const doc = quotationDocumentSchema.safeParse({ understanding: 'x', clientBudget: 'not an array' });
    assert.equal(doc.success, true);
    assert.equal(doc.data?.clientBudget, null);
    assert.equal(doc.data?.understanding, 'x');
  });

  test('the note quotes them exactly and names the draft’s own figure', () => {
    const note = clientBudgetNoteFor({
      proposedRupees: 90000,
      said: [{ area: 'budget', said: 'Around ₹50–60k is what I had in mind' }],
    });
    assert.match(note!, /^FOR THE APPROVER ONLY/);
    assert.match(note!, /On budget: “Around ₹50–60k is what I had in mind”/);
    assert.match(note!, /This draft is ₹90,000\./);
  });

  test('it distinguishes what they said about paying from what they said about budget', () => {
    const note = clientBudgetNoteFor({
      proposedRupees: 90000,
      said: [{ area: 'payment_expectations', said: 'Can I pay in three parts?' }],
    });
    assert.match(note!, /On paying: “Can I pay in three parts\?”/);
  });

  test('and it says a gap is a decision, not a defect in the draft', () => {
    const note = clientBudgetNoteFor({ proposedRupees: 90000, said: [{ area: 'budget', said: '₹40k' }] });
    assert.match(note!, /phase the work rather than discount it/);
    assert.match(note!, /a decision for you rather than a mistake in the draft/);
  });

  test('silent when the client never said anything', () => {
    // An approver block that appears on every quotation is one nobody reads.
    assert.equal(clientBudgetNoteFor({ proposedRupees: 90000, said: null }), null);
    assert.equal(clientBudgetNoteFor({ proposedRupees: 90000, said: [] }), null);
    assert.equal(clientBudgetNoteFor({ proposedRupees: 90000, said: [{ area: 'budget', said: '   ' }] }), null);
  });

  test('the assembler puts it FIRST, before the agency’s own formulas', () => {
    // It is the only one of these notes that is a fact about the client.
    assert.match(STANDARDS, /const notes = \[budgetNote, costNote, pricingNote, timelineNote\]/);
  });

  /**
   * And the page itself, RENDERED — not a regex over the renderer.
   *
   * The gate is structural (`internalNote` draws only where `statusBandFor`
   * returns a band), but "structural" is a claim about source. Both copies of
   * the same quotation are drawn here and their transcripts read, because the
   * client copy is the one that matters and a source pin cannot prove it.
   */
  const pdfBase = {
    organizationName: 'BussEnhancer',
    preparedFor: 'A Sample Client',
    title: 'Delivery platform',
    version: 2,
    body: 'Covers the apps.',
    currency: 'INR',
    items: [{ description: 'Customer app', quantity: 1, amountMinor: 90_000_00 }],
    subtotalMinor: 90_000_00,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: 90_000_00,
    validUntil: '2026-09-08',
    preparedAt: '2026-08-24T10:00:00.000Z',
    timeZone: 'Asia/Kolkata',
    reference: 'test-ref',
  };
  const SAID = 'Around ₹50–60k is what I had in mind';
  const sectionsWithBudget = async () => {
    const { quotationSectionsFor } = await import('../src/modules/sales/quotation-standards.ts');
    const sections = quotationSectionsFor(90_000_00, 0, {
      understanding: 'A delivery platform.',
      clientBudget: [{ area: 'budget', said: SAID }],
    });
    assert.ok(sections, 'the assembler must return sections for a documented quotation');
    return sections;
  };

  test('an UNAPPROVED copy draws it, under the approver’s own heading', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const rendered = await renderQuotationPdf({
      ...pdfBase, status: 'pending_approval', ...(await sectionsWithBudget()),
    });
    const text = rendered.drawnText.join('\n');
    assert.ok(text.includes('FOR THE APPROVER — NOT PART OF THE QUOTATION'), 'the approver section did not draw');
    assert.ok(text.includes(SAID), 'the client’s own sentence did not reach the approver');
    assert.equal(rendered.replacedCharacters.length, 0, 'every glyph must exist in the subset fonts');
  });

  test('and the copy the CLIENT receives does not — same sections, sent status', async () => {
    const { renderQuotationPdf } = await import('../src/lib/pdf/quotation.ts');
    const sections = await sectionsWithBudget();
    // The assembler handed over the note; only the status differs.
    assert.ok(String(sections.internalNote ?? '').includes(SAID), 'the fixture must actually carry the note');
    for (const status of ['approved', 'sent', 'accepted']) {
      const rendered = await renderQuotationPdf({ ...pdfBase, status, ...sections });
      const text = rendered.drawnText.join('\n');
      assert.ok(!text.includes(SAID), `the client’s budget sentence leaked onto a ${status} copy`);
      assert.ok(!text.includes('FOR THE APPROVER'), `the approver heading leaked onto a ${status} copy`);
      assert.ok(text.includes('Total'), `the ${status} copy must still render whole`);
    }
  });
});

describe('D. it survives the versions that follow', () => {
  test('a revision carries the stored words forward', () => {
    // A fact about the client, not about this draft. A revision that dropped
    // it would leave the approver comparing a new price against nothing.
    assert.match(WORKFLOWS, /clientBudget: \(storedDocument\?\.clientBudget as/);
  });

  test('a rework reads them fresh, because a price objection is exactly when they matter', () => {
    assert.match(WORKFLOWS, /const reworkBudget = await budgetSignalFor\(admin, job\.organization_id, objection\.lead_id\);/);
    assert.match(WORKFLOWS, /clientBudget: reworkBudget\.length > 0 \? reworkBudget : null/);
  });

  test('the reasoning is recorded where the field is written', () => {
    assert.match(WORKFLOWS_RAW, /What the client said\n {10}\/\/ about money is a fact about them, not about this draft/);
  });
});
