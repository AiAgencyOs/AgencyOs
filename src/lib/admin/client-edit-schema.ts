import { z } from 'zod';

/**
 * The client edit form's shape — SCR-014/015. Pure (no server import) so
 * the form, the door and a test can all read it; the checksum is the
 * database's (`core.update_client_account`), and `client-edit.ts` holds
 * the door.
 */
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const updateClientAccountSchema = z.object({
  clientAccountId: z.uuid(),
  name: z.string().trim().min(1, 'A client needs a name.').max(200),
  legalName: z.string().trim().max(200).default(''),
  gstin: z.string().trim().toUpperCase().max(15).default('').refine((v) => v === '' || GSTIN_SHAPE.test(v), 'A GSTIN is 15 characters: 2 digits, 10-character PAN, entity digit, Z, check character.'),
  pan: z.string().trim().toUpperCase().max(10).default('').refine((v) => v === '' || PAN_SHAPE.test(v), 'A PAN is 5 letters, 4 digits, 1 letter.'),
  billingAddress: z.string().trim().max(1000).default(''),
});
export type UpdateClientAccountInput = z.input<typeof updateClientAccountSchema>;
