import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { filterRequirements, groupByModule, numberRows, requirementCode, requirementKpis, splitCriteria, statusOf, UNASSIGNED_MODULE, type RequirementRow } from '../src/modules/projects/requirements-tab.ts';

const row = (over: Partial<RequirementRow>): RequirementRow => ({
  id: 'i', code: 'REQ-001', title: 'Home screen', detail: null, criteria: [], inclusion: 'included', versionStatus: 'active', version: 1, status: 'approved',
  module: null, delivery: null, createdAt: '2026-09-01T00:00:00Z', screens: [], testCases: 0, deliverables: [], comments: 0, priority: null, assignee: null, files: [], featureId: null, tasks: [], quotations: [], clarifications: [], ...over,
});

describe('a requirement is a scope item, numbered by its place in the list', () => {
  test('codes are three digits and start at 001', () => {
    assert.equal(requirementCode(0), 'REQ-001');
    assert.equal(requirementCode(41), 'REQ-042');
  });
  test('the active version is numbered before an open draft, each in its own order', () => {
    const out = numberRows([
      { id: 'd1', versionStatus: 'draft' as const, position: 0 },
      { id: 'a2', versionStatus: 'active' as const, position: 1 },
      { id: 'a1', versionStatus: 'active' as const, position: 0 },
    ]);
    assert.deepEqual(out.map((r) => [r.id, r.code]), [['a1', 'REQ-001'], ['a2', 'REQ-002'], ['d1', 'REQ-003']]);
  });
});

describe('the status is the state of the version, never a claim', () => {
  test('a draft item is in review; a frozen one is approved unless it is optional or excluded', () => {
    assert.equal(statusOf('draft', 'included'), 'in_review');
    assert.equal(statusOf('draft', 'excluded'), 'in_review');
    assert.equal(statusOf('active', 'included'), 'approved');
    assert.equal(statusOf('active', 'optional'), 'optional');
    assert.equal(statusOf('active', 'excluded'), 'excluded');
  });
});

describe('acceptance criteria are one per line', () => {
  test('bullets, dashes and numbering are stripped and blank lines dropped', () => {
    assert.deepEqual(splitCriteria('Show poster\n- Trailer plays\n\n * Buy button\n3. UI as designed\r\n•  Cast'), ['Show poster', 'Trailer plays', 'Buy button', 'UI as designed', 'Cast']);
    assert.deepEqual(splitCriteria(null), []);
    assert.deepEqual(splitCriteria('   \n  '), []);
  });
});

describe('the figures and the list are computed from the rows', () => {
  const rows = [
    row({ id: '1', delivery: 'done', module: 'Auth' }),
    row({ id: '2', delivery: null, module: 'Auth' }),
    row({ id: '3', delivery: 'not_started', module: null }),
    row({ id: '4', status: 'in_review', versionStatus: 'draft' }),
    row({ id: '5', status: 'excluded', inclusion: 'excluded' }),
  ];
  test('KPIs: not started counts only approved items whose delivery has not begun', () => {
    assert.deepEqual(requirementKpis(rows, 2), { total: 5, approved: 3, inReview: 1, changesRequested: 2, notStarted: 2 });
  });
  test('grouped by module, with the un-moduled last', () => {
    const groups = groupByModule(rows);
    assert.deepEqual(groups.map((g) => [g.module, g.rows.length]), [['Auth', 2], [UNASSIGNED_MODULE, 3]]);
  });
  test('filters by status and by search over code, title and module', () => {
    assert.equal(filterRequirements(rows, 'approved', '').length, 3);
    assert.equal(filterRequirements(rows, 'not_started', '').length, 2);
    assert.equal(filterRequirements(rows, 'all', 'auth').length, 2);
    assert.equal(filterRequirements(rows, 'in_review', 'nothing like this').length, 0);
  });
});
