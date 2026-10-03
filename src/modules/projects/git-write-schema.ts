import { z } from 'zod';

/**
 * Git is written — Decision: reversed by the owner on 2026-09-30 (bucket F,
 * F4). The three GitHub writes, the commit link, the build trigger and the
 * workflow link, as the forms send them. Shapes match the database checks in
 * 20261001130000_a_design_has_activity_assets_have_states_and_git_is_written.sql.
 */

export const createTaskBranchSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
});
export type CreateTaskBranchInput = z.infer<typeof createTaskBranchSchema>;

export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
export const submitReviewSchema = z.object({
  projectId: z.uuid(),
  pullNumber: z.coerce.number().int().positive('A pull request number is needed.'),
  event: z.enum(REVIEW_EVENTS),
  body: z.string().trim().max(4000).default(''),
});
export type SubmitReviewInput = z.input<typeof submitReviewSchema>;

export const mergePullRequestSchema = z.object({
  projectId: z.uuid(),
  pullNumber: z.coerce.number().int().positive('A pull request number is needed.'),
});
export type MergePullRequestInput = z.input<typeof mergePullRequestSchema>;

export const linkCommitSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  sha: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{7,40}$/, 'A commit sha is 7 to 40 hex characters.'),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v.length === 0 || v.startsWith('https://'), 'A commit link starts with https://')
    .optional(),
  message: z.string().trim().max(500).optional(),
});
export type LinkCommitInput = z.input<typeof linkCommitSchema>;

export const triggerBuildSchema = z.object({
  projectId: z.uuid(),
  note: z.string().trim().max(500).optional(),
});
export type TriggerBuildInput = z.infer<typeof triggerBuildSchema>;

export const setRepositoryWorkflowSchema = z.object({
  projectId: z.uuid(),
  /** Blank clears it. */
  workflowFile: z
    .string()
    .trim()
    .max(130)
    .refine((v) => v.length === 0 || /^[A-Za-z0-9._-]{1,120}\.ya?ml$/.test(v), 'A workflow file is its name under .github/workflows/, ending in .yml'),
});
export type SetRepositoryWorkflowInput = z.infer<typeof setRepositoryWorkflowSchema>;

/** SCR-042 — the repository's access level and merge policy (migration 20261006400200). */
export const setRepositoryPolicySchema = z.object({
  projectId: z.uuid(),
  accessLevel: z.enum(['read_only', 'branch_and_review', 'full']),
  mergeMinApprovals: z.coerce.number().int().min(0, 'Zero or more approvals.').max(5, 'At most 5 approvals.'),
  mergeRole: z.enum(['owner', 'admin', 'delivery']),
});
export type SetRepositoryPolicyInput = z.input<typeof setRepositoryPolicySchema>;

/** Owner decision 13 — dispatch the contract / migration check workflow on a client environment. */
export const dispatchEnvironmentChecksSchema = z.object({
  projectId: z.uuid(),
  environmentId: z.uuid(),
  checks: z.array(z.enum(['api_contract', 'migrations'])).min(1, 'Choose at least one check to run.').max(2),
  /** Blank means the default workflow file name. */
  workflowFile: z
    .string()
    .trim()
    .max(130)
    .refine((v) => v.length === 0 || /^[A-Za-z0-9._-]{1,120}\.ya?ml$/.test(v), 'A workflow file is its name under .github/workflows/, ending in .yml')
    .optional(),
});
export type DispatchEnvironmentChecksInput = z.input<typeof dispatchEnvironmentChecksSchema>;

export const refreshEnvironmentChecksSchema = z.object({
  projectId: z.uuid(),
  environmentId: z.uuid(),
});
export type RefreshEnvironmentChecksInput = z.input<typeof refreshEnvironmentChecksSchema>;
