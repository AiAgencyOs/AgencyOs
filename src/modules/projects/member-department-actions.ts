'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setMemberDepartment } from './member-department-service';

/** The Team tab's Department control — a Server Action over core.set_member_department. */
export async function setMemberDepartmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const raw = String(formData.get('department') ?? '').trim();
  const result = await setMemberDepartment({ userId: String(formData.get('userId') ?? ''), department: raw === '' ? null : (raw as never) });
  if (!result.ok) return { status: 'error', message: result.error.message };
  if (projectId) revalidatePath(`/projects/${projectId}/team`);
  revalidatePath('/settings/team');
  return { status: 'success', message: result.data.department ? `Department set to ${result.data.department}.` : 'Department cleared.' };
}
