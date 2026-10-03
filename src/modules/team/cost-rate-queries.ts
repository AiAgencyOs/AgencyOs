import 'server-only';

import { agencyClock } from '@/lib/admin/agency-clock';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { rateInForceOn } from './cost-rate-schema';
import type { CostRate, MemberCostRates } from './cost-rate-types';

export type { CostRate, CostRateAccess, MemberCostRates } from './cost-rate-types';

type RateRow = {
  id: string;
  user_id: string;
  hourly_cost_minor: number;
  currency: string;
  effective_from: string;
  set_by: string;
  note: string | null;
  created_at: string;
};

/**
 * Every cost rate the reader may see, grouped per person: the rate in force
 * today (agency time) and the full history. RLS on core.member_cost_rates
 * admits owner and ops_admin only; anybody else gets an empty map, which
 * the page must not mistake for "no rates" — it gates the column on role
 * before reading. Any failed read refuses.
 */
export async function listMemberCostRates(): Promise<Record<string, MemberCostRates>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('core')
    .from('member_cost_rates')
    .select('id, user_id, hourly_cost_minor, currency, effective_from, set_by, note, created_at')
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) unreadable('listMemberCostRates', error);

  const rows = (data ?? []) as RateRow[];
  const setterIds = [...new Set(rows.map((r) => r.set_by))];
  const names = new Map<string, string>();
  if (setterIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .schema('core')
      .from('users')
      .select('id, full_name, email')
      .in('id', setterIds);
    if (usersError) unreadable('listMemberCostRates.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email ?? 'Unknown');
  }

  const clock = await agencyClock();
  const today = clock.dayKey(new Date());

  const byUser = new Map<string, CostRate[]>();
  for (const r of rows) {
    const rate: CostRate = {
      id: r.id,
      userId: r.user_id,
      hourlyCostMinor: Number(r.hourly_cost_minor),
      currency: r.currency,
      effectiveFrom: r.effective_from,
      setBy: r.set_by,
      setByName: names.get(r.set_by) ?? 'Former member',
      note: r.note,
      createdAt: r.created_at,
    };
    const list = byUser.get(r.user_id) ?? [];
    list.push(rate);
    byUser.set(r.user_id, list);
  }

  const out: Record<string, MemberCostRates> = {};
  for (const [userId, history] of byUser) {
    out[userId] = { current: rateInForceOn(history, today), history };
  }
  return out;
}
