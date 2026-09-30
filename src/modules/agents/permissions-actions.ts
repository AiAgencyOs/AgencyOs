'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { setAgentProjectAssignment, setAgentToolPermission } from './permissions-service';

/** SCR-063 — the agent detail page's two owner-only writes. */

export async function setAgentToolPermissionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const result = await setAgentToolPermission({
    agentKey,
    toolKey: String(formData.get('toolKey') ?? '').trim(),
    allowed: formData.get('allowed') === 'true',
    note: String(formData.get('note') ?? '').trim() || undefined,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  return {
    status: 'success',
    message: `${result.data.allowed ? 'Allowed' : 'Denied'}. Recorded as policy — the orchestrator does not read it yet.`,
  };
}

export async function setAgentProjectAssignmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const agentKey = String(formData.get('agentKey') ?? '');
  const projectId = String(formData.get('projectId') ?? '');
  const result = await setAgentProjectAssignment({
    agentKey,
    projectId,
    active: formData.get('active') === 'true',
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(`/agents/${agentKey}`);
  revalidatePath(`/projects/${projectId}`);
  return { status: 'success', message: result.data.active ? 'Assigned.' : 'Assignment withdrawn.' };
}
