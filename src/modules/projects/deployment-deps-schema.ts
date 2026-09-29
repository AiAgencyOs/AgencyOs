import { z } from 'zod';

/** SCR-049 — a deployment dependency on the release candidate's handover (`projects.set_deployment_dependency`). */
export const setDeploymentDependencySchema = z.object({
  projectId: z.uuid(),
  handoverId: z.uuid(),
  label: z.string().trim().min(1, 'Name the dependency.').max(200),
  status: z.enum(['pending', 'ready']).default('pending'),
  remove: z.boolean().default(false),
});
export type SetDeploymentDependencyInput = z.input<typeof setDeploymentDependencySchema>;

export type DeploymentDependency = { label: string; status: 'pending' | 'ready'; updatedAt: string | null };

/** The jsonb column as the page reads it; anything malformed is dropped rather than guessed at. */
export function parseDeploymentDependencies(raw: unknown): DeploymentDependency[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => e !== null && typeof e.label === 'string')
    .map((e) => ({ label: String(e.label), status: e.status === 'ready' ? 'ready' : 'pending', updatedAt: typeof e.updated_at === 'string' ? e.updated_at : null }));
}
