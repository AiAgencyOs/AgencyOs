import 'server-only';

import { createClient } from '@/lib/db/server';

import type { ExpenseCategory } from './expense-categories';

/**
 * The organization's expense categories, retired ones included (so an old
 * expense still has its label). RLS admits owner, ops_admin and finance; a
 * failed read THROWS rather than answering with the starting six — a screen
 * that quietly offers the wrong list files money under the wrong name.
 */
export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('finance')
    .from('expense_categories')
    .select('key, label, retired_at, sort_order')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'listExpenseCategories', detail: error.message }));
    throw new Error(`listExpenseCategories: ${error.message}`);
  }
  return (data ?? []).map((r) => ({ key: r.key, label: r.label, retired: r.retired_at !== null, sortOrder: r.sort_order }));
}

/** How many expenses are filed under each category key (retired categories included), for the Settings list. */
export async function countExpensesByCategory(): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').from('expenses').select('category').limit(20000);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'countExpensesByCategory', detail: error.message }));
    throw new Error(`countExpensesByCategory: ${error.message}`);
  }
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  return counts;
}
