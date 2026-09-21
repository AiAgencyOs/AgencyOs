import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { region, TO_END } from './_region.ts';

/**
 * The team roster has a door — Master §6, P2-05.
 *
 * G-253 created `projects.group_team_defaults`, read it onto every group card,
 * and gave it a SELECT policy and nothing else. **No write path existed.** So
 * every card raised since carried the client's contacts and none of the
 * agency's own team — which is the half of the list the person opening
 * WhatsApp actually needs.
 *
 * The behaviour was proven by driving all three doors against a scratch
 * Postgres. What is asserted here is what a regression would silently undo:
 * the guards, and the one property the whole design rests on — **removing
 * somebody from the roster leaves an existing card's copy intact.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917230000_the_team_roster_has_a_door.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const G253 = read('supabase/migrations/20260917120000_the_group_is_a_manual_action.sql');
const SERVICE = read('src/modules/projects/service.ts');
const ROSTER = region(SERVICE, 'The internal team roster', TO_END);
const QUERIES = read('src/modules/projects/queries.ts');
const PANEL = read('app/(internal)/settings/team-roster-panel.tsx');
const PAGE = read('app/(internal)/settings/team/page.tsx');
const LAYOUT = read('app/(internal)/settings/layout.tsx');

const door = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the table had no way in, and that is recorded', () => {
  test('G-253 gave it a read policy and no write policy', () => {
    const policies = G253.match(/create policy [^;]*group_team_defaults[^;]*/gs) ?? [];
    assert.ok(policies.length > 0, 'G-253 defines no policy at all on the roster');
    for (const policy of policies) {
      assert.doesNotMatch(policy, /for (insert|update|delete|all)/);
    }
    // And no door either: this migration is the first to write the table.
    assert.doesNotMatch(G253, /insert into projects\.group_team_defaults/);
  });

  test('the consequence is stated, not just the fix', () => {
    assert.match(PROSE, /a table nobody can write to is a table that does not\s+exist/);
    assert.match(PROSE, /none of the agency's\s+own team/);
    // Three units shipped between G-253 and this one without noticing. Saying
    // so is the part that makes the next reader check.
    assert.match(PROSE, /three units shipped\s+between G-253 and this one and none of them noticed/);
  });
});

describe('B. a deletion cannot rewrite a group that already exists', () => {
  test('the card copies the roster rather than referencing it', () => {
    // The property the whole design rests on, asserted against G-253 rather
    // than trusted: if the card ever grew a foreign key to the roster, a
    // removal here would silently edit a group somebody already made.
    assert.doesNotMatch(G253, /references projects\.group_team_defaults/);
    assert.match(G253, /members jsonb/);
  });

  test('and the deletion says which property it is relying on', () => {
    // Against the RAW migration: `door()` strips comments, and the sentence
    // that matters here is a comment sitting on the delete itself.
    const raw = region(MIGRATION, 'create or replace function projects.remove_team_default', '$$;');
    assert.match(raw.replace(/\n\s*--\s?/g, ' '), /a card's member list is a COPY \(G-253\)/);
    assert.match(PROSE, /deleting somebody from the roster\s+cannot rewrite a group that already exists/);
  });

  test('deactivating is offered as the softer gesture, with the distinction that decides', () => {
    // Somebody leaving a project is not somebody leaving the company, and a
    // product that offers only delete makes the first look like the second.
    assert.match(PROSE, /somebody leaves a project rather than the\s+company/);
    assert.match(SQL, /create or replace function projects\.set_team_default_active/);
  });

  test('the surface repeats it where the person clicking is', () => {
    assert.match(PANEL, /A card keeps the team it was prepared with/);
    assert.match(PANEL, /a group set up in March is not rewritten by a change made today/i);
  });
});

describe('C. the guards every door in this repository carries', () => {
  for (const name of ['add_team_default', 'set_team_default_active', 'remove_team_default']) {
    test(`${name} refuses an unattended caller`, () => {
      const fn = door(name);
      assert.match(fn, /v_actor uuid := \(select auth\.uid\(\)\)/);
      assert.match(fn, /if v_actor is null then/);
      assert.match(fn, /'no_actor'::text/);
    });

    test(`${name} is tenancy-guarded and not callable by the world`, () => {
      assert.match(door(name), /core\.current_organization_id\(\)/);
      assert.match(door(name), /core\.can_write\(\)/);
      assert.match(SQL, new RegExp(`revoke all on function projects\\.${name}\\([^)]*\\) from public;`));
      assert.match(SQL, new RegExp(`grant execute on function projects\\.${name}\\([^)]*\\) to authenticated;`));
    });

    test(`${name} is security definer with an empty search_path`, () => {
      assert.match(door(name), /security definer\s*\nset search_path = ''/);
    });
  }

  test('the two doors that take a row lock it before deciding', () => {
    for (const name of ['set_team_default_active', 'remove_team_default']) {
      assert.match(door(name), /from projects\.group_team_defaults d where d\.id = p_member_id for update/);
    }
  });

  test('but the argument-only refusal comes BEFORE the lock', () => {
    const fn = door('add_team_default');
    assert.ok(fn.indexOf("'invalid_phone'") < fn.indexOf('core.current_organization_id'));
    assert.match(PROSE, /told which field, not which constraint/);
  });

  test('an unknown row is an answer, not a raise', () => {
    for (const name of ['set_team_default_active', 'remove_team_default']) {
      assert.match(door(name), /'unknown_member'::text/);
      assert.doesNotMatch(door(name), /raise exception/);
    }
  });

  test('adding somebody already listed is an answer too', () => {
    // A duplicate is two names for one person in a group of eight — refused,
    // but not with an error: adding somebody who is already there is not a
    // mistake.
    const fn = door('add_team_default');
    assert.match(fn, /'already_listed'::text, v_new/);
    assert.match(fn, /where d\.organization_id = v_org and d\.phone = v_phone/);
    assert.match(PROSE, /not a mistake worth an error/);
  });

  test('the comment carries the full signature, including the optional role', () => {
    // `comment on function projects.add_team_default(text, text, int)` applied
    // cleanly right up to the point it did not: Postgres resolves a comment by
    // exact signature and answers "function does not exist".
    assert.match(SQL, /comment on function projects\.add_team_default\(text, text, text, int\)/);
  });
});

describe('D. the service refuses what the door would, one layer earlier', () => {
  test('every write is owner-gated, because the roster is the agency’s own', () => {
    assert.equal((ROSTER.match(/can\(context\.role, 'organization\.settings'\)/g) ?? []).length, 3);
    assert.match(LAYOUT, /can\(context\.role, 'organization\.settings'\)/);
  });

  test('already_listed is a success, not an error', () => {
    // A person adding a colleague who is already there has not failed at
    // anything, and telling them they have sends them looking for a problem.
    assert.match(ROSTER, /case 'already_listed':/);
    assert.match(ROSTER, /return ok\(\{ memberId: row!\.member_id!, added: false \}\)/);
    assert.match(ROSTER, /That number is already on the roster\.|already on the roster/);
  });

  test('invalid_phone names the field rather than the constraint', () => {
    assert.match(ROSTER, /A WhatsApp number is 6–20 digits/);
  });

  test('the read reports its failure rather than answering "nobody"', () => {
    // An empty roster and an unreadable one look identical on the page, and
    // one of them means every new group card silently loses the team.
    assert.match(QUERIES, /if \(error\) unreadable\('listTeamDefaults', error\)/);
  });

  test('the actions revalidate /settings, where the roster is', () => {
    const actions = read('src/modules/projects/actions.ts');
    const roster = region(actions, 'The internal team roster', "The operational plan");
    assert.equal((roster.match(/revalidatePath\('\/settings'\)/g) ?? []).length, 3);
  });
});

describe('E. the panel does not claim to make a group', () => {
  test('it says AgencyOS cannot add anybody to WhatsApp', () => {
    // ADM-95: Meta refused this WABA the Groups API (#131215). A settings page
    // listing "team members" reads as membership unless it says otherwise.
    assert.match(PANEL, /AgencyOS cannot add anybody to a WhatsApp group/);
    assert.match(PANEL.replace(/\n\s*\*\s?/g, ' '), /Meta refused this WABA the Groups API \(#131215, ADM-95\)/);
  });

  test('and it sends nothing itself', () => {
    assert.doesNotMatch(PANEL, /sendWhatsApp|dispatchMessage|fetch\(/);
  });

  test('an empty roster says what that means, not just that it is empty', () => {
    assert.match(PANEL, /every group card so far has carried only the client’s contacts/);
  });

  test('the page renders it and reads it server-side', () => {
    assert.match(PAGE, /const teamDefaults = await listTeamDefaults\(\)/);
    assert.match(PAGE, /<TeamRosterPanel members=\{teamDefaults\} \/>/);
  });
});
