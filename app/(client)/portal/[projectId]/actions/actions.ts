'use server';

import { revalidatePath } from 'next/cache';

import { requireClient } from '@/lib/auth/session';
import type { FormState } from '@/modules/identity/types';
import { resolveClientActionRequest } from '@/modules/portal/client-action-service';

/** The one action on the "what we need from you" page: it records the client's claim that something is done. It confirms nothing. */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

export async function resolveClientActionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireClient();
  const result = await resolveClientActionRequest(text(formData, 'requestId'), text(formData, 'note'), text(formData, 'reference') || null);
  if (!result.ok) return { status: 'error', message: result.message };
  revalidatePath(`/portal/${text(formData, 'projectId')}/actions`);
  return { status: 'success', message: result.message };
}
