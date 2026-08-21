import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('attractive_but_incomplete'))
  .map((f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8'))
  .join('\n');

/**
 * Attractive, but incomplete.
 *
 * Doc 12 §9: *"This matrix is one of the main controls preventing an AI
 * designer from producing attractive but incomplete work."*
 *
 * The refusals themselves are triggers and are proved against real Postgres by
 * `db:verify:uicoverage`. What this file protects is the LINE — which of Doc
 * 12 §20's ten conditions block and which are only reported. That line is a
 * judgement about what the documents actually define, and a judgement is
 * exactly the kind of thing that erodes without a test naming it.
 */
describe('Doc 12 — the screen coverage matrix', () => {
  test('the migration exists and builds both halves of the link', () => {
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /create table if not exists projects\.screens/);
    // A screen may cover several scope items and a scope item may need several
    // screens, so the mapping is a join table rather than a column on either.
    assert.match(migration, /create table if not exists projects\.screen_scope_items/);
    assert.match(migration, /primary key \(screen_id, scope_item_id\)/);
  });

  test('exactly three conditions block, and they are the three Doc 12 §20 states exactly', () => {
    // §20 lists ten. Seven are judgement — "client-specific branding
    // requirements satisfied", "no unresolved material placeholders" — and
    // nobody has configured what they mean. Inventing a threshold for those
    // would be inventing the business rule, which is the one thing the audit
    // mandate forbids outright.
    const blocking = [...migration.matchAll(/select '([a-z_]+)'(?:::text)?, true,/g)].map((m) => m[1]);
    assert.deepEqual(new Set(blocking), new Set([
      'included_scope_item_has_no_screen', // §20 "All major features represented."
      'screen_has_no_scope_mapping',       // §20 "All screens have feature/requirement mapping."
    ]));
    // The third is not a matrix row because it is refused at write time rather
    // than reported at read time: §20 "Excluded features not accidentally
    // designed as commitments." A screen mapped to an exclusion never exists,
    // so there is nothing for the matrix to flag.
    assert.match(migration, /refuse_excluded_screen_mapping/);
    assert.match(migration, /inclusion = 'excluded'/);
  });

  test('and the judgements are reported, never enforced', () => {
    const reported = [...migration.matchAll(/select '([a-z_]+)', false,/g)].map((m) => m[1]);
    assert.deepEqual(new Set(reported), new Set([
      'screen_missing_states',            // §9 says "flag", not "block"
      'optional_scope_item_has_no_screen', // it was agreed as optional
    ]));
  });

  test('the gate is a trigger, not a third rewrite of submit_deliverable', () => {
    // `submit_deliverable` has been re-emitted once already, by the QA
    // migration, to add the blocking-defect refusal. Re-emitting it again to
    // add a third rule is how a branch gets silently dropped — this repository
    // has done exactly that once and recorded it. A row rule also binds every
    // path that moves the row, not only today's single caller.
    assert.doesNotMatch(migration, /create or replace function projects\.submit_deliverable/);
    assert.match(migration, /create trigger refuse_uncovered_design\s+before update of status on projects\.deliverables/);
  });

  test('it fires only for a design, only into review, and only against an agreed baseline', () => {
    const fn = migration.slice(
      migration.indexOf('function projects.refuse_uncovered_design'),
      migration.indexOf('drop trigger if exists refuse_uncovered_design'),
    );
    assert.match(fn, /new\.kind <> 'design'/);
    assert.match(fn, /new\.status <> 'in_review'/);
    // Re-entrancy: a row already in review must not be re-gated by an
    // unrelated update.
    assert.match(fn, /old\.status = 'in_review'/);
    // No baseline means no agreed scope, so there is nothing for the rule to
    // be true or false about. Blocking there would block every design filed
    // before the scope is agreed — most early design work, and something no
    // document asks for.
    assert.match(fn, /scope_versions[\s\S]*?status = 'active'/);
    assert.match(fn, /return new;/);
  });

  test('the fields the matrix reasons about are structured, and the rest are prose', () => {
    // Doc 12 §8 lists eighteen fields. A field §9 flags on cannot be prose —
    // and a nullable jsonb key would answer "unknown", which is the answer
    // that lets incomplete work through.
    for (const column of [
      'has_empty_state    boolean not null default false',
      'has_loading_state  boolean not null default false',
      'has_error_state    boolean not null default false',
      'has_success_state  boolean not null default false',
    ]) {
      assert.ok(migration.includes(column), `missing structured state: ${column}`);
    }
    assert.match(migration, /user_role\s+text not null/);
    // §9 "flag duplicate screens" — refused rather than flagged, because a
    // duplicate id is not a design judgement, it is two rows claiming one name.
    assert.match(migration, /unique \(project_id, screen_key\)/);
  });

  test('both new tables carry the tenancy guards a new org-scoped table needs', () => {
    for (const table of ['screens', 'screen_scope_items']) {
      assert.match(migration, new RegExp(`alter table projects\\.${table} enable row level security`));
      assert.match(migration, new RegExp(`alter table projects\\.${table} force row level security`));
      assert.match(migration, new RegExp(`freeze_org_${table}`));
    }
    // One enforce_parent_org per organization-scoped foreign key, or
    // db:verify:tenancyguards fails in CI and nowhere else.
    for (const fk of ['project_id', 'deliverable_id', 'screen_id', 'scope_item_id']) {
      assert.match(migration, new RegExp(`enforce_parent_org\\('${fk}'`), `no parent-org guard for ${fk}`);
    }
  });
});
