/**
 * Where a proof or receipt is opened from — pure and client-safe.
 *
 * An UPLOADED file is opened through /api/finance/attachment (a signed URL the
 * route mints per click, five minutes long); a pasted LINK is opened as it is.
 * When a record has both, the uploaded file wins: it is the one we hold.
 */
export const FINANCE_ATTACHMENT_ROUTE = '/api/finance/attachment';

export function claimProofHref(c: { id: string; proofUrl: string | null; proofFileName?: string | null }): string | null {
  if (c.proofFileName) return `${FINANCE_ATTACHMENT_ROUTE}/claim-proof/${c.id}`;
  return c.proofUrl;
}

export function expenseReceiptHref(e: { id: string; receiptUrl?: string | null; receiptFileName?: string | null }): string | null {
  if (e.receiptFileName) return `${FINANCE_ATTACHMENT_ROUTE}/expense-receipt/${e.id}`;
  return e.receiptUrl ?? null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;

/** Whether the proof is an image worth previewing inline: judged by the uploaded file's name, else the link. */
export function proofIsImage(href: string | null, fileName?: string | null): boolean {
  if (!href) return false;
  return IMAGE.test(fileName ?? href);
}
