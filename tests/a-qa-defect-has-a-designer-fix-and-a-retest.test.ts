import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * QA DEFECT -> DESIGNER FIX -> QA RETEST (Phase 4 UI Designer / QAP defect flows). The behavioural proof is
 * scripts/verify-phase-four-qa-fix-loop.sql, red-proven against a real Postgres; this is the text-level guard that the loop is
 * reachable (the defect class this repository keeps finding: built and unreachable).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const migration = read('supabase/migrations/20261031120000_a_qa_defect_has_a_designer_fix_and_a_retest.sql');
const workflows = read('app/api/jobs/run/workflows.ts');

describe('a QA defect has a fix and a retest', () => {
  test('both QA verdict events reach the fixing agent', () => {
    assert.ok(SUBSCRIPTIONS['project.ui_version_qa_reviewed']?.includes('ui_designer:reviseUIVersion'));
    assert.deepEqual(SUBSCRIPTIONS['project.prototype_qa_reviewed'], ['ui_prototype:reviseBuild', 'projects:syncP4uiBuild']);
  });

  test('both revise doors accept a QA-failed row, and count it on its own counter', () => {
    assert.match(migration, /'client_change', 'admin_edit', 'qa_changes_required'/);
    assert.match(migration, /v_latest\.artifact_status is distinct from 'qa_changes_required'/);
    assert.match(migration, /ui_qa_fix_count\s+= ui_qa_fix_count\s+\+ case when v_is_qa/);
    assert.match(migration, /prototype_qa_fix_count\s+= prototype_qa_fix_count\s+\+ case when v_is_qa/);
  });

  test('the workflows act only on a defect verdict and read the QA findings, never a pass', () => {
    assert.match(workflows, /qaOutcome !== 'qa_changes_required'/);
    assert.match(workflows, /event\.outcome !== 'qa_changes_required'/);
    assert.match(workflows, /ui_qa_fix_count/);
    assert.match(workflows, /prototype_qa_fix_count/);
  });
});
