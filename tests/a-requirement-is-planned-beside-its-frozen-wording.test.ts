import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { priorityOf, priorityRank, requirementFileLinkSchema, setRequirementPlanSchema } from '../src/modules/projects/requirement-plan-schema.ts';

const id = '00000000-0000-4000-8000-000000000001';

describe('a requirement\'s priority is High, Medium or Low and its assignee a person or nobody', () => {
  test('a stored value outside the three reads as not set, and the list sorts High first, unset last', () => {
    assert.equal(priorityOf('high'), 'high');
    assert.equal(priorityOf('High'), null);
    assert.equal(priorityOf(null), null);
    const sorted = (['low', null, 'high', 'medium'] as const).map((p) => p).sort((a, b) => priorityRank(a) - priorityRank(b));
    assert.deepEqual(sorted, ['high', 'medium', 'low', null]);
  });

  test('the plan form takes null for "not set" and "nobody", and refuses a priority off the list', () => {
    assert.equal(setRequirementPlanSchema.safeParse({ projectId: id, scopeItemId: id, priority: null, assigneeId: null }).success, true);
    assert.equal(setRequirementPlanSchema.safeParse({ projectId: id, scopeItemId: id, priority: 'low', assigneeId: id }).success, true);
    assert.equal(setRequirementPlanSchema.safeParse({ projectId: id, scopeItemId: id, priority: 'urgent', assigneeId: null }).success, false);
    assert.equal(setRequirementPlanSchema.safeParse({ projectId: id, scopeItemId: id, priority: 'low', assigneeId: 'someone' }).success, false);
  });

  test('an attachment is named by a requirement and a file, both ids', () => {
    assert.equal(requirementFileLinkSchema.safeParse({ projectId: id, scopeItemId: id, fileId: id }).success, true);
    assert.equal(requirementFileLinkSchema.safeParse({ projectId: id, scopeItemId: id, fileId: '' }).success, false);
  });
});
