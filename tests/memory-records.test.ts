import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Document 05 — AI Agent Memory & Context System — is thirteen pages and had
 * no tables. Doc 21 §41 names `memory_records` among the canonical entities;
 * nothing created it.
 *
 * Memory is the layer where a model's guess turns into a client fact if
 * nobody stops it. Doc 05 §35 is the sentence the table is built around:
 * *"Never store a model-generated assumption as a verified client fact
 * without provenance."*
 *
 * Behaviour is proved against real Postgres in `scripts/verify-memory.mjs`.
 * These pin the decisions.
 */

const migration = readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url)))
  .filter((f) => f.includes('memory_that_cannot_promote_itself'))
  .map((f) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8'))
  .join('\n');

describe('A. the confidence ladder is Doc 05 §18, exactly', () => {
  test('all six classes exist, and no seventh', () => {
    // Read the CHECK list alone. A slice from the column would also catch the
    // default's own `'inferred'` and report a seventh class that is the same
    // word twice — a test failing on its own parser rather than on the schema.
    const list = migration.match(/check \(confidence in\s*\n?\s*\(([^)]*)\)\)/);
    assert.ok(list?.[1], 'the confidence CHECK is gone');
    const listed = [...(list[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      [...listed].sort(),
      ['conflicted', 'explicit', 'inferred', 'stale', 'temporary', 'verified'],
    );
  });

  test('and the default is the weakest useful one', () => {
    // `inferred` — a row that says nothing about where it came from claims
    // nothing more than that a model produced it.
    assert.match(migration, /confidence\s+text not null default 'inferred'/);
  });
});

describe('B. two rules that are structural, not advisory', () => {
  test('a claim to come from somewhere must say where', () => {
    assert.match(migration, /memory_claimed_provenance_is_recorded/);
    assert.match(migration, /confidence not in \('explicit', 'verified'\)/);
    assert.match(migration, /source_kind is not null and source_id is not null/);
  });

  test('an agent may never write verified', () => {
    // The memory version of a producer verifying its own work — the thing
    // ADM-82 forbids everywhere else in this system.
    assert.match(migration, /memory_agent_cannot_verify/);
    assert.match(migration, /authored_by_agent is null or confidence <> 'verified'/);
  });

  test('nor promote its own row to explicit afterwards', () => {
    // The CHECK covers `verified`; the trigger covers the walk upward.
    assert.match(migration, /an agent-authored memory cannot become explicit/);
  });
});

describe('C. a correction supersedes, it does not overwrite', () => {
  test('superseding is a one-way door', () => {
    assert.match(migration, /a superseded memory stays superseded/);
  });

  test('superseded content is history', () => {
    assert.match(migration, /a superseded memory is history; write a new one instead/);
  });

  test('and nothing is deleted', () => {
    assert.match(migration, /a memory is superseded, never deleted/);
  });
});

describe('D. recall applies the same scope as the data', () => {
  test('it is SECURITY INVOKER, so RLS is the authorization', () => {
    // Doc 21 §27. A definer function here would be a way around the policy —
    // the class `db:verify:invokerrls` exists to catch.
    const fn = migration.slice(migration.indexOf('function ai.recall'));
    assert.match(fn.slice(0, 400), /security invoker/);
  });

  test('superseded and expired rows are never returned', () => {
    const fn = migration.slice(migration.indexOf('function ai.recall'));
    assert.match(fn, /m\.superseded_by is null/);
    assert.match(fn, /m\.expires_at is null or m\.expires_at > now\(\)/);
  });

  test('and what a client said outranks what a model guessed', () => {
    const fn = migration.slice(migration.indexOf('function ai.recall'));
    assert.match(fn, /when 'explicit'\s+then 0/);
    assert.match(fn, /when 'inferred'\s+then 3/);
  });

  test('the row count is bounded, because context is not a dump', () => {
    // Doc 05 §19: relevant context dynamically, not all history in every call.
    const fn = migration.slice(migration.indexOf('function ai.recall'));
    assert.match(fn, /least\(coalesce\(p_limit, 50\), 200\)/);
  });
});

describe('E. it is checked where it will actually run', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workflow = readFileSync(
    fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url)),
    'utf8',
  );

  test('package.json exposes it and CI runs it', () => {
    assert.match(pkg.scripts['db:verify:memory'] ?? '', /verify-memory\.mjs/);
    assert.match(workflow, /npm run db:verify:memory/);
  });

  test('the table carries its tenancy guards', () => {
    assert.match(migration, /freeze_org_memory_records/);
    assert.match(migration, /core\.enforce_parent_org\('superseded_by'/);
  });
});
