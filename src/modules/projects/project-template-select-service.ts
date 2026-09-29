import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { setProjectTemplateSchema, type SetProjectTemplateInput } from './project-template-select-schema';

/**
 * SCR-027 — record which saved template a project follows. Informational:
 * nothing is re-applied when it changes (a project created from a template
 * already carries the template's structure; one created by hand does not
 * gain it by naming a template afterwards, and the page says so).
 * `project.write`; `projects.set_project_template` checks
 * `core.can_manage_delivery()` again and audits `project.template_set`.
 */
export async function setProjectTemplate(input: SetProjectTemplateInput): Promise<Result<{ templateId: string | null }>> {
  const parsed = setProjectTemplateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid template.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change project settings.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('set_project_template', {
    p_project_id: parsed.data.projectId,
    p_template_id: parsed.data.templateId,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProjectTemplate', detail: error.message }));
    return err('INTERNAL', 'Could not record the template.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome ?? 'no answer') {
    case 'set':
      return ok({ templateId: parsed.data.templateId });
    case 'unknown_template':
      return err('NOT_FOUND', 'That template does not exist in this organisation.');
    case 'not_found':
      return err('NOT_FOUND', 'That project is not visible to you.');
    default:
      return err('FORBIDDEN', 'You do not have permission to change this project’s template.');
  }
}
