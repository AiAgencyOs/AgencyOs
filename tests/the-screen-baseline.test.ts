import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The screen baseline — Master §7.3, §7.4, §13; G-278.
 *
 * Phase 3 does two things before any design work: finalize the complete screen
 * list, and define what each screen must contain. **Most of that already
 * existed.** `projects.screens` was built in August for Document 12's coverage
 * matrix and is substantially Master §13's contract, produced by a running
 * agent and guarded by three rules that were already mechanically true.
 *
 * So this unit is mostly about what it does **not** rebuild, and about the one
 * design decision that is not obvious: the version is a **snapshot**, because
 * `unique (project_id, screen_key)` is load-bearing and re-keying screens per
 * version would break both the duplicate refusal Doc 12 §9 asks for and the
 * inventory workflow that reads it.
 *
 * The assertion this file exists for is §8's: **editing a screen after
 * finalization must not rewrite what was agreed.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260918150000_the_screen_baseline.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const AUGUST = read('supabase/migrations/20260821230000_attractive_but_incomplete.sql');

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. what it deliberately does not rebuild', () => {
  test('the August screen model still owns the contract', () => {
    // The positive twin: if these disappeared, every "we extended it"
    // assertion below would be describing something that no longer exists.
    assert.match(AUGUST, /create table if not exists projects\.screens/);
    assert.match(AUGUST, /unique \(project_id, screen_key\)/);
    assert.match(AUGUST, /create table if not exists projects\.screen_scope_items/);
  });

  test('no second screen table is created', () => {
    // The mandate's own execution protocol: "do not create duplicate design
    // workflows if an existing one can be extended."
    assert.doesNotMatch(SQL, /create table if not exists projects\.screen_definitions/);
    assert.doesNotMatch(SQL, /create table[^;]*\bscreens\b\s*\(/);
  });

  test('and the three rules that were already true are not re-implemented', () => {
    // A screen may not map to an excluded item; every screen maps to one;
    // every included item has a screen. All three are August triggers.
    assert.match(AUGUST, /refuse_excluded_screen_mapping/);
    assert.match(AUGUST, /refuse_uncovered_design/);
    assert.doesNotMatch(SQL, /refuse_excluded_screen_mapping|refuse_uncovered_design/);
  });

  test('the extension is exactly three columns, and each has a reason', () => {
    assert.match(SQL, /add column if not exists required_sections text/);
    assert.match(SQL, /add column if not exists dependencies\s+text/);
    assert.match(SQL, /add column if not exists baseline_version\s+int/);
    assert.match(PROSE, /Three things are genuinely missing, and only three/);
  });
});

describe('B. the version is a snapshot, and that is the decision', () => {
  test('the snapshot column exists and is written by the door', () => {
    assert.match(SQL, /screens\s+jsonb not null default '\[\]'::jsonb/);
    assert.match(door('finalize_screen_baseline'), /set status = 'finalized',\s*\n\s*screens = coalesce\(v_snapshot/);
  });

  test('and the reason it is not per-version screen rows is written down', () => {
    // Re-keying screens per version would break Doc 12 §9's duplicate refusal
    // AND the inventory workflow that reads `project_id` to decide whether an
    // inventory exists. The mandate forbids breaking Phase 1/2 foundations.
    assert.match(PROSE, /that constraint is load-bearing/);
    assert.match(PROSE, /Re-keying screens per version would break both/);
  });

  test('a finalized baseline cannot be edited at all', () => {
    // §8: "editing the current state must not destroy the previous decision
    // trail." Proven on a scratch Postgres: the update raises.
    assert.match(SQL, /create or replace function projects\.freeze_finalized_screen_baseline/);
    assert.match(SQL, /if old\.status = 'finalized' then/);
    assert.match(SQL, /a finalized screen baseline is history; draft the next version instead/);
  });

  test('the snapshot carries every field §13 names', () => {
    const fn = door('finalize_screen_baseline');
    for (const field of [
      'screenKey', 'name', 'userRole', 'purpose', 'requiredSections',
      'requiredData', 'actions', 'dependencies', 'entryPoint', 'exitAction',
      'states', 'scopeItemIds',
    ]) {
      assert.match(fn, new RegExp(`'${field}'`), `§13's ${field} is not in the snapshot`);
    }
  });

  test('the stamp on the screen is a version number, not a reference', () => {
    // A screen outlives the baseline that froze it. A foreign key would make
    // deleting a baseline reach into the working set.
    assert.match(SQL, /baseline_version\s+int check \(baseline_version is null or baseline_version > 0\)/);
    assert.doesNotMatch(SQL, /baseline_id .*references projects\.screen_baselines/);
    assert.match(PROSE, /A stamp, not a reference/);
  });
});

describe('C. the list is complete, or it does not finalize', () => {
  test('an empty list is refused', () => {
    assert.match(door('finalize_screen_baseline'), /'no_screens'::text/);
    assert.match(PROSE, /An empty list is not a list/);
  });

  test('an INCLUDED scope item with no screen is refused, with its count', () => {
    // §7.3's completeness, asked at the moment a baseline is finalized rather
    // than at design review, which is when the August trigger asks it.
    const fn = door('finalize_screen_baseline');
    assert.match(fn, /and si\.inclusion = 'included'/);
    assert.match(fn, /'uncovered_scope'::text/);
    assert.match(fn, /format\('uncovered_scope_items:%s', v_uncovered\)/);
    assert.match(PROSE, /a checklist refusal somebody has to investigate is a refusal nobody acts on/);
  });

  test('completeness is checked against the baseline’s OWN scope version', () => {
    // Not the project's latest. A baseline finalized against v1 of the scope
    // is complete or not against v1, whatever happened afterwards.
    assert.match(door('finalize_screen_baseline'), /si\.scope_version_id = v_row\.scope_version_id/);
  });

  test('superseded screens do not count toward the list', () => {
    const fn = door('finalize_screen_baseline');
    assert.equal((fn.match(/status <> 'superseded'/g) ?? []).length, 4);
  });
});

describe('D. versioning says why, and only one list is open', () => {
  test('one draft at a time, by partial index', () => {
    // Two drafts is two answers to "what are we designing against".
    assert.match(SQL, /create unique index if not exists screen_baselines_one_draft/);
    assert.match(SQL, /where status in \('draft', 'review'\)/);
    assert.match(door('draft_screen_baseline'), /'already_drafting'::text/);
  });

  test('v1 needs no reason; v2 does', () => {
    const fn = door('draft_screen_baseline');
    assert.match(fn, /if v_last > 0 and \(p_change_reason is null or length\(btrim\(p_change_reason\)\) = 0\) then/);
    assert.match(fn, /'needs_reason'::text/);
    assert.match(PROSE, /a second version with no stated cause is a\s+rewrite wearing a version number/);
  });

  test('a baseline names the ACTIVE scope version it was built against', () => {
    assert.match(SQL, /scope_version_id uuid not null references projects\.scope_versions\(id\) on delete restrict/);
    assert.match(door('draft_screen_baseline'), /and sv\.status = 'active'/);
    assert.match(door('draft_screen_baseline'), /'no_scope'::text/);
  });

  test('a finalized baseline is dated and non-empty', () => {
    assert.match(SQL, /constraint screen_baselines_finalized_is_dated/);
    assert.match(SQL, /check \(status <> 'finalized' or \(finalized_at is not null and screen_count > 0\)\)/);
  });
});

describe('E. §22’s ambiguous screen can finally say so', () => {
  test('`blocked` is added to the screen status vocabulary', () => {
    assert.match(SQL, /check \(status in \('draft', 'in_review', 'approved', 'superseded', 'blocked'\)\)/);
    assert.match(PROSE, /a screen whose requirement is\s+ambiguous to say so and nothing could express that/);
  });

  test('`finalized` is deliberately NOT a screen status, and the reason is recorded', () => {
    // Master §13 lists it; `approved` already means the design-review state
    // the coverage trigger reads, and two words for one column is how a
    // trigger starts refusing the wrong rows.
    assert.doesNotMatch(SQL, /'draft', 'in_review', 'approved', 'superseded', 'blocked', 'finalized'/);
    assert.match(PROSE, /Two words for one column is how a trigger starts refusing\s+the wrong rows/);
    assert.match(PROSE, /Recorded in the Phase 3 traceability matrix as D-1/);
    assert.match(read('docs/phase3/AGENCYOS_PHASE3_TRACEABILITY.md'), /D-1 — Screen status vocabulary \(CONFLICTING\)/);
  });

  test('widening a CHECK is additive, which is why it is safe ahead of the code', () => {
    // Every existing row satisfies the wider constraint. The narrowing
    // direction is the one that broke production in G-261.
    assert.match(PROSE, /Widening a CHECK is\s+additive: every existing row still satisfies it/);
  });
});

describe('F. it moves the phase, and nothing else', () => {
  test('drafting opens screen definition; finalizing opens theme generation', () => {
    assert.match(door('draft_screen_baseline'), /set state = 'screen_definition'/);
    assert.match(door('finalize_screen_baseline'), /set state = 'theme_generation'/);
  });

  test('and neither transition clobbers a state it does not own', () => {
    // A phase already past screen definition is not dragged back by a
    // re-draft, and a phase that is not in screen definition is not pushed
    // forward by a finalize.
    assert.match(door('draft_screen_baseline'), /and state in \('context_loading', 'screen_definition'\)/);
    assert.match(door('finalize_screen_baseline'), /and state = 'screen_definition'/);
  });

  test('no design artifact is created here', () => {
    // §7.4 is explicit: "a content/requirements baseline, not full final
    // visual UI."
    // Not the word "theme" — `theme_generation` is the phase STATE this
    // door legitimately moves to. A design ARTIFACT is what must not appear.
    assert.doesNotMatch(SQL, /create table[^;]*\b(theme|palette|color)/i);
    assert.doesNotMatch(SQL, /figma|palette|design_token/i);
  });

  test('and nobody is messaged', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|conversation_messages|whatsapp/i);
  });
});

describe('G. the guards every table and door here carries', () => {
  test('both org-scoped foreign keys are tenancy-guarded', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('scope_version_id', 'projects\.scope_versions'\)/);
    assert.match(SQL, /core\.freeze_organization_id\(\)/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.screen_baselines enable row level security/);
    assert.match(SQL, /alter table projects\.screen_baselines force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  for (const name of ['draft_screen_baseline', 'finalize_screen_baseline']) {
    test(`${name} refuses an unattended caller and is tenancy-checked`, () => {
      const fn = door(name);
      assert.match(fn, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
      assert.match(fn, /'no_actor'::text/);
      assert.match(fn, /core\.current_organization_id\(\)/);
      assert.match(fn, /core\.can_write\(\)/);
      assert.match(fn, /security definer\s*\nset search_path = ''/);
    });

    test(`${name} locks its row before deciding`, () => {
      assert.match(door(name), /for update/);
    });
  }

  test('neither is callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.draft_screen_baseline\(uuid, text\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.finalize_screen_baseline\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.draft_screen_baseline\(uuid, text\) to authenticated/);
  });

  test('both audit and announce inside the same transaction', () => {
    for (const name of ['draft_screen_baseline', 'finalize_screen_baseline']) {
      assert.match(door(name), /perform core\.record_audit\(/);
      assert.match(door(name), /perform core\.emit_event\(/);
    }
    assert.match(SQL, /'project\.screen_list_drafted'/);
    assert.match(SQL, /'project\.screen_list_finalized'/);
  });
});
