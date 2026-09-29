import { z } from 'zod';

/**
 * SCR-034/035 — a person edits a screen's states, role, device targets,
 * components and responsive coverage after creation (migration
 * 20261001130000, `projects.set_screen_states`).
 */

export const DEVICE_TARGETS = ['mobile', 'tablet', 'desktop', 'watch', 'tv'] as const;
export type DeviceTarget = (typeof DEVICE_TARGETS)[number];

const listOf = z
  .string()
  .trim()
  .max(2000)
  .transform((v) =>
    v
      .split(/\r?\n|,|;/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50),
  );

export const setScreenStatesSchema = z.object({
  projectId: z.uuid(),
  screenId: z.uuid(),
  hasEmptyState: z.boolean().default(false),
  hasLoadingState: z.boolean().default(false),
  hasErrorState: z.boolean().default(false),
  hasSuccessState: z.boolean().default(false),
  userRole: z.string().trim().max(100).optional(),
  deviceTargets: z.array(z.enum(DEVICE_TARGETS)).default([]),
  /** One component per line or comma. */
  components: z.string().optional().transform((v) => (v ?? '')).pipe(listOf),
  /** The device targets whose layout is drawn and checked. */
  responsiveCovered: z.array(z.enum(DEVICE_TARGETS)).default([]),
});
export type SetScreenStatesInput = z.input<typeof setScreenStatesSchema>;

/** `{"mobile": true, "tablet": false}` over the screen's targets — what the database stores. */
export function responsiveCoverage(targets: readonly string[], covered: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of targets) out[t] = covered.includes(t);
  return out;
}

/** Coverage as the inventory reports it: targets covered over all targets; null when the screen names none. */
export function coverageOf(targets: readonly string[], coverage: unknown): { covered: number; total: number } | null {
  if (targets.length === 0) return null;
  const map = (coverage && typeof coverage === 'object' ? coverage : {}) as Record<string, unknown>;
  return { covered: targets.filter((t) => map[t] === true).length, total: targets.length };
}
