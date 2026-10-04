import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { ACQUISITION_CHANNELS, type AcquisitionChannel, type IcpDefinition } from './schema';

/** Reads for the Lead Generation screens. Every failed read refuses (G-054): an empty list is never a hidden error. */

export type ChannelSettings = {
  channel: AcquisitionChannel;
  enabled: boolean;
  paused: boolean;
  pauseReason: string | null;
  pausedAt: string | null;
  monthlyQualifiedTarget: number | null;
  monthlyBudgetMinor: number | null;
  dailyLimit: number | null;
};

/** One entry per engine, in the fixed order, whether or not the organisation has been seeded yet. */
export async function readChannelSettings(): Promise<{ seeded: boolean; channels: ChannelSettings[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('acquisition_channels')
    .select('channel, enabled, paused, pause_reason, paused_at, monthly_qualified_target, monthly_budget_minor, daily_limit');
  if (error) unreadable('readChannelSettings', error);
  const byChannel = new Map((data ?? []).map((r) => [r.channel, r]));
  return {
    seeded: (data ?? []).length > 0,
    channels: ACQUISITION_CHANNELS.map((channel) => {
      const r = byChannel.get(channel);
      return {
        channel,
        enabled: r?.enabled ?? false,
        paused: r?.paused ?? false,
        pauseReason: r?.pause_reason ?? null,
        pausedAt: r?.paused_at ?? null,
        monthlyQualifiedTarget: r?.monthly_qualified_target ?? null,
        monthlyBudgetMinor: r?.monthly_budget_minor === null || r?.monthly_budget_minor === undefined ? null : Number(r.monthly_budget_minor),
        dailyLimit: r?.daily_limit ?? null,
      };
    }),
  };
}

export type TargetServiceView = { id: string; name: string; description: string | null; priority: number; active: boolean };

export async function listTargetServices(): Promise<TargetServiceView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('target_services').select('id, name, description, priority, active').order('priority').order('name');
  if (error) unreadable('listTargetServices', error);
  return (data ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description, priority: s.priority, active: s.active }));
}

export type IcpView = { version: number; definition: IcpDefinition; note: string | null; createdAt: string } | null;

export async function readCurrentIcp(): Promise<{ current: IcpView; versions: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('icp_versions').select('version, definition, note, created_at').order('version', { ascending: false }).limit(1);
  if (error) unreadable('readCurrentIcp', error);
  const { count, error: countError } = await supabase.schema('crm').from('icp_versions').select('version', { count: 'exact', head: true });
  if (countError) unreadable('readCurrentIcp.count', countError);
  const row = data?.[0];
  return {
    current: row ? { version: row.version, definition: (row.definition ?? {}) as IcpDefinition, note: row.note, createdAt: row.created_at } : null,
    versions: count ?? 0,
  };
}

export type SourceCount = { source: string; leads: number; qualified: number; won: number };

/**
 * What the CRM already knows, by the source it was recorded under. Real counts from crm.leads - nothing is
 * estimated. `won` is leads that converted (the lead-level WON; ADM-10). Bounded to the most recent 5,000
 * leads so a large book cannot make the page unbounded; `truncated` says so rather than hiding it.
 */
export async function readLeadsBySource(): Promise<{ rows: SourceCount[]; total: number; truncated: boolean }> {
  const supabase = await createClient();
  const LIMIT = 5000;
  const { data, error } = await supabase.schema('crm').from('leads').select('source, status').order('created_at', { ascending: false }).limit(LIMIT);
  if (error) unreadable('readLeadsBySource', error);
  const by = new Map<string, SourceCount>();
  for (const l of data ?? []) {
    const row = by.get(l.source) ?? { source: l.source, leads: 0, qualified: 0, won: 0 };
    row.leads += 1;
    if (l.status === 'qualified' || l.status === 'converted') row.qualified += 1;
    if (l.status === 'converted') row.won += 1;
    by.set(l.source, row);
  }
  return { rows: [...by.values()].sort((a, b) => b.leads - a.leads), total: (data ?? []).length, truncated: (data ?? []).length >= LIMIT };
}
