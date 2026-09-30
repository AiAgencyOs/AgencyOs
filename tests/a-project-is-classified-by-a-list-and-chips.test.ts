import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEPARTMENTS, departmentOf, isDepartment } from '../src/modules/projects/member-department-schema.ts';
import { normaliseChips, projectTypeOf, PROJECT_TYPES, setProjectClassificationSchema } from '../src/modules/projects/project-classification-schema.ts';

describe('a project type is from a fixed list; technology and tags are lower-cased, unique chips', () => {
  test('the list is exactly the owner\'s seven, and anything else reads as not set', () => {
    assert.deepEqual([...PROJECT_TYPES], ['Website', 'Web app', 'Mobile app', 'SaaS', 'E-commerce', 'Branding', 'Other']);
    assert.equal(projectTypeOf('SaaS'), 'SaaS');
    assert.equal(projectTypeOf('saas'), null);
    assert.equal(projectTypeOf(null), null);
  });

  test('chips are split on commas and new lines, trimmed, lower-cased and de-duplicated in first-seen order', () => {
    assert.deepEqual(normaliseChips('  React, Node.JS\nreact ,, POSTGRES '), ['react', 'node.js', 'postgres']);
    assert.deepEqual(normaliseChips(['A', 'a', ' b ']), ['a', 'b']);
    assert.deepEqual(normaliseChips(' , ,\n'), []);
  });

  test('the form is refused with a sentence when there are too many chips or one is too long', () => {
    const base = { projectId: '00000000-0000-4000-8000-000000000001', type: 'Website' as const, technology: [], tags: [] };
    assert.equal(setProjectClassificationSchema.safeParse(base).success, true);
    assert.equal(setProjectClassificationSchema.safeParse({ ...base, type: null }).success, true);
    assert.equal(setProjectClassificationSchema.safeParse({ ...base, type: 'Game' }).success, false);
    const twelve = Array.from({ length: 12 }, (_, i) => `t${i}`);
    assert.equal(setProjectClassificationSchema.safeParse({ ...base, technology: twelve }).success, true);
    const tooMany = setProjectClassificationSchema.safeParse({ ...base, technology: [...twelve, 'x'] });
    assert.equal(tooMany.success, false);
    assert.match(tooMany.success ? '' : (tooMany.error.issues[0]?.message ?? ''), /at most 12/);
    assert.equal(setProjectClassificationSchema.safeParse({ ...base, tags: Array.from({ length: 11 }, (_, i) => `g${i}`) }).success, false);
    assert.equal(setProjectClassificationSchema.safeParse({ ...base, tags: ['x'.repeat(31)] }).success, false);
  });
});

describe('a member\'s department is one of six names', () => {
  test('the list is the owner\'s six, in order; a stored value outside it reads as not set', () => {
    assert.deepEqual([...DEPARTMENTS], ['Design', 'Development', 'QA', 'Sales', 'Management', 'Operations']);
    assert.equal(isDepartment('QA'), true);
    assert.equal(isDepartment('qa'), false);
    assert.equal(departmentOf('Marketing'), null);
    assert.equal(departmentOf('Sales'), 'Sales');
    assert.equal(departmentOf(undefined), null);
  });
});
