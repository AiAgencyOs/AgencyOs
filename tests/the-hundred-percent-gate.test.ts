import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cumulativeLadder, phaseSevenGate } from '../src/modules/projects/payment-structure.ts';
import { region } from './_region.ts';

/**
 * The hundred percent gate — Finance §7, §12; ADM-105.
 *
 * G-251 wrote the gate as a pure function and **nothing ever computed the
 * number it takes**: `phaseSevenGate`'s only caller was its own test. That is
 * the shape this repository calls half a check — a rule stated, tested, and
 * unreachable. This closes it.
 *
 * The behaviour is proven where SQL runs: a project driven up Finance §12's
 * ladder, with the two cases that decide whether this is a gate or a
 * decoration — an unverified payment counting for nothing, and **a refund
 * closing it again**.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917200000_the_hundred_percent_gate.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const SERVICE = read('src/modules/finance/service.ts');
const PROGRESS = region(SERVICE, 'Where a project is on Finance §12', "Finance \u00a79");
/**
 * G-268 moved the SHAPING of this row into `finance/ladder.ts`, because a
 * second door onto it — the page's `readPaymentLadder` — needed the same rule
 * and two copies of "what an unmeasurable plan means" is how two doors start
 * to disagree. The rules below are unchanged; they are asserted where they now
 * live. Following a rule to its new home is the point of a test like this.
 */
const LADDER = read('src/modules/finance/ladder.ts');
const TOTALS = read('supabase/migrations/20260809120001_sales_pipeline_and_delivery.sql');

describe('A. the ladder it computes is ADM-105’s', () => {
  test('§12’s rungs are the cumulative ladder the payment structure already derives', () => {
    // 0 → 30 → 50 → 80 → 100. The spec draws it in prose; G-251 derives it.
    // Nothing here writes it down a third time.
    assert.deepEqual(
      cumulativeLadder().map((rung) => rung.cumulative),
      [30, 50, 80, 100],
    );
    assert.doesNotMatch(SQL, /\b30\b|\b50\b|\b80\b/);
  });

  test('and the gate rule is not restated in the migration', () => {
    // `phaseSevenGate` owns "100% or it stays shut". A second copy in SQL is a
    // second thing to keep honest.
    assert.doesNotMatch(SQL, /gate_open|phase_?7|shortfall/i);
    assert.match(PROSE, /G-251 wrote the gate as a pure function/);
  });
});

describe('B. verified means NET verified, and a refund closes the gate', () => {
  test('the count runs through net_verified_minor, not paid_minor', () => {
    assert.match(SQL, /finance\.net_verified_minor\(plan\.invoice_id\) >= plan\.total_minor/);
    assert.doesNotMatch(SQL, /paid_minor/);
  });

  test('and the migration says what that subtraction buys', () => {
    assert.match(PROSE, /\*\*a refund closes this gate\s+again\.\*\*/);
    assert.match(PROSE, /which is the difference between a\s+gate and a decoration/);
  });

  test('a voided invoice is not a live one — on BOTH lookups', () => {
    // The invoice id and its total are read in two subqueries, and a red-proof
    // removing the filter from only the first one left this green when it
    // asserted a single match. A voided invoice reaching either half is a
    // withdrawn bill counted as money.
    assert.equal((SQL.match(/i\.status <> 'void'/g) ?? []).length, 2);
  });

  test('the service says both consequences where its reader is', () => {
    assert.match(PROGRESS, /a payment captured but not yet verified by an Admin counts for nothing/);
    assert.match(PROGRESS, /\*\*a refund closes the gate again\*\*/);
  });
});

describe('C. an unmeasurable plan cannot open the gate', () => {
  test('unpriced milestones are EXCLUDED, not treated as unmeasurable', () => {
    // The first draft required every milestone to carry a percentage, which
    // would have shut the gate on an ordinary plan of four priced milestones
    // plus an unpriced retainer. `assert_payment_plan_totals` is the authority
    // on what a valid plan looks like, and it sums only the priced ones.
    assert.match(SQL, /and m\.payment_percent is not null/);
    assert.match(TOTALS, /and payment_percent is not null;/);
    assert.match(PROSE, /The first draft of this function got that wrong/);
  });

  test('no priced milestones at all is NULL, never 0', () => {
    assert.match(SQL, /case when count\(\*\) > 0 and coalesce\(sum\(payment_percent\), 0\) = 100/);
    assert.match(PROSE, /0% is a claim somebody acts on and "nobody has agreed a payment plan" is a\s+different fact/);
  });

  test('and the service forces the gate shut rather than passing 0 through', () => {
    assert.match(LADDER, /gate: measurable \? phaseSevenGate\(verifiedPercent!\) : \{ open: false, shortfallPercent: 100 \}/);
    assert.match(
      LADDER.replace(/\n\s*\*\s?/g, ' '),
      /the day somebody relaxes\s*that function an unmeasurable project would open the last phase on\s*arithmetic that does not exist/,
    );
  });

  test('a failed read is not a project at 0%', () => {
    assert.match(PROGRESS, /if \(error\) return err\('INTERNAL', 'Could not read the payment progress\.'\)/);
    assert.match(PROGRESS.replace(/\n\s*\/\/ ?/g, ' '), /The difference decides whether the last phase of somebody's project opens/);
  });
});

describe('D. the pure gate finally has a caller', () => {
  test('the service applies phaseSevenGate rather than re-deriving it', () => {
    assert.match(LADDER, /import \{ cumulativeLadder, phaseSevenGate \} from '@\/modules\/projects\/payment-structure'/);
    assert.match(LADDER, /phaseSevenGate\(verifiedPercent!\)/);
    // And the service reaches it through the shaper rather than around it.
    assert.match(SERVICE, /return ok\(toLadderProgress\(row\)\)/);
  });

  test('and the gate still says what is owed when it is shut', () => {
    // The property that made it worth calling: a refusal that names the
    // shortfall rather than a bare false.
    assert.deepEqual(phaseSevenGate(30), { open: false, shortfallPercent: 70 });
    assert.deepEqual(phaseSevenGate(100), { open: true, shortfallPercent: 0 });
  });

  test('the function is not callable by the world', () => {
    assert.match(SQL, /revoke all on function finance\.project_payment_progress\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function finance\.project_payment_progress\(uuid\) to authenticated, service_role/);
  });

  test('it reads and writes nothing', () => {
    // `stable` and `security invoker`: it sees what the caller may see, and
    // changes nothing.
    assert.match(SQL, /language sql\s*\n\s*stable\s*\n\s*security invoker/);
    assert.doesNotMatch(SQL, /insert into|update |delete from/i);
  });
});
