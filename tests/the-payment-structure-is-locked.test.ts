import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCKED_PAYMENT_STRUCTURE,
  cumulativeAfter,
  cumulativeLadder,
  lockedAmountsFor,
  phaseSevenGate,
  structureDiffersFromQuotation,
} from '../src/modules/projects/payment-structure.ts';
import { paymentScheduleFor } from '../src/modules/sales/quotation-standards.ts';

/**
 * The locked project payment structure — ADM-105, Phase 2 Finance §2.
 *
 * The owner settled a conflict this repository raised rather than resolved:
 * Phase 2 locks 30/20/30/20 while the quotation corpus derives 40/30/30 or
 * 30/30/25/15 and freezes it onto the quotation. What is asserted here is the
 * ANSWER, the arithmetic the Finance specification is most emphatic about, and
 * the difference that survives the answer.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/service.ts');
const HANDLERS = read('src/modules/projects/handlers.ts');
const INSTALL = SERVICE.slice(SERVICE.indexOf('Install the locked payment structure on a project'), SERVICE.indexOf('A milestone with its project context'));

describe('A. ADM-105’s answer, transcribed', () => {
  test('four milestones, 30 · 20 · 30 · 20, in order', () => {
    assert.deepEqual(LOCKED_PAYMENT_STRUCTURE.map((m) => [m.key, m.percent]), [
      ['M1', 30], ['M2', 20], ['M3', 30], ['M4', 20],
    ]);
    assert.deepEqual(LOCKED_PAYMENT_STRUCTURE.map((m) => m.position), [1, 2, 3, 4]);
    assert.equal(LOCKED_PAYMENT_STRUCTURE.reduce((sum, m) => sum + m.percent, 0), 100);
  });

  test('each is bound to the trigger Finance §2 gives it — none is optional', () => {
    assert.deepEqual(LOCKED_PAYMENT_STRUCTURE.map((m) => m.trigger), [
      'phase_2', 'phase_4_completed', 'phase_5_completed', 'phase_6_completed',
    ]);
  });

  test('the cumulative ladder is 30 → 50 → 80 → 100, derived and not written twice', () => {
    assert.deepEqual(cumulativeLadder(), [
      { key: 'M1', cumulative: 30 },
      { key: 'M2', cumulative: 50 },
      { key: 'M3', cumulative: 80 },
      { key: 'M4', cumulative: 100 },
    ]);
    assert.equal(cumulativeAfter('M1'), 30);
    assert.equal(cumulativeAfter('M4'), 100);
  });

  test('Phase 7 opens only at 100% verified, and says what is owed when it does not', () => {
    assert.deepEqual(phaseSevenGate(100), { open: true, shortfallPercent: 0 });
    assert.deepEqual(phaseSevenGate(80), { open: false, shortfallPercent: 20 });
    assert.deepEqual(phaseSevenGate(0), { open: false, shortfallPercent: 100 });
    // Over-payment does not become a negative shortfall.
    assert.deepEqual(phaseSevenGate(110), { open: true, shortfallPercent: 0 });
  });
});

describe('B. the money, to the paisa', () => {
  test('the rows always sum to the budget, including amounts no percentage divides', () => {
    for (const budget of [1_000_000, 5_000_000, 10_000_000, 17_500_000, 1, 7, 333_333, 99_999]) {
      const rows = lockedAmountsFor(budget);
      assert.equal(rows.length, 4);
      assert.equal(rows.reduce((a, b) => a + b, 0), budget, `₹${budget} does not sum`);
    }
  });

  test('₹1,00,000 splits 30/20/30/20 exactly', () => {
    assert.deepEqual(lockedAmountsFor(10_000_000), [3_000_000, 2_000_000, 3_000_000, 2_000_000]);
  });

  test('the last row absorbs the remainder, which is Part L’s rule and not a second one', () => {
    // 7 paise: 2 + 1 + 2 + the rest.
    const rows = lockedAmountsFor(7);
    assert.equal(rows.reduce((a, b) => a + b, 0), 7);
    assert.equal(rows[3], 7 - rows[0]! - rows[1]! - rows[2]!);
  });
});

describe('C. the difference the answer did not make disappear', () => {
  test('a quotation whose corpus family differs is NAMED, not silently overridden', () => {
    // Below ₹1,00,000 the corpus family is 40/30/30 — a client read that.
    const family = paymentScheduleFor(5_000_000);
    const diff = structureDiffersFromQuotation(family.rows.map((r) => r.pct));
    assert.ok(diff);
    assert.equal(diff!.differs, true, 'the client read one shape and is billed another');
    assert.deepEqual(diff!.locked, [30, 20, 30, 20]);
  });

  test('a quotation carrying no schedule is not a difference', () => {
    assert.equal(structureDiffersFromQuotation(null), null);
    assert.equal(structureDiffersFromQuotation([]), null);
  });

  test('a matching schedule reports no difference', () => {
    const diff = structureDiffersFromQuotation([30, 20, 30, 20]);
    assert.ok(diff && diff.differs === false);
  });
});

describe('D. installing it never overwrites a person’s judgement', () => {
  test('an existing plan is left alone, by name', () => {
    assert.match(INSTALL, /if \(\(existing\?\.length \?\? 0\) > 0\) \{[\s\S]{0,200}installed: false/);
    assert.match(INSTALL, /a payment plan already exists and was left alone/);
    assert.match(INSTALL, /It never replaces a plan somebody configured/);
  });

  test('a project with no budget gets no plan of zeroes', () => {
    assert.match(INSTALL, /!project\.budget_minor \|\| project\.budget_minor <= 0/);
    assert.match(INSTALL, /would look configured while billing nobody/);
  });

  test('it writes through the ONE insert path, with its guards', () => {
    // replace_payment_plan carries the deferred 100% trigger and refuses a
    // plan already met or already billed. A second writer would be a second
    // set of rules to keep honest.
    assert.match(INSTALL, /\.rpc\('replace_payment_plan'/);
    assert.doesNotMatch(INSTALL, /from\('milestones'\)[\s\S]{0,120}\.insert\(/);
  });

  test('a failed read is not an absent project', () => {
    assert.match(INSTALL, /if \(readError\) return err\('INTERNAL'/);
    assert.match(INSTALL, /if \(existingError\) return err\('INTERNAL'/);
  });

  test('the client is explicit, so nobody installs with the wrong authority by forgetting', () => {
    assert.match(INSTALL, /supabase: Awaited<ReturnType<typeof createClient>>/);
    assert.doesNotMatch(INSTALL, /const supabase = await createClient\(\)/);
  });
});

describe('E. it happens when Phase 2 starts, and cannot unstart it', () => {
  test('the phase-start handler installs it, outside the phase-start door', () => {
    assert.match(HANDLERS, /const structure = await installLockedPaymentStructure\(projectId, admin as never\)/);
    // Not inside `start_phase_two`: the payment plan has its own door with its
    // own guards, and a DEFINER phase-start reaching through them would borrow
    // an authority it was not granted.
    const migration = read('supabase/migrations/20260916130000_phase_two_begins_where_phase_one_ends.sql');
    assert.doesNotMatch(migration, /replace_payment_plan/);
    // The word appears in a comment about `met_at`; what must not appear is a
    // statement writing the table.
    assert.doesNotMatch(migration, /(insert into|update|delete from)\s+projects\.milestones/i);
  });

  test('a structure that could not be installed does not unstart the phase', () => {
    assert.match(HANDLERS, /Best-effort on purpose/);
    // The job still settles: both branches return `succeeded`.
    const branch = HANDLERS.slice(HANDLERS.indexOf("case 'started':"), HANDLERS.indexOf("case 'no_handoff':"));
    assert.match(branch, /status: 'succeeded'/);
    assert.doesNotMatch(branch, /status: 'failed'/);
  });

  test('and the detail says which happened, rather than going quiet', () => {
    assert.match(HANDLERS, /No payment structure was installed: \$\{structure\.data\.reason\}/);
    assert.match(HANDLERS, /The locked payment structure could not be installed/);
  });
});
