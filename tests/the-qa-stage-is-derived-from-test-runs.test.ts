import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lifecyclePhaseOf } from '../src/modules/projects/project-archive-schema.ts';
import { isInQa, pipelineCounts, projectStageChip } from '../src/lib/admin/qa-stage.ts';

const base = { status: 'active', archivedAt: null, openTestRuns: 0, hasRelease: false };

describe('a project is In QA while it has an open test run and no release', () => {
  it('needs an open run', () => {
    assert.equal(isInQa(base), false);
    assert.equal(isInQa({ ...base, openTestRuns: 1 }), true);
    assert.equal(isInQa({ ...base, openTestRuns: 3 }), true);
  });

  it('a release ends it', () => {
    assert.equal(isInQa({ ...base, openTestRuns: 2, hasRelease: true }), false);
  });

  it('a finished, cancelled or archived project is never in QA', () => {
    assert.equal(isInQa({ ...base, status: 'completed', openTestRuns: 1 }), false);
    assert.equal(isInQa({ ...base, status: 'cancelled', openTestRuns: 1 }), false);
    assert.equal(isInQa({ ...base, archivedAt: '2026-09-01T00:00:00Z', openTestRuns: 1 }), false);
  });

  it('the chip says In QA, otherwise the stored status in words', () => {
    assert.deepEqual(projectStageChip({ ...base, openTestRuns: 1 }), { key: 'in_qa', label: 'In QA', inQa: true });
    assert.deepEqual(projectStageChip({ ...base, status: 'on_hold' }), { key: 'on_hold', label: 'On hold', inQa: false });
  });

  it('the pipeline counts a project once: In QA takes it out of its stored status', () => {
    const counts = pipelineCounts([
      { ...base, openTestRuns: 1 },
      { ...base },
      { ...base, status: 'onboarding' },
      { ...base, status: 'completed', openTestRuns: 1 },
      { ...base, openTestRuns: 1, hasRelease: true },
    ]);
    assert.equal(counts.inQa, 1);
    assert.equal(counts.active, 2);
    assert.equal(counts.onboarding, 1);
    assert.equal(counts.completed, 1);
  });

  it('the lifecycle phase agrees: only an open run is QA, a release wins', () => {
    const facts = { status: 'active', archivedAt: null, productionReadyAt: null, hasPhaseTwo: true, hasPhaseThree: true, hasPhaseFour: true, hasOpenTestRun: false, hasHandover: false };
    assert.equal(lifecyclePhaseOf(facts), 'development');
    assert.equal(lifecyclePhaseOf({ ...facts, hasOpenTestRun: true }), 'qa');
    assert.equal(lifecyclePhaseOf({ ...facts, hasOpenTestRun: true, hasHandover: true }), 'release');
  });
});
