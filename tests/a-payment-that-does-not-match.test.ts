import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A payment that does not match — Finance §4.7, §6, §12, §16, FIN-I05.
 *
 * Four locked places name **MISMATCH** as a decision an Admin may take, and
 * `verify_payment_submission` took a **boolean**. That is a shape rather than
 * a missing branch: a boolean cannot express three decisions, so the third
 * could not be recorded no matter what anybody typed.
 *
 * What separates MISMATCH from REJECT is not severity but **finality** — §6's
 * own words are *"requires resolution"* — and that is the assertion most of
 * this file is about, because it is the one a regression would quietly undo.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260918130000_a_payment_that_does_not_match.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const ORIGIN = read('supabase/migrations/20260821250000_a_payment_is_claimed_then_verified.sql');
const EVENTS = read('supabase/migrations/20260821270000_the_events_the_documents_name.sql');

const fn = (source: string, name: string) => {
  const start = source.indexOf(`create or replace function finance.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return source.slice(start, source.indexOf('$$;', start));
};
const door = fn(SQL, 'verify_payment_submission');
const guard = fn(SQL, 'payment_submissions_guard');
const emitter = fn(SQL, 'emit_payment_submission_event');

describe('A. a mismatch is unresolved, a rejection is finished', () => {
  test('the door lets a mismatched claim be decided again', () => {
    assert.match(door, /if v_row\.status not in \('pending_verification', 'mismatch'\) then/);
    assert.match(door, /'settled'::text, v_row\.status/);
  });

  test('AND the row guard agrees — the rule is held by two layers', () => {
    // Found by DRIVING it. The door's own check was changed and the UPDATE
    // would still have been refused, because a trigger holds the same rule
    // independently and knew nothing about the new status.
    assert.match(guard, /if old\.status not in \('pending_verification', 'mismatch'\)\s*\n\s*and new\.status is distinct from old\.status then/);
    assert.match(PROSE, /\*\*Found by driving it, not by reading it\.\*\*/);
    assert.match(PROSE, /the shape this repository calls half a check/);
  });

  test('verified and rejected are still final, in both layers', () => {
    for (const layer of [door, guard]) {
      assert.doesNotMatch(layer, /'verified', 'rejected'/);
    }
    // The original refused everything non-pending; the carry-forward widened
    // it by exactly one value and nothing else.
    const before = fn(ORIGIN, 'payment_submissions_guard');
    assert.match(before, /if old\.status <> 'pending_verification'/);
  });

  test('and the difference is stated as finality, not severity', () => {
    assert.match(PROSE, /Not severity\. \*\*Finality\.\*\*/);
    assert.match(PROSE, /requires resolution/);
  });
});

describe('B. a mismatch is not a verification', () => {
  test('no verifier and no moment are stamped on it', () => {
    const branch = door.slice(door.indexOf("if v_decision = 'mismatch'"), door.indexOf("'mismatch'::text, 'mismatch'::text"));
    assert.match(branch, /set status = 'mismatch',\s*\n\s*mismatch_note = p_reason,\s*\n\s*updated_at = now\(\)/);
    assert.doesNotMatch(branch, /verified_by|verified_at/);
    assert.match(PROSE, /would make the\s+queue of unchecked claims look shorter than it is/);
  });

  test('it says what did not line up, or it is refused', () => {
    assert.match(door, /'no_note'::text, v_row\.status/);
    assert.match(SQL, /check \(status <> 'mismatch'\s*\n\s*or \(mismatch_note is not null and length\(trim\(mismatch_note\)\) > 0\)\)/);
    assert.match(PROSE, /A mismatch nobody described is a claim parked forever/);
  });

  test('the note is its own column, not shared with the rejection reason', () => {
    // Two different endings. One column holding both makes "was this
    // rejected?" unanswerable.
    assert.match(SQL, /add column if not exists mismatch_note text/);
    assert.match(door, /mismatch_note = p_reason/);
    assert.match(door, /rejected_reason = p_reason/);
  });
});

describe('C. nothing here opens a gate, and that is structural', () => {
  test('the migration writes no money and touches no ledger', () => {
    // The executable bodies, not the file: the function COMMENT names
    // `net_verified_minor` and `finance.payments` in the sentence explaining
    // WHY nothing here can open a gate, and a check that read that as a write
    // would forbid the explanation.
    const bodies = [door, guard, emitter].join('\n');
    assert.doesNotMatch(bodies, /insert into finance\.payments|update finance\.(payments|invoices)/);
    assert.doesNotMatch(bodies, /paid_minor|verified_minor|net_verified/);
  });

  test('and §16’s "gate remains closed" is enforced by absence, not by a check', () => {
    assert.match(PROSE, /\*\*no line in this migration enforces\s+it\*\*, deliberately/);
    assert.match(PROSE, /a stronger guarantee than a check\s+somebody has to remember to write/);
  });

  test('an unknown decision is refused on the argument, before the row', () => {
    assert.ok(door.indexOf("'unknown_decision'") < door.indexOf('for update'));
    assert.match(door, /if v_decision not in \('confirm', 'reject', 'mismatch'\) then/);
  });
});

describe('D. the signature does not break what is already deployed', () => {
  test('`p_approve` is kept and `p_decision` added beside it', () => {
    // This repository pushes migrations from a branch before the matching code
    // merges. Replacing the boolean would refuse every verification on
    // production the moment it applied — G-261's regression, exactly.
    assert.match(SQL, /p_approve\s+boolean default true,/);
    assert.match(SQL, /p_decision\s+text default null/);
    assert.match(door, /case when p_approve then 'confirm' else 'reject' end/);
    assert.match(PROSE, /the exact regression G-261 caused/);
  });

  test('the old signature is DROPPED, because a default makes an overload', () => {
    // G-260: `create or replace` with a new defaulted parameter leaves two
    // live functions, and two live definitions of a money function is one too
    // many. Proven on the scratch database by counting pg_proc.
    assert.match(SQL, /drop function if exists finance\.verify_payment_submission\(uuid, uuid, text, boolean, text\);/);
    assert.ok(
      SQL.indexOf('drop function if exists finance.verify_payment_submission') <
        SQL.indexOf('create or replace function finance.verify_payment_submission'),
    );
    assert.match(PROSE, /a defaulted parameter creates an OVERLOAD and not a replacement/);
  });

  test('the grant is restored on the new signature', () => {
    // A drop takes the grant with it, and a door nobody may call does not
    // exist (G-265 learned this the same way).
    assert.match(SQL, /revoke all on function finance\.verify_payment_submission\(uuid, uuid, text, boolean, text, text\) from public, anon/);
    assert.match(SQL, /grant execute on function finance\.verify_payment_submission\(uuid, uuid, text, boolean, text, text\)\s*\n\s*to authenticated, service_role/);
  });

  test('every line of the previous definition survives except the marked edits', () => {
    const before = fn(ORIGIN, 'verify_payment_submission');
    const carried = door.split('\n').map((l) => l.trim());
    const missing = before
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'))
      // Edit 4: the `settled` predicate. Edit 3: `if p_approve then` became a
      // resolved decision. Excluded by SHAPE, so a semantic change hiding
      // among the rest still fails.
      .filter((l) => !l.startsWith("if v_row.status <> 'pending_verification'"))
      .filter((l) => l !== 'if p_approve then')
      // Edit 1 appended a parameter, so the line before it gained a comma.
      // Mechanical, and excluded by SHAPE rather than by name.
      .filter((l) => !carried.includes(l) && !carried.includes(`${l},`));
    assert.deepEqual(missing, [], 'lines dropped in the carry-forward');
  });
});

describe('E. FIN-I05 — verified/rejected/mismatch events', () => {
  test('the emitter announced ONE of the three, and a rejection was already silent', () => {
    const before = fn(EVENTS, 'emit_payment_submission_event');
    assert.doesNotMatch(before, /payment\.rejected|payment\.mismatched/);
    assert.match(PROSE, /\*\*a rejection was already silent\*\* before MISMATCH existed/);
  });

  test('both halves are added together', () => {
    assert.match(emitter, /new\.status = 'rejected' and old\.status is distinct from 'rejected'/);
    assert.match(emitter, /new\.status = 'mismatch' and old\.status is distinct from 'mismatch'/);
    assert.match(SQL, /'payment\.rejected'/);
    assert.match(SQL, /'payment\.mismatched'/);
  });

  test('and the existing two are carried forward unchanged', () => {
    assert.match(emitter, /'payment\.submitted', 'payment_submission', new\.id/);
    assert.match(emitter, /'payment\.verified', 'payment_submission', new\.id/);
  });

  test('the mismatch event carries the note, so a reader need not re-query', () => {
    assert.match(emitter, /'note', new\.mismatch_note/);
  });

  test('neither new event claims a subscriber it does not have', () => {
    assert.match(SQL, /Nothing subscribes yet/);
    assert.doesNotMatch(read('src/lib/events/dispatch.ts'), /payment\.mismatched|payment\.rejected/);
  });
});

describe('F. what this does NOT fix, said plainly', () => {
  test('the whole claim layer still has no caller, on either side', () => {
    // Doc 15 §11 and §12: nothing inserts a payment_submission and nothing
    // calls verify_payment_submission. MISMATCH is a correct fix to a door in
    // a subsystem that is unreachable end to end — building only a verify
    // surface would show an always-empty list.
    //
    // Recorded rather than half-built, and asserted here so that the day a
    // caller appears, this test fails and the record gets corrected with it.
    const sources = ['src/modules/finance/service.ts', 'src/modules/finance/queries.ts', 'src/modules/finance/actions.ts'];
    for (const source of sources) {
      assert.doesNotMatch(read(source), /payment_submissions|verify_payment_submission/, `${source} now reaches the claim layer — update the record`);
    }
  });
});
