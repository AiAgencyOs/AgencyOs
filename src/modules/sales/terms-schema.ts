import { z } from 'zod';

/**
 * SCR-012 — the commercial terms as edited in the composer. Stored on the
 * draft's `document.commercialTerms`; once the quotation leaves draft,
 * `proposals_guard` freezes the document and the next version is how they
 * change. An empty list means "the standard clauses", exactly as before.
 */
export const MAX_TERMS = 30;

export const setProposalTermsSchema = z.object({
  proposalId: z.uuid(),
  terms: z.array(z.string().trim().min(1).max(500)).max(MAX_TERMS),
});
export type SetProposalTermsInput = z.infer<typeof setProposalTermsSchema>;

/** One clause per non-empty line, trimmed and bounded — what the textarea posts. */
export function termsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}
