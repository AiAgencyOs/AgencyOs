import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A guard that cannot fail open — G-281.
 *
 * `core.current_user_role()` reads the role out of the access token, and a
 * token with no role makes it NULL. Every one of the four role predicates is
 * `current_user_role() in (...)`, so each is **NULL** for such a caller — and
 * `not NULL` is NULL, which plpgsql's `if` does not execute. A guard written
 * `if ... or not (select core.can_write()) then refuse` therefore **falls
 * through**.
 *
 * Forty-eight functions were written that way. This is the migration that
 * coalesces all of them, and — more durably — the check that makes the
 * forty-ninth occurrence fail in CI.
 *
 * **The migration was generated, not typed.** G-303's near-miss was one
 * function rewritten from memory: a dropped rule, a dropped event, two
 * renamed outcomes and a changed return arity, none of it intended. Forty-
 * eight functions is forty-eight chances to do that again, so every body in
 * the file is `pg_get_functiondef` read back from a database with every
 * migration applied, with one counted substitution.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260920100000_forty_eight_guards_that_could_fail_open.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const SCRIPT = read('scripts/verify-fail-open-guards.mjs');
const WORKFLOW = read('.github/workflows/verify.yml');
const PKG = read('package.json');

const PREDICATES = ['is_admin', 'is_owner', 'can_write', 'is_internal'] as const;

describe('A. every uncoalesced guard is gone, and the count is the point', () => {
  test('the file coalesces forty-eight guards — and exactly that many', () => {
    // The pattern matched forty-nine times across the forty-eight functions.
    // The forty-ninth was never a guard: it was a sentence of prose in
    // `crm.cancel_meeting` explaining why the check reads `can_write()` and
    // not `is_internal()`, which the substitution rewrote into something the
    // author did not say. That line was reworded by hand and the migration
    // says so, because an undisclosed hand edit in a file that claims to be
    // generated is worth more than the edit itself.
    const fixed = SQL.match(/not coalesce\(\(select core\.(?:is_admin|is_owner|can_write|is_internal)\(\)\), false\)/g) ?? [];
    assert.equal(fixed.length, 48);
    assert.match(MIGRATION, /-- core\.can_write\(\) rather than core\.is_internal\(\), because review found the first/);
    assert.match(PROSE, /the forty-ninth match was never\s+a guard/);
  });

  test('and leaves none of the uncoalesced form behind', () => {
    // Including in its own prose: the check below scans whole bodies, so a
    // comment quoting the bad form would fail it.
    assert.doesNotMatch(SQL, /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal)\s*\(/);
    assert.doesNotMatch(SQL, /not\s+core\.(?:is_admin|is_owner|can_write|is_internal)\s*\(/);
  });

  test('all four NULL-capable predicates are covered', () => {
    for (const p of PREDICATES) {
      assert.match(SQL, new RegExp(`not coalesce\\(\\(select core\\.${p}\\(\\)\\), false\\)`), `${p} is not covered`);
    }
  });

  test('and `is_known_timezone` is deliberately left alone', () => {
    // It is `p_zone is not null and exists (...)`, so it cannot be NULL.
    // Coalescing it would be a change made because a regex matched.
    assert.doesNotMatch(SQL, /coalesce\(\(select core\.is_known_timezone/);
  });
});

describe('B. it was generated from the live definitions, not rewritten', () => {
  test('the file says so, and says why', () => {
    assert.match(PROSE, /So nothing here was typed/);
    assert.match(PROSE, /`pg_get_functiondef` read back from a database with every migration applied/);
    assert.match(PROSE, /Forty-eight functions is forty-eight chances to do that again/);
  });

  test('the substitution was counted per function, not hoped for', () => {
    // A substitution that silently did nothing would otherwise pass.
    assert.match(PROSE, /gains\s+exactly as many `coalesce\(\(select core\.` as the pattern matched/);
  });

  test('and Postgres’s own rendering is kept rather than reformatted', () => {
    // A formatting pass over generated text is another chance to change
    // something by hand.
    assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION/);
    assert.match(PROSE, /a formatting pass over generated\s+text is another chance to change something by hand/i);
  });

  test('every statement is a replacement — nothing is created, dropped or altered', () => {
    // `create or replace` preserves each function's grants and its comment,
    // so the ACL surface is untouched. A `drop` here would silently discard
    // both.
    assert.doesNotMatch(SQL, /^\s*(drop|alter|create table|create index)\b/im);
    assert.doesNotMatch(SQL, /\bdrop function\b/i);
    assert.match(PROSE, /preserves each function's grants and\s+its comment/);
  });
});

describe('C. the standing check', () => {
  test('it returns the offending functions, both spellings', () => {
    assert.match(SQL, /create or replace function core\.fail_open_authority_guards\(\)/);
    assert.match(SQL, /returns table \(\s*\n\s*schema_name\s+text,\s*\n\s*function_name text,\s*\n\s*arguments\s+text,\s*\n\s*occurrences\s+int\s*\n\s*\)/);
    // `not X(` and `not (select X(` alike — and asserted TWICE, because the
    // pattern appears in the `where` and in the count, and pinning one leaves
    // the other free to narrow.
    const pattern = SQL.match(/'not\\s\+\(\\\(\\s\*select\\s\+\)\?core\\\.\(is_admin\|is_owner\|can_write\|is_internal\)\\s\*\\\('/g) ?? [];
    assert.equal(pattern.length, 2);
  });

  test('it scans whole bodies, comments included, and that is deliberate', () => {
    // Its own first draft failed its own check, because the comment spelled
    // out the bad form as an example.
    assert.match(PROSE, /the first draft of this\s+function failed its own check for exactly that reason/);
    assert.match(PROSE, /narrowing the scan to\s+exclude comments would hide a guard somebody commented out and left/);
  });

  test('and it is not callable by the public', () => {
    assert.match(SQL, /revoke all on function core\.fail_open_authority_guards\(\) from public, anon;/);
    assert.match(SQL, /grant execute on function core\.fail_open_authority_guards\(\) to authenticated, service_role;/);
  });

  test('PostgREST is told to reload, or the RPC does not exist to a caller', () => {
    assert.match(SQL, /notify pgrst, 'reload schema';/);
  });
});

describe('D. it is proved by calling doors, not by reading them', () => {
  test('the script mints the token the sign-in hook cannot produce', () => {
    // organization_id and no role — the exact shape the gap is about.
    assert.match(SCRIPT, /app_metadata: role === undefined\s*\n\s*\? \{ organization_id: ORG, audience: 'internal' \}/);
  });

  test('a refusal is asserted for each predicate shape, with the state behind it', () => {
    assert.match(SCRIPT, /set_organization_name \(is_owner\) refuses it/);
    assert.match(SCRIPT, /add_team_default \(can_write\) refuses it/);
    // Not just the outcome string: nothing was written.
    assert.match(SCRIPT, /and the agency name is unchanged/);
    assert.match(SCRIPT, /and no team default was written/);
  });

  test('and every refusal has its positive twin', () => {
    // A refusal test alone stays green against a door that refuses
    // everybody, which is an outage rather than a fix.
    assert.match(SCRIPT, /set_organization_name accepts an owner/);
    assert.match(SCRIPT, /add_team_default accepts an owner/);
    assert.match(SCRIPT, /A refusal test alone\s*\n \*\s+passes just as well against a door that refuses everybody/);
  });

  test('the catalogue check is asserted empty, and names what it found', () => {
    assert.match(SCRIPT, /'and it returns no functions'/);
    assert.match(SCRIPT, /rows\.map\(\(x\) => `\$\{x\.schema_name\}\.\$\{x\.function_name\}\(\$\{x\.arguments\}\)`\)\.join\(', '\)/);
  });

  test('and it runs in CI, where a forty-ninth occurrence will fail', () => {
    assert.match(PKG, /"db:verify:failopen": "node scripts\/verify-fail-open-guards\.mjs"/);
    assert.match(WORKFLOW, /run: npm run db:verify:failopen/);
  });
});

describe('E. no other migration reintroduces the form', () => {
  test('nothing written after this one negates a role predicate uncoalesced', () => {
    // The live check is the real guard — it reads what is installed, not what
    // a file says. This is the cheap half: a new migration with the old habit
    // fails here in seconds rather than in the live job.
    const dir = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
    const THIS = '20260920100000_forty_eight_guards_that_could_fail_open.sql';
    const later = readdirSync(dir).filter((f) => f.endsWith('.sql') && f > THIS);
    const offenders = later.filter((f) =>
      /not\s+\(\s*select\s+core\.(?:is_admin|is_owner|can_write|is_internal)\s*\(/.test(
        readFileSync(`${dir}/${f}`, 'utf8').replace(/^\s*--.*$/gm, ''),
      ));
    assert.deepEqual(offenders, []);
  });

  test('and the sweep is looking at a real list of files', () => {
    // Zero files would make the assertion above pass on nothing at all.
    const dir = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
    assert.ok(readdirSync(dir).filter((f) => f.endsWith('.sql')).length > 200);
  });
});
