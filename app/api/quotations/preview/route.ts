import { NextResponse } from 'next/server';

import { quotationPdfPreview } from '@/modules/sales/preview-service';
import { termsFromText } from '@/modules/sales/terms-schema';
import { routeError } from '@/lib/route-errors';

/**
 * SCR-012 — "Preview PDF" from the composer, before anything is saved.
 *
 * The composer's own form posts here (a second submit button with
 * `formAction` and `formTarget="_blank"`), so the fields are exactly the
 * ones `composeQuotationAction` would receive; the service renders them
 * with the same renderer the saved quotation uses and nothing is written.
 * `inline`, like the saved document's route: the browser shows it, the
 * person looks, then goes back and saves or edits.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toMinor(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const descriptions = formData.getAll('lineDescription').map((v) => String(v).trim());
  const quantities = formData.getAll('lineQuantity').map((v) => Number(String(v).trim() || '1'));
  const unitPrices = formData.getAll('lineUnitPrice').map((v) => toMinor(v));
  const lines = descriptions
    .map((description, i) => ({ description, quantity: Number.isFinite(quantities[i]) && (quantities[i] ?? 0) > 0 ? (quantities[i] as number) : 1, unitPriceMinor: unitPrices[i] ?? 0 }))
    .filter((l) => l.description.length > 0);

  const projectType = String(formData.get('projectType') ?? '').trim();
  const duration = String(formData.get('duration') ?? '').trim();
  const bodyText = String(formData.get('body') ?? '').trim();
  const body = [projectType ? `Project type: ${projectType}` : '', duration ? `Duration: ${duration}` : '', bodyText].filter(Boolean).join('\n');

  const result = await quotationPdfPreview({
    opportunityId: String(formData.get('opportunityId') ?? ''),
    title: String(formData.get('title') ?? ''),
    body,
    validUntil: String(formData.get('validUntil') ?? '') || undefined,
    currency: String(formData.get('currency') ?? 'INR'),
    lines,
    discountMinor: toMinor(formData.get('discount')),
    taxMinor: toMinor(formData.get('tax')),
    commercialTerms: termsFromText(String(formData.get('commercialTerms') ?? '')),
  });

  if (!result.ok) {
    return routeError(result.error.code, result.error.message);
  }

  return new NextResponse(Buffer.from(result.data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${result.data.filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
