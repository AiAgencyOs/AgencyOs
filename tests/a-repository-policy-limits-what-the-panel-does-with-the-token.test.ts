import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  accessAllows,
  accessRefusal,
  countApprovals,
  evaluateMergePolicy,
  parseAccessLevel,
  parseMergeRole,
} from '../src/modules/projects/repository-policy.ts';

describe('the access level limits what the panel does in a repository', () => {
  test('read only allows reading and nothing else', () => {
    assert.equal(accessAllows('read_only', 'read'), true);
    for (const a of ['branch', 'review', 'build', 'merge'] as const) assert.equal(accessAllows('read_only', a), false, a);
  });
  test('branches and reviews allow the writes short of a merge', () => {
    for (const a of ['read', 'branch', 'review', 'build'] as const) assert.equal(accessAllows('branch_and_review', a), true, a);
    assert.equal(accessAllows('branch_and_review', 'merge'), false);
  });
  test('full allows a merge, and a refusal says what to change', () => {
    assert.equal(accessAllows('full', 'merge'), true);
    assert.equal(accessRefusal('full', 'merge'), null);
    assert.match(accessRefusal('read_only', 'merge') ?? '', /does not allow a merge/);
    assert.match(accessRefusal('read_only', 'merge') ?? '', /owner or ops admin can widen it/);
  });
  test('an unknown stored value reads as what a link always allowed', () => {
    assert.equal(parseAccessLevel('nonsense'), 'full');
    assert.equal(parseAccessLevel(null), 'full');
    assert.equal(parseMergeRole('nonsense'), 'delivery');
  });
});

describe('the merge policy', () => {
  const base = { level: 'full', mergeRole: 'admin', minApprovals: 2, roles: ['ops_admin'], approvals: 2 } as const;
  test('a role in the allowed set, enough approvals and a full level may merge', () => {
    assert.deepEqual(evaluateMergePolicy(base), { allowed: true, reasons: [] });
  });
  test('a delivery lead is refused when merging is for admins', () => {
    const v = evaluateMergePolicy({ ...base, roles: ['delivery_lead'] });
    assert.equal(v.allowed, false);
    assert.match(v.reasons.join(' '), /owner or ops admin/);
  });
  test('a secondary role counts: a member who was granted ops admin may merge', () => {
    assert.equal(evaluateMergePolicy({ ...base, roles: ['member', 'ops_admin'] }).allowed, true);
  });
  test('too few approvals are refused with the counts', () => {
    const v = evaluateMergePolicy({ ...base, approvals: 1 });
    assert.equal(v.allowed, false);
    assert.match(v.reasons.join(' '), /1 approving review; the policy needs 2/);
  });
  test('an owner-only policy refuses everyone else, and every failing reason is reported', () => {
    const v = evaluateMergePolicy({ level: 'branch_and_review', mergeRole: 'owner', minApprovals: 1, roles: ['ops_admin'], approvals: 0 });
    assert.equal(v.allowed, false);
    assert.equal(v.reasons.length, 3);
  });
});

describe('approvals are each reviewer\'s latest word', () => {
  test('the last review of a reviewer counts, and only when it is an approval', () => {
    assert.equal(countApprovals([{ user: 'a', state: 'APPROVED' }, { user: 'b', state: 'APPROVED' }]), 2);
    assert.equal(countApprovals([{ user: 'a', state: 'APPROVED' }, { user: 'a', state: 'CHANGES_REQUESTED' }]), 0);
    assert.equal(countApprovals([{ user: 'a', state: 'CHANGES_REQUESTED' }, { user: 'a', state: 'APPROVED' }]), 1);
  });
  test('a comment does not withdraw an approval, and a deleted user is not counted', () => {
    assert.equal(countApprovals([{ user: 'a', state: 'APPROVED' }, { user: 'a', state: 'COMMENTED' }]), 1);
    assert.equal(countApprovals([{ user: null, state: 'APPROVED' }]), 0);
  });
});
