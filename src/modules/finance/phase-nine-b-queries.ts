import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for the Phase 9B screens. Every read refuses on failure (G-054). The milestone state is the database's derived answer
 * (`finance.milestone_financial_lifecycle`); nothing here recomputes it.
 */

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

export type MilestoneLifecycleLine = { milestoneId: string; name: string; position: number; state: string; plannedMinor: number; invoicedMinor: number; verifiedNetMinor: number; waivedMinor: number; outstandingMinor: number };

/** The derived lifecycle of every milestone of a project; an empty list for a role that reads no finance (the database answers). */
export async function readMilestoneLifecycle(projectId: string): Promise<MilestoneLifecycleLine[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('finance').rpc('milestone_financial_lifecycle' as never, { p_project_id: projectId } as never);
  if (error) unreadable('readMilestoneLifecycle', error);
  return rows(data).map((r) => ({
    milestoneId: String(r.milestone_id), name: String(r.milestone_name ?? ''), position: num(r.milestone_position), state: String(r.state), plannedMinor: num(r.planned_minor),
    invoicedMinor: num(r.invoiced_minor), verifiedNetMinor: num(r.verified_net_minor), waivedMinor: num(r.waived_minor), outstandingMinor: num(r.outstanding_minor),
  }));
}

export type ScheduleView = { id: string; accountId: string | null; unit: string; count: number; anchorDate: string; source: string; enabled: boolean };
export type DueItemView = { id: string; scheduleId: string; periodStart: string; periodEnd: string; state: string; reconciliationId: string | null };
export type AutomationControlView = { agentKey: string; paused: boolean; reason: string; setAt: string };

export async function readPhaseNineBControls(): Promise<{ schedules: ScheduleView[]; dueItems: DueItemView[]; automation: AutomationControlView[] }> {
  const supabase = await createClient();
  const [schedules, due, automation] = await Promise.all([
    supabase.schema('finance').from('reconciliation_schedules' as never).select('id, account_id, cadence_unit, cadence_count, anchor_date, source, enabled').limit(50),
    supabase.schema('finance').from('reconciliation_due_items' as never).select('id, schedule_id, period_start, period_end, state, reconciliation_id').order('period_start' as never, { ascending: false } as never).limit(20),
    supabase.schema('finance').from('finance_automation_controls' as never).select('agent_key, paused, reason, set_at').limit(10),
  ]);
  if (schedules.error) unreadable('readPhaseNineBControls.schedules', schedules.error);
  if (due.error) unreadable('readPhaseNineBControls.due', due.error);
  if (automation.error) unreadable('readPhaseNineBControls.automation', automation.error);
  return {
    schedules: rows(schedules.data).map((s) => ({ id: String(s.id), accountId: str(s.account_id), unit: String(s.cadence_unit), count: num(s.cadence_count), anchorDate: String(s.anchor_date), source: String(s.source), enabled: s.enabled === true })),
    dueItems: rows(due.data).map((d) => ({ id: String(d.id), scheduleId: String(d.schedule_id), periodStart: String(d.period_start), periodEnd: String(d.period_end), state: String(d.state), reconciliationId: str(d.reconciliation_id) })),
    automation: rows(automation.data).map((a) => ({ agentKey: String(a.agent_key), paused: a.paused === true, reason: String(a.reason ?? ''), setAt: String(a.set_at) })),
  };
}
