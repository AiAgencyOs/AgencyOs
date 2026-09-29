import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Decision F1 — what the payment gate would answer right now, read from the
 * same function `projects.mark_production_ready` calls, plus the recorded
 * overrides with who and why.
 */
export type FinalPaymentState = {
  state: 'no_priced_milestone' | 'no_invoice' | 'unverified' | 'verified' | 'overridden';
  milestoneId: string | null;
  milestoneName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
};

export async function readFinalPaymentState(projectId: string): Promise<FinalPaymentState> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('final_payment_state', { p_project_id: projectId });
  if (error) unreadable('readFinalPaymentState', error);
  const row = (Array.isArray(data) ? data[0] : data) as { state: string; milestone_id: string | null; milestone_name: string | null; invoice_id: string | null; invoice_number: string | null } | undefined;
  if (!row) unreadable('readFinalPaymentState', { message: 'no row returned' });
  const state = ['no_priced_milestone', 'no_invoice', 'unverified', 'verified', 'overridden'].includes(row!.state) ? (row!.state as FinalPaymentState['state']) : 'unverified';
  return { state, milestoneId: row!.milestone_id, milestoneName: row!.milestone_name, invoiceId: row!.invoice_id, invoiceNumber: row!.invoice_number };
}

export type ReleasePaymentOverride = { id: string; reason: string; overriddenByName: string | null; createdAt: string };

export async function listReleasePaymentOverrides(projectId: string): Promise<ReleasePaymentOverride[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('release_payment_overrides')
    .select('id, reason, overridden_by, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) unreadable('listReleasePaymentOverrides', error);
  const rows = data ?? [];
  const userIds = [...new Set(rows.map((r) => r.overridden_by).filter((id): id is string => id !== null))];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: uError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', userIds);
    if (uError) unreadable('listReleasePaymentOverrides.users', uError);
    for (const u of users ?? []) nameById.set(u.id, u.full_name || u.email);
  }
  return rows.map((r) => ({ id: r.id, reason: r.reason, overriddenByName: r.overridden_by ? (nameById.get(r.overridden_by) ?? null) : null, createdAt: r.created_at }));
}
