'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';
import { resolveTaxFlag, saveNegotiationLimits, saveTaxConfig } from '@/modules/sales/p1o-quotation-service';

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

/** Rupees typed by a person, to minor units exactly (no float arithmetic on money); null for anything that is not a plain amount. */
function minor(v: string): number | null {
  const m = v.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

export async function saveTaxConfigAction(_prev: FormState, f: FormData): Promise<FormState> {
  const mode = text(f, 'mode') === 'gst' ? 'gst' : 'non_gst';
  const pct = text(f, 'ratePercent');
  const m = pct.match(/^(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (mode === 'gst' && !m) return { status: 'error', message: 'Enter the GST rate as a percentage, like 18 or 12.5.' };
  const rateBp = mode === 'non_gst' ? 0 : Number((m as RegExpMatchArray)[1]) * 100 + Number(((m as RegExpMatchArray)[2] ?? '').padEnd(2, '0'));
  const result = await saveTaxConfig({ mode, rateBp, note: text(f, 'note') || null });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/policy');
  return { status: 'success', message: result.data };
}

export async function saveLimitsAction(_prev: FormState, f: FormData): Promise<FormState> {
  const discount = text(f, 'maxDiscount');
  const advance = text(f, 'minAdvance');
  const maxDiscountMinor = discount === '' ? null : minor(discount);
  if (discount !== '' && (maxDiscountMinor === null || maxDiscountMinor <= 0)) return { status: 'error', message: 'Enter the maximum discount in rupees, like 5000, or leave it empty for no limit.' };
  const minAdvancePct = advance === '' ? null : Number(advance);
  if (advance !== '' && (!Number.isFinite(minAdvancePct) || (minAdvancePct as number) <= 0 || (minAdvancePct as number) > 100)) return { status: 'error', message: 'The minimum advance is a percentage between 1 and 100, or empty for no limit.' };
  const result = await saveNegotiationLimits({ maxDiscountMinor, minAdvancePct });
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/policy');
  return { status: 'success', message: result.data };
}

export async function resolveTaxFlagAction(_prev: FormState, f: FormData): Promise<FormState> {
  const result = await resolveTaxFlag(text(f, 'flagId'), text(f, 'note'));
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/quotations/policy');
  return { status: 'success', message: result.data };
}
