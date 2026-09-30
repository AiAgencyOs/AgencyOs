'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { switchOrganization } from '@/lib/admin/organization-switch';
import type { FormState } from '@/modules/identity/types';

/**
 * The organisation selector's door — SCR-001 (bucket F, stream F-A). One
 * Server Action over `switchOrganization`, which records the choice
 * (audited as `organization.switched`) and refreshes the session; on
 * success the whole shell is re-rendered from /dashboard under the new
 * claims. A refusal is shown verbatim beside the selector.
 */
export async function switchOrganizationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const organizationId = String(formData.get('organizationId') ?? '').trim();
  if (!organizationId) return { status: 'error', message: 'Choose an organisation.' };

  const result = await switchOrganization({ organizationId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/', 'layout');
  redirect('/dashboard');
}
