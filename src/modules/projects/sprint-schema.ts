import { z } from 'zod';

/**
 * Sprints — owner decision 1, migration 20261005100000. A sprint belongs to
 * one project and has a fixed length: a start date and a number of days. The
 * last day is never stored; it is `starts_on + length_days - 1`, computed here
 * and nowhere else. No capacity, no velocity.
 */

export const SPRINT_LENGTH_MIN = 1;
export const SPRINT_LENGTH_MAX = 60;
/** The lengths the "New sprint" form offers first; any whole number of days from 1 to 60 is accepted. */
export const SPRINT_LENGTH_CHOICES = [7, 14, 21, 28] as const;

const DAY_MS = 86_400_000;

function parseDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last day of a sprint, inclusive: a 14-day sprint starting on the 1st ends on the 14th. */
export function sprintEnd(startsOn: string, lengthDays: number): string {
  return formatDay(parseDay(startsOn) + (lengthDays - 1) * DAY_MS);
}

export type SprintState = 'closed' | 'upcoming' | 'active' | 'ended';

/** Closed beats the calendar; otherwise the sprint is upcoming, active or (past its last day, still open) ended. */
export function sprintState(sprint: { startsOn: string; lengthDays: number; closedAt: string | null }, today: string): SprintState {
  if (sprint.closedAt) return 'closed';
  if (today < sprint.startsOn) return 'upcoming';
  if (today > sprintEnd(sprint.startsOn, sprint.lengthDays)) return 'ended';
  return 'active';
}

/** "Day 3 of 14" while the sprint is active, else null. */
export function sprintDay(sprint: { startsOn: string; lengthDays: number }, today: string): { day: number; of: number } | null {
  if (today < sprint.startsOn || today > sprintEnd(sprint.startsOn, sprint.lengthDays)) return null;
  return { day: Math.round((parseDay(today) - parseDay(sprint.startsOn)) / DAY_MS) + 1, of: sprint.lengthDays };
}

/** Whether two inclusive day ranges share a day — the rule the database applies to open sprints. */
export function sprintsOverlap(a: { startsOn: string; lengthDays: number }, b: { startsOn: string; lengthDays: number }): boolean {
  return a.startsOn <= sprintEnd(b.startsOn, b.lengthDays) && b.startsOn <= sprintEnd(a.startsOn, a.lengthDays);
}

export const createSprintSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1, 'Give the sprint a name.').max(80, 'A sprint name is at most 80 characters.'),
  startsOn: z.iso.date('Pick the first day of the sprint.'),
  lengthDays: z.number().int().min(SPRINT_LENGTH_MIN, 'A sprint lasts at least one day.').max(SPRINT_LENGTH_MAX, `A sprint lasts at most ${SPRINT_LENGTH_MAX} days.`),
});
export type CreateSprintInput = z.input<typeof createSprintSchema>;

export const closeSprintSchema = z.object({ projectId: z.uuid(), sprintId: z.uuid() });
export type CloseSprintInput = z.input<typeof closeSprintSchema>;

export const placeTaskInSprintSchema = z.object({ projectId: z.uuid(), taskId: z.uuid(), sprintId: z.uuid().nullable() });
export type PlaceTaskInSprintInput = z.input<typeof placeTaskInSprintSchema>;
