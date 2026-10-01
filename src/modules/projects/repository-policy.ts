/**
 * The repository policy (SCR-042: "approve/reject merge based on policy" and
 * "least privilege for repo access") — pure rules, no I/O, so the doors and
 * the page use one copy and a test can drive them with real inputs.
 *
 * `access_level` limits what the panel may do in one repository, whatever the
 * organisation-wide `GITHUB_TOKEN` could do:
 *
 *   read_only          read commits, branches, pull requests and checks
 *   branch_and_review  also create task branches, submit reviews, trigger builds
 *   full               also merge
 *
 * `merge_role` is who may merge (owner; admin = owner or ops admin; delivery =
 * also the delivery lead) and `merge_min_approvals` the approving reviews a
 * pull request needs first. Red or running checks always refuse a merge
 * (src/lib/git/github-write.ts) — that is not configurable.
 */

export const ACCESS_LEVELS = ['read_only', 'branch_and_review', 'full'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const MERGE_ROLES = ['owner', 'admin', 'delivery'] as const;
export type MergeRole = (typeof MERGE_ROLES)[number];

export const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = {
  read_only: 'Read only',
  branch_and_review: 'Branches and reviews',
  full: 'Full, including merge',
};
export const MERGE_ROLE_LABEL: Record<MergeRole, string> = { owner: 'Owner only', admin: 'Owner or ops admin', delivery: 'Owner, ops admin or delivery lead' };

/** What the GitHub token needs to be able to do for each level — the least privilege, stated. */
export const ACCESS_LEVEL_NEEDS: Record<AccessLevel, string[]> = {
  read_only: ['Contents: read', 'Pull requests: read', 'Checks and commit statuses: read', 'Metadata: read'],
  branch_and_review: ['Everything in Read only', 'Contents: write (create a task branch)', 'Pull requests: write (submit a review)', 'Actions: write (dispatch the build workflow)'],
  full: ['Everything in Branches and reviews', 'Pull requests: write (squash merge)'],
};

export type GitAction = 'read' | 'branch' | 'review' | 'build' | 'merge';

const REQUIRED: Record<GitAction, AccessLevel> = { read: 'read_only', branch: 'branch_and_review', review: 'branch_and_review', build: 'branch_and_review', merge: 'full' };
const RANK: Record<AccessLevel, number> = { read_only: 0, branch_and_review: 1, full: 2 };

export function parseAccessLevel(v: string | null | undefined): AccessLevel {
  return (ACCESS_LEVELS as readonly string[]).includes(v ?? '') ? (v as AccessLevel) : 'full';
}
export function parseMergeRole(v: string | null | undefined): MergeRole {
  return (MERGE_ROLES as readonly string[]).includes(v ?? '') ? (v as MergeRole) : 'delivery';
}

/** May the panel do this in a repository set to this level? */
export function accessAllows(level: AccessLevel, action: GitAction): boolean {
  return RANK[level] >= RANK[REQUIRED[action]];
}

export function accessRefusal(level: AccessLevel, action: GitAction): string | null {
  if (accessAllows(level, action)) return null;
  return `This repository is set to "${ACCESS_LEVEL_LABEL[level]}", which does not allow ${action === 'merge' ? 'a merge' : action === 'branch' ? 'creating a branch' : action === 'review' ? 'submitting a review' : 'triggering a build'}. An owner or ops admin can widen it under Access and merge policy.`;
}

export type MergePolicyInput = {
  level: AccessLevel;
  mergeRole: MergeRole;
  minApprovals: number;
  /** Every role the caller holds (primary plus secondary). */
  roles: readonly string[];
  /** Approving reviews the pull request has now — the latest review of each reviewer. */
  approvals: number;
};

export type MergePolicyVerdict = { allowed: boolean; reasons: string[] };

const ROLES_FOR: Record<MergeRole, readonly string[]> = { owner: ['owner'], admin: ['owner', 'ops_admin'], delivery: ['owner', 'ops_admin', 'delivery_lead'] };

export function evaluateMergePolicy(input: MergePolicyInput): MergePolicyVerdict {
  const reasons: string[] = [];
  const refusal = accessRefusal(input.level, 'merge');
  if (refusal) reasons.push(refusal);
  if (!input.roles.some((r) => ROLES_FOR[input.mergeRole].includes(r))) reasons.push(`Merging is limited to: ${MERGE_ROLE_LABEL[input.mergeRole].toLowerCase()}.`);
  if (input.approvals < input.minApprovals) reasons.push(`The pull request has ${input.approvals} approving review${input.approvals === 1 ? '' : 's'}; the policy needs ${input.minApprovals}.`);
  return { allowed: reasons.length === 0, reasons };
}

/** Approving reviews from GitHub's review list: the LAST review of each reviewer counts, and only if it is APPROVED. */
export function countApprovals(reviews: readonly { user: string | null; state: string }[]): number {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (!r.user) continue;
    if (r.state === 'COMMENTED') continue; // a comment does not withdraw an approval
    latest.set(r.user, r.state);
  }
  return [...latest.values()].filter((s) => s === 'APPROVED').length;
}
