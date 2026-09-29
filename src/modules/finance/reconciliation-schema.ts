import { z } from 'zod';

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date, like 2026-09-01');

/** Doc 15 §15's five findings — the finance.reconciliation_items CHECK verbatim. */
export const RECONCILIATION_FINDINGS = ['matched', 'unmatched', 'duplicate', 'missing', 'discrepant'] as const;
export type ReconciliationFinding = (typeof RECONCILIATION_FINDINGS)[number];

export const openReconciliationSchema = z
  .object({
    periodStart: isoDate,
    periodEnd: isoDate,
    source: z.string().trim().min(1, 'Say which statement this is').max(200),
    accountId: z.uuid().optional(),
  })
  .refine((v) => v.periodEnd > v.periodStart, { message: 'The period must end after it starts.' });
export type OpenReconciliationInput = z.infer<typeof openReconciliationSchema>;

/**
 * One statement line, verbatim, with our reading of it beside it. A
 * `matched` finding must name the payment (the table refuses otherwise); an
 * exception may be queued before anybody knows why — §29's queue.
 */
export const addReconciliationItemSchema = z
  .object({
    reconciliationId: z.uuid(),
    statementLine: z.string().trim().min(1, 'Paste the statement line').max(500),
    statementDate: isoDate,
    amountMinor: z.number().int(),
    reference: z.string().trim().max(200).optional(),
    finding: z.enum(RECONCILIATION_FINDINGS),
    paymentId: z.uuid().optional(),
    reason: z.string().trim().max(600).optional(),
  })
  .refine((v) => v.finding !== 'matched' || Boolean(v.paymentId), {
    message: 'A matched line must name the payment it matched.',
    path: ['paymentId'],
  });
export type AddReconciliationItemInput = z.infer<typeof addReconciliationItemSchema>;

/** Working the exception queue: change the finding, name a payment, give the reason. */
export const resolveReconciliationItemSchema = z
  .object({
    itemId: z.uuid(),
    finding: z.enum(RECONCILIATION_FINDINGS),
    paymentId: z.uuid().optional(),
    reason: z.string().trim().max(600).optional(),
  })
  .refine((v) => v.finding !== 'matched' || Boolean(v.paymentId), {
    message: 'A matched line must name the payment it matched.',
    path: ['paymentId'],
  });
export type ResolveReconciliationItemInput = z.infer<typeof resolveReconciliationItemSchema>;

export const closeReconciliationSchema = z.object({ reconciliationId: z.uuid() });
export type CloseReconciliationInput = z.infer<typeof closeReconciliationSchema>;
