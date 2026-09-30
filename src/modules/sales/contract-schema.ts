import { z } from 'zod';

/**
 * Owner decision 10 — a contract is a simple record on a WON deal: title,
 * file link, signer name, signed date, status. No e-signature: "signed" is a
 * person recording that it was, naming who signed and the day.
 */
export const CONTRACT_STATUSES = ['draft', 'sent', 'signed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = { draft: 'Draft', sent: 'Sent', signed: 'Signed' };

/**
 * The moves the door allows (mirrored in `sales.update_contract_status`):
 * a draft goes out or is recorded signed; a sent one is signed or recalled to
 * draft; a signed contract is a record of what happened and does not move.
 */
const NEXT: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ['sent', 'signed'],
  sent: ['signed', 'draft'],
  signed: [],
};

export function nextContractStatuses(from: ContractStatus): readonly ContractStatus[] {
  return NEXT[from];
}

export function canMoveContract(from: ContractStatus, to: ContractStatus): boolean {
  return NEXT[from].includes(to);
}

const link = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\/\S+$/i, 'Paste a full link starting with https://');

const optionalLink = z.union([z.literal(''), link]).optional();

export const createContractSchema = z
  .object({
    opportunityId: z.uuid(),
    title: z.string().trim().min(1, 'A contract needs a title').max(200),
    fileUrl: optionalLink,
    signerName: z.string().trim().max(200).optional(),
    signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date').optional().or(z.literal('')),
    status: z.enum(CONTRACT_STATUSES).default('draft'),
  })
  .superRefine((v, ctx) => signedNeedsWhoAndWhen(v.status, v.signerName, v.signedOn, ctx));
export type CreateContractInput = z.input<typeof createContractSchema>;

export const updateContractStatusSchema = z
  .object({
    contractId: z.uuid(),
    status: z.enum(CONTRACT_STATUSES),
    fileUrl: optionalLink,
    signerName: z.string().trim().max(200).optional(),
    signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date').optional().or(z.literal('')),
  })
  .superRefine((v, ctx) => signedNeedsWhoAndWhen(v.status, v.signerName, v.signedOn, ctx));
export type UpdateContractStatusInput = z.input<typeof updateContractStatusSchema>;

/** A signed contract names its signer and the day; anything else carries neither a date. */
function signedNeedsWhoAndWhen(status: ContractStatus, signerName: string | undefined, signedOn: string | undefined, ctx: z.RefinementCtx) {
  if (status === 'signed') {
    if (!signerName?.trim()) ctx.addIssue({ code: 'custom', path: ['signerName'], message: 'A signed contract names who signed it' });
    if (!signedOn) ctx.addIssue({ code: 'custom', path: ['signedOn'], message: 'A signed contract has the day it was signed' });
  } else if (signedOn) {
    ctx.addIssue({ code: 'custom', path: ['signedOn'], message: 'Only a signed contract has a signed date' });
  }
}
