import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The limit is a stop, not a suggestion — Master §16, §19; PM §4.6–4.8, §9;
 * Designer §4.8, §16; G-284.
 *
 * Two sentences carry the unit, and neither is asking for an error return:
 *
 *   PM §4.8  *"When configured revision limit is reached/exceeded, do not
 *            continue an endless generation loop. Create human escalation."*
 *   PM §9    *"Revision count is incremented only for client-requested
 *            rounds."*
 *
 * A door that answered `limit_reached` and changed nothing would leave the
 * phase in `revision` — claiming a designer is working — while the loop had in
 * fact stopped forever. So passing the limit is a **state transition**.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919160000_the_limit_is_a_stop.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const PHASE = read('supabase/migrations/20260918140000_phase_three_begins_where_phase_two_ends.sql');
const OPTIONS = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.open_design_revision');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. passing the limit is a state transition, not an error return', () => {
  test('the phase STOPS, and the door says `escalated` rather than refusing', () => {
    // The whole unit is this. Driven on a scratch Postgres: round 3 against a
    // limit of 2 leaves the phase in revision_limit_escalation and creates no
    // revision row.
    assert.match(door, /if v_phase3\.client_revision_count >= v_phase3\.client_revision_limit then\s*\n\s*update projects\.phase_three\s*\n\s*set state = 'revision_limit_escalation'/);
    assert.match(door, /return query select 'escalated'::text/);
  });

  test('and the reason names the count, the limit and what was asked', () => {
    // G-277 made the state unenterable without a reason so this could not be
    // skipped. A person reading it must not have to go and look the numbers up.
    assert.match(door, /'The client revision limit was reached: %s of %s rounds used\. '/);
    assert.match(door, /v_phase3\.client_revision_count, v_phase3\.client_revision_limit, v_changes/);
    assert.match(PHASE, /check \(state not in \('blocked_requirement', 'scope_escalation', 'revision_limit_escalation'\)/);
  });

  test('nothing is drawn on the way past the limit', () => {
    // The `return` is inside the limit branch, above the insert — asserting the
    // ORDER, because a later insert would spend a round the escalation says was
    // never taken.
    // Presence FIRST: indexOf returns -1 when absent, so a bare ordering
    // assertion passes on a control that was deleted outright.
    assert.ok(door.includes("'escalated'::text") && door.includes('insert into projects.design_revisions'));
    assert.ok(door.indexOf("'escalated'::text") < door.indexOf('insert into projects.design_revisions'));
  });

  test('and once escalated the designer waits, rather than resuming', () => {
    // Designer §16: "waits for escalation outcome". Resuming here would answer
    // a question that was put to a human.
    assert.match(door, /if v_phase3\.state = 'revision_limit_escalation' then\s*\n\s*return query select 'escalation_open'::text/);
    assert.match(PROSE, /Resuming the loop here would answer\s+a question that was put to a human/);
  });

  test('the door reports why it stopped, in the event as well as the row', () => {
    assert.match(SQL, /'project\.revision_limit_escalated'/);
    // BOTH calls — the audit and the event. A single match passed while the
    // event payload was stripped, because the audit call above carries the same
    // text: the assertion had bound itself to the wrong copy.
    assert.equal(
      (door.match(/'revisionCount', v_phase3\.client_revision_count,\s*\n\s*'revisionLimit', v_phase3\.client_revision_limit/g) ?? []).length,
      2,
    );
  });
});

describe('B. the count is client-only, and that is a rule', () => {
  test('only a client round moves the counter', () => {
    // PM §9, exactly. The guard is what makes it true — asserting the
    // increment alone would survive removing the condition around it.
    assert.match(door, /if p_origin = 'client_revision' then\s*\n\s*update projects\.phase_three\s*\n\s*set client_revision_count = client_revision_count \+ 1/);
  });

  test('and only a client round can reach the limit', () => {
    assert.ok(door.includes("if p_origin = 'client_revision' then")
              && door.includes('client_revision_count >= v_phase3.client_revision_limit'));
    assert.ok(door.indexOf("if p_origin = 'client_revision' then") < door.indexOf('client_revision_count >= v_phase3.client_revision_limit'));
  });

  test('the reason it is client-only is recorded, because it is not obvious', () => {
    // An Admin EDIT is a revision. Counting it would spend the client's rounds
    // on work they never asked for, and a careful internal review would make
    // the limit arrive sooner.
    assert.match(PROSE, /a careful internal review would make the limit arrive\s+sooner/);
  });

  test('a round number belongs to a client round and to nothing else', () => {
    // Written as an equivalence, not two one-way checks: an internal revision
    // that acquired a round number would appear in the client's history.
    assert.match(SQL, /constraint design_revisions_round_is_client_only\s*\n\s*check \(\(origin = 'client_revision'\) = \(round_number is not null\)\)/);
  });

  test('and the round is frozen at the moment it was opened', () => {
    // Master §16 wants the counter visible. A column that recomputed from the
    // live counter would renumber history every time the counter moved.
    assert.match(door, /v_round := v_phase3\.client_revision_count \+ 1;/);
    assert.match(SQL, /frozen when it was opened, so history reads correctly after the counter moves on/);
  });
});

describe('C. a client revision must point at the client', () => {
  test('the citation is required in DDL, not by a service', () => {
    assert.match(SQL, /constraint design_revisions_client_origin_cites_the_client\s*\n\s*check \(origin <> 'client_revision' or client_decision_id is not null\)/);
    assert.match(door, /'needs_client_decision'::text/);
  });

  test('a SCOPE question can never become a design round', () => {
    // Master §17 and Designer §4.8. G-283 gave possible_scope_change its own
    // classification so that this line could exist; without it the rule would
    // be enforced only by whoever chose which decision id to pass.
    assert.match(door, /if v_decision\.decision <> 'design_change_request' then\s*\n\s*return query select 'not_a_design_change'::text/);
    assert.match(PROSE, /the client\s+would pay a revision for asking about a feature/);
  });

  test('and the classification it depends on is still G-283’s', () => {
    // The positive twin: if `possible_scope_change` stopped being a distinct
    // classification, this check would be comparing against nothing.
    assert.match(
      read('supabase/migrations/20260919140000_a_client_answer_is_not_a_guess.sql'),
      /check \(decision in \(\s*\n\s*'client_selected',/,
    );
  });

  test('the cited decision must be about the option being revised', () => {
    assert.match(door, /if v_decision\.selected_theme_option_id is distinct from p_from_theme_option_id then\s*\n\s*return query select 'decision_not_for_this_option'::text/);
  });

  test('and it must belong to this phase, not merely exist', () => {
    assert.match(door, /where d\.id = p_client_decision_id\s*\n\s*and d\.phase_three_id = v_phase3\.id/);
  });
});

describe('D. a retry must not burn a round', () => {
  test('one client decision opens one revision, enforced by the table', () => {
    assert.match(SQL, /unique \(client_decision_id\)/);
  });

  test('and the retry is answered BEFORE the limit is touched', () => {
    // A second call for a decision already handled must not be able to trip an
    // escalation the first call did not. Order is the whole guarantee.
    assert.ok(door.includes("'exists'::text")
              && door.includes('client_revision_count >= v_phase3.client_revision_limit'));
    assert.ok(door.indexOf("'exists'::text") < door.indexOf('client_revision_count >= v_phase3.client_revision_limit'));
    assert.match(PROSE, /a retry must not\s+be able to trip an escalation the first call did not/);
  });
});

describe('E. it opens a round; it does not draw and it does not erase', () => {
  test('no theme option is created here', () => {
    assert.doesNotMatch(door, /insert into projects\.theme_options/);
    assert.match(PROSE, /\*\*It does not draw anything\.\*\*/);
  });

  test('and the version link it will eventually use is still G-279’s', () => {
    // The positive twin: the new version is a theme_options row whose
    // `revision_of` points back. Without that column this separation would
    // leave the revision unattached to what it produced.
    assert.match(OPTIONS, /revision_of\s+uuid references projects\.theme_options\(id\) on delete set null/);
  });

  test('it does not reset the gates, because two owners for one rule is none', () => {
    assert.doesNotMatch(door, /internal_review_status =|admin_status =|client_status =/);
    assert.match(PROSE, /Doing it again here would be a second owner for one\s+rule/);
  });

  test('the option it revises is referenced, never updated', () => {
    // Designer §20: "a new revision must not erase a previously reviewed or
    // client-shared version."
    assert.doesNotMatch(door, /update projects\.theme_options/);
    assert.match(SQL, /constraint design_revisions_to_is_not_from/);
  });

  test('a delivered revision produced something', () => {
    assert.match(SQL, /constraint design_revisions_delivered_has_a_version\s*\n\s*check \(status <> 'delivered' or to_theme_option_id is not null\)/);
  });

  test('the request and the round cannot be edited, but delivery can be recorded', () => {
    // The raise must be reached by the guard, not merely present: a red-proof
    // neutering the condition would otherwise leave the message in place.
    assert.match(SQL, /if new\.origin is distinct from old\.origin[\s\S]{0,400}?then\s*\n\s*raise exception 'a design revision records what was asked and which round it was; those cannot be edited'/);
    // Status and to_theme_option_id are deliberately absent from that list.
    assert.doesNotMatch(SQL, /new\.status is distinct from old\.status/);
  });
});

describe('F. the guards this table and door carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    for (const col of ['project_id', 'phase_three_id', 'from_theme_option_id', 'to_theme_option_id',
                       'client_decision_id', 'design_review_id', 'admin_decision_id']) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${col}'`), `${col} has no guard`);
    }
  });

  test('and organization_id is frozen by its own named trigger', () => {
    assert.match(SQL, /create trigger freeze_org_design_revisions\s*\n\s*before update of organization_id on projects\.design_revisions/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.design_revisions enable row level security/);
    assert.match(SQL, /alter table projects\.design_revisions force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and does not fail open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    // G-281: `not NULL` is NULL and an `if` does not execute it.
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.can_write\(\)\)/);
  });

  test('every argument-only refusal happens before any row is read', () => {
    for (const code of ["'bad_origin'", "'no_requested_changes'", "'needs_client_decision'"]) {
      assert.ok(door.includes(code), `${code} is gone`);
      assert.ok(door.indexOf(code) < door.indexOf('from projects.theme_options'), `${code} is checked after a row`);
    }
  });

  test('it locks the phase row before deciding, and is security definer', () => {
    assert.match(door, /for update/);
    assert.match(door, /security definer\s*\nset search_path = ''/);
  });

  test('it audits, announces, and is not callable by the world', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /'project\.design_revision_opened'/);
    assert.match(SQL, /revoke all on function projects\.open_design_revision\(uuid, text, text, uuid, uuid, uuid\) from public, anon/);
  });

  test('the origin vocabulary is the one the artifact already uses', () => {
    // Reused rather than reinvented, so the request and the version it produces
    // cannot disagree about what kind of round this was.
    assert.match(SQL, /check \(origin in \('internal_review', 'admin_edit', 'client_revision'\)\)/);
    assert.match(OPTIONS, /check \(origin in \('initial', 'internal_review', 'admin_edit', 'client_revision'\)\)/);
  });
});
