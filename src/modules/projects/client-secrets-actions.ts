'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { revealClientSecret, revokeClientSecret, storeClientSecret } from './client-secrets-service';

/** The project vault's three doors (ADM-106). Nothing here puts a value in a URL, a log or a revalidated page. */

export type RevealState = FormState & { value?: string; label?: string };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

export async function storeClientSecretAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await storeClientSecret({
    projectId,
    label: text(formData, 'label'),
    kind: text(formData, 'kind'),
    value: String(formData.get('value') ?? ''),
  });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Stored — encrypted. Opening it later is recorded against your name.' };
}

export async function revealClientSecretAction(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const result = await revealClientSecret(text(formData, 'secretId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  return { status: 'success', message: 'Shown once, and recorded in the audit log against your name.', label: result.data.label, value: result.data.value };
}

export async function revokeClientSecretAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = text(formData, 'projectId');
  const result = await revokeClientSecret(text(formData, 'secretId'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: 'Revoked — the value is gone.' };
}
