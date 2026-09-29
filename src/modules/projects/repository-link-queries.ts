import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

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
  linkedBy: string | null;
  linkedAt: string;
  updatedAt: string;
};

export async function getRepositoryLink(projectId: string): Promise<RepositoryLink | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('repository_links')
    .select('id, provider, owner, repo, default_branch, linked_by, created_at, updated_at')
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
    linkedBy: data.linked_by,
    linkedAt: data.created_at,
    updatedAt: data.updated_at,
  };
}
