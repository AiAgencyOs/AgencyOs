import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A reactivation tick has a ceiling — G-223 (Phase 10 rate control).
 *
 * ── what G-216 bounds, and what it leaves open ─────────────────────────────
 *
 * G-216 bounds what the agency STARTS over a day — per contact, per
 * organization, and a fatigue cooldown — enforced in the send chokepoint
 * because a day is a fact any writer reads from the rows. None of it bounds
 * THROUGHPUT WITHIN ONE TICK: the day the pilot is switched on for a large
 * enrolled cohort, the first worker invocation that finds them due sends as
 * many as the batch and the daily limits allow, all at once. The daily limit
 * stops the SECOND message to a person; it does not smooth the FIRST across the
 * hundreds due together.
 *
 * ── one setting, enforced where only an invocation can count ────────────────
 *
 * `reactivation_max_per_run` is the most `inactive_lead` follow-ups a single
 * worker invocation will SEND for one organization. It lives in the worker, not
 * the database, because "per run" is a fact about an invocation and only the
 * invocation can count itself. Unset, there is no ceiling — never a limit of
 * zero, which would be a stopped campaign wearing a throttle's clothes.
 *
 * ── the door is carried forward, not appended to ───────────────────────────
 *
 * `core.set_organization_setting` cannot be ALTERed to extend a plpgsql
 * whitelist; it is regenerated verbatim from its latest definition with one
 * marked edit. Regenerating from an older copy is how a function silently
 * reverts (the lesson G-126 and D16 both paid for), and revoking from PUBLIC
 * also revokes service_role, so the grant must ride along.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260909120000_a_reactivation_tick_has_a_ceiling.sql'));
// The prose, deliberately unstripped: what the migration says it did NOT build
// — and WHY the ceiling lives in the worker — is in its comments, which
// `sqlCode` removes.
const MIGRATION_PROSE = read('supabase/migrations/20260909120000_a_reactivation_tick_has_a_ceiling.sql');
const WORKER = codeOnly(read('src/modules/crm/follow-up-worker.ts'));

describe('A. the door — one key, on the whitelist the database owns', () => {
  test('reactivation_max_per_run is whitelisted', () => {
    assert.ok(MIGRATION.includes(`'reactivation_max_per_run'`), 'the key is not on the whitelist');
  });

  test('it is a bounded whole number, 1–500 — a separator or a slipped decimal must not pass', () => {
    // The pricing rates learned this the expensive way: "1,000" parses to 1.
    // 500 is the enrolment batch ceiling (G-219): a throttle larger than any
    // single tick could reach is a throttle nobody set on purpose.
    assert.match(
      MIGRATION,
      /reactivation_max_per_run' then[\s\S]{0,200}?'\^\[0-9\]\{1,3\}\$'[\s\S]{0,120}?< 1 or [^\n]*> 500/,
    );
  });

  test('zero is not a value — clearing the setting is how the ceiling is removed', () => {
    // A stored 0 would read as "send nothing", which is a stopped campaign, not
    // a throttle. The floor is 1, and unsetting the key is the only way off.
    assert.match(MIGRATION, /reactivation_max_per_run' then[\s\S]{0,200}?< 1 /);
  });

  test('the whole function is carried forward — every other key still on the list', () => {
    // Regenerating from an older copy is how a function silently reverts. If
    // this migration dropped a key, the door it owns would quietly narrow.
    for (const key of [
      'whatsapp_phone_number_id',
      'quotation_contact_email',
      'pricing_day_rate_rupees',
      'project_group_identifier',
      'negotiation_max_rounds',
      'negotiation_max_autonomous_quote_rupees',
    ]) {
      assert.ok(MIGRATION.includes(`'${key}'`), `${key} was dropped in the regeneration`);
    }
  });

  test('and the grant rides along with the regeneration — revoking PUBLIC revokes service_role', () => {
    // G-184's lesson: re-emitting the function drops the grant unless it is
    // re-issued, and an owner-facing setting the admin client cannot write is
    // a door that looks open and is not.
    assert.match(MIGRATION, /revoke all on function core\.set_organization_setting\(uuid, text, text\) from public;/);
    assert.match(
      MIGRATION,
      /grant execute on function core\.set_organization_setting\(uuid, text, text\) to authenticated, service_role;/,
    );
  });

  test('the type in the application agrees with the database’s own list', () => {
    const settings = codeOnly(read('src/lib/admin/settings.ts'));
    assert.ok(settings.includes(`'reactivation_max_per_run'`), 'the key is not offered by the product');
    assert.ok(settings.includes('reactivation_max_per_run:'), 'the key has no hint for the person typing it');
  });
});

describe('B. the ceiling is the worker’s, and it applies to inactive_lead alone', () => {
  test('the cap is read once per organization and cached for the run', () => {
    assert.match(WORKER, /const reactivationCap = new Map<string, number \| null>\(\)/);
    assert.match(WORKER, /const reactivationSent = new Map<string, number>\(\)/);
    assert.match(WORKER, /if \(reactivationCap\.has\(organizationId\)\) return/);
  });

  test('an unset, unparseable, or zero cap is null — never a limit of zero', () => {
    // The same posture the negotiation round cap took: zero would be the
    // strictest limit by accident, so only a positive number becomes a ceiling.
    assert.match(WORKER, /String\(raw\)\.trim\(\) === '' \? null : Number\(raw\)/);
    assert.match(WORKER, /parsed !== null && Number\.isFinite\(parsed\) && parsed > 0 \? Math\.floor\(parsed\) : null/);
  });

  test('the block gates inactive_lead only, and only once a send is otherwise permitted', () => {
    // A sequence the worker would not send anyway must not be counted against
    // the ceiling. The gate names the situation and reads the running total.
    assert.match(
      WORKER,
      /if \(seq\.situation_key === 'inactive_lead'\) \{\s*const cap = await reactivationCapFor\(seq\.organization_id\);\s*if \(cap !== null && \(reactivationSent\.get\(seq\.organization_id\) \?\? 0\) >= cap\)/,
    );
  });

  test('a capped tick BLOCKS the overflow — no attempt consumed, tried again next tick', () => {
    // continue before the claim, the same shape as the timezone and consent
    // blocks: a throttled send spends nothing and drains next tick.
    assert.match(
      WORKER,
      /await noteBlock\(admin, seq\.sequence_id, 'reactivation_run_cap'\);\s*outcome\.blocked \+= 1;\s*continue;/,
    );
  });

  test('only a send that actually went out counts against the ceiling', () => {
    assert.match(
      WORKER,
      /if \(seq\.situation_key === 'inactive_lead'\) \{\s*reactivationSent\.set\(\s*seq\.organization_id,\s*\(reactivationSent\.get\(seq\.organization_id\) \?\? 0\) \+ 1,?\s*\);\s*\}/,
    );
  });

  test('the counter is incremented BEFORE recordSent, so the next sequence this tick sees the total', () => {
    // The send-path increment is the only reactivationSent.set — the gate above
    // only reads. It must land before the recordSent it guards, or a burst
    // within one tick would all clear a gate reading a stale zero.
    const inc = WORKER.indexOf('reactivationSent.set(');
    const record = WORKER.indexOf('await recordSent(', inc);
    assert.ok(inc > 0, 'the send-path increment exists');
    assert.ok(record > inc, 'the increment precedes the recordSent it guards');
  });

  test('the block gate stands BEFORE the claim, not after the send', () => {
    // The claim is the INSERT into follow_up_sends. A cap gate placed after it
    // would spend an attempt on the send it then throttles; placed before, the
    // overflow costs nothing and drains next tick.
    const gate = WORKER.indexOf('if (cap !== null && (reactivationSent.get');
    const claim = WORKER.indexOf("from('follow_up_sends').insert", gate);
    assert.ok(gate > 0, 'the cap gate exists');
    assert.ok(claim > gate, 'the cap gate precedes the claim INSERT');
  });
});

describe('C. what this is NOT, said plainly', () => {
  test('the migration explains why the ceiling lives in the worker, not the database', () => {
    assert.match(MIGRATION_PROSE, /only the\n-- invocation can count itself/);
  });

  test('and that it is not a second copy of G-216’s daily limits', () => {
    assert.match(MIGRATION_PROSE, /It is NOT a second copy of G-216/);
    assert.match(MIGRATION_PROSE, /the sequence is throttled, not\n-- stopped/);
  });
});
