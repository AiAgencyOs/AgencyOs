import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Modules and test access — Phase 12, gaps G-024 and G-025.
 *
 * Directive §16 describes a build as customer app, delivery app, vendor,
 * admin, backend — and `projects.tasks` was a flat list, so "how is the vendor
 * panel going" had no answer the system could give.
 *
 * The behaviour is proved against a real database by
 * `scripts/verify-modules.mjs`. Pinned here: that the task state machine was
 * not duplicated, and that a build's test access cannot carry the credentials.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120004_modules.sql', import.meta.url)),
  'utf8',
);

const tasksMigration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260807120006_projects.sql', import.meta.url)),
  'utf8',
).includes('projects.tasks')
  ? 'found'
  : 'elsewhere';

describe('A. the existing state machine is not duplicated', () => {
  test('modules use directive §16’s vocabulary, which is coarser than a task’s', () => {
    for (const status of [
      'not_started',
      'planned',
      'in_progress',
      'code_review',
      'qa',
      'ready_for_client',
      'approved',
    ]) {
      assert.ok(migration.includes(`'${status}'`), `${status} is missing from the module statuses`);
    }
  });

  test('and the task statuses are left exactly as they were', () => {
    // Directive §16: "Do not invent statuses if an existing state machine
    // already exists." Tasks had one; this migration must not touch it.
    assert.ok(
      !/alter table projects\.tasks[\s\S]{0,200}status/i.test(migration),
      'the task status vocabulary was altered',
    );
    assert.equal(tasksMigration, 'found', 'the tasks table still lives where it did');
  });

  test('module_id on a task is nullable, because back-filling by guess is worse', () => {
    assert.match(migration, /add column if not exists module_id uuid references projects\.modules/);
    assert.ok(!/module_id uuid not null/.test(migration));
  });
});

describe('B. nothing is cross-wired between projects', () => {
  test('a task cannot name a module from another project', () => {
    // module_id and project_id are separate references, so no foreign key says
    // this. Without the trigger a task would appear in another project's
    // progress — the shape D22 was.
    assert.match(migration, /tasks_module_guard/);
    assert.match(migration, /that module belongs to another project/);
  });

  test('and neither can a deliverable', () => {
    assert.match(migration, /'wrong_module'::text/);
  });

  test('a module name is unique within its project, and only within it', () => {
    assert.match(migration, /unique \(project_id, name\)/);
  });
});

describe('C. test access carries no credentials — G-025, directive §17 and §22', () => {
  test('the column refuses the shapes somebody actually pastes', () => {
    assert.match(migration, /deliverables_test_access_shape/);
    assert.match(migration, /\(password\|passwd\)/);
    assert.match(migration, /pin\\s\*\[:=\]/);
    assert.match(migration, /api\[_ -\]\?key\|secret\|token/);
  });

  test('and it is honest about what that check is', () => {
    // A regex is not a secret detector. It stops the accident, not a
    // determined author, and the comment says so rather than implying
    // protection nobody has.
    assert.match(migration, /Not a secret detector, and not pretending to be one/);
  });

  test('a recorded build’s access instructions are immutable like the rest of it', () => {
    const guard = migration.slice(migration.indexOf('function projects.deliverables_guard'));
    assert.match(guard.slice(0, 1500), /new\.test_access_method is distinct from old\.test_access_method/);
  });
});

describe('D. where the project actually is', () => {
  test('progress counts tasks and the open defects against builds of each module', () => {
    assert.match(migration, /function projects\.module_progress/);
    assert.match(migration, /from qa\.defects d[\s\S]{0,200}dv\.module_id = m\.id/);
  });

  test('ordering is explicit, because "backend" comes before "admin panel" in the plan', () => {
    assert.match(migration, /order by m\.position, m\.name/);
  });

  test('a client may see the shape of their build, not the tasks underneath', () => {
    assert.match(migration, /core\.is_client\(\)/);
    const policies = migration.match(/create policy \w+ on projects\.modules/g) ?? [];
    assert.equal(policies.length, 2);
  });
});
