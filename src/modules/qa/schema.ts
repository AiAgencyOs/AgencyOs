import { z } from 'zod';

/**
 * The QA vocabulary — gap G-030, directive §19.
 *
 * The severity and status words are `ARCHITECTURE.md` §4.8's own, kept rather
 * than improved: a design document followed except where somebody preferred
 * otherwise is not a design document. Everything here mirrors a CHECK in
 * `20260813120002_qa_defects.sql`, and the tests read this file rather than
 * restating the lists, so the two cannot drift.
 */

export const DEFECT_SEVERITIES = ['blocker', 'major', 'minor', 'trivial'] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const DEFECT_STATUSES = ['open', 'fixed', 'wontfix', 'verified'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

/**
 * Legal moves.
 *
 * `fixed → open` is the one worth reading twice: verification failing is not
 * a new bug, it is the same bug still being wrong, and forcing a new row for
 * it would lose the history of what was tried. `verified` and `wontfix` are
 * terminal — a verified defect that can be reopened makes "verified" mean
 * "verified for now", and the entire value of the state is that somebody
 * checked.
 */
export const DEFECT_TRANSITIONS: Record<DefectStatus, readonly DefectStatus[]> = {
  open: ['fixed', 'wontfix'],
  fixed: ['verified', 'open'],
  verified: [],
  wontfix: [],
};

/** What stops a version reaching the client — ARCHITECTURE.md §4.8. */
export const BLOCKING_SEVERITIES: readonly DefectSeverity[] = ['blocker', 'major'];

export function blocksDelivery(defect: { status: DefectStatus; severity: DefectSeverity }): boolean {
  return defect.status === 'open' && BLOCKING_SEVERITIES.includes(defect.severity);
}

export const raiseDefectSchema = z.object({
  projectId: z.uuid(),
  /** Absent means project-wide: it blocks every submission, not one version. */
  deliverableId: z.uuid().optional(),
  severity: z.enum(DEFECT_SEVERITIES),
  title: z.string().trim().min(1, 'A defect needs a name').max(200),
  /**
   * Required, and not out of formality. A bug nobody can reproduce is a
   * rumour, and the cost of writing the steps down is paid once by whoever
   * found it rather than repeatedly by whoever picks it up.
   */
  reproduction: z.string().trim().min(1, 'How do you make it happen?').max(4000),
  expected: z.string().trim().max(2000).optional(),
  actual: z.string().trim().max(2000).optional(),
  environment: z.string().trim().max(500).optional(),
  evidenceUrl: z.url().optional(),
});

export type RaiseDefectInput = z.infer<typeof raiseDefectSchema>;

export const settleDefectSchema = z
  .object({
    defectId: z.uuid(),
    status: z.enum(['fixed', 'wontfix', 'verified', 'open']),
    /** Required to leave `open` — what stops a bug being closed by silence. */
    resolution: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.status === 'open' || (v.resolution && v.resolution.length > 0), {
    message: 'Say what happened to it.',
    path: ['resolution'],
  });

export type SettleDefectInput = z.infer<typeof settleDefectSchema>;
