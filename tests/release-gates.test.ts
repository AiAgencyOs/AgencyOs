import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('evidence_is_not_confidence'))
  .map((f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8'))
  .join('\n');

/**
 * Evidence is not confidence.
 *
 * Doc 14 §31 lists nine ways a system lies to itself about being ready. The
 * refusals are constraints and triggers, proved against real Postgres by
 * `db:verify:gates`. What this file protects is the two judgements underneath
 * them, both of which read as omissions to somebody who does not know why:
 * that NO readiness score is computed, and that an unknown gate reports
 * `undecided` rather than passing.
 */
describe('Doc 14 — release gates, and the score that is deliberately absent', () => {
  test('no readiness score is computed anywhere', () => {
    assert.ok(migration, 'the migration is missing');
    // §19: "The scoring model and weights are configurable in the Admin Policy
    // Engine." §20's bands are labelled *Suggested*. Nobody has configured
    // any of it, and a weight invented here would be the business rule being
    // invented rather than implemented — the same refusal ADM-88 made about
    // lead scoring, for the same reason.
    //
    // §31 also makes the score the least interesting part: "A high score
    // cannot override a hard safety or quality gate."
    //
    // Checked against the SQL with comments stripped. A first draft matched the
    // word "weight" over the whole file and fired on this migration's own
    // paragraph explaining why there are none — a check that fires on the
    // documentation of a prohibition is one people learn to skip, and this
    // repository has now written that sentence three times.
    // `comment on ... is '...'` is documentation too, and it is where the
    // second draft still found the word — inside this migration's own
    // explanation of why no weight exists. Both forms of prose come out.
    const sql = migration
      .replace(/comment on [\s\S]*?';/g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    assert.doesNotMatch(sql, /\b(weight|readiness_score|band)\b/i, 'the SQL names a weight or a band');
    assert.doesNotMatch(sql, /score\s+(?:int|numeric|smallint|real)/i, 'a score is stored');
    assert.doesNotMatch(sql, /\bsum\([^)]*\*/, 'a weighted aggregate is computed');
  });

  test('a gate with no evidence is undecided, never passing', () => {
    // The whole shape of the reading. A readiness report that resolves the
    // unknown in its own favour is how false production readiness happens,
    // and §31 is a list of exactly that mistake told nine ways.
    assert.match(migration, /'pass' \| 'fail' \| 'undecided'/);
    const undecided = [...migration.matchAll(/'([a-z_]+)', 'undecided'/g)].map((m) => m[1]);
    // The six Doc 14 §21 names that AgencyOS records nothing for. Listed
    // rather than omitted: a gate that disappears from the report reads as met.
    assert.deepEqual(new Set(undecided), new Set([]));
    for (const gate of ['security_gates', 'performance_gates', 'migration_validation',
                        'deployment_config_valid', 'rollback_plan', 'client_acceptance']) {
      assert.ok(migration.includes(`'${gate}'`), `Doc 14 §21's ${gate} is not reported at all`);
    }
    assert.match(migration, /select g, 'undecided'/);
  });

  test('skipped is its own column and the arithmetic has to close', () => {
    // §31: "Skipped tests are not passes." Without the constraint a run can
    // report 100 passed of 100 while 30 were skipped, which is the sentence
    // written as a row.
    assert.match(migration, /skipped\s+int not null default 0/);
    assert.match(migration, /check \(passed \+ failed \+ skipped = total\)/);
    // And the gate counts a suite only when nothing failed AND nothing was
    // skipped — the constraint alone would let an honest skip through.
    assert.match(migration, /r\.failed > 0 or r\.skipped > 0/);
  });

  test('evidence names the exact build, so a new build inherits nothing', () => {
    // §31: "Do not approve a build different from the tested build."
    // projects.deliverables is unique per (project, kind, version), so naming
    // the row names the version.
    assert.match(migration, /deliverable_id\s+uuid not null references projects\.deliverables/);
    assert.match(migration, /refuse_non_build_test_run/);
  });

  test('an agent-authored run must point at something a human can open', () => {
    // §31: "Never use agent confidence as evidence." The rule binds the author
    // who cannot be asked afterwards — Doc 14 §18 admits manual testing, so a
    // person recording a manual run may have no URL.
    assert.match(migration, /test_runs_agent_evidence_is_external/);
    assert.match(migration, /executed_by_agent is null\s*\n?\s*or \(evidence_url is not null/);
  });

  test('UPDATE and DELETE are not the same rule, and the migration says which is which', () => {
    // A first draft refused both row-by-row, which also refused the
    // `on delete cascade` from projects.projects — so a project that had ever
    // been tested could not be deleted, and the verification script's cleanup
    // failed silently on every run while reporting all checks passed.
    assert.match(migration, /create trigger refuse_test_run_rewrite\s+before update on qa\.test_runs/);
    assert.doesNotMatch(migration, /refuse_test_run_rewrite\s+before update or delete/);
    // DELETE goes through the helper this repository already has for it.
    assert.match(migration, /test_runs_reject_end_user_delete[\s\S]*?core\.reject_end_user_delete/);
    // And the grant is what makes the claim true of the service role, which
    // that helper deliberately exempts. Saying so matters more than the rule
    // reading well.
    assert.match(migration, /grant select, insert on qa\.test_runs/);
    assert.doesNotMatch(migration, /grant[^;]*update[^;]*on qa\.test_runs/);
  });

  test('the ADM-19 reading is left alone', () => {
    // ADM-19 settled what "production ready" is allowed to mean. Doc 14 §21's
    // eleven gates are about DEPLOYMENT, which AgencyOS has no engine for.
    // Folding them into ADM-19's three would be re-deciding a granted decision
    // from a document talking about something else.
    assert.doesNotMatch(migration, /create or replace function projects\.production_readiness/);
    assert.doesNotMatch(migration, /create or replace function projects\.mark_production_ready/);
  });
});
