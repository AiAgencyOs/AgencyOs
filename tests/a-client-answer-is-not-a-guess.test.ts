import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A client answer is not a guess — PM §4.5, §4.9, §12, §18; Master §17; G-283.
 *
 * PM §12 gives six classifications and no seventh. Two sentences shape the
 * whole unit, and both are about the same failure:
 *
 *   §4.5 *"Do not treat ambiguous feedback as final approval."*
 *   §4.9 *"Do not rely on an informal assumption that the client 'seems
 *        okay'."*
 *
 * So a final confirmation must name the exact theme **and** colour, and both
 * must be things that client was actually **shown** — checked against G-282's
 * frozen snapshot, not against the options as they stand now.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919140000_a_client_answer_is_not_a_guess.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const SHARES = read('supabase/migrations/20260919130000_only_what_admin_approved.sql');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.record_client_design_decision');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. six classifications, and no seventh', () => {
  test('exactly PM §12’s list', () => {
    for (const d of ['client_selected', 'design_change_request', 'client_reference',
                     'possible_scope_change', 'clarification_required', 'final_confirmed']) {
      assert.match(SQL, new RegExp(`'${d}'`), `§12's ${d} is missing`);
    }
    assert.match(SQL, /check \(decision in \(\s*\n\s*'client_selected',/);
    assert.match(door, /'bad_decision'::text/);
  });

  test('`clarification_required` exists so an unclear reply is not an approval', () => {
    // §4.5. Without it a PM facing "looks good but can we talk" has to choose
    // between two wrong answers.
    assert.match(PROSE, /has to choose between two wrong answers/);
  });
});

describe('B. the client’s own words, on every classification', () => {
  test('client_words is NOT NULL and refused when blank', () => {
    assert.match(SQL, /client_words\s+text not null check \(length\(btrim\(client_words\)\) between 1 and 4000\)/);
    assert.match(door, /'no_client_words'::text/);
  });

  test('and the reason is the assertion it prevents', () => {
    assert.match(PROSE, /an interpretation this system cannot show the source of is this system's opinion about a client/);
  });

  test('refused on the ARGUMENT, before the share is even read', () => {
    assert.ok(door.indexOf("'no_client_words'") < door.indexOf('from projects.client_design_shares'));
  });

  test('a decision can never be edited afterwards', () => {
    // A client said what they said. The raise must be the FIRST statement, not
    // merely present — asserting the message is asserting the sentence beside
    // the guard.
    assert.match(SQL, /as \$\$\s*\nbegin\s*\n\s*raise exception 'a client decision is a record of what the client said; record a new one instead'/);
    assert.match(SQL, /create trigger freeze_client_design_decision\s*\n\s*before update on projects\.client_design_decisions/);
  });
});

describe('C. the rule PM §4.9 is asking for', () => {
  test('a client can only choose from what they were SHOWN', () => {
    // Checked against the frozen snapshot, not the live options: one revised
    // since the share is not the thing the client saw.
    assert.match(door, /from jsonb_array_elements\(v_share\.shared_options\) o/);
    // The CONDITION, not the return value. A red-proof replacing
    // `if not v_shown` with `if false` left the return statement in place —
    // unreachable, and this test green. A refusal assertion must name the
    // branch that reaches it.
    assert.match(door, /if not v_shown then\s*\n\s*return query select 'not_shown'::text/);
    assert.match(PROSE, /accepting it here would record a confirmation of something else/);
  });

  test('and the snapshot it checks against is still frozen', () => {
    // The positive twin: if the share stopped being a snapshot, this check
    // would silently start reading live options.
    assert.match(SHARES, /shared_options\s+jsonb not null/);
    assert.match(SHARES, /a client design share is a record of what was sent; it cannot be edited/);
  });

  test('a final confirmation must name BOTH, at the row and at the door', () => {
    assert.match(SQL, /constraint client_decisions_final_names_both\s*\n\s*check \(decision <> 'final_confirmed'\s*\n\s*or \(selected_theme_option_id is not null and selected_color_option_id is not null\)\)/);
    assert.match(door, /'needs_both'::text/);
    assert.match(PROSE, /A confirmation that cannot point at what was confirmed is the informal assumption\s+§4\.9 forbids/);
  });

  test('a selection names at least the direction', () => {
    assert.match(SQL, /constraint client_decisions_selection_names_a_theme\s*\n\s*check \(decision <> 'client_selected' or selected_theme_option_id is not null\)/);
    assert.match(door, /'needs_selection'::text/);
  });

  test('a palette from another direction is not an answer to this one', () => {
    // §12: a colour belongs to a theme.
    assert.match(door, /and c\.theme_option_id = p_theme_option_id/);
    assert.match(door, /'color_not_of_theme'::text/);
  });

  test('a reference must actually contain something', () => {
    assert.match(SQL, /constraint client_decisions_reference_has_content/);
    assert.match(door, /'needs_reference'::text/);
  });
});

describe('D. scope is routed, never designed', () => {
  test('a possible scope change STOPS the phase', () => {
    // Master §17 and PM §18: new functionality is not automatically a design
    // revision.
    assert.match(door, /when 'possible_scope_change'\s+then 'scope_escalation'/);
  });

  test('and it records why, in the client’s words', () => {
    // G-277 made `scope_escalation` unenterable without a reason. This is
    // where that pays: the blocker a person reads is what the client asked for.
    assert.match(door, /The client asked for something that may be new scope: ' \|\| v_words/);
  });

  test('nothing creates a change request automatically', () => {
    // §17 says route to the workflow; routing means a person decides, with the
    // client's words in front of them.
    assert.doesNotMatch(door, /insert into projects\.change_requests/);
    assert.match(PROSE, /routing means a person decides, with the client's words in front of them/);
  });
});

describe('E. it records; it does not revise and it does not lock', () => {
  test('no theme version is created here', () => {
    assert.doesNotMatch(door, /insert into projects\.theme_options/);
    assert.match(PROSE, /\*\*It does not revise anything\.\*\*/);
  });

  test('an option reaches `selected`, never `locked`', () => {
    assert.match(door, /set client_status = 'selected'/);
    assert.doesNotMatch(door, /client_status = 'locked'/);
    assert.match(PROSE, /\*\*It does not lock\.\*\*/);
  });

  test('and the row rule that guards locking is still G-279’s', () => {
    // The positive twin: `locked` requires Admin approval at the row, so even
    // a future caller cannot lock something that never passed the gate.
    assert.match(
      read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql'),
      /check \(client_status <> 'locked' or admin_status = 'approved'\)/,
    );
  });

  test('a change request marks the option, not a new version', () => {
    assert.match(door, /set client_status = 'change_requested'/);
    assert.match(door, /and client_status = 'shared'/);
  });

  test('every classification emits the event §15 names for it', () => {
    for (const e of ['client_design_selected', 'client_final_design_confirmed',
                     'client_design_change_requested', 'client_reference_received',
                     'possible_scope_change_detected']) {
      assert.match(SQL, new RegExp(`'project\\.${e}'`), `${e} is not declared`);
    }
  });
});

describe('F. the guards this table and door carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    for (const col of ['project_id', 'phase_three_id', 'share_id',
                       'selected_theme_option_id', 'selected_color_option_id', 'conversation_id']) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${col}'`), `${col} has no guard`);
    }
  });

  test('and organization_id is frozen by its own named trigger', () => {
    // CI caught this exact omission on G-282; the local check now covers both
    // halves of what the verifier tests, and it was run before pushing.
    assert.match(SQL, /create trigger freeze_org_client_design_decisions\s*\n\s*before update of organization_id/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.client_design_decisions enable row level security/);
    assert.match(SQL, /alter table projects\.client_design_decisions force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and does not fail open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.can_write\(\)\)/);
  });

  test('it locks the phase, audits, announces, and is not callable by the world', () => {
    assert.match(door, /for update/);
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /revoke all on function projects\.record_client_design_decision\([^)]*\) from public, anon/);
  });
});
