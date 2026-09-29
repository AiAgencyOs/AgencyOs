'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { err, ok, type Result } from '@/lib/result';
import type { FormState } from '@/modules/identity/types';

import { listProjectTemplates, type ProjectTemplateSummary } from './project-template-queries';
import type { CreateProjectFromTemplateInput } from './project-template-schema';
import { createProjectFromTemplate, createProjectTemplateFromProject, deleteProjectTemplate, type FromTemplateOutcome } from './project-template-service';

/**
 * Project templates — the doors as Server Actions. Decision: reversed by
 * the owner on 2026-09-29. "Save as template" and "delete" are
 * `FormState` forms; "create from template" is RPC-style like
 * `createProjectManuallyAction`, because the Quick Create palette needs
 * the new project's id to navigate there, and the picker is a read
 * exposed as an action for the same reason that palette's client pickers
 * are — a failed read is a refusal, not an empty list.
 */

export async function createProjectTemplateFromProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await createProjectTemplateFromProject({
    projectId,
    name: String(formData.get('name') ?? ''),
    description: String(formData.get('description') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/templates');
  const c = result.data.counts;
  return {
    status: 'success',
    message: `Saved: ${c.modules} module${c.modules === 1 ? '' : 's'}, ${c.features} feature${c.features === 1 ? '' : 's'}, ${c.milestones} milestone${c.milestones === 1 ? '' : 's'}, ${c.scopeItems} scope item${c.scopeItems === 1 ? '' : 's'}, ${c.tasks} task title${c.tasks === 1 ? '' : 's'}, ${c.onboarding} onboarding item${c.onboarding === 1 ? '' : 's'}.`,
  };
}

export async function createProjectFromTemplateAction(input: CreateProjectFromTemplateInput): Promise<Result<FromTemplateOutcome>> {
  const result = await createProjectFromTemplate(input);
  if (result.ok) {
    revalidatePath('/projects');
    revalidatePath('/clients');
  }
  return result;
}

export async function listProjectTemplateOptionsAction(): Promise<Result<ProjectTemplateSummary[]>> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to create projects.');
  try {
    return ok(await listProjectTemplates());
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Templates could not be read.');
  }
}

export async function deleteProjectTemplateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await deleteProjectTemplate({ templateId: String(formData.get('templateId') ?? '') });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/settings/templates');
  return { status: 'success', message: 'Template deleted.' };
}
