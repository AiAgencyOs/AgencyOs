'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Settings › Finance › invoice numbering and terms — PDF §7. The form posts
 * text; the door (`finance.set_invoice_numbering`) re-checks the role,
 * validates each field and audits the old and new values. Empty clears.
 */
export async function setInvoiceNumberingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) {
    return { status: 'error', message: 'You do not have permission to change organization settings.' };
  }

  const text = (name: string) => String(formData.get(name) ?? '').trim();
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('set_invoice_numbering', {
    p_prefix: text('prefix'),
    p_terms_days: text('termsDays'),
    p_terms_note: text('termsNote'),
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setInvoiceNumbering', detail: error.message }));
    return { status: 'error', message: 'Could not save the numbering.' };
  }
  const outcome = (Array.isArray(data) ? data[0]?.outcome : undefined) as string | undefined;
  switch (outcome) {
    case 'set':
      revalidatePath('/settings/finance');
      return { status: 'success', message: 'Saved. The next invoice uses this prefix and these terms; invoices already raised keep their numbers.' };
    case 'invalid_prefix':
      return { status: 'error', message: 'The prefix is 1 to 8 letters or digits, no spaces or dashes.' };
    case 'invalid_days':
      return { status: 'error', message: 'Terms are a whole number of days between 0 and 365.' };
    case 'invalid_note':
      return { status: 'error', message: 'The terms note is at most 500 characters.' };
    case 'forbidden':
      return { status: 'error', message: 'The database refused: only an owner or ops admin may change this.' };
    default:
      return { status: 'error', message: 'Could not save the numbering.' };
  }
}
