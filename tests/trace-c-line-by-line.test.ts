import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildCredentialProblem } from '../src/modules/projects/build-secrets-guard.ts';
import { summariseMapping, taskForBranch, taskForCommit } from '../src/modules/projects/code-task-mapping.ts';
import { assetMatches, describeDesignRef, recentFeedback, sharedVersions } from '../src/modules/projects/design-feedback.ts';
import { taskAcceptanceProblem, TASK_ACCEPTANCE_MESSAGES } from '../src/modules/projects/task-acceptance.ts';

/**
 * Trace C (PDF pages 46 to 63): the pure rules behind five lines the
 * line-by-line trace found unbuilt. The database halves (who may finish a task,
 * the PM request) are proved live by `npm run db:verify:trace-c`.
 */

describe('SCR-038 recent feedback names the exact version each answer is about', () => {
  const themes = [
    { id: 't1', name: 'Calm', version: 1 },
    { id: 't2', name: 'Bold', version: 2 },
  ];
  const shares = [
    { id: 's1', shareNumber: 1, sharedOptions: [{ name: 'Calm', version: 1 }, { name: 'Bold', version: 2 }] },
    { id: 's2', shareNumber: 2, sharedOptions: [] },
  ];

  test('an answer that picked an option cites the option, its version and the share', () => {
    const ref = describeDesignRef({ id: 'd', shareId: 's1', decision: 'client_selected', clientWords: 'x', selectedThemeOptionId: 't2', createdAt: '2026-01-02' }, shares[0], new Map(themes.map((t) => [t.id, t])));
    assert.equal(ref, 'Theme “Bold” v2 · share 1');
  });

  test('an answer with no option cites every version the share carried, from its own snapshot', () => {
    const ref = describeDesignRef({ id: 'd', shareId: 's1', decision: 'clarification_required', clientWords: 'x', selectedThemeOptionId: null, createdAt: '2026-01-02' }, shares[0], new Map());
    assert.equal(ref, 'Calm v1, Bold v2 · share 1');
    assert.deepEqual(sharedVersions(shares[1]), []);
  });

  test('a share that stored nothing is named as such, never invented', () => {
    const ref = describeDesignRef({ id: 'd', shareId: 's2', decision: 'clarification_required', clientWords: 'x', selectedThemeOptionId: null, createdAt: '2026-01-02' }, shares[1], new Map());
    assert.equal(ref, 'The options sent in share 2');
    assert.equal(describeDesignRef({ id: 'd', shareId: 'gone', decision: 'x', clientWords: 'x', selectedThemeOptionId: null, createdAt: '' }, undefined, new Map()), 'The options sent in a share that is no longer listed');
  });

  test('design and prototype answers merge newest first, and the list is capped', () => {
    const feedback = recentFeedback({
      decisions: [
        { id: 'a', shareId: 's1', decision: 'client_selected', clientWords: 'we like Bold', selectedThemeOptionId: 't2', createdAt: '2026-03-01T10:00:00Z' },
        { id: 'b', shareId: 's1', decision: 'design_change_request', clientWords: 'darker', selectedThemeOptionId: null, createdAt: '2026-01-01T10:00:00Z' },
      ],
      shares,
      themes,
      uiDecisions: [{ id: 'c', uiVersion: 3, decision: 'change_requested', clientWords: 'move the button', createdAt: '2026-02-01T10:00:00Z' }],
      limit: 2,
    });
    assert.deepEqual(feedback.map((f) => f.id), ['design-a', 'prototype-c']);
    assert.equal(feedback[1]!.refersTo, 'UI version 3');
    assert.equal(feedback[1]!.kind, 'prototype');
  });

  test('an asset search reads title, kind and status, ignoring case; empty matches everything', () => {
    const asset = { title: 'Brand Mark', kind: 'logo', status: 'draft', rightsNote: 'licensed by Acme' };
    assert.equal(assetMatches(asset, 'brand'), true);
    assert.equal(assetMatches(asset, 'LOGO'), true);
    assert.equal(assetMatches(asset, 'acme'), true);
    assert.equal(assetMatches(asset, 'approved'), false);
    assert.equal(assetMatches(asset, '   '), true);
  });
});

describe('SCR-042 every code artifact says which task it maps to', () => {
  const tasks = [
    { id: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'Checkout' },
    { id: 'a1b2c3d4-0000-4000-8000-000000000002', title: 'Cart' },
    { id: 'ffee1122-0000-4000-8000-000000000003', title: 'Login' },
  ];

  test('a pull request maps through the branch the panel made for the task', () => {
    assert.equal(taskForBranch('task/ffee1122-login-form', tasks)?.title, 'Login');
    assert.equal(taskForBranch('TASK/FFEE1122', tasks)?.title, 'Login');
  });

  test('a branch that is not a task branch, or names no task, or names two, maps to nothing', () => {
    assert.equal(taskForBranch('feature/login', tasks), null);
    assert.equal(taskForBranch('task/00000000-nothing', tasks), null);
    assert.equal(taskForBranch('task/a1b2c3d4-ambiguous', tasks), null);
  });

  test('a commit maps through a linked sha, short or full, and never through a guess', () => {
    const links = [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', taskId: tasks[2]!.id }];
    assert.equal(taskForCommit('abcdef1234567890abcdef1234567890abcdef12', links, tasks)?.title, 'Login');
    assert.equal(taskForCommit('abcdef1', links, tasks)?.title, 'Login');
    assert.equal(taskForCommit('abc', links, tasks), null);
    assert.equal(taskForCommit('1234567', links, tasks), null);
  });

  test('the summary counts what maps and what does not', () => {
    const summary = summariseMapping({
      commits: [{ sha: 'abcdef1234567890abcdef1234567890abcdef12' }, { sha: '9999999999999999999999999999999999999999' }],
      pullRequests: [{ headBranch: 'task/ffee1122-login' }, { headBranch: 'main-fix' }, { headBranch: 'hotfix' }],
      links: [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', taskId: tasks[2]!.id }],
      tasks,
    });
    assert.deepEqual(summary, { commits: { mapped: 1, total: 2 }, pullRequests: { mapped: 1, total: 3 } });
  });
});

describe('SCR-043 a secret is never typed into a build, environment or dependency field', () => {
  test('an API key in a rollback note is refused, naming the field and where credentials go', () => {
    const problem = buildCredentialProblem([{ label: 'How to roll back', value: 'redeploy with sk-ant-api03-abcdefghijklmnopqrstuvwx' }]);
    assert.ok(problem);
    assert.match(problem!, /^How to roll back:/);
    assert.match(problem!, /Settings › Keys & secrets/);
    assert.match(problem!, /Nothing was saved/);
  });

  test('a password inside an environment address, and a token in a query string, are refused', () => {
    assert.ok(buildCredentialProblem([{ label: 'Address', value: 'https://admin:hunter2hunter2@staging.example.com', isLink: true }]));
    assert.ok(buildCredentialProblem([{ label: 'Evidence link', value: 'https://ci.example.com/run/1?access_token=abcdef123456', isLink: true }]));
  });

  test('a "password: value" line in a note is refused', () => {
    assert.ok(buildCredentialProblem([{ label: 'Notes', value: 'login with\npassword: correcthorse99' }]));
  });

  test('ordinary text and links pass, and the first offending field is the one named', () => {
    assert.equal(buildCredentialProblem([{ label: 'Notes', value: 'Redeploy the previous build; no migration to undo.' }, { label: 'Address', value: 'https://staging.example.com', isLink: true }, { label: 'Version', value: null }]), null);
    const problem = buildCredentialProblem([
      { label: 'Name', value: 'Stripe SDK' },
      { label: 'Reference', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    ]);
    assert.match(problem ?? '', /^Reference:/);
  });
});

describe('SCR-041 the database refusals of a move to done are said in words', () => {
  test('each code maps to its own sentence, and an unrelated error maps to nothing', () => {
    assert.equal(taskAcceptanceProblem('task_acceptance_not_yours: the person who does the work'), TASK_ACCEPTANCE_MESSAGES.notYours);
    assert.equal(taskAcceptanceProblem('task_needs_evidence: a task is done only with evidence'), TASK_ACCEPTANCE_MESSAGES.needsEvidence);
    assert.equal(taskAcceptanceProblem('task_has_unverified_defect: a defect'), TASK_ACCEPTANCE_MESSAGES.unverifiedDefect);
    assert.equal(taskAcceptanceProblem('agent_task_unverified: an agent-generated task'), null);
    assert.equal(taskAcceptanceProblem(undefined), null);
  });
});
