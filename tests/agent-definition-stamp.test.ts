import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The validation stamp — gap G-130.
 *
 * ADM-83 granted `ai.agents.definition_version` and `last_validated_at`, and
 * nothing ever wrote either. Every row in every environment read `null`, which
 * the column comment defines as *never validated*: two fields carrying a fact
 * no producer produced.
 *
 * The producer is `scripts/verify-agent-definitions.mjs`, and it needs a live
 * database — so these tests pin the properties that a passing run would not
 * demonstrate on its own, chiefly the refusals.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const script = read('../scripts/verify-agent-definitions.mjs');
const pkg = JSON.parse(read('../package.json'));
const workflow = read('../.github/workflows/verify.yml');
const migration = read('../supabase/migrations/20260814120002_an_agent_that_cannot_run_says_why.sql');

describe('A. a stamp is never written for a row that did not verify', () => {
  test('the stamping loop is unreachable while any check has failed', () => {
    // The property this whole script stands on. A validation claim written
    // onto a drifted row is worse than the null it replaces, because it puts
    // "checked and agreed" on the one row that needs attention.
    const guard = script.indexOf('if (failures > 0)');
    const firstPatch = script.indexOf("rest('PATCH'");
    assert.ok(guard > 0, 'there is no failure guard before stamping');
    assert.ok(firstPatch > guard, 'a PATCH is reachable before the failure guard');
    assert.match(script, /nothing was stamped/);
  });

  test('and it exits non-zero rather than reporting a partial success', () => {
    const tail = script.slice(script.indexOf('if (failures > 0)'));
    assert.match(tail, /process\.exit\(1\)/);
  });
});

describe('B. it refuses rather than repairs', () => {
  test('nothing in the script writes enabled, disabled_reason or autonomy_level', () => {
    // Whether a drifted row is wrong or the registry is, is a deployment
    // question. Guessing either way silently changes what an operator's
    // system does — so this reports and stops.
    const patches = [...script.matchAll(/rest\('PATCH'[^)]*\)/g)].map((m) => m[0]);
    assert.ok(patches.length > 0, 'the script never writes anything, so it cannot be a producer');
    for (const forbidden of ['enabled', 'disabled_reason', 'autonomy_level']) {
      assert.ok(
        !new RegExp(`${forbidden}\\s*:`).test(script.slice(script.indexOf('const stampable'))),
        `the script writes ${forbidden}, which is a repair rather than a verification`,
      );
    }
  });

  test('an empty registry parse fails loudly instead of stamping against nothing', () => {
    // A parser that drifts and finds no definitions would otherwise mark every
    // enabled row as validated against an empty registry — a check passing for
    // the worst possible reason.
    assert.match(script, /if \(defined\.size === 0\)/);
    assert.match(script, /a check that finds nothing would stamp every row/);
  });
});

describe('C. the stamp means what the column says it means', () => {
  test('the version is a hash of registry.ts, which is what the column documents', () => {
    // "Which revision of src/modules/agents/registry.ts this row was last
    // validated against." So it hashes the file, not one agent's fields.
    assert.match(script, /createHash\('sha256'\)\.update\(registrySource\)/);
    assert.match(migration, /Which revision of src\/modules\/agents\/registry\.ts/);
  });

  test('a git SHA was not used, and the reason is recorded', () => {
    // It would move on every unrelated commit, reporting drift where none
    // exists and training a reader to ignore the column.
    assert.match(script, /git SHA was rejected/);
  });

  test('both halves of the claim are written together', () => {
    // ADM-83's constraint: a version and a time, or neither. Half of one reads
    // as validated to anybody scanning.
    const stamp = script.slice(script.indexOf('const stampable'));
    assert.match(stamp, /definition_version:\s*VERSION/);
    assert.match(stamp, /last_validated_at:/);
    assert.match(migration, /check \(\(definition_version is null\) = \(last_validated_at is null\)\)/);
  });

  test('and the result is read back rather than inferred from a status code', () => {
    // A PATCH that wrote only half would otherwise be reported as success.
    assert.match(script, /no row claims validation with only half a claim/);
  });
});

describe('D. it is wired where it will actually run', () => {
  test('package.json exposes it', () => {
    assert.equal(pkg.scripts['db:verify:definitions'], 'node scripts/verify-agent-definitions.mjs');
  });

  test('and CI runs it against a real database', () => {
    // A verification script nobody runs is documentation with a shebang.
    assert.match(workflow, /npm run db:verify:definitions/);
    assert.match(workflow, /Agent definitions — G-130/);
  });
});

describe('E. it checks the half the static check cannot', () => {
  test('it reads live rows rather than the seed', () => {
    // check-record §14 proves the seed matches the registry. Enabling an agent
    // is an UPDATE by design, so a live row can diverge with no diff to review.
    assert.match(script, /rest\('GET', 'agents\?select=/);
    assert.ok(!/seed\.sql/.test(script), 'the script reads the seed, which check-record already covers');
  });

  test('and it checks the live handoff mirror too', () => {
    assert.match(script, /agent_handoff_targets\?select=from_agent,to_agent/);
  });
});
