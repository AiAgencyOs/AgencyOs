import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LADDER_CAPTION, describeLadder, ladderRungs } from '../src/modules/finance/ladder.ts';
import { cumulativeLadder } from '../src/modules/projects/payment-structure.ts';

/**
 * The ladder is visible — Finance §7, §12; G-268.
 *
 * The same rule has now been half-checked twice. G-251 wrote `phaseSevenGate`
 * as a pure function and **nothing computed the number it takes**. G-264
 * computed the number — and its own caller, `readPaymentProgress`, was then
 * read by nothing. A rule stated, derived, and never shown to the person it is
 * about is a rule the product does not have.
 *
 * What is asserted here is mostly the distinction the surface exists to keep:
 * **unreadable, unmeasurable and measured-at-zero are three different facts**
 * that a careless page renders identically as *0%*.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const LADDER = read('src/modules/finance/ladder.ts');
/** Code only. The doc comments cite 30/20/30/20 to say it is NOT restated. */
const CODE = LADDER.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');
const QUERIES = read('src/modules/finance/queries.ts');
const SERVICE = read('src/modules/finance/service.ts');

const measured = (verifiedPercent: number, verifiedMilestones = 1, milestones = 4) => ({
  verifiedPercent,
  measurable: true,
  milestones,
  verifiedMilestones,
  gate: { open: verifiedPercent >= 100, shortfallPercent: Math.max(0, 100 - verifiedPercent) },
});

describe('A. three states a page would otherwise print as 0%', () => {
  test('unmeasurable says there is no percentage, rather than printing one', () => {
    const { money, gate } = describeLadder({
      verifiedPercent: null,
      measurable: false,
      milestones: 0,
      verifiedMilestones: 0,
      gate: { open: false, shortfallPercent: 100 },
    });
    assert.match(money, /no percentage to verify against/);
    // Not "0% verified". The sentence may still say "adds to 100%" — what it
    // must not do is print a computed figure.
    assert.doesNotMatch(money, /\d+% of the payment plan is verified/);
    assert.match(gate, /stays shut until a payment plan exists/);
  });

  test('measured at zero is a real number about a real plan', () => {
    const { money, gate } = describeLadder(measured(0, 0));
    assert.match(money, /^0% of the payment plan is verified/);
    assert.match(gate, /100% is still to be verified/);
  });

  test('and unreadable is neither — the read refuses instead of answering', () => {
    // G-054: a Server Component cannot act on a failure, so the reader throws
    // and `error.tsx` takes it. What it must never do is come back as 0%.
    assert.match(QUERIES, /if \(error\) unreadable\('readPaymentLadder', error\)/);
    // The describer is never even asked: it takes a progress, not a Result.
    assert.doesNotMatch(CODE, /Could not read|'INTERNAL'|\bok\(/);
    assert.match(
      PAGE.replace(/\n\s*\*\s?/g, ' '),
      /an unreadable project and a project whose client has paid nothing are different facts/,
    );
  });
});

describe('B. the ladder is derived, not restated', () => {
  test('the rungs are cumulativeLadder’s', () => {
    assert.deepEqual(
      ladderRungs(measured(0, 0)).map((r) => r.cumulative),
      cumulativeLadder().map((r) => r.cumulative),
    );
    // 30/20/30/20 is ADM-105's and locked. Neither file writes the ladder down.
    assert.doesNotMatch(CODE, /\b30\b|\b50\b|\b80\b/);
    assert.doesNotMatch(PAGE.slice(PAGE.indexOf('ladderRungs')), /\b30%|\b50%|\b80%/);
  });

  test('cleared means verified, and stops where the money stops', () => {
    assert.deepEqual(
      ladderRungs(measured(50, 2)).map((r) => r.cleared),
      [true, true, false, false],
    );
  });

  test('an unmeasurable project clears nothing — and still shows the ladder', () => {
    const rungs = ladderRungs({
      verifiedPercent: null,
      measurable: false,
      milestones: 0,
      verifiedMilestones: 0,
      gate: { open: false, shortfallPercent: 100 },
    });
    assert.equal(rungs.length, 4);
    assert.deepEqual(rungs.map((r) => r.cleared), [false, false, false, false]);
    // Asserted as behaviour, and it took two goes to get an assertion that
    // could fail. The first draft leaned on a -1 sentinel; a red-proof
    // swapping it to 0 changed nothing, because the locked ladder has no 0%
    // rung. Then the explicit branch was no better tested, because
    // `readPaymentProgress` always sends `verifiedPercent: null` when the
    // plan is unmeasurable, and null coerces to the same 0.
    //
    // THIS is the case only the branch answers: a percentage arriving
    // alongside `measurable: false`. That pairing is not produced today, and
    // the branch is what stops a future caller's stale or defaulted figure
    // clearing every rung of a plan that does not add up.
    assert.deepEqual(
      ladderRungs({
        verifiedPercent: 100,
        measurable: false,
        milestones: 0,
        verifiedMilestones: 0,
        gate: { open: false, shortfallPercent: 100 },
      }).map((r) => r.cleared),
      [false, false, false, false],
    );
    // And the invariant it is defending is asserted where it is produced —
    // one shaper, so there is exactly one place this could stop being true.
    assert.match(LADDER, /const verifiedPercent = measurable \? Number\(row\.verified_percent \?\? 0\) : null;/);
    assert.match(LADDER.replace(/\n\s*\*\s?/g, ' '), /showing nothing would read as "this project has no payment plan at all"/);
  });
});

describe('C. the gate is reported, never decided', () => {
  test('the describer trusts the gate it is handed', () => {
    // `phaseSevenGate` owns "100% or it stays shut". A second copy in wording
    // is a second thing to keep honest, and this one would be the copy people
    // actually read.
    assert.doesNotMatch(CODE, /100 - |>= 100|Math\.max/);
    assert.match(describeLadder(measured(100, 4)).gate, /Fully verified/);
    assert.match(describeLadder(measured(99, 3)).gate, /1% is still to be verified/);
  });

  test('"may open", not "is open" — nothing here unlocks anything', () => {
    // Phases 4–6 do not exist in this deployment. A page saying the phase
    // opened would describe a step nobody took.
    assert.match(describeLadder(measured(100, 4)).gate, /may open/);
    assert.doesNotMatch(describeLadder(measured(100, 4)).gate, /is open|has opened|unlocked/);
    assert.match(LADDER.replace(/\n\s*\/\/ ?/g, ' '), /because\s+Phases 4–6 do not exist yet/);
  });

  test('the shortfall is carried into the sentence, not just the truth value', () => {
    // The property that made `phaseSevenGate` worth calling in the first
    // place: a refusal that names what is owed.
    assert.match(describeLadder(measured(80, 3)).gate, /20% is still to be verified/);
  });
});

describe('D. what verified costs is said where the number is read', () => {
  test('both surprises are named', () => {
    assert.match(LADDER_CAPTION, /an Admin confirmed the payment against the bank/);
    assert.match(LADDER_CAPTION, /a refund takes the percentage back down/);
  });

  test('and it is rendered, not merely exported', () => {
    // An exported constant nobody renders is the exact defect this unit
    // exists to close, one layer down.
    assert.match(PAGE, /\{LADDER_CAPTION\}/);
  });
});

describe('E. the surface itself', () => {
  test('the money figure is behind invoice.read, like every other one here', () => {
    assert.match(PAGE, /can\(context\.role, 'invoice\.read'\) \? await readPaymentLadder\(projectId\) : null/);
  });

  test('the gate finally reaches a page — through queries.ts, per §3.2', () => {
    // The RULE, not the import list. G-269 legitimately added a third reader
    // to the same line, and pinning the exact spelling made a correct change
    // look like a regression.
    assert.match(PAGE, /import \{[^}]*\breadPaymentLadder\b[^}]*\} from '@\/modules\/finance\/queries'/);
    // And not around the boundary: a page calling service.ts directly is what
    // the lint rule refuses, and the first draft of this unit did it.
    assert.doesNotMatch(PAGE, /@\/modules\/[a-z]+\/service/);
  });

  test('the shaping is done ONCE, by both doors', () => {
    // The service answers a Result for callers that can act on a failure; the
    // query refuses for a Server Component that cannot. Neither re-derives
    // the gate — two copies of "what an unmeasurable plan means" is how two
    // doors onto one row start to disagree.
    assert.match(SERVICE, /return ok\(toLadderProgress\(row\)\)/);
    assert.match(QUERIES, /return toLadderProgress\(/);
    assert.doesNotMatch(SERVICE, /phaseSevenGate\(/);
    assert.doesNotMatch(QUERIES, /phaseSevenGate\(/);
    assert.equal((LADDER.match(/phaseSevenGate\(/g) ?? []).length, 2);
  });

  test('the describer computes and the module decides nothing else', () => {
    assert.doesNotMatch(CODE, /supabase|createClient|rpc\(|insert|update/i);
  });
});
