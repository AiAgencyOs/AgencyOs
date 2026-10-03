import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { parseAccessLevel, parseMergeRole, type AccessLevel, type MergeRole } from './repository-policy';

/**
 * The one GitHub repository a project is read from — Decision: reversed by
 * the owner on 2026-09-29. Only the link is stored; what GitHub says about it
 * is read on the page, per request, by src/lib/git/github.ts.
 */
export type RepositoryLink = {
  id: string;
  provider: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  /** SCR-043 — the GitHub Actions workflow a build trigger dispatches; null means record only. */
  workflowFile: string | null;
  /** SCR-042: what the panel may do here, and the merge policy (migration 20261006400200). */
  accessLevel: AccessLevel;
  mergeMinApprovals: number;
  mergeRole: MergeRole;
  linkedBy: string | null;
  linkedAt: string;
  updatedAt: string;
};

export async function getRepositoryLink(projectId: string): Promise<RepositoryLink | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('repository_links')
    .select('id, provider, owner, repo, default_branch, workflow_file, access_level, merge_min_approvals, merge_role, linked_by, created_at, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) unreadable('getRepositoryLink', error);
  if (!data) return null;

  return {
    id: data.id,
    provider: data.provider,
    owner: data.owner,
    repo: data.repo,
    defaultBranch: data.default_branch,
    workflowFile: data.workflow_file ?? null,
    accessLevel: parseAccessLevel(data.access_level),
    mergeMinApprovals: data.merge_min_approvals ?? 0,
    mergeRole: parseMergeRole(data.merge_role),
    linkedBy: data.linked_by,
    linkedAt: data.created_at,
    updatedAt: data.updated_at,
  };
}
