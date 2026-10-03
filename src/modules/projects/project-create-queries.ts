import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The pickers Quick Create needs — SCR-004. Small, bounded lists of the
 * accounts and projects the caller may already see (RLS), for a `<select>`
 * rather than a free-text id field that would make "not found" the normal
 * outcome of using it.
 */

export type ClientAccountOption = { id: string; name: string; currency: string };

export async function listClientAccountOptions(limit = 200): Promise<ClientAccountOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, name, currency')
    .eq('status', 'active')
    .order('name', { ascending: true })
    .limit(limit);
  if (error) unreadable('listClientAccountOptions', error);
  return data ?? [];
}

export type ProjectOption = { id: string; name: string; status: string };

/** Projects that could still be billed: anything not completed, cancelled or deleted. */
export async function listProjectOptions(limit = 200): Promise<ProjectOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, name, status')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listProjectOptions', error);
  return data ?? [];
}

export type MilestoneOption = {
  id: string;
  name: string;
  position: number;
  status: string;
  amountMinor: number;
  currency: string;
  paymentPercent: number | null;
};

export async function listMilestoneOptions(projectId: string): Promise<MilestoneOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, name, position, status, amount_minor, currency, payment_percent')
    .eq('project_id', projectId)
    .order('position', { ascending: true });
  if (error) unreadable('listMilestoneOptions', error);
  return (data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    position: m.position,
    status: m.status,
    amountMinor: m.amount_minor,
    currency: m.currency,
    paymentPercent: m.payment_percent === null ? null : Number(m.payment_percent),
  }));
}
