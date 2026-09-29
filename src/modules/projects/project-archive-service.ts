import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { archiveProjectSchema, type ArchiveProjectInput } from './project-archive-schema';

/**
 * Archive a completed project — SCR-018 (migration 20261001120000).
 * `project.write` here; `projects.archive_project` checks
 * `core.can_manage_delivery()` again under its own row lock, refuses any
 * status but `completed`, and writes the audit row in the same transaction.
 */
export async function archiveProject(input: ArchiveProjectInput): Promise<Result<{ archivedAt: string; alreadyArchived: boolean }>> {
  const parsed = archiveProjectSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid project.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to archive a project.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('archive_project', {
    p_project_id: parsed.data.projectId,
    ...(parsed.data.reason ? { p_reason: parsed.data.reason } : {}),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'archiveProject', detail: error.message }));
    return err('INTERNAL', 'Could not archive the project.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; archived_at?: string | null } | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'archived':
      return ok({ archivedAt: row?.archived_at ?? new Date().toISOString(), alreadyArchived: false });
    case 'already_archived':
      return ok({ archivedAt: row?.archived_at ?? '', alreadyArchived: true });
    case 'not_completed':
      return err('CONFLICT', 'Only a completed project can be archived. Finish it first — an archive is where finished work goes, not where an active project is hidden.');
    case 'not_found':
      return err('NOT_FOUND', 'That project is not visible to you.');
    default:
      return err('FORBIDDEN', 'You do not have permission to archive this project.');
  }
}
