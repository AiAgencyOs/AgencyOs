import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cleanFolderPath, createProjectFolderSchema, folderNodes, folderPathProblem, parentFolder } from '../src/modules/projects/project-folder-schema.ts';

describe('a folder is a record with a path; the tree shows empty ones', () => {
  test('a typed name is cleaned segment by segment and refused when it cannot be a path', () => {
    assert.equal(cleanFolderPath('  Mockups / Mobile  '), 'Mockups/Mobile');
    assert.equal(cleanFolderPath('/a//b/'), 'a/b');
    assert.equal(folderPathProblem(''), 'Give the folder a name.');
    assert.match(folderPathProblem('a/../b') ?? '', /\.\./);
    assert.match(folderPathProblem('x'.repeat(201)) ?? '', /at most 200/);
    assert.equal(folderPathProblem('mockups/mobile'), null);
  });

  test('the parent of a path, and of a top-level folder', () => {
    assert.equal(parentFolder('a/b/c'), 'a/b');
    assert.equal(parentFolder('a'), '');
  });

  test('an empty folder is a node with no files; a file counts toward its folder and every ancestor', () => {
    const nodes = folderNodes(
      [
        { category: 'design', path: 'mockups/mobile' },
        { category: 'design', path: 'mockups' },
        { category: 'design', path: 'empty' },
        { category: 'assets', path: 'mockups' },
      ],
      [
        { category: 'design', folder: 'mockups/mobile' },
        { category: 'design', folder: 'mockups' },
        { category: 'assets', folder: '' },
      ],
    );
    assert.deepEqual(
      nodes.map((n) => [n.category, n.path, n.depth, n.files]),
      [
        ['assets', 'mockups', 0, 0],
        ['design', 'empty', 0, 0],
        ['design', 'mockups', 0, 2],
        ['design', 'mockups/mobile', 1, 1],
      ],
    );
  });

  test('the New Folder form needs a real category and a usable name', () => {
    const base = { projectId: '00000000-0000-4000-8000-000000000001', category: 'design', path: ' mockups / ios ' };
    const ok = createProjectFolderSchema.safeParse(base);
    assert.equal(ok.success && ok.data.path, 'mockups/ios');
    assert.equal(createProjectFolderSchema.safeParse({ ...base, category: 'photos' }).success, false);
    assert.equal(createProjectFolderSchema.safeParse({ ...base, path: ' / ' }).success, false);
  });
});
