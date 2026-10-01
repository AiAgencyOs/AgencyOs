'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { WATCH_PHASES, type WatchPhase } from './project-defaults-schema';
import { setProjectDefaultAssignee, setProjectRoleDefaultAssignee, unwatchProject, watchProject } from './project-defaults-service';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES, type ProjectRole } from './project-members-schema';

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
  // No box on the form at all (the header's one-click control) means the organisation's default phases (Settings › Project defaults).
  const phases = formData.has('phasesForm') ? chosen : undefined;

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

/** Q-B4 — one project role's default assignee, from the Settings tab. A blank person clears it. */
export async function setRoleDefaultAssigneeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const projectId = String(formData.get('projectId') ?? '');
  const role = String(formData.get('projectRole') ?? '');
  if (!(PROJECT_ROLES as readonly string[]).includes(role)) return { status: 'error', message: 'Choose a project role.' };
  const projectRole = role as ProjectRole;
  const result = await setProjectRoleDefaultAssignee({
    projectId,
    projectRole,
    userId: String(formData.get('userId') ?? '').trim() || null,
  });
  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidateProject(projectId);
  const label = PROJECT_ROLE_LABEL[projectRole];
  return { status: 'success', message: result.data.cleared ? `${label} default cleared.` : `${label} default saved.` };
}
