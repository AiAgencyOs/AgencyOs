'use server';

import { revalidatePath } from 'next/cache';

import { addPortfolioItem, setPortfolioItemActive } from '@/modules/crm/service';
import type { FormState } from '@/modules/identity/types';

/**
 * The portfolio list — G-013, ADM-12.
 *
 * Business rules §5.3: AgencyOS may send samples, demos and past work only
 * from a list the Admin maintains. These actions are the maintaining. Nothing
 * here sends anything, and nothing in the repository sends from this list yet.
 */
export async function addPortfolioItemAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const description = String(formData.get('description') ?? '').trim();

  const result = await addPortfolioItem({
    kind: String(formData.get('kind') ?? '') as 'sample' | 'demo' | 'past_work',
    title: String(formData.get('title') ?? ''),
    url: String(formData.get('url') ?? ''),
    ...(description ? { description } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/portfolio');
  return { status: 'success', message: 'Added to the list.' };
}

export async function setPortfolioItemActiveAction(
  _state: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await setPortfolioItemActive({
    itemId: String(formData.get('itemId') ?? ''),
    isActive: formData.get('isActive') === 'true',
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath('/portfolio');
  return { status: 'success', message: 'Updated.' };
}
