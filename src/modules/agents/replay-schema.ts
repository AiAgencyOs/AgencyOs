import { z } from 'zod';

/** SCR-065 — replay a run's job. Mirrors `ai.replay_run` (20261001150000): only `read` work, with a reason. */
export const replayRunSchema = z.object({
  runId: z.uuid('Not a run id.'),
  reason: z.string().trim().min(1, 'Say why the run is being replayed.').max(500),
});
export type ReplayRunInput = z.infer<typeof replayRunSchema>;
