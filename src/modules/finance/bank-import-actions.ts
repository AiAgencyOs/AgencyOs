'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { BANK_CSV_MAX_BYTES } from './bank-import-schema';
import { confirmBankLineMatch, ignoreBankLine, importBankStatement } from './bank-import-service';

/** Server Actions for the bank CSV import — thin wrappers over bank-import-service.ts. */

const PAGE = '/finance/payments';

export async function importBankStatementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const reconciliationId = String(formData.get('reconciliationId') ?? '').trim();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a CSV file exported from the bank.' };
  }
  if (file.size > BANK_CSV_MAX_BYTES) {
    return { status: 'error', message: 'That file is too large for a statement (2 MB at most).' };
  }

  const result = await importBankStatement({
    reconciliationId,
    filename: file.name.slice(0, 200),
    csvText: await file.text(),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  const skipped = result.data.skipped.length;
  return {
    status: 'success',
    message:
      `${result.data.imported} line${result.data.imported === 1 ? '' : 's'} imported.` +
      (skipped > 0 ? ` ${skipped} could not be read: ${result.data.skipped.slice(0, 3).join(' ')}${skipped > 3 ? ' …' : ''}` : ''),
  };
}

export async function confirmBankLineMatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await confirmBankLineMatch({
    lineId: text('lineId'),
    paymentId: text('paymentId'),
    ...(text('reason') ? { reason: text('reason') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return { status: 'success', message: 'Matched. The reconciliation line is written; the payment is untouched.' };
}

export async function ignoreBankLineAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await ignoreBankLine({ lineId: text('lineId'), reason: text('reason') });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return { status: 'success', message: 'Set aside, with the reason kept.' };
}
