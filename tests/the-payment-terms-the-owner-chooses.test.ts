import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { paymentScheduleFor } from '../src/modules/sales/quotation-standards.ts';
import { quotationDocumentSchema } from '../src/modules/sales/schema.ts';

/**
 * The payment terms the owner chooses — G-196 (Doc 07 §11, QM-22/PR-09).
 *
 * Every quotation this system has drawn carried one of two schedules chosen
 * by amount: 40/30/30 under a lakh, 30/30/25/15 at or above it. Those are
 * OBSERVED — ten of the corpus's forty-five each — which is why they were
 * hard-coded and why they remain the default.
 *
 * Doc 07 §11 asks for something else: *configurable* milestones. An agency
 * that wanted 50% up front, or four milestones instead of three, had to edit
 * a TypeScript file and deploy.
 *
 * The test that matters most in this file is the one that proves NOTHING
 * changed for an agency that configures nothing.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904130000_the_payment_terms_the_owner_chooses.sql'));
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
// The prose, unstripped: why two readers a few lines apart take OPPOSITE
// postures on a failed read is a decision, and `codeOnly` removes exactly the
// place a decision is recorded.
const WORKFLOWS_PROSE = read('app/api/jobs/run/workflows.ts');

describe('A. an agency that configures nothing keeps exactly what it had', () => {
  test('the two corpus families are untouched, by amount', () => {
    assert.equal(paymentScheduleFor(80_000_00).family, 'A');
    assert.equal(paymentScheduleFor(100_000_00).family, 'B');
    assert.deepEqual(
      paymentScheduleFor(80_000_00).rows.map((r) => r.pct),
      [40, 30, 30],
    );
    assert.deepEqual(
      paymentScheduleFor(150_000_00).rows.map((r) => r.pct),
      [30, 30, 25, 15],
    );
  });

  test('null and undefined are both "not configured"', () => {
    assert.equal(paymentScheduleFor(80_000_00, null).family, 'A');
    assert.equal(paymentScheduleFor(80_000_00, undefined).family, 'A');
  });

  test('and a structure with no milestones falls back rather than drawing an empty schedule', () => {
    assert.equal(paymentScheduleFor(80_000_00, { name: 'Broken', milestones: [] }).family, 'A');
  });
});

describe('B. a configured structure, and Part L still holds', () => {
  const owners = { name: 'Half up front', milestones: [{ label: 'Advance', pct: 50 }, { label: 'Handover', pct: 50 }] };

  test('the owner’s labels and percentages are what the client reads', () => {
    const schedule = paymentScheduleFor(90_000_00, owners);
    assert.equal(schedule.family, 'C');
    assert.deepEqual(schedule.rows.map((r) => r.label), ['Advance', 'Handover']);
    assert.deepEqual(schedule.rows.map((r) => r.amountMinor), [45_000_00, 45_000_00]);
  });

  test('Σ milestones = total, for amounts no percentage divides cleanly', () => {
    // The corpus study's Part L, and the reason the last row absorbs the
    // remainder here exactly as it does in the two families.
    const thirds = {
      name: 'Thirds',
      milestones: [
        { label: 'Advance', pct: 33.33 },
        { label: 'Middle', pct: 33.33 },
        { label: 'Handover', pct: 33.34 },
      ],
    };
    for (const total of [1, 7, 999, 12_345_67, 100_000_00, 3_333_333]) {
      const sum = paymentScheduleFor(total, thirds).rows.reduce((acc, r) => acc + r.amountMinor, 0);
      assert.equal(sum, total, `the schedule must sum to ${total}`);
    }
  });

  test('a one-milestone schedule is a real schedule', () => {
    const all = paymentScheduleFor(50_000_00, { name: 'All up front', milestones: [{ label: 'Advance', pct: 100 }] });
    assert.deepEqual(all.rows.map((r) => r.amountMinor), [50_000_00]);
  });
});

describe('C. it is FROZEN onto the quotation, not read at render time', () => {
  test('the document carries it', () => {
    const parsed = quotationDocumentSchema.safeParse({
      understanding: 'A build.',
      paymentStructure: { name: 'Half up front', milestones: [{ label: 'Advance', pct: 50 }, { label: 'End', pct: 50 }] },
    });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.paymentStructure?.milestones.length, 2);
  });

  test('a malformed structure loses only itself', () => {
    const doc = quotationDocumentSchema.safeParse({ understanding: 'x', paymentStructure: 'not an object' });
    assert.equal(doc.success, true);
    assert.equal(doc.data?.paymentStructure, null);
    assert.equal(doc.data?.understanding, 'x');
  });

  test('the assembler reads the frozen one, never the organization', () => {
    const standards = codeOnly(read('src/modules/sales/quotation-standards.ts'));
    assert.match(standards, /paymentScheduleFor\(\s*totalMinor,\s*\(doc\.paymentStructure/);
  });

  test('a REVISION carries it forward rather than re-reading it', () => {
    // A revision is the same negotiation and the same terms. Re-reading would
    // let a mid-negotiation change of policy move the schedule under a client
    // who is comparing v1 with v2.
    assert.match(WORKFLOWS, /paymentStructure:\s*\(storedDocument\?\.paymentStructure as/);
  });

  test('a REWORK re-reads it, because a rework re-prices', () => {
    // A scope cut that takes a deal under a lakh should take the schedule
    // with it — the band is a function of the amount, and the amount moved.
    const rework = WORKFLOWS.lastIndexOf('paymentStructure: await paymentStructureFor(');
    const draft = WORKFLOWS.indexOf('paymentStructure: await paymentStructureFor(');
    assert.ok(draft > 0 && rework > draft, 'both the draft and the rework must read it fresh');
  });
});

describe('D. which structure, when an agency has several', () => {
  test('the band is matched inclusive-below, exclusive-above — the families’ own shape', () => {
    assert.match(WORKFLOWS, /totalMinor >= row\.min_amount_minor/);
    assert.match(WORKFLOWS, /totalMinor < row\.max_amount_minor/);
  });

  test('the NARROWEST matching band wins', () => {
    // So a catch-all and a special one for large deals can coexist without
    // the catch-all having to be bounded.
    assert.match(WORKFLOWS, /width\(row\) < width\(best\)/);
    assert.match(WORKFLOWS, /Number\.POSITIVE_INFINITY/);
  });

  test('and a failed read falls back to the families rather than failing the draft', () => {
    // The opposite of the negotiation limits beside it, and the difference is
    // the point: a limit that lapses removes a bound the owner asked for; a
    // structure that cannot be read falls back to what 45 real quotations used.
    assert.match(WORKFLOWS, /scope: 'paymentStructureFor'/);
    assert.match(WORKFLOWS_PROSE, /One failure loses a rule; the other loses a preference/);
  });
});

describe('E. the database owns the hundred', () => {
  test('the sum is enforced, and DEFERRED because milestones arrive one at a time', () => {
    assert.match(MIGRATION, /create constraint trigger payment_milestones_sum[\s\S]{0,200}?deferrable initially deferred/);
    assert.match(MIGRATION, /if v_total <> 100 then/);
  });

  test('an empty structure does not raise — deleting one must stay possible', () => {
    // G-190's lesson one schema along: a rule that refuses the empty state
    // makes its own parent undeletable.
    assert.match(MIGRATION, /if v_count = 0 then\s+return null;/);
  });

  test('the setter reports a bad total as its own outcome', () => {
    // A person who typed 30/30/30 deserves to be told the total is ninety,
    // not handed a constraint violation at commit.
    assert.match(MIGRATION, /return query select 'does_not_sum'::text/);
    assert.match(MIGRATION, /return query select 'invalid_milestones'::text/);
    assert.match(MIGRATION, /return query select 'invalid_band'::text/);
  });

  test('and it replaces the set rather than editing a row', () => {
    // Qualified, and the qualification is the fix rather than the style:
    // this function's own OUT parameter is called `structure_id`, so an
    // unqualified reference is ambiguous — which PL/pgSQL refuses at CALL
    // time, not at creation. The first save worked and every later one
    // answered 42702.
    assert.match(MIGRATION, /delete from sales\.payment_milestones m where m\.structure_id = v_id;/);
  });

  test('a direct write is refused even for the owner', () => {
    assert.match(MIGRATION, /payment terms are set through sales\.set_payment_structure, not by writing the row/);
    assert.match(MIGRATION, /create trigger payment_structures_sanctioned/);
    assert.match(MIGRATION, /create trigger payment_milestones_sanctioned/);
  });

  test('and both tables carry the tenancy pair every org-scoped table here carries', () => {
    assert.match(MIGRATION, /create trigger freeze_org_payment_structures/);
    assert.match(MIGRATION, /create trigger freeze_org_payment_milestones/);
    assert.match(MIGRATION, /core\.enforce_parent_org\('structure_id', 'sales\.payment_structures'\)/);
  });

  test('withdrawing deactivates rather than deletes', () => {
    assert.match(MIGRATION, /update sales\.payment_structures set active = false/);
  });
});
