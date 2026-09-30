'use server';

import { revalidatePath } from 'next/cache';

import type { FormState } from '@/modules/identity/types';

import { parseMinorUnits } from './schema';
import {
  addReconciliationItem,
  closeReconciliation,
  openReconciliation,
  resolveReconciliationItem,
} from './reconciliation-service';

/** Server Actions for reconciliation — thin wrappers over reconciliation-service.ts. */

const PAGE = '/finance/payments';

export async function openReconciliationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await openReconciliation({
    periodStart: text('periodStart'),
    periodEnd: text('periodEnd'),
    source: text('source'),
    ...(text('accountId') ? { accountId: text('accountId') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return {
    status: 'success',
    message: result.data.alreadyOpen
      ? 'This account already has an open period — enter the lines there.'
      : 'Period opened. Enter the statement lines below.',
  };
}

export async function addReconciliationItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const amount = parseMinorUnits(text('amount'));
  if (amount === null) return { status: 'error', message: 'That is not an amount.' };

  const result = await addReconciliationItem({
    reconciliationId: text('reconciliationId'),
    statementLine: text('statementLine'),
    statementDate: text('statementDate'),
    amountMinor: amount,
    finding: text('finding') as never,
    ...(text('reference') ? { reference: text('reference') } : {}),
    ...(text('paymentId') ? { paymentId: text('paymentId') } : {}),
    ...(text('reason') ? { reason: text('reason') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return { status: 'success', message: 'Line recorded.' };
}

export async function resolveReconciliationItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = (name: string) => String(formData.get(name) ?? '').trim();

  const result = await resolveReconciliationItem({
    itemId: text('itemId'),
    finding: text('finding') as never,
    ...(text('paymentId') ? { paymentId: text('paymentId') } : {}),
    ...(text('reason') ? { reason: text('reason') } : {}),
  });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return { status: 'success', message: 'Saved.' };
}

export async function closeReconciliationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await closeReconciliation({ reconciliationId: String(formData.get('reconciliationId') ?? '') });

  if (!result.ok) return { status: 'error', message: result.error.message };

  revalidatePath(PAGE);
  return {
    status: 'success',
    message: result.data.alreadyClosed ? 'Already closed.' : 'Period closed. Nothing in it was altered — a reconciliation is a reading, not a correction.',
  };
}
