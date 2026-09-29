'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { err, ok, type Result } from '@/lib/result';

import {
  listClientAccountOptions,
  listMilestoneOptions,
  listProjectOptions,
  type ClientAccountOption,
  type MilestoneOption,
  type ProjectOption,
} from './project-create-queries';
import type { CreateProjectManuallyInput } from './project-create-schema';
import { createProjectManually } from './project-create-service';

/**
 * Quick Create's project door and its pickers — SCR-004.
 *
 * RPC-style rather than `FormState`, like `createLeadAction`: the command
 * palette needs the created id to navigate there. The pickers are reads
 * exposed as actions because the palette is a client component with no
 * server render to hand them down through; a failed read is returned as a
 * refusal rather than an empty list, so the picker says "could not be
 * read" instead of "no clients".
 */
export async function createProjectManuallyAction(
  input: CreateProjectManuallyInput,
): Promise<Result<{ projectId: string }>> {
  const result = await createProjectManually(input);
  if (result.ok) {
    revalidatePath('/projects');
    revalidatePath('/clients');
  }
  return result;
}

export async function listClientAccountOptionsAction(): Promise<Result<ClientAccountOption[]>> {
  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to create projects.');
  try {
    return ok(await listClientAccountOptions());
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Client accounts could not be read.');
  }
}

export async function listProjectOptionsAction(): Promise<Result<ProjectOption[]>> {
  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) return err('FORBIDDEN', 'You do not have permission to raise invoices.');
  try {
    return ok(await listProjectOptions());
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Projects could not be read.');
  }
}

export async function listMilestoneOptionsAction(projectId: string): Promise<Result<MilestoneOption[]>> {
  const context = await requireInternal();
  if (!can(context.role, 'invoice.create')) return err('FORBIDDEN', 'You do not have permission to raise invoices.');
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return err('VALIDATION', 'Pick a project first.');
  try {
    return ok(await listMilestoneOptions(projectId));
  } catch (e) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Milestones could not be read.');
  }
}
