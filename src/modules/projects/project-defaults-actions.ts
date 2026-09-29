'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { WATCH_PHASES, type WatchPhase } from './project-defaults-schema';
import { setProjectDefaultAssignee, unwatchProject, watchProject } from './project-defaults-service';

/** SCR-027 — the Settings tab's defaults and the overview's watch control. */

function revalidateProject(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/settings`);
  revalidatePath('/notifications');
}

export async function setDefaultAssigneeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const result = await setProjectDefaultAssignee({
    projectId,
    defaultAssigneeId: String(formData.get('defaultAssigneeId') ?? '').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateProject(projectId);
  return { status: 'success', message: result.data.cleared ? 'Default assignee cleared — new tasks start unassigned.' : 'Default assignee saved.' };
}

export async function watchProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const userId = String(formData.get('userId') ?? '').trim() || undefined;
  const chosen = formData.getAll('phases').map(String).filter((p): p is WatchPhase => (WATCH_PHASES as readonly string[]).includes(p));
  // No box on the form at all (the header's one-click control) means every phase.
  const phases = formData.has('phasesForm') ? chosen : [...WATCH_PHASES];

  const result = await watchProject({ projectId, userId, phases });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateProject(projectId);
  return { status: 'success', message: userId ? 'Watcher added.' : 'You are watching this project.' };
}

export async function unwatchProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const userId = String(formData.get('userId') ?? '').trim() || undefined;

  const result = await unwatchProject({ projectId, userId });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateProject(projectId);
  return { status: 'success', message: result.data.removed ? (userId ? 'Watcher removed.' : 'You stopped watching this project.') : 'Nobody was watching.' };
}
