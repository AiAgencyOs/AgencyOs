import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  linkRepositorySchema,
  unlinkRepositorySchema,
  type LinkRepositoryInput,
  type UnlinkRepositoryInput,
} from './repository-link-schema';

/**
 * Live Git's two doors — Decision: reversed by the owner on 2026-09-29.
 *
 * `project.write` is the capability the link-based repository rows already
 * use on this tab (addRepository / removeRepository), held by owner,
 * ops_admin and delivery_lead; `projects.link_repository` and
 * `projects.unlink_repository` name the same three roles again, and RLS on
 * `projects.repository_links` a third time. Both functions write
 * audit.audit_log. Neither touches GitHub: linking records where to read
 * from, and the reading happens on the page, per request.
 */

export async function linkRepository(input: LinkRepositoryInput): Promise<Result<{ linkId: string }>> {
  const parsed = linkRepositorySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid repository.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to link a repository.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('link_repository', {
    p_project_id: parsed.data.projectId,
    p_owner: parsed.data.owner,
    p_repo: parsed.data.repo,
    p_default_branch: parsed.data.defaultBranch,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'linkRepository', detail: error.message }));
    return err('INTERNAL', 'Could not link the repository.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; id?: string | null } | undefined;
  switch (row?.outcome) {
    case 'linked':
      if (!row.id) return err('INTERNAL', 'Could not link the repository.');
      return ok({ linkId: row.id });
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may link a repository.');
    case 'not_found':
      return err('NOT_FOUND', 'Project not found.');
    case 'invalid_repository':
      return err('VALIDATION', 'That is not a GitHub owner/repository pair.');
    default:
      return err('INTERNAL', 'Could not link the repository.');
  }
}

export async function unlinkRepository(input: UnlinkRepositoryInput): Promise<Result<{ unlinked: true }>> {
  const parsed = unlinkRepositorySchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid project.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to unlink a repository.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .rpc('unlink_repository', { p_project_id: parsed.data.projectId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'unlinkRepository', detail: error.message }));
    return err('INTERNAL', 'Could not unlink the repository.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'unlinked':
      return ok({ unlinked: true });
    case 'not_linked':
      return err('NOT_FOUND', 'This project has no linked repository.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may unlink a repository.');
    default:
      return err('INTERNAL', 'Could not unlink the repository.');
  }
}
