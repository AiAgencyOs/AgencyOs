import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { region } from './_region.ts';

/**
 * Phase 4 master checklist, P4-INFRA-03. `projects.ui_versions.status`
 * already declared a full 11-value CHECK constraint; nothing enforced which
 * values may follow which. This migration adds that as a database-layer
 * trigger, traced off every door that writes the column (see its own header)
 * rather than designed fresh — the graph asserted here is a record of what
 * was actually verified against a real scratch Postgres
 * (`scripts/apply-migrations-locally.sh`, KEEP=1) before this file was
 * written: a legal chain draft→qa_pass→admin_review→admin_approved→
 * client_review→client_approved→locked succeeded end to end, and
 * qa_pass→locked (skipping every gate) was rejected.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql', import.meta.url),
  ),
  'utf8',
);

const guard = region(migration, 'function projects.enforce_ui_version_status_transition');

describe('the UI version transition graph is exactly what the doors already enforce', () => {
  test('the trigger fires before update, for each row', () => {
    assert.match(migration, /before update on projects\.ui_versions/);
    assert.match(migration, /for each row execute function projects\.enforce_ui_version_status_transition/);
  });

  test('every legal edge this repo\'s doors actually write is admitted', () => {
    const edges: Array<[string, string]> = [
      ['draft', 'qa_pass'],
      ['draft', 'qa_changes_required'],
      ['qa_pass', 'admin_review'],
      ['admin_review', 'admin_approved'],
      ['admin_review', 'admin_edit'],
      ['admin_approved', 'client_review'],
      ['client_review', 'client_approved'],
      ['client_review', 'client_change'],
      ['client_change', 'client_approved'],
      ['client_approved', 'locked'],
    ];
    for (const [from, to] of edges) {
      assert.match(
        guard,
        new RegExp(`old\\.status = '${from}'[\\s\\S]{0,40}new\\.status[\\s\\S]{0,40}${to}`),
        `missing edge ${from} -> ${to}`,
      );
    }
  });

  test('a version cannot skip straight to locked from anywhere but client_approved', () => {
    // The one edge every door's own guard exists to prevent — asserted
    // directly rather than only by absence, per this repo's own rule that an
    // absence-only test stays green after the feature it guards is removed.
    assert.doesNotMatch(guard, /old\.status = 'qa_pass'[\s\S]{0,40}new\.status[\s\S]{0,40}'locked'/);
    assert.doesNotMatch(guard, /old\.status = 'draft'[\s\S]{0,60}'locked'/);
  });

  test('it raises restrict_violation, not a bare exception a caller could swallow', () => {
    assert.match(guard, /using errcode = 'restrict_violation'/);
  });

  test('qa_changes_required, client_change and admin_edit have no outgoing edge — revise_ui_version starts a new row instead', () => {
    assert.doesNotMatch(guard, /old\.status = 'qa_changes_required'/);
    assert.doesNotMatch(guard, /old\.status = 'admin_edit'/);
  });
});
