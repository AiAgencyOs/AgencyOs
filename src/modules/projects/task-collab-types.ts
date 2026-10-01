/**
 * The shapes the task collaboration panel renders — kept free of any server
 * import so a client component may import the empty value without pulling
 * `@/lib/db/server` (and `next/headers`) into the browser bundle.
 */

export type TaskComment = { id: string; body: string; authorId: string | null; authorName: string; createdAt: string; createdLabel: string };
export type TaskChecklistItem = {
  id: string;
  label: string;
  position: number;
  doneAt: string | null;
  doneBy: string | null;
  doneByName: string | null;
  doneLabel: string | null;
};
export type TaskAttachment = { id: string; title: string; url: string; /** SCR-020: screenshot | log | url | file. */ kind: string; addedByName: string | null; createdAt: string; createdLabel: string };

export type TaskCollab = {
  taskId: string;
  comments: TaskComment[];
  checklist: TaskChecklistItem[];
  /** Ticked / total, and the percentage the progress bar draws. */
  progress: { done: number; total: number; percent: number };
  attachments: TaskAttachment[];
  blocked: { reason: string | null; at: string | null; sinceLabel: string | null; type: string | null; owner: string | null; nextAction: string | null };
  /** SCR-021: evidence submitted for this task (`projects.task_evidence`) — the hand-off to review needs at least one. */
  evidenceCount: number;
  /** SCR-020: who produced the work, and whether an agent's work has been verified. */
  origin: { kind: 'human' | 'agent'; verifiedAt: string | null; verifiedLabel: string | null; verifiedByName: string | null; note: string | null };
};

export function emptyTaskCollab(taskId: string): TaskCollab {
  return {
    taskId,
    comments: [],
    checklist: [],
    progress: { done: 0, total: 0, percent: 0 },
    attachments: [],
    blocked: { reason: null, at: null, sinceLabel: null, type: null, owner: null, nextAction: null },
    evidenceCount: 0,
    origin: { kind: 'human', verifiedAt: null, verifiedLabel: null, verifiedByName: null, note: null },
  };
}
