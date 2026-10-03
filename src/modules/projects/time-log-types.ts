/**
 * Plain types for time logs, shared by the server readers in
 * time-log-queries.ts and the client panels that render them. No
 * server-only import lives here so a client component may import it.
 */
export type TimeLogEntry = {
  id: string;
  taskId: string;
  personId: string;
  personName: string;
  hours: number;
  loggedOn: string;
  note: string | null;
  createdAt: string;
};

export type TaskTime = {
  taskId: string;
  totalHours: number;
  entries: TimeLogEntry[];
};

export function emptyTaskTime(taskId: string): TaskTime {
  return { taskId, totalHours: 0, entries: [] };
}
