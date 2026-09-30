import { z } from 'zod';

/**
 * SCR-027 — a project's default assignee and its watchers
 * (`projects.projects.default_assignee_id`, `projects.project_watchers`,
 * 20260929190000).
 */

/** The state rows a watcher can follow — the CHECK on `project_watchers.phases`. */
export const WATCH_PHASES = ['status', 'phase_two', 'phase_three', 'phase_four'] as const;
export type WatchPhase = (typeof WATCH_PHASES)[number];

export const WATCH_PHASE_LABEL: Record<WatchPhase, string> = {
  status: 'Project status',
  phase_two: 'Phase 2 — planning',
  phase_three: 'Phase 3 — design',
  phase_four: 'Phase 4 — UI & prototype',
};

export const setDefaultAssigneeSchema = z.object({
  projectId: z.uuid(),
  /** Null clears it: tasks go back to being created unassigned. */
  defaultAssigneeId: z.uuid().nullable(),
});
export type SetDefaultAssigneeInput = z.infer<typeof setDefaultAssigneeSchema>;

export const watchProjectSchema = z.object({
  projectId: z.uuid(),
  /** Omitted means the caller themself. Naming somebody else is owner/ops_admin only. */
  userId: z.uuid().optional(),
  /** Omitted means the organisation's default phases (Settings › Project defaults), else all four. */
  phases: z.array(z.enum(WATCH_PHASES)).max(WATCH_PHASES.length).optional(),
});
export type WatchProjectInput = z.infer<typeof watchProjectSchema>;

export const unwatchProjectSchema = z.object({
  projectId: z.uuid(),
  userId: z.uuid().optional(),
});
export type UnwatchProjectInput = z.infer<typeof unwatchProjectSchema>;
