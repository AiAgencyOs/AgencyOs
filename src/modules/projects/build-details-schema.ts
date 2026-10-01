import { z } from 'zod';

import { PROTOTYPE_PLATFORMS } from './prototype-schema';

/** A prototype or build's platform, commit ref, build number and rollback target, and Admin's decision on a prototype (migration 20261006400200). */

export const setDeliverableDetailsSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid(),
  platform: z.enum(PROTOTYPE_PLATFORMS).optional(),
  commitRef: z.string().trim().max(200, 'A commit ref is at most 200 characters.').default(''),
  buildNumber: z.string().trim().max(60, 'A build number is at most 60 characters.').default(''),
  rollbackTargetId: z.uuid().optional(),
  rollbackNote: z.string().trim().max(1000, 'A rollback note is at most 1000 characters.').default(''),
});
export type SetDeliverableDetailsInput = z.input<typeof setDeliverableDetailsSchema>;

export const decidePrototypeAdminSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid(),
  decision: z.enum(['approved', 'changes_required']),
  note: z.string().trim().max(1000, 'A note is at most 1000 characters.').default(''),
});
export type DecidePrototypeAdminInput = z.input<typeof decidePrototypeAdminSchema>;

export const recordPrototypeQaSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid(),
  outcome: z.enum(['passed', 'changes_required']),
  note: z.string().trim().max(1000, 'A note is at most 1000 characters.').default(''),
  evidenceUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v.length === 0 || v.startsWith('https://'), 'Evidence is a link that starts with https://')
    .default(''),
});
export type RecordPrototypeQaInput = z.input<typeof recordPrototypeQaSchema>;

export const sendPrototypeSchema = z.object({
  projectId: z.uuid(),
  deliverableId: z.uuid(),
  overrideReason: z.string().trim().max(500, 'An override reason is at most 500 characters.').default(''),
});
export type SendPrototypeInput = z.input<typeof sendPrototypeSchema>;

/** Pure: what stands between a prototype and the client, in words. Empty means it may go on the normal path. */
export function prototypeSendBlockers(gate: { qaPassed: boolean; adminApproved: boolean; qaSource: string }): string[] {
  const out: string[] = [];
  if (!gate.qaPassed) out.push(gate.qaSource === 'no QA evidence' ? 'QA has not passed it: there is no QA evidence yet.' : `QA has not passed it (${gate.qaSource}).`);
  if (!gate.adminApproved) out.push('Admin has not approved it.');
  return out;
}
