import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCommitToTask, summariseMapping, taskPrefixInMessage } from '../src/modules/projects/code-task-mapping.ts';
import { mayChangeTask, projectRoleDbProblem, projectRoleProblem, PROJECT_ROLE_MESSAGES } from '../src/modules/projects/project-role-guard.ts';
import { ADD_DEPENDENCY_MESSAGES } from '../src/modules/projects/task-dependency-schema.ts';
import { dependencyIsSatisfied, evaluateStartCheck, START_REQUIREMENT_MESSAGE } from '../src/modules/projects/task-start-check.ts';
import { COMPLETION_MESSAGE, completingProblem, selectableStatuses } from '../src/modules/projects/task-transitions.ts';

const STATUSES = ['todo', 'in_progress', 'blocked', 'in_review', 'done'] as const;

test('Q-B1 a task reaches Completed only from In review', () => {
  for (const from of ['todo', 'in_progress', 'blocked']) assert.equal(completingProblem(from, 'done'), COMPLETION_MESSAGE, `from ${from}`);
  assert.equal(completingProblem('in_review', 'done'), null);
  assert.equal(completingProblem('done', 'done'), null, 'already completed is no new transition');
  assert.equal(completingProblem('todo', 'in_progress'), null);
  assert.equal(completingProblem(null, 'in_progress'), null);
});

test('Q-B1 the status selects offer Completed only from In review', () => {
  assert.ok(!selectableStatuses(STATUSES, 'in_progress').includes('done'));
  assert.ok(selectableStatuses(STATUSES, 'in_review').includes('done'));
  assert.ok(selectableStatuses(STATUSES, 'done').includes('done'));
  assert.ok(!selectableStatuses(STATUSES, 'done').includes('in_review'));
});

test('Q-B2 an observer changes nothing; a contributor changes only their own task; others follow the agency role', () => {
  const base = { manager: false, userId: 'me' };
  assert.equal(projectRoleProblem({ ...base, role: 'observer', assigneeId: 'me' }), PROJECT_ROLE_MESSAGES.observer);
  assert.equal(projectRoleProblem({ ...base, role: 'contributor', assigneeId: 'someone' }), PROJECT_ROLE_MESSAGES.contributor);
  assert.equal(projectRoleProblem({ ...base, role: 'contributor', assigneeId: null }), PROJECT_ROLE_MESSAGES.contributor);
  assert.equal(projectRoleProblem({ ...base, role: 'contributor', assigneeId: 'me' }), null);
  for (const role of ['developer', 'designer', 'qa', 'project_manager', null]) assert.equal(projectRoleProblem({ ...base, role, assigneeId: 'someone' }), null, String(role));
  assert.equal(projectRoleProblem({ manager: true, userId: 'me', role: 'observer', assigneeId: 'x' }), null, 'the roles that keep the roster are not bound by it');
  assert.equal(mayChangeTask({ ...base, role: 'observer', assigneeId: 'me' }), false);
});

test('Q-B2 a database refusal is answered in the same words', () => {
  assert.equal(projectRoleDbProblem('project_role_observer_read_only: your role'), PROJECT_ROLE_MESSAGES.observer);
  assert.equal(projectRoleDbProblem('project_role_contributor_own_tasks: x'), PROJECT_ROLE_MESSAGES.contributor);
  assert.equal(projectRoleDbProblem('something else'), null);
  assert.equal(projectRoleDbProblem(undefined), null);
});

test('Q-C3 / R2-1 Start Task needs a requirement and every task it depends on done, and names the failing task', () => {
  assert.deepEqual(evaluateStartCheck({ requirementLinked: true, blocking: [] }), { startable: true, requirementOk: true, openDependencies: 0, reason: null });
  const noReq = evaluateStartCheck({ requirementLinked: false, blocking: [{ title: 'Schema', status: 'todo' }] });
  assert.equal(noReq.startable, false);
  assert.equal(noReq.reason, START_REQUIREMENT_MESSAGE, 'the requirement check speaks first');
  const one = evaluateStartCheck({ requirementLinked: true, blocking: [{ title: 'Build the schema', status: 'in_progress' }] });
  assert.equal(one.startable, false);
  assert.match(one.reason ?? '', /waiting on "Build the schema" \(in progress\)\. Finish it first/);
  const many = evaluateStartCheck({
    requirementLinked: true,
    blocking: ['d', 'c', 'b', 'a', 'e'].map((title) => ({ title, status: 'todo' })),
  });
  assert.equal(many.openDependencies, 5);
  assert.match(many.reason ?? '', /waiting on "a" \(todo\), "b" \(todo\), "c" \(todo\) and 2 more\. Finish them first/);
});

test('R2-1 the dependency door refusals are said in words', () => {
  for (const outcome of ['itself', 'other_project', 'already', 'cycle', 'not_found']) assert.ok(ADD_DEPENDENCY_MESSAGES[outcome], outcome);
  assert.match(ADD_DEPENDENCY_MESSAGES.cycle!, /wait for each other/);
});

const tasks = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'Checkout' },
  { id: 'ffee1122-0000-4000-8000-000000000003', title: 'Login' },
];

test('Q-C4 a commit maps by the task branch or by the task id prefix in its message', () => {
  assert.equal(taskPrefixInMessage('Fix totals (task/ffee1122)'), 'ffee1122');
  assert.equal(taskPrefixInMessage('TASK: FFEE1122 wire the form'), 'ffee1122');
  assert.equal(taskPrefixInMessage('task#ffee1122'), 'ffee1122');
  assert.equal(taskPrefixInMessage('bump deadbeef to 1.2'), null, 'a bare hex word is not the convention');
  assert.equal(taskPrefixInMessage('multitask ffee1122'), null);

  assert.deepEqual(mapCommitToTask({ sha: '1234567', message: 'task/ffee1122 add form' }, [], tasks), { task: tasks[1], via: 'message' });
  assert.deepEqual(mapCommitToTask({ sha: '1234567', message: 'wip', branch: 'task/a1b2c3d4-checkout' }, [], tasks), { task: tasks[0], via: 'branch' });
  assert.equal(mapCommitToTask({ sha: '1234567', message: 'task/00000000 nothing' }, [], tasks), null, 'a prefix matching no task maps to nothing');
  assert.equal(mapCommitToTask({ sha: '1234567', message: 'task/a1b2c3d4', branch: 'main' }, [], [...tasks, { id: 'a1b2c3d4-0000-4000-8000-000000000009', title: 'Twin' }]), null, 'an ambiguous prefix maps to nothing');
});

test('Q-C4 a manual link still wins over the convention, and the summary counts both', () => {
  const links = [{ sha: 'abcdef1234567890abcdef1234567890abcdef12', taskId: tasks[0]!.id }];
  assert.equal(mapCommitToTask({ sha: 'abcdef1234567890abcdef1234567890abcdef12', message: 'task/ffee1122 x' }, links, tasks)?.via, 'link');
  assert.equal(mapCommitToTask({ sha: 'abcdef1234567890abcdef1234567890abcdef12', message: 'task/ffee1122 x' }, links, tasks)?.task.title, 'Checkout');
  const summary = summariseMapping({
    commits: [{ sha: 'abcdef1234567890abcdef1234567890abcdef12' }, { sha: '1111111', message: 'task/ffee1122 y' }, { sha: '2222222', message: 'nothing' }],
    pullRequests: [],
    links,
    tasks,
  });
  assert.deepEqual(summary.commits, { mapped: 2, total: 3 });
});

test('S2-3 a dependency on a done, cancelled or archived task is satisfied; anything else is open', () => {
  for (const status of ['done', 'cancelled', 'archived']) assert.equal(dependencyIsSatisfied({ status }), true, status);
  assert.equal(dependencyIsSatisfied({ status: 'in_review', archivedAt: '2026-10-01T00:00:00Z' }), true, 'archived by date');
  for (const status of ['todo', 'in_progress', 'blocked', 'in_review']) assert.equal(dependencyIsSatisfied({ status }), false, status);
});
