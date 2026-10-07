'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireClient } from '@/lib/auth/session';
import type { FormState } from '@/modules/identity/types';
import { readClientHandoverItems } from '@/modules/portal/handover-queries';
import { logHandoverAccess, requestHandoverAcceptance } from '@/modules/portal/handover-service';

/**
 * The handover page's two actions. Nothing here accepts a handover: the request action writes a REQUEST that a person confirms with their own verification,
 * and the open action logs the access and then follows the reference the database function returned (never one the form supplied).
 */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

export async function requestHandoverAcceptanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireClient();
  const projectId = text(formData, 'projectId');
  const kind = text(formData, 'kind') === 'changes_request' ? 'changes_request' : 'acceptance_request';
  const result = await requestHandoverAcceptance(text(formData, 'packageId'), kind, text(formData, 'note') || null);
  if (!result.ok) return { status: 'error', message: result.message };
  revalidatePath(`/portal/${projectId}/handover`);
  return { status: 'success', message: result.message };
}

/** Log the opening of one delivered item, then send the client to it. A reference that is not a web address is shown on the page instead. */
export async function openHandoverItemAction(formData: FormData): Promise<void> {
  await requireClient();
  const projectId = text(formData, 'projectId');
  const packageId = text(formData, 'packageId');
  const kind = text(formData, 'kind');
  // the reference is read again from the client-safe function: a forged form field reaches nothing the client may not already see
  const items = await readClientHandoverItems(projectId);
  const item = items.find((i) => i.kind === kind);
  if (!item) redirect(`/portal/${projectId}/handover`);
  const logged = await logHandoverAccess(packageId, 'item_opened', kind);
  if (logged !== 'logged') redirect(`/portal/${projectId}/handover`);
  const ref = item.artifactRef ?? '';
  if (/^https?:\/\//i.test(ref)) redirect(ref);
  redirect(`/portal/${projectId}/handover`);
}
