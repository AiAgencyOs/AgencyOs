import { z } from 'zod';

/**
 * The bank CSV import and its two resolutions — SCR-053, owner decision
 * 2026-09-29 (AGENT_BRIEF_D decision 2). Parsing lives in bank-csv.ts; these
 * are the shapes the doors accept.
 */

/** Upload size ceiling. A month of statement lines is kilobytes; this is generous. */
export const BANK_CSV_MAX_BYTES = 2 * 1024 * 1024;

export const importBankStatementSchema = z.object({
  reconciliationId: z.uuid(),
  filename: z.string().trim().max(200).optional(),
  csvText: z.string().min(1, 'The file is empty.').max(BANK_CSV_MAX_BYTES, 'That file is too large for a statement.'),
});
export type ImportBankStatementInput = z.infer<typeof importBankStatementSchema>;

export const confirmBankLineMatchSchema = z.object({
  lineId: z.uuid(),
  paymentId: z.uuid('Choose the payment this line is.'),
  reason: z.string().trim().max(600).optional(),
});
export type ConfirmBankLineMatchInput = z.infer<typeof confirmBankLineMatchSchema>;

export const ignoreBankLineSchema = z.object({
  lineId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why this line is set aside.').max(600),
});
export type IgnoreBankLineInput = z.infer<typeof ignoreBankLineSchema>;

export const BANK_LINE_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: 'Pending',
  confirmed: 'Matched',
  ignored: 'Set aside',
};
