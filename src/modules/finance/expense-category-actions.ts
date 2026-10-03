'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { expenseCategoryOutcomeMessage } from './expense-category-outcome';

/**
 * Settings › Finance › Expense categories. One action for the four verbs
 * (add, rename, retire, restore); the door `finance.set_expense_category`
 * re-checks the role, validates and audits. Nothing is ever deleted.
 */
export async function setExpenseCategoryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) {
    return { status: 'error', message: 'You do not have permission to change organization settings.' };
  }
  const action = String(formData.get('action') ?? '');
  const key = String(formData.get('key') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();

  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('set_expense_category', { p_action: action, p_key: key, p_label: label });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setExpenseCategory', detail: error.message }));
    return { status: 'error', message: 'Could not save the category.' };
  }
  const outcome = (Array.isArray(data) ? data[0]?.outcome : undefined) as string | undefined;
  const result = expenseCategoryOutcomeMessage(outcome, label);
  if (result.status === 'success') {
    revalidatePath('/settings/finance');
    revalidatePath('/finance/expenses');
  }
  return result;
}
