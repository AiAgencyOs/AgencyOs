import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The lock is what the client confirmed — Master §7.11, §7.12, §16, §19;
 * PM §4.10; Designer §4.9; G-285.
 *
 * G-283 emitted `project.client_final_design_confirmed` and nothing consumed
 * it. This is what does — and the unit is one signature decision with a lot of
 * validation behind it.
 *
 * Master §22 sketches `lockPhase3Direction(projectId, themeId, colorId,
 * figmaVersion)`. That is **not** the signature here: a door accepting a theme
 * id can lock something the client never confirmed, and §16's no-silent-
 * overwrite rule would be held by whoever computed the arguments.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919180000_the_lock_is_what_the_client_confirmed.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const DECISIONS = read('supabase/migrations/20260919140000_a_client_answer_is_not_a_guess.sql');
const OPTIONS = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.lock_phase_three_direction');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. it takes no argument about what to lock', () => {
  test('the phase is the only parameter', () => {
    // The whole unit. A theme id argument could carry a stale variable, a
    // retried job's last-round ids, or an agent's guess — and the rule would
    // be held by whoever computed it.
    assert.match(SQL, /create or replace function projects\.lock_phase_three_direction\(\s*\n\s*p_phase_three_id uuid\s*\n\)/);
    assert.doesNotMatch(door, /p_theme_option_id|p_color_option_id|p_figma/);
  });

  test('it reads the confirmation instead', () => {
    assert.match(door, /from projects\.client_design_decisions d\s*\n\s*where d\.phase_three_id = v_phase3\.id\s*\n\s*and d\.decision = 'final_confirmed'/);
    assert.match(door, /v_decision\.selected_theme_option_id/);
    assert.match(door, /v_decision\.selected_color_option_id/);
    assert.match(door, /'not_confirmed'::text/);
  });

  test('and every guarantee it inherits is still enforced on that row', () => {
    // The positive twin, and the reason this signature is safe: G-283 already
    // refuses a confirmation that does not name BOTH, and one naming anything
    // the client was not shown. None of that could be inherited by a door
    // taking the ids as arguments.
    assert.match(DECISIONS, /constraint client_decisions_final_names_both/);
    assert.match(DECISIONS, /'not_shown'::text/);
    assert.match(PROSE, /The rule would then be held by \*\*whoever computed the arguments\*\*/);
  });

  test('the newest confirmation is the one that counts', () => {
    assert.match(door, /order by d\.created_at desc\s*\n\s*limit 1;/);
  });
});

describe('B. §7.12’s validation, each with its own refusal', () => {
  test('a finalized screen baseline is required', () => {
    assert.match(door, /where b\.project_id = v_phase3\.project_id\s*\n\s*and b\.status = 'finalized'/);
    assert.match(door, /'no_screen_baseline'::text/);
  });

  test('a theme Admin never approved is refused by name, not by check violation', () => {
    assert.match(door, /if v_theme\.admin_status <> 'approved' then\s*\n\s*return query select 'theme_not_approved'::text/);
    assert.match(PROSE, /a named refusal is readable and a check violation is not/);
  });

  test('and the row rule behind it is still G-279’s', () => {
    // The positive twin: even without the door's check, `locked` requires
    // Admin approval at the row, so the gate cannot be walked around.
    assert.match(OPTIONS, /check \(client_status <> 'locked' or admin_status = 'approved'\)/);
  });

  test('a phase waiting on a person is not a phase to complete', () => {
    assert.match(door, /if v_phase3\.state in \('blocked_requirement', 'scope_escalation', 'revision_limit_escalation'\) then\s*\n\s*return query select 'blocked'::text/);
  });

  test('each missing piece is named rather than lumped into one "not ready"', () => {
    // The same reason G-282's share names the offending options: a PM told
    // "not ready" has to go and find out which.
    for (const code of ["'not_confirmed'", "'no_screen_baseline'", "'theme_not_approved'", "'blocked'"]) {
      assert.match(door, new RegExp(code.replace(/'/g, "'")), `${code} is missing`);
    }
    assert.match(PROSE, /a PM told\s+"not ready" has to go and find out which/);
  });
});

describe('C. Figma is canonical, and a missing one is not faked', () => {
  test('readiness is exactly whether the canonical artifact exists', () => {
    assert.match(door, /v_ready := v_theme\.figma_node_id is not null;/);
  });

  test('the two facts are kept apart: complete, and not ready', () => {
    // Phase 3 IS complete — the client confirmed, and recording otherwise
    // would be a different lie. The HANDOFF is not ready.
    assert.match(door, /set state = 'completed', completed_at = now\(\)/);
    assert.match(door, /return query select 'locked_not_ready'::text/);
    assert.match(PROSE, /Collapsing those two facts into one/);
  });

  test('and the row cannot claim ready without one', () => {
    assert.match(SQL, /constraint phase_three_handoffs_ready_has_figma\s*\n\s*check \(not phase_four_ready or figma_node_id is not null\)/);
  });

  test('a handoff that is not ready must say which artifact is missing', () => {
    // Designer §26: do not fake completion. "Not ready" with no reason is a
    // shrug, and Phase 4 would have nothing to act on.
    assert.match(SQL, /constraint phase_three_handoffs_not_ready_says_why\s*\n\s*check \(phase_four_ready or \(readiness_note is not null and length\(btrim\(readiness_note\)\) > 0\)\)/);
    assert.match(door, /'Locked without the canonical Figma artifact: the selected theme has no Figma node reference\. '/);
  });

  test('`phase_four_ready` is emitted ONLY when it is true', () => {
    // An event that fired regardless would be the faked completion wearing a
    // name. Driven on a scratch Postgres: without Figma only
    // phase_three_completed is written to the outbox.
    assert.match(door, /if v_ready then\s*\n\s*perform core\.emit_event\(\s*\n\s*v_phase3\.organization_id, 'project\.phase_four_ready'/);
    // And the completion event is NOT inside that branch.
    assert.ok(door.indexOf("'project.phase_three_completed'") < door.indexOf('if v_ready then'));
    assert.ok(door.includes("'project.phase_three_completed'") && door.includes('if v_ready then'));
  });

  test('and nothing here invents a Figma reference', () => {
    assert.doesNotMatch(door, /figma_node_id\s*:?=\s*'/);
    assert.match(door, /v_theme\.figma_file_key, v_theme\.figma_node_id, v_theme\.figma_version/);
  });
});

describe('D. the handoff is a snapshot, for PM §4.10’s reason', () => {
  test('the payload freezes what Phase 4 consumes', () => {
    for (const key of ['screenBaseline', 'theme', 'colors', 'approvalEvidence', 'revisionRounds']) {
      assert.match(door, new RegExp(`'${key}'`), `${key} is not in the payload`);
    }
    assert.match(SQL, /payload\s+jsonb not null/);
  });

  test('and the reason is the sentence PM §4.10 gives', () => {
    // Driven: renaming the theme after the lock leaves the payload saying what
    // was actually locked.
    assert.match(PROSE, /"Client should not need to reselect the visual direction in Phase 4\."/);
    assert.match(PROSE, /A handoff that joined live rows would answer what the direction is \*\*now\*\*/);
  });

  test('the approval evidence travels with it', () => {
    // Master §7.11: "store client confirmation evidence, selected option IDs,
    // Figma version and timestamp."
    assert.match(door, /'clientDecisionId', v_decision\.id, 'clientWords', v_decision\.client_words/);
    assert.match(door, /'evidenceRef', v_decision\.evidence_ref, 'confirmedAt', v_decision\.created_at/);
    assert.match(SQL, /client_decision_id\s+uuid not null references projects\.client_design_decisions\(id\) on delete restrict/);
  });

  test('it cannot be locked twice, and the table says so too', () => {
    assert.match(door, /'already_locked'::text/);
    assert.match(SQL, /phase_three_id\s+uuid not null unique references projects\.phase_three\(id\)/);
  });

  test('and it cannot be edited at all', () => {
    // The raise is the whole body — there is no condition to neuter.
    assert.match(SQL, /as \$\$\s*\nbegin\s*\n\s*raise exception 'a phase 3 handoff is the locked direction; a later change is a new version, not an edit';\s*\nend;/);
    assert.match(SQL, /create trigger freeze_phase_three_handoff\s*\n\s*before update on projects\.phase_three_handoffs/);
  });
});

describe('E. it locks a selection; it does not start Phase 4', () => {
  test('the chosen option and its palette become `locked`', () => {
    assert.match(door, /update projects\.theme_options set client_status = 'locked' where id = v_theme\.id;/);
    assert.match(door, /update projects\.color_options set client_status = 'locked' where id = v_color\.id;/);
  });

  test('nothing here starts Phase 4', () => {
    // PM §5: "Must not start Phase 4 before Phase 3 completion gate passes."
    // Emitting readiness is not starting, and the consuming unit does not
    // exist yet — which is stated rather than left to be discovered.
    assert.doesNotMatch(door, /insert into projects\.phase_four|start_phase_four/);
    assert.match(PROSE, /\*\*It does not start Phase 4\.\*\*/);
  });

  test('and it creates no design artifact of its own', () => {
    assert.doesNotMatch(door, /insert into projects\.theme_options|insert into projects\.color_options|insert into projects\.screen_baselines/);
  });
});

describe('F. the guards this table and door carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    for (const col of ['project_id', 'phase_three_id', 'screen_baseline_id',
                       'theme_option_id', 'color_option_id', 'client_decision_id']) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${col}'`), `${col} has no guard`);
    }
  });

  test('and organization_id is frozen by its own named trigger', () => {
    assert.match(SQL, /create trigger freeze_org_phase_three_handoffs\s*\n\s*before update of organization_id on projects\.phase_three_handoffs/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.phase_three_handoffs enable row level security/);
    assert.match(SQL, /alter table projects\.phase_three_handoffs force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and does not fail open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.can_write\(\)\)/);
  });

  test('it locks the phase row before deciding anything', () => {
    assert.match(door, /where p3\.id = p_phase_three_id\s*\n\s*for update;/);
    assert.ok(door.includes('for update;') && door.includes("'already_locked'::text"));
    assert.ok(door.indexOf('for update;') < door.indexOf("'already_locked'::text"));
  });

  test('it audits, announces, and is not callable by the world', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(SQL, /'project\.phase_three_completed'/);
    assert.match(SQL, /'project\.phase_four_ready'/);
    assert.match(SQL, /revoke all on function projects\.lock_phase_three_direction\(uuid\) from public, anon/);
    assert.match(door, /security definer\s*\nset search_path = ''/);
  });
});
