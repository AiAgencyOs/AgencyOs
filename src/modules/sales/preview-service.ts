import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { quotationSectionsFor } from './quotation-standards';
import { quotationDocumentSurroundings } from './service';

/**
 * SCR-012 — the quotation as it WOULD render, before anything is saved.
 *
 * The composer posts its own fields here and gets the same document the
 * saved quotation would produce: the same renderer, the same sections
 * assembler, the same letterhead reader — only the row does not exist yet,
 * so the reference reads PREVIEW, the version is "next" as a label and the
 * status band says draft. Nothing is written, and the arithmetic is the
 * composer's own: the totals that count are the ones the pricing door
 * computes from stored rows once the person saves.
 *
 * `proposal.draft`, the composer's gate; the opportunity is read under the
 * caller's RLS for the letterhead's "prepared for" line.
 */
export const quotationPreviewSchema = z.object({
  opportunityId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(20_000).default(''),
  validUntil: z.iso.date().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('INR'),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(500), quantity: z.number().positive().max(1_000_000), unitPriceMinor: z.number().int().nonnegative() })).min(1).max(100),
  discountMinor: z.number().int().nonnegative().default(0),
  taxMinor: z.number().int().nonnegative().default(0),
  commercialTerms: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
});
export type QuotationPreviewInput = z.input<typeof quotationPreviewSchema>;

export async function quotationPdfPreview(input: QuotationPreviewInput): Promise<Result<{ bytes: Uint8Array; filename: string }>> {
  const parsed = quotationPreviewSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Add a title and at least one line to preview.');

  const context = await requireInternal();
  if (!can(context, 'proposal.draft')) return err('FORBIDDEN', 'You do not have permission to draft quotations.');

  const supabase = await createClient();
  const { data: opportunity, error } = await supabase.schema('sales').from('opportunities').select('id').eq('id', parsed.data.opportunityId).maybeSingle();
  if (error) return err('INTERNAL', 'Could not read the deal.');
  if (!opportunity) return err('NOT_FOUND', 'Deal not found.');

  const items = parsed.data.lines.map((l) => ({ description: l.description, quantity: l.quantity, amountMinor: Math.round(l.quantity * l.unitPriceMinor) }));
  const subtotalMinor = items.reduce((n, i) => n + i.amountMinor, 0);
  const totalMinor = Math.max(0, subtotalMinor - parsed.data.discountMinor + parsed.data.taxMinor);

  try {
    const surroundings = await quotationDocumentSurroundings(supabase, opportunity.id);
    const { renderQuotationPdf, quotationPdfFilename } = await import('@/lib/pdf/quotation');
    const sections = quotationSectionsFor(
      totalMinor,
      parsed.data.taxMinor,
      { understanding: parsed.data.body || null, commercialTerms: parsed.data.commercialTerms.length > 0 ? parsed.data.commercialTerms : null },
      items,
      { validityDays: surroundings.validityDays },
    );
    const rendered = await renderQuotationPdf({
      ...surroundings,
      preparedByName: null,
      preparedByRole: null,
      title: parsed.data.title,
      version: 0,
      status: 'draft',
      body: parsed.data.body || null,
      currency: parsed.data.currency,
      items,
      ...(sections ?? {}),
      subtotalMinor,
      discountMinor: parsed.data.discountMinor,
      taxMinor: parsed.data.taxMinor,
      totalMinor,
      validUntil: parsed.data.validUntil ?? null,
      preparedAt: new Date().toISOString(),
      // The nil uuid: the footer's address names no row, and the derived
      // code reads Q-<year>-000000 rather than a hex slice of a word.
      reference: '00000000-0000-0000-0000-000000000000',
    });
    return ok({ bytes: rendered.bytes, filename: quotationPdfFilename(`PREVIEW ${parsed.data.title}`, 0) });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'quotationPdfPreview', detail }));
    return err('INTERNAL', 'The preview could not be rendered.');
  }
}
