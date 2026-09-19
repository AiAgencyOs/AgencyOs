import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The tokens Phase 4 inherits — Designer §4.5, §19, §23; G-295.
 *
 * §23 asks for a `DesignTokenSet` carrying *"typography/color/spacing/surface
 * primitives + version"*, and §19 says what it is for: *"Phase 4 receives
 * design tokens/primitives **rather than recreating them**."*
 *
 * Two decisions carry the unit. The **boundary** is held by the schema having
 * nowhere to cross it — every primitive §4.5 names is a column and there is no
 * jsonb catch-all. And **colour is deliberately absent**, because
 * `color_options` already holds the palette and a second copy is a second
 * place it can disagree with itself.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920000000_the_tokens_phase_four_inherits.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const COLOURS = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');

const slice = (marker: string) => {
  const start = SQL.indexOf(marker);
  assert.ok(start > 0, `${marker} does not exist`);
  const cut = SQL.slice(start, SQL.indexOf('$$;', start));
  assert.ok(cut.length > 0 && cut.length < SQL.length, `${marker} is not bounded`);
  return cut;
};
const recordDoor = slice('create or replace function projects.record_design_token_set');
const finalDoor = slice('create or replace function projects.finalize_design_token_set');
const lockDoor = slice('create or replace function projects.lock_phase_three_direction');
const table = SQL.slice(
  SQL.indexOf('create table if not exists projects.design_token_sets'),
  SQL.indexOf('comment on table projects.design_token_sets'),
);

describe('A. §4.5’s boundary is the schema having nowhere to cross it', () => {
  test('there is no jsonb catch-all', () => {
    // A `tokens jsonb` column is exactly where a complete production design
    // system arrives — one reasonable addition at a time, and nothing ever
    // refuses.
    assert.doesNotMatch(table, /jsonb/);
    assert.match(PROSE, /one component at a time, each addition reasonable on its own, and nothing\s+ever refuses/);
  });

  test('every primitive §4.5 names is a named column', () => {
    for (const col of ['font_family_heading', 'font_family_body', 'type_scale_ratio',
                       'base_spacing_px', 'radius_style', 'elevation_style', 'border_style',
                       'icon_treatment', 'navigation_style', 'button_treatment', 'card_treatment']) {
      assert.match(table, new RegExp(`^\\s+${col}\\s`, 'm'), `${col} is missing`);
    }
  });

  test('and the style columns are closed vocabularies, not free text', () => {
    // "Spacing feel" and "border/radius/shadow style" are directions a
    // reviewer judges. A free-text column would take a CSS value.
    assert.match(table, /radius_style\s+text check \(radius_style is null or radius_style in \('sharp', 'soft', 'rounded', 'pill'\)\)/);
    assert.match(table, /navigation_style\s+text check \(navigation_style is null or navigation_style in \('top_bar', 'side_nav', 'bottom_tabs', 'hybrid'\)\)/);
  });

  test('a set that says nothing is refused, at the row and at the door', () => {
    assert.match(table, /constraint design_token_sets_says_something\s*\n\s*check \(num_nonnulls\(/);
    assert.match(recordDoor, /return query select 'says_nothing'::text/);
  });
});

describe('B. colour is absent, and that is the reuse rule', () => {
  test('no colour column exists here', () => {
    assert.doesNotMatch(table, /_hex|palette|colour|color/i);
  });

  test('because the palette already has a table', () => {
    // The positive twin: if `color_options` stopped holding named tokens,
    // this omission would leave colour nowhere.
    // The DECLARATION, with its validation. A bare /primary_hex/ also matches
    // a renamed `primary_hexx`, so the twin proved nothing.
    assert.match(COLOURS, /primary_hex\s+text not null check \(primary_hex ~\* /);
    assert.match(PROSE, /Copying them here would create two places a\s+palette can disagree with itself/);
  });

  test('and the handoff assembles both', () => {
    assert.match(lockDoor, /'colors', jsonb_build_object\(/);
    assert.match(lockDoor, /'tokens', case when v_tokens\.id is null then null else jsonb_build_object\(/);
  });

  test('it is not AgencyOS’s own product theme', () => {
    assert.match(PROSE, /That file is \*\*AgencyOS's own product theme\*\*/);
  });
});

describe('C. null means unchanged, and a new version inherits', () => {
  test('the door overlays rather than replacing', () => {
    // Found by driving it: a version that started blank lost every primitive
    // the previous one carried.
    assert.match(recordDoor, /coalesce\(nullif\(btrim\(coalesce\(p_navigation_style, ''\)\), ''\), v_prev\.navigation_style\)/);
    assert.match(recordDoor, /navigation_style\s+= coalesce\(nullif\(btrim\(coalesce\(p_navigation_style, ''\)\), ''\), navigation_style\)/);
  });

  test('every primitive is carried forward, not just some', () => {
    // A partial overlay is worse than none: it loses exactly the fields
    // somebody did not think to check.
    assert.equal((recordDoor.match(/v_prev\.\w+/g) ?? []).length, 12);
  });

  test('and the cost of that choice is stated', () => {
    assert.match(PROSE, /this door cannot clear a primitive back to null, only change one/);
  });
});

describe('D. a finalized set is what Phase 4 inherits', () => {
  test('it cannot be edited', () => {
    assert.match(SQL, /if old\.status = 'final' then\s*\n\s*raise exception 'a finalized design token set is what Phase 4 inherits; draft the next version instead'/);
  });

  test('a final set is dated', () => {
    assert.match(table, /constraint design_token_sets_final_is_dated\s*\n\s*check \(status <> 'final' or finalized_at is not null\)/);
  });

  test('finalizing takes the newest version and locks the row first', () => {
    assert.match(finalDoor, /order by s\.version desc\s*\n\s*limit 1\s*\n\s*for update;/);
    assert.match(finalDoor, /'already_final'::text/);
    assert.match(finalDoor, /'no_draft'::text/);
  });

  test('and it announces, because §19 hands the result onward', () => {
    assert.match(SQL, /'project\.design_tokens_finalized'/);
    assert.match(finalDoor, /perform core\.emit_event\(/);
  });
});

describe('E. §19 — readiness now requires the tokens as well as Figma', () => {
  test('both are checked, and the note names everything missing', () => {
    // A deliberate change to G-285's rule, not a side effect: a handoff marked
    // ready without tokens claims Phase 4 has what it needs while leaving it
    // to invent the primitives.
    assert.match(lockDoor, /if v_theme\.figma_node_id is null then\s*\n\s*v_missing := array_append\(v_missing,/);
    assert.match(lockDoor, /if v_tokens\.id is null then\s*\n\s*v_missing := array_append\(v_missing,/);
    assert.match(lockDoor, /v_ready := array_length\(v_missing, 1\) is null;/);
  });

  test('the note lists them all, not the first one', () => {
    assert.match(lockDoor, /array_to_string\(v_missing, '; and '\)/);
  });

  test('`array_append`, not `||` — the bug driving the negative path found', () => {
    // `text[] || text` is read as an array-literal cast and raises. It only
    // exists on the NOT-ready path, so the ready path passed while this broke.
    assert.doesNotMatch(lockDoor, /v_missing := v_missing \|\|/);
    assert.match(PROSE, /no regex over this file would have seen it/);
  });

  test('Phase 3 still completes either way', () => {
    // The client confirmed. Collapsing "complete" and "ready" would be the
    // faked completion inverted — refusing to record what happened.
    assert.match(lockDoor, /set state = 'completed', completed_at = now\(\)/);
    assert.match(lockDoor, /return query select 'locked_not_ready'::text/);
  });

  test('and `phase_four_ready` is still emitted only when true', () => {
    assert.match(lockDoor, /if v_ready then\s*\n\s*perform core\.emit_event\(\s*\n\s*v_phase3\.organization_id, 'project\.phase_four_ready'/);
    assert.ok(lockDoor.indexOf("'project.phase_three_completed'") < lockDoor.indexOf('if v_ready then'));
  });

  test('the lock is replaced rather than joined by a second door', () => {
    // The payload is one snapshot; assembling it in two places would let the
    // halves disagree about which moment they froze.
    assert.match(PROSE, /assembling it in two places would let the halves disagree/);
    assert.match(lockDoor, /create or replace function projects\.lock_phase_three_direction/);
  });
});

describe('F. the guards this table and its doors carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    for (const col of ['project_id', 'theme_option_id']) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${col}', 'projects\\.`), `${col} has no guard`);
    }
  });

  test('and organization_id is frozen by its own named trigger', () => {
    assert.match(SQL, /create trigger freeze_org_design_token_sets\s*\n\s*before update of organization_id on projects\.design_token_sets/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.design_token_sets enable row level security/);
    assert.match(SQL, /alter table projects\.design_token_sets force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('both doors refuse a null actor and do not fail open', () => {
    for (const d of [recordDoor, finalDoor]) {
      assert.match(d, /v_actor uuid := \(select auth\.uid\(\)\)/);
      assert.match(d, /'no_actor'::text/);
      assert.match(d, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
      assert.doesNotMatch(d, /not \(select core\.can_write\(\)\)/);
    }
  });

  test('and none of the three is callable by the world', () => {
    for (const sig of [
      'projects\\.record_design_token_set\\(uuid, text, text, numeric, int, text, text, text, text, text, text, text, text\\)',
      'projects\\.finalize_design_token_set\\(uuid\\)',
      'projects\\.lock_phase_three_direction\\(uuid\\)',
    ]) {
      assert.match(SQL, new RegExp(`revoke all on function ${sig} from public, anon`), `${sig} is open`);
    }
  });
});
