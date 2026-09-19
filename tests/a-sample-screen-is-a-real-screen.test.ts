import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A sample screen is a real screen — Designer §7, §17, §18, §19; G-292.
 *
 * §19 asks for a `RepresentativeScreen` carrying *"screenDefinition link,
 * theme link, Figma node, preview"*, and §17 states the rule that makes the
 * first of those mandatory rather than convenient:
 *
 *   *"Every designed screen or representative sample maps to an approved
 *   ScreenDefinition or explicitly approved design requirement."*
 *
 * A sample that maps to nothing is a designer inventing a screen — §17's next
 * line forbids inventing business logic, and a picture of a screen nobody
 * approved is the invention, whatever the caption says.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919220000_a_sample_screen_is_a_real_screen.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const OPTIONS = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');

const slice = (marker: string) => {
  const start = SQL.indexOf(marker);
  assert.ok(start > 0, `${marker} does not exist`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};
const door = slice('create or replace function projects.record_representative_screen');
const coverage = slice('create or replace function projects.representative_coverage');

describe('A. §17 — a sample maps to an approved screen, or it is not recorded', () => {
  test('the mapping is NOT NULL, in DDL', () => {
    assert.match(SQL, /screen_id\s+uuid not null references projects\.screens\(id\) on delete restrict/);
  });

  test('and the screen must actually be approved', () => {
    assert.match(door, /if v_screen\.status <> 'approved' then\s*\n\s*return query select 'screen_not_approved'::text/);
  });

  test('a screen from another project is not a mapping, whatever it looks like', () => {
    assert.match(door, /if v_screen\.project_id is distinct from v_theme\.project_id then\s*\n\s*return query select 'screen_not_in_project'::text/);
  });

  test('and the reason this is a rule rather than a nicety', () => {
    assert.match(PROSE, /a picture of a screen nobody\s+approved is the invention, whatever the caption says/);
  });

  test('`restrict` on the screen, so an approved definition cannot vanish under a sample', () => {
    // §18: representative screens remain available as reference. One whose
    // screen was deleted references nothing.
    assert.match(SQL, /references projects\.screens\(id\) on delete restrict/);
  });
});

describe('B. §7 — coverage is ANSWERED, not enforced', () => {
  test('the coverage function returns what is unmet, not a verdict', () => {
    assert.match(SQL, /returns table \(\s*\n\s*sample_count\s+int,[\s\S]{0,300}?unmet\s+text\[\]\s*\n\)/);
    assert.match(coverage, /array_remove\(array\[/);
  });

  test('and no door refuses on coverage', () => {
    // §7 hedges both "at least one" rules with "when applicable" — twice, in a
    // document that elsewhere says "must" without hedging. A gate here would
    // invent a rule the specification deliberately softened.
    assert.doesNotMatch(door, /has_primary|has_content|representative_coverage/);
    assert.match(PROSE, /would invent a rule the specification\s+deliberately softened/);
  });

  test('each unmet item says what is missing in a sentence', () => {
    for (const phrase of [
      'no primary, home or dashboard-like screen is sampled',
      'no content pattern is sampled: a list, a detail view or a form',
      'no navigation or state context is sampled',
    ]) {
      assert.ok(coverage.includes(phrase), `${phrase} is not reported`);
    }
  });

  test('a direction with no samples answers rather than erroring', () => {
    // Driven: an unknown theme reports all three unmet and count 0. `bool_or`
    // over no rows is NULL, and a NULL there would drop the item from the
    // array — reporting a pattern as covered because nothing was sampled.
    assert.equal((coverage.match(/coalesce\(c\.has_\w+, false\)/g) ?? []).length, 6);
  });

  test('and it is scoped to the reader’s organisation, like every other read', () => {
    assert.match(coverage, /and t\.organization_id = \(select core\.current_organization_id\(\)\)/);
    assert.match(coverage, /and \(select core\.is_internal\(\)\)/);
  });
});

describe('C. §7 — redundancy is refused, because §7 names its cost', () => {
  test('one sample per screen per direction', () => {
    assert.match(SQL, /unique \(theme_option_id, screen_id\)/);
  });

  test('and the door answers it rather than raising a constraint violation', () => {
    // A check violation tells a caller nothing it can act on.
    assert.match(door, /return query select 'already_sampled'::text/);
    assert.ok(door.indexOf("'already_sampled'") < door.indexOf('insert into projects.representative_screens'));
  });

  test('the same screen in a DIFFERENT direction is a real sample', () => {
    // Which is the point of samples: the unique key is the pair, not the
    // screen. Driven on a scratch Postgres.
    assert.doesNotMatch(SQL, /unique \(screen_id\)/);
  });
});

describe('D. a sample nobody can look at demonstrates nothing', () => {
  test('a Figma node or a preview, and having neither is refused', () => {
    // §8 permits a preview as a SECONDARY artifact, so either satisfies this.
    assert.match(SQL, /constraint representative_screens_something_to_look_at\s*\n\s*check \(figma_node_id is not null or preview_asset_url is not null\)/);
    assert.match(door, /if v_node is null and v_url is null then\s*\n\s*return query select 'nothing_to_show'::text/);
  });

  test('and it is refused on the ARGUMENTS, before any row is read', () => {
    assert.ok(door.includes("'nothing_to_show'") && door.includes('from projects.theme_options t'));
    assert.ok(door.indexOf("'nothing_to_show'") < door.indexOf('from projects.theme_options t'));
  });
});

describe('E. §18 — a locked direction’s samples are what it was judged on', () => {
  test('a locked direction takes no new sample', () => {
    assert.match(door, /if v_theme\.client_status = 'locked' then\s*\n\s*return query select 'direction_locked'::text/);
  });

  test('and the rule that makes `locked` mean something is still G-279’s', () => {
    // The positive twin: `locked` requires Admin approval at the row.
    assert.match(OPTIONS, /check \(client_status <> 'locked' or admin_status = 'approved'\)/);
  });

  test('what a sample stands for cannot be edited', () => {
    assert.match(SQL, /if new\.screen_id is distinct from old\.screen_id\s*\n\s*or new\.theme_option_id is distinct from old\.theme_option_id then\s*\n\s*raise exception 'a representative screen stands for one screen in one direction/);
  });

  test('but its preview can be, because that is not what it stands for', () => {
    // Driven: updating preview_asset_url succeeds.
    assert.doesNotMatch(SQL, /new\.preview_asset_url is distinct from old\.preview_asset_url/);
  });
});

describe('F. the guards this table and door carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    for (const col of ['project_id', 'theme_option_id', 'screen_id']) {
      assert.match(SQL, new RegExp(`core\\.enforce_parent_org\\('${col}'`), `${col} has no guard`);
    }
  });

  test('and organization_id is frozen by its own named trigger', () => {
    assert.match(SQL, /create trigger freeze_org_representative_screens\s*\n\s*before update of organization_id on projects\.representative_screens/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.representative_screens enable row level security/);
    assert.match(SQL, /alter table projects\.representative_screens force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and does not fail open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.can_write\(\)\)/);
  });

  test('it records; it draws nothing', () => {
    assert.doesNotMatch(door, /insert into projects\.theme_options|update projects\.theme_options/);
    assert.match(SQL, /It records; it draws nothing\./);
  });

  test('it audits, announces, and neither function is callable by the world', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /'project\.representative_screen_recorded'/);
    assert.match(SQL, /revoke all on function projects\.record_representative_screen\(uuid, uuid, text, text, text, text\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.representative_coverage\(uuid\) from public, anon/);
  });
});
