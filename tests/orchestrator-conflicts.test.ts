import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeConflicts,
  HIGH_CONFLICT_PATHS,
  isHighConflictPath,
  leaseScopeKey,
  scopesOverlap,
} from '../src/modules/orchestrator/conflicts.ts';

/**
 * Concurrency and conflict analysis - Orchestrator spec 7. The planning half of a rule the database enforces
 * (`projects.claim_concurrency_lease`); `scripts/verify-phase5-orchestrator.sql` drives the enforcing half on a real Postgres.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('A. what "the same files" means', () => {
  test('a glob is cut at its first wildcard segment, and leading ./ and / are ignored', () => {
    assert.equal(leaseScopeKey('./src/ui/**'), 'src/ui');
    assert.equal(leaseScopeKey('/src/ui/*.tsx'), 'src/ui');
    assert.equal(leaseScopeKey('src\\ui\\button.tsx'), 'src/ui/button.tsx');
    assert.equal(leaseScopeKey('**'), '');
  });

  test('a directory overlaps what is in it, in both directions; src/ui is not src/uikit', () => {
    assert.equal(scopesOverlap(['src/ui'], ['src/ui/button.tsx']), true);
    assert.equal(scopesOverlap(['src/ui/button.tsx'], ['src/ui']), true);
    assert.equal(scopesOverlap(['src/ui'], ['src/uikit/x.ts']), false);
    assert.equal(scopesOverlap(['src/uikit/x.ts'], ['src/ui']), false);
  });

  test('the whole repository overlaps everything', () => {
    assert.equal(scopesOverlap(['**'], ['src/api/x.ts']), true);
  });

  test('two different files under a high-conflict path overlap: one migration sequence', () => {
    assert.equal(scopesOverlap(['supabase/migrations/20261102100001_a.sql'], ['supabase/migrations/20261102100002_b.sql']), true);
    assert.equal(isHighConflictPath('supabase/migrations/20261102100001_a.sql'), true);
    assert.equal(isHighConflictPath('src/ui/button.tsx'), false);
  });
});

describe('B. analyzeConflicts returns what may run in parallel and what must be serialized', () => {
  test('disjoint tasks are all parallel and nothing is serialized', () => {
    const r = analyzeConflicts([
      { id: 'fe', filePaths: ['src/ui/**'] },
      { id: 'be', filePaths: ['src/api/**'] },
      { id: 'docs', filePaths: ['docs/**'] },
    ]);
    assert.deepEqual(r.parallel, ['fe', 'be', 'docs']);
    assert.deepEqual(r.serialized, []);
    assert.deepEqual(r.conflicts, []);
  });

  test('overlapping tasks are serialized together and named with the files they share', () => {
    const r = analyzeConflicts([
      { id: 'a', filePaths: ['src/ui/**'] },
      { id: 'b', filePaths: ['src/ui/button.tsx'] },
      { id: 'c', filePaths: ['src/api/x.ts'] },
    ]);
    assert.deepEqual(r.parallel, ['c']);
    assert.deepEqual(r.serialized, [['a', 'b']]);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]?.reason, 'overlapping_files');
    assert.deepEqual(r.conflicts[0]?.paths, ['src/ui/**']);
  });

  test('two migrations are a high_conflict_path conflict even though their file names differ', () => {
    const r = analyzeConflicts([
      { id: 'm1', filePaths: ['supabase/migrations/20261102100001_a.sql'] },
      { id: 'm2', filePaths: ['supabase/migrations/20261102100002_b.sql'] },
    ]);
    assert.equal(r.conflicts[0]?.reason, 'high_conflict_path');
    assert.deepEqual(r.serialized, [['m1', 'm2']]);
  });

  test('a task that waits for the other is sequenced, not a conflict, directly or through a chain', () => {
    const direct = analyzeConflicts([
      { id: 'a', filePaths: ['src/ui/**'] },
      { id: 'd', filePaths: ['src/ui/**'], dependsOn: ['a'] },
    ]);
    assert.deepEqual(direct.conflicts, []);
    assert.deepEqual(direct.parallel, ['a', 'd'], 'sequenced tasks do not conflict, so neither is held back by the other');

    const chain = analyzeConflicts([
      { id: 'a', filePaths: ['src/ui/**'] },
      { id: 'd', filePaths: ['src/other/**'], dependsOn: ['a'] },
      { id: 'e', filePaths: ['src/ui/button.tsx'], dependsOn: ['d'] },
    ]);
    assert.deepEqual(chain.conflicts, [], 'e waits for d which waits for a: a and e never run at once');
  });

  test('a task that declares no files cannot be proven safe: it is serialized with every other task', () => {
    const r = analyzeConflicts([
      { id: 'a', filePaths: ['src/ui/**'] },
      { id: 'b', filePaths: [] },
      { id: 'c', filePaths: ['src/api/**'] },
    ]);
    assert.deepEqual(r.parallel, []);
    assert.equal(r.conflicts.every((c) => c.reason === 'undeclared_scope'), true);
    assert.deepEqual(new Set(r.serialized[0]), new Set(['a', 'b', 'c']));
  });

  test('a serialized group is ordered dependencies first, otherwise as given', () => {
    const r = analyzeConflicts([
      { id: 'x', filePaths: ['src/a'], dependsOn: ['y'] },
      { id: 'y', filePaths: ['src/a'] },
      { id: 'z', filePaths: ['src/a'] },
    ]);
    assert.deepEqual(r.serialized, [['y', 'x', 'z']]);
    assert.equal(r.conflicts.some((c) => (c.a === 'x' && c.b === 'y') || (c.a === 'y' && c.b === 'x')), false, 'x and y are sequenced, not in conflict');
  });

  test('a cycle in the declared dependencies does not hang the analysis', () => {
    const r = analyzeConflicts([
      { id: 'a', filePaths: ['x'], dependsOn: ['b'] },
      { id: 'b', filePaths: ['x'], dependsOn: ['a'] },
    ]);
    assert.deepEqual(r.conflicts, []);
  });
});

describe('C. the TypeScript list and the database list are one list', () => {
  const migration = read('supabase/migrations/20261102100000_two_agents_do_not_hold_the_same_files_and_a_refused_tool_call_is_audited.sql');

  test('HIGH_CONFLICT_PATHS equals projects.high_conflict_paths()', () => {
    const start = migration.indexOf('create or replace function projects.high_conflict_paths()');
    assert.ok(start >= 0, 'the SQL list is declared');
    const open = migration.indexOf('select array[', start);
    assert.ok(open > start, 'the SQL list opens');
    const end = migration.indexOf(']::text[]', open);
    assert.ok(end > start, 'the SQL list ends');
    const sqlList = [...migration.slice(open, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...sqlList].sort(), [...HIGH_CONFLICT_PATHS].sort());
  });

  test('the SQL key function cuts at the same wildcard characters as the TypeScript one', () => {
    assert.match(migration, /exit when v_segment ~ '\[\*\?\\\[\{\]'/);
  });
});
