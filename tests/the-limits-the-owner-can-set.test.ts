import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * The limits the owner can set — G-195 (Doc §21, Doc 07 §6).
 *
 * ── what was already right, and what was missing ──────────────────────────
 *
 * §21 lists nine negotiation limits and ends: *"All limits are configurable
 * in the Admin Approval & Policy Engine."* Migration 156 recorded the honest
 * state — **none is configured** — and refused to invent one, on the grounds
 * that a maximum discount this repository chose would be this repository
 * writing the agency's commercial policy.
 *
 * That was right about the NUMBERS and silent about the MECHANISM. §21 asks
 * for configurability, and an owner who wanted a round cap had nowhere to put
 * one. The absence of the number and the absence of the door are not the same
 * absence.
 *
 * ── four, not nine, and the four are the ones with somewhere to bite ───────
 *
 * A limit is only real where something would otherwise act without it. Each
 * of these bounds an act the system takes ON ITS OWN; the rest of §21's list
 * — minimum advance, maximum deferral, maximum free scope — has nothing
 * autonomous to bind yet, and a column for a rule nothing consults is the
 * shape G-130 and G-133 both record.
 *
 * ── and none of them can refuse a person ──────────────────────────────────
 *
 * ADM-07 puts the decision with a human. A limit that could refuse an owner's
 * own approval would be this system overruling the person it exists to serve.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904120000_the_limits_the_owner_can_set.sql'));
// The prose, deliberately unstripped: what a migration says it did NOT build
// lives in its comments, and `sqlCode` removes exactly those.
const MIGRATION_PROSE = read('supabase/migrations/20260904120000_the_limits_the_owner_can_set.sql');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

describe('A. the door — four keys, on the whitelist the database owns', () => {
  test('all four are whitelisted, and nothing else was added with them', () => {
    for (const key of [
      'negotiation_max_rounds',
      'negotiation_min_price_rupees',
      'negotiation_max_discount_pct',
      'negotiation_max_autonomous_quote_rupees',
    ]) {
      assert.ok(MIGRATION.includes(`'${key}'`), `${key} is not on the whitelist`);
    }
  });

  test('each is a bounded whole number — a separator or a slipped decimal must not pass', () => {
    // The pricing rates learned this the expensive way: "8,000" parses to 8.
    assert.match(MIGRATION, /negotiation_max_rounds' then[\s\S]{0,200}?'\^\[0-9\]\{1,2\}\$'[\s\S]{0,120}?< 1 or [^\n]*> 20/);
    assert.match(MIGRATION, /negotiation_min_price_rupees' then[\s\S]{0,200}?'\^\[0-9\]\{1,8\}\$'/);
    assert.match(MIGRATION, /negotiation_max_autonomous_quote_rupees' then[\s\S]{0,200}?'\^\[0-9\]\{1,9\}\$'/);
  });

  test('the discount cap can never be set above what the offers table itself allows', () => {
    // A configured cap of 80 would read as permission the DDL then refuses,
    // and a limit that cannot be reached is one nobody can rely on.
    assert.match(MIGRATION, /negotiation_max_discount_pct' then[\s\S]{0,200}?< 1 or [^\n]*> 50/);
  });

  test('and the type in the application agrees with the database’s own list', () => {
    const settings = codeOnly(read('src/lib/admin/settings.ts'));
    for (const key of [
      'negotiation_max_rounds',
      'negotiation_min_price_rupees',
      'negotiation_max_discount_pct',
      'negotiation_max_autonomous_quote_rupees',
    ]) {
      assert.ok(settings.includes(`'${key}'`), `${key} is not offered by the product`);
      assert.ok(settings.includes(`${key}:`), `${key} has no hint for the person typing it`);
    }
  });
});

describe('B. the discount cap refuses rather than trims', () => {
  test('above the owner’s configured cap is an outcome, not a smaller number', () => {
    // Silently writing 10 when somebody asked for 25 would be the system
    // deciding a concession on their behalf, and the whole point of the row
    // is whose decision it carries.
    assert.match(MIGRATION, /if v_cap is not null and p_discount_pct > v_cap then/);
    assert.match(MIGRATION, /return query select 'above_configured_cap'::text, null::uuid;/);
  });

  test('and unset is no bound at all', () => {
    assert.match(MIGRATION, /nullif\(o\.settings->>'negotiation_max_discount_pct', ''\)::numeric into v_cap/);
  });
});

describe('C. the two money limits, beside the cost floor and not instead of it', () => {
  test('all three refusals exist and are named separately', () => {
    // Three different sentences about one number, and any of them can be the
    // binding one: what it cost to build, what the agency will take, and what
    // may leave the building unwatched.
    assert.match(MIGRATION, /return query select 'below_floor'::text/);
    assert.match(MIGRATION, /return query select 'below_minimum_price'::text/);
    assert.match(MIGRATION, /return query select 'above_autonomous_ceiling'::text/);
  });

  test('the agency’s two are read from CURRENT settings, not from the frozen document', () => {
    // The cost floor belongs to the quotation — it is what the decider had in
    // front of them. These belong to the agency, and it is the agency's
    // present policy that binds an act happening now with nobody watching.
    assert.match(MIGRATION, /into v_min_price, v_autonomous_cap[\s\S]{0,120}?from core\.organizations o/);
    assert.match(MIGRATION, /v_floor := \(\(v_row\.document->'productionCost'->>'minimumRupees'\)/);
  });

  test('each refusal returns before anything is written', () => {
    assert.match(MIGRATION, /if v_min_price is not null and v_total < v_min_price then\s+return query[^\n]+\n\s+return;/);
    assert.match(MIGRATION, /if v_autonomous_cap is not null and v_total > v_autonomous_cap then\s+return query[^\n]+\n\s+return;/);
  });

  test('and the applying function stays revoked from everyone but the service role', () => {
    // G-184's lesson, and re-emitting the function would have dropped it:
    // revoking from PUBLIC also revokes service_role, so the grant is
    // explicit and must ride along with every regeneration.
    assert.match(MIGRATION, /revoke execute on function sales\.apply_approved_offer\(uuid\) from public;/);
    assert.match(MIGRATION, /grant execute on function sales\.apply_approved_offer\(uuid\) to service_role;/);
  });
});

describe('D. the round cap is the loop control §20 asked for', () => {
  test('the objection’s round is read, and compared with the owner’s number', () => {
    assert.match(WORKFLOWS, /answered_by, round'/);
    assert.match(WORKFLOWS, /if \(roundCap\.value !== null && objection\.round > roundCap\.value\)/);
  });

  test('a limit that cannot be READ fails the job instead of lapsing', () => {
    // The opposite posture to budgetSignalFor two functions up, and
    // deliberately: a budget that cannot be read costs the drafter context,
    // while a limit that cannot be read costs the rule.
    assert.match(WORKFLOWS, /if \(!roundCap\.ok\) \{[\s\S]{0,400}?await failJob\(admin, job, `could not read the negotiation limits/);
  });

  test('an unset or unparseable limit is null — never zero, which would be the strictest limit by accident', () => {
    assert.match(WORKFLOWS, /if \(raw === undefined \|\| raw === null \|\| String\(raw\)\.trim\(\) === ''\) return \{ ok: true, value: null \}/);
    assert.match(WORKFLOWS, /if \(!Number\.isFinite\(parsed\) \|\| parsed <= 0\) return \{ ok: true, value: null \}/);
  });

  test('it stands down BEFORE the resume guard and the model call', () => {
    // A quotation the agency has decided not to redraft again should cost
    // nothing to not redraft.
    // Measured inside the REWORK handler's own region: `could not read newer
    // versions` is the resume guard's message in the reviser too, and the
    // first version of this check compared the cap against the OTHER
    // workflow's copy — a true comparison of two unrelated positions.
    const rework = WORKFLOWS.indexOf('the ask names no quotation to rework');
    assert.ok(rework > 0, 'the rework handler must be findable');
    const cap = WORKFLOWS.indexOf('const roundCap = await negotiationLimitFor', rework);
    const guard = WORKFLOWS.indexOf('could not read newer versions', rework);
    assert.ok(cap > 0 && guard > 0 && cap < guard, 'the cap must be checked before the resume guard');
  });

  test('and standing down HANDS THE THREAD OVER — the half G-110 paid for', () => {
    // A client waiting for a person who does not know they are waited for is
    // worse off than before the escalation existed.
    assert.match(WORKFLOWS, /const handed = await handToAPersonForLead\(/);
    assert.match(WORKFLOWS, /rpc\('hand_conversation_to_a_person'/);
    assert.match(WORKFLOWS, /needs a person/);
  });

  test('the handover reports whether it actually happened, rather than claiming it', () => {
    assert.match(WORKFLOWS, /handed \? '; handed to a person' : '; NO conversation to hand over'/);
  });

  test('and it finds the thread from the message first, the lead second', () => {
    assert.match(WORKFLOWS, /if \(messageId\) \{[\s\S]{0,400}?from\('conversation_messages'\)/);
    assert.match(WORKFLOWS, /if \(!conversationId\) \{[\s\S]{0,400}?\.eq\('kind', 'direct'\)/);
  });
});

describe('E. what was deliberately NOT built', () => {
  test('the migration names the limits it did not build, and why', () => {
    // Migration 156 refused to invent numbers and said so, which is why it
    // could be trusted about the state it reported. This one owes the same.
    assert.match(MIGRATION_PROSE, /minimum advance, maximum deferral, maximum free\n-- scope/);
    assert.match(MIGRATION_PROSE, /nowhere in this system to bind yet/);
  });

  test('and says plainly that none of the four can stop a person', () => {
    assert.match(MIGRATION_PROSE, /ADM-07 puts the decision with a human/);
    assert.match(MIGRATION_PROSE, /Every enforcement below sits on an autonomous path/);
  });
});
