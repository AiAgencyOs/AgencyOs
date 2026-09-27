import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { region } from './_region.ts';

/**
 * Phase 4 master checklist, P4-INFRA-03. `projects.prototype_artifacts` had
 * no status column at all — its lifecycle was inferred only from
 * `qa_reviewed_at is null`. This migration adds one, deliberately smaller
 * than `ui_versions.status`: this table has no lifecycle beyond QA coverage,
 * client/admin review state lives on the linked `deliverables.status`
 * (already guarded since 20260815210000), and this must not duplicate that
 * machine. Verified end to end against a real scratch Postgres before this
 * file was written: record_prototype_qa_verdict now writes status alongside
 * qa_findings/qa_reviewed_at, and qa_pass->draft is rejected by the trigger.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql', import.meta.url),
  ),
  'utf8',
);

const guard = region(migration, 'function projects.enforce_prototype_artifact_status_transition');
const door = region(migration, 'function projects.record_prototype_qa_verdict');

describe('prototype_artifacts gets a real status, not just qa_reviewed_at is null', () => {
  test('the vocabulary is smaller than ui_versions — no client/admin review states duplicated here', () => {
    assert.match(migration, /check \(status in \('draft', 'qa_pass', 'qa_changes_required'\)\)/);
  });

  test('the only legal edges are draft -> qa_pass and draft -> qa_changes_required', () => {
    assert.match(guard, /old\.status = 'draft' and new\.status in \('qa_pass', 'qa_changes_required'\)/);
  });

  test('qa_pass and qa_changes_required are terminal for this row — revise_prototype_build starts a new one', () => {
    assert.doesNotMatch(guard, /old\.status = 'qa_pass'/);
    assert.doesNotMatch(guard, /old\.status = 'qa_changes_required'/);
  });

  test('record_prototype_qa_verdict writes status in the same statement as qa_findings/qa_reviewed_at', () => {
    assert.match(door, /set status = p_outcome,\s*qa_findings = p_findings,\s*qa_reviewed_at = now\(\)/);
  });

  test('it raises restrict_violation on an illegal move', () => {
    assert.match(guard, /using errcode = 'restrict_violation'/);
  });
});
